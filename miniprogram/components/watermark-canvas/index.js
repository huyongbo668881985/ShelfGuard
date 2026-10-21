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
     * 绘制水印
     */
    _drawWatermark(ctx, width, height, config) {
      const scale = width / 750
      const padding = 40 * scale
      const baseFontSize = (config.fontSize || 24) * scale
      const titleFontSize = baseFontSize * 1.4
      const lineSpacing = baseFontSize * 1.8

      // 生成时间文本
      const dateTime = config.dateTime || this._formatDateTime()

      // 根据位置绘制
      if (config.position === 'top') {
        this._drawTopWatermark(ctx, width, height, config, {
          padding, baseFontSize, titleFontSize, lineSpacing, dateTime
        })
      } else if (config.position === 'full') {
        this._drawFullWatermark(ctx, width, height, config, {
          padding, baseFontSize, titleFontSize, lineSpacing, dateTime
        })
      } else {
        // 默认 bottom
        this._drawBottomWatermark(ctx, width, height, config, {
          padding, baseFontSize, titleFontSize, lineSpacing, dateTime
        })
      }
    },

    /**
     * 底部水印（动态行高与超长截断，避免空行与文字溢出）
     */
    _drawBottomWatermark(ctx, width, height, config, params) {
      const { padding, baseFontSize, titleFontSize, lineSpacing, dateTime } = params
      const maxTextWidth = width - padding * 2

      const lines = []
      if (config.taskName) {
        lines.push({ text: config.taskName, isTitle: true })
      }
      if (config.storeName) {
        lines.push({ text: `门店：${config.storeName}`, isTitle: false })
      }
      if (config.address) {
        lines.push({ text: `位置：${config.address}`, isTitle: false })
      }
      const bottomText = [config.userName, dateTime].filter(Boolean).join('  ')
      if (bottomText) {
        lines.push({ text: bottomText, isTitle: false })
      }

      const totalLines = Math.max(1, lines.length)
      const bgHeight = (totalLines - 1) * lineSpacing + titleFontSize + padding * 2
      const bgY = height - bgHeight

      // 绘制半透明背景
      ctx.fillStyle = config.bgColor || 'rgba(0, 0, 0, 0.4)'
      ctx.fillRect(0, bgY, width, bgHeight)

      // 绘制动态文本
      ctx.fillStyle = config.color || '#ffffff'
      ctx.textAlign = 'left'

      let currentY = bgY + padding + titleFontSize
      lines.forEach((item, idx) => {
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
     * 格式化当前时间
     */
    _formatDateTime() {
      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hour = String(now.getHours()).padStart(2, '0')
      const min = String(now.getMinutes()).padStart(2, '0')
      return `${year}-${month}-${day} ${hour}:${min}`
    }
  }
})
