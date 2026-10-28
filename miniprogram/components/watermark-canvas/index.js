// components/watermark-canvas/index.js
// 可复用的 Canvas 水印合成组件

Component({
  properties: {
    // 原图路径
    imagePath: { type: String, value: '' },
    // 水印配置
    watermark: {
      type: Object,
      value: {
        taskName: '',        // 任务名称
        storeName: '',       // 门店名称
        userName: '',        // 业务员姓名
        address: '',         // 位置信息
        dateTime: '',        // 时间日期（为空则自动获取当前时间）
        logoPath: '',        // LOGO 图片路径
        // 样式配置
        position: 'bottom',  // 水印位置：top / bottom / full
        color: '#ffffff',    // 文字颜色
        bgColor: 'rgba(0, 0, 0, 0.4)', // 背景色
        opacity: 1,          // 整体透明度 0-1
        fontSize: 16,        // 基础字号（相对于 750 设计稿，已调小以免水印过大）
        showLogo: true       // 是否显示 LOGO
      }
    }
  },

  data: {
    canvasId: 'watermarkCanvas',
    composing: false
  },

  methods: {
    /**
     * 合成水印图片（对外调用）
     * @returns {Promise<string>} 合成后的临时文件路径
     */
    async compose() {
      if (!this.properties.imagePath) {
        throw new Error('缺少图片路径')
      }

      this.setData({ composing: true })

      try {
        const query = this.createSelectorQuery()
        const canvasRes = await new Promise(resolve => {
          query.select('#watermarkCanvas')
            .fields({ node: true, size: true })
            .exec(res => resolve(res[0]))
        })

        if (!canvasRes || !canvasRes.node) {
          throw new Error('Canvas 节点获取失败')
        }

        const canvas = canvasRes.node
        const ctx = canvas.getContext('2d')
        const watermark = this.properties.watermark

        // 加载原图
        const img = canvas.createImage()
        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = reject
          img.src = this.properties.imagePath
        })

        // 设置画布尺寸为原图尺寸（保持高清）
        canvas.width = img.width
        canvas.height = img.height

        // 绘制原图
        ctx.drawImage(img, 0, 0, img.width, img.height)

        // 设置全局透明度
        ctx.globalAlpha = watermark.opacity || 1

        // 绘制水印
        this._drawWatermark(ctx, canvas.width, canvas.height, watermark)

        // 恢复透明度
        ctx.globalAlpha = 1

        // 等待一帧渲染缓冲后再导出，避免部分机型导出空白图
        await new Promise(resolve => {
          if (typeof canvas.requestAnimationFrame === 'function') {
            canvas.requestAnimationFrame(resolve)
          } else {
            setTimeout(resolve, 30)
          }
        })

        // 导出为临时文件
        const tempPath = await new Promise((resolve, reject) => {
          wx.canvasToTempFilePath({
            canvas: canvas,
            fileType: 'jpg',
            quality: 0.92,
            success: res => resolve(res.tempFilePath),
            fail: reject
          })
        })

        this.setData({ composing: false })
        this.triggerEvent('compose', { tempPath })
        return tempPath

      } catch (err) {
        this.setData({ composing: false })
        console.error('水印合成失败:', err)
        this.triggerEvent('error', { error: err })
        throw err
      }
    },

    /**
     * 绘制圆角矩形
     */
    _drawRoundRect(ctx, x, y, w, h, r) {
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath()
        ctx.roundRect(x, y, w, h, r)
        ctx.fill()
        return
      }
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.lineTo(x + w - r, y)
      ctx.arcTo(x + w, y, x + w, y + r, r)
      ctx.lineTo(x + w, y + h - r)
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
      ctx.lineTo(x + r, y + h)
      ctx.arcTo(x, y + h, x, y + h - r, r)
      ctx.lineTo(x, y + r)
      ctx.arcTo(x, y, x + r, y, r)
      ctx.closePath()
      ctx.fill()
    },

    /**
     * 绘制水印
     */
    _drawWatermark(ctx, width, height, config) {
      // 比例参考短边，防止多图横向拼接（宽远大于高）时字体与内边距暴增占满半张图
      const refDim = Math.min(width, height)
      const scale = Math.max(0.65, refDim / 900)
      const padding = Math.round(20 * scale)
      const baseFontSize = Math.round((config.fontSize || 16) * scale)
      const titleFontSize = Math.round(baseFontSize * 1.25)
      const lineSpacing = Math.round(baseFontSize * 1.45)

      // 生成时间文本（含今日水印专用的大时间和星期）
      const dateTimeObj = this._formatDateTime()

      // 根据位置绘制
      if (config.position === 'top') {
        this._drawTopWatermark(ctx, width, height, config, {
          padding, baseFontSize, titleFontSize, lineSpacing, dateTime: dateTimeObj.fullStr
        })
      } else if (config.position === 'full') {
        this._drawFullWatermark(ctx, width, height, config, {
          padding, baseFontSize, titleFontSize, lineSpacing, dateTime: dateTimeObj.fullStr
        })
      } else {
        // 默认 bottom：今日水印相机经典左下角卡片式排版
        this._drawBottomWatermark(ctx, width, height, config, {
          scale, padding, baseFontSize, titleFontSize, lineSpacing, dateTimeObj
        })
      }
    },

    /**
     * 底部水印 —— 今日水印相机经典卡片排版
     * 特性：
     * 1. 左下角圆角卡片，紧凑精致，绝不占满半张图；
     * 2. 大字真实时间 + 经典黄色强调竖条 + 星期标注；
     * 3. 结构化字段行：任务、门店（可选）、地点、记录人。
     */
    _drawBottomWatermark(ctx, width, height, config, params) {
      const { scale, baseFontSize, dateTimeObj } = params

      const cardMargin = Math.round(24 * scale)
      const cardPadX = Math.round(20 * scale)
      const cardPadY = Math.round(16 * scale)

      const timeFontSize = Math.round(baseFontSize * 2.2)
      const subFontSize = Math.round(baseFontSize * 0.85)
      const fieldFontSize = Math.round(baseFontSize * 0.95)
      const lineH = Math.round(baseFontSize * 1.45)

      // 提取项目条目
      const items = []
      if (config.taskName) items.push({ label: '任务', value: config.taskName })
      if (config.storeName) items.push({ label: '门店', value: config.storeName })
      if (config.address) items.push({ label: '地点', value: config.address })
      if (config.userName) items.push({ label: '记录人', value: config.userName })

      // 卡片宽度自适应（大屏或横图时限宽 540*scale，小图限宽 width - margin*2）
      const cardW = Math.min(width - cardMargin * 2, Math.round(520 * scale))
      const maxTextW = cardW - cardPadX * 2

      // 时间块高度 + 分割线 + 各字段高度
      const headerH = Math.round(48 * scale)
      const cardH = cardPadY * 2 + headerH + items.length * lineH + Math.round(8 * scale)

      const cardX = cardMargin
      const cardY = height - cardMargin - cardH

      // 1. 背景处理：默认无大黑框（纯透明），仅当外部显式配置了有色背景时才画底板
      const hasBg = config.bgColor && config.bgColor !== 'transparent' && config.bgColor !== 'none'
      if (hasBg) {
        ctx.fillStyle = config.bgColor
        this._drawRoundRect(ctx, cardX, cardY, cardW, cardH, Math.round(12 * scale))
      }

      // 开启柔和暗色微阴影，确保纯透明纯白文字在任何亮色/复杂货架背景上都清晰立体、不刺眼
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.75)'
      ctx.shadowBlur = Math.round(4 * scale)
      ctx.shadowOffsetX = Math.round(1.2 * scale)
      ctx.shadowOffsetY = Math.round(1.2 * scale)

      // 2. 绘制今日水印黄色强调竖条
      const barW = Math.max(3, Math.round(4 * scale))
      const barH = Math.round(38 * scale)
      const barX = cardX + (hasBg ? cardPadX : 0)
      const barY = cardY + (hasBg ? cardPadY : 0) + Math.round(4 * scale)
      ctx.fillStyle = '#FFA000'
      ctx.fillRect(barX, barY, barW, barH)

      // 3. 绘制大时间 (如 15:54)
      const timeX = barX + barW + Math.round(10 * scale)
      const textBaseY = cardY + (hasBg ? cardPadY : 0)
      ctx.fillStyle = '#FFFFFF'
      ctx.textAlign = 'left'
      ctx.font = `bold ${timeFontSize}px sans-serif`
      ctx.fillText(dateTimeObj.timeStr, timeX, textBaseY + Math.round(30 * scale))

      // 3.1 真实时间防伪标
      const tagFontSize = Math.round(baseFontSize * 0.72)
      const tagW = Math.round(56 * scale)
      const tagH = Math.round(18 * scale)
      const tagX = timeX + Math.round(timeFontSize * 2.1)
      const tagY = textBaseY + Math.round(10 * scale)
      ctx.fillStyle = '#FFA000'
      this._drawRoundRect(ctx, tagX, tagY, tagW, tagH, Math.round(3 * scale))
      ctx.font = `bold ${tagFontSize}px sans-serif`
      ctx.fillStyle = '#FFFFFF'
      ctx.fillText('真实时间', tagX + Math.round(5 * scale), tagY + Math.round(13 * scale))

      // 4. 绘制时间下方日期与星期 (如 2026.10.21 星期三)
      ctx.font = `${subFontSize}px sans-serif`
      ctx.fillStyle = 'rgba(240, 245, 250, 0.95)'
      ctx.fillText(dateTimeObj.dateWeekStr, timeX, textBaseY + Math.round(47 * scale))

      // 5. 分割线
      const divY = textBaseY + headerH
      const lineStartX = cardX + (hasBg ? cardPadX : 0)
      const lineEndX = lineStartX + cardW - (hasBg ? cardPadX * 2 : 0)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'
      ctx.lineWidth = Math.max(1, Math.round(1 * scale))
      ctx.beginPath()
      ctx.moveTo(lineStartX, divY)
      ctx.lineTo(lineEndX, divY)
      ctx.stroke()

      // 6. 逐行绘制字段 (任务 / 门店 / 地点 / 记录人)
      let currY = divY + Math.round(16 * scale)
      const labelW = Math.round(62 * scale)
      const valMaxW = maxTextW - labelW

      items.forEach(item => {
        ctx.font = `${fieldFontSize}px sans-serif`
        ctx.fillStyle = 'rgba(225, 230, 240, 0.9)'
        ctx.fillText(item.label + '：', lineStartX, currY)

        ctx.font = `500 ${fieldFontSize}px sans-serif`
        ctx.fillStyle = '#FFFFFF'
        const safeVal = this._truncateText(ctx, item.value, valMaxW)
        ctx.fillText(safeVal, lineStartX + labelW, currY)

        currY += lineH
      })

      ctx.restore()
    },

    /**
     * 顶部水印
     */
    _drawTopWatermark(ctx, width, height, config, params) {
      const { padding, baseFontSize, titleFontSize, lineSpacing, dateTime } = params
      const maxTextWidth = width - padding * 2

      const lines = []
      if (config.taskName) lines.push({ text: config.taskName, isTitle: true })
      if (config.storeName) lines.push({ text: `门店：${config.storeName}`, isTitle: false })
      if (config.address) lines.push({ text: `位置：${config.address}`, isTitle: false })
      const bottomText = [config.userName, dateTime].filter(Boolean).join('  ')
      if (bottomText) lines.push({ text: bottomText, isTitle: false })

      const totalLines = Math.max(1, lines.length)
      const bgHeight = (totalLines - 1) * lineSpacing + titleFontSize + padding * 2

      // 绘制半透明背景
      ctx.fillStyle = config.bgColor || 'rgba(0, 0, 0, 0.4)'
      ctx.fillRect(0, 0, width, bgHeight)

      // 文字颜色
      ctx.fillStyle = config.color || '#ffffff'
      ctx.textAlign = 'left'

      let currentY = padding + titleFontSize
      lines.forEach((item) => {
        if (item.isTitle) {
          ctx.font = `bold ${titleFontSize}px sans-serif`
        } else {
          ctx.font = `${baseFontSize}px sans-serif`
        }
        const safeText = this._truncateText(ctx, item.text, maxTextWidth)
        ctx.fillText(safeText, padding, currentY)
        currentY += lineSpacing
      })
    },

    /**
     * 测量并截断文本，超出宽度补省略号
     */
    _truncateText(ctx, text, maxWidth) {
      if (!text || !maxWidth) return text || ''
      if (ctx.measureText(text).width <= maxWidth) return text

      let low = 0
      let high = text.length
      let best = text
      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const sub = text.slice(0, mid) + '...'
        if (ctx.measureText(sub).width <= maxWidth) {
          best = sub
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      return best
    },

    /**
     * 全屏水印（平铺）
     */
    _drawFullWatermark(ctx, width, height, config, params) {
      const { baseFontSize } = params
      const text = `${config.taskName || ''} ${config.userName || ''}`

      ctx.fillStyle = config.color || 'rgba(255, 255, 255, 0.3)'
      ctx.font = `${baseFontSize}px sans-serif`
      ctx.textAlign = 'center'

      // 旋转绘制
      ctx.save()
      ctx.translate(width / 2, height / 2)
      ctx.rotate(-Math.PI / 6)

      const step = baseFontSize * 8
      for (let y = -height; y < height; y += step) {
        for (let x = -width; x < width; x += step) {
          ctx.fillText(text, x, y)
        }
      }

      ctx.restore()
    },

    /**
     * 格式化当前时间（含今日水印专用大时间、年月日与星期）
     */
    _formatDateTime() {
      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hour = String(now.getHours()).padStart(2, '0')
      const min = String(now.getMinutes()).padStart(2, '0')
      const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
      const week = weekdays[now.getDay()]

      return {
        timeStr: `${hour}:${min}`,
        dateWeekStr: `${year}.${month}.${day}  ${week}`,
        fullStr: `${year}-${month}-${day} ${hour}:${min}`
      }
    }
  }
})
