// components/watermark-canvas/index.js
// 可复用的 Canvas 水印合成组件

const MAX_CANVAS_DIM = 3600

/**
 * 计算水印画布合成方案（外扩底栏 / 拼图空白格嵌合 / 3600px 安全上限保护）
 * @param {number} imgWidth
 * @param {number} imgHeight
 * @param {Object} config
 */
function computeCanvasPlan(imgWidth, imgHeight, config = {}) {
  const safeW = Math.max(1, Math.round(imgWidth || 1))
  const safeH = Math.max(1, Math.round(imgHeight || 1))
  const position = config.position || 'bottom'
  const emptyCell = config.emptyCell && config.emptyCell.width > 0 && config.emptyCell.height > 0
    ? config.emptyCell
    : null

  let layoutMode = 'overlay'
  if (position === 'bottom') {
    if (config.layoutMode === 'grid_slot' && emptyCell) {
      layoutMode = 'grid_slot'
    } else if (config.layoutMode === 'footer_bar' || config.layoutMode === 'compact_bar' || config.layoutMode === 'overlay') {
      layoutMode = config.layoutMode
    } else {
      layoutMode = 'compact_bar'
    }
  }

  const refDim = Math.min(safeW, safeH * 1.35)
  const barScale = Math.max(0.75, refDim / 900)
  let rawBarHeight = 0

  if (layoutMode === 'compact_bar') {
    const padY = Math.round(14 * barScale)
    const lineH = Math.round(24 * barScale)
    rawBarHeight = padY * 2 + lineH * 3 + Math.round(6 * barScale)
  } else if (layoutMode === 'footer_bar') {
    const padY = Math.round(16 * barScale)
    const lineH = Math.round(24 * barScale)
    const leftMinH = Math.round(78 * barScale)
    const rightMinH = lineH * 4
    rawBarHeight = padY * 2 + Math.max(leftMinH, rightMinH)
  }

  const maxRaw = Math.max(safeW, safeH + rawBarHeight)
  const shrink = maxRaw > MAX_CANVAS_DIM ? MAX_CANVAS_DIM / maxRaw : 1

  const canvasWidth = Math.max(1, Math.round(safeW * shrink))
  const imgDrawWidth = canvasWidth
  const imgDrawHeight = Math.max(1, Math.round(safeH * shrink))
  let barHeight = rawBarHeight > 0 ? Math.max(1, Math.round(rawBarHeight * shrink)) : 0
  let canvasHeight = imgDrawHeight + barHeight
  if (canvasHeight > MAX_CANVAS_DIM) {
    barHeight = Math.max(0, MAX_CANVAS_DIM - imgDrawHeight)
    canvasHeight = imgDrawHeight + barHeight
  }

  const scaledEmptyCell = emptyCell
    ? {
        x: Math.round(emptyCell.x * shrink),
        y: Math.round(emptyCell.y * shrink),
        width: Math.round(emptyCell.width * shrink),
        height: Math.round(emptyCell.height * shrink)
      }
    : null

  return {
    layoutMode,
    shrink,
    barScale: barScale * shrink,
    canvasWidth,
    canvasHeight,
    imgDrawWidth,
    imgDrawHeight,
    barHeight,
    emptyCell: scaledEmptyCell
  }
}

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

        const plan = computeCanvasPlan(img.width, img.height, watermark)

        // 设置画布尺寸（单图/双数拼图含外扩底栏，且严格不超过 3600px 安全上限）
        canvas.width = plan.canvasWidth
        canvas.height = plan.canvasHeight

        // 绘制原图（若底栏导致超限，等比例缩放后完整绘制，不裁边）
        ctx.drawImage(img, 0, 0, plan.imgDrawWidth, plan.imgDrawHeight)

        // 设置全局透明度
        ctx.globalAlpha = watermark.opacity || 1

        // 绘制水印
        this._drawWatermark(ctx, plan, watermark)

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
     * 绘制水印（按 layoutMode 分流：compact_bar / footer_bar / grid_slot / overlay）
     */
    _drawWatermark(ctx, plan, config) {
      const { canvasWidth: width, canvasHeight: height, imgDrawHeight, barHeight, layoutMode, barScale, emptyCell } = plan
      const refDim = Math.min(width, height)
      const scale = Math.max(0.75, (refDim / 900) * 1.2)
      const padding = Math.round(20 * scale)
      const baseFontSize = Math.round((config.fontSize || 17) * scale)
      const titleFontSize = Math.round(baseFontSize * 1.25)
      const lineSpacing = Math.round(baseFontSize * 1.45)

      // 生成时间文本（含今日水印专用的大时间和星期）
      const dateTimeObj = this._formatDateTime(config.dateTime)

      if (config.position === 'top') {
        this._drawTopWatermark(ctx, width, height, config, {
          padding, baseFontSize, titleFontSize, lineSpacing, dateTime: dateTimeObj.fullStr
        })
        return
      }
      if (config.position === 'full') {
        this._drawFullWatermark(ctx, width, height, config, {
          padding, baseFontSize, titleFontSize, lineSpacing, dateTime: dateTimeObj.fullStr
        })
        return
      }

      if (layoutMode === 'grid_slot' && emptyCell) {
        this._drawGridSlotWatermark(ctx, emptyCell, config, dateTimeObj)
        return
      }

      if (layoutMode === 'footer_bar' && barHeight > 0) {
        this._drawHorizontalTwoColumnCard(
          ctx,
          { x: 0, y: imgDrawHeight, width, height: barHeight },
          barScale,
          config,
          dateTimeObj,
          { topBorder: true, bgColor: '#161922' }
        )
        return
      }

      if (layoutMode === 'compact_bar' && barHeight > 0) {
        this._drawCompactBar(
          ctx,
          { x: 0, y: imgDrawHeight, width, height: barHeight },
          barScale,
          config,
          dateTimeObj
        )
        return
      }

      // 兜底 overlay：今日水印相机经典左下角卡片式排版
      this._drawBottomWatermark(ctx, width, height, config, {
        scale, padding, baseFontSize, titleFontSize, lineSpacing, dateTimeObj
      })
    },

    /**
     * 共享时间模块：橙色 [真实时间] 标签 + 黄色强调竖条 + 大号时间 + 日期星期
     */
    _drawTimeBlock(ctx, x, y, scale, dateTimeObj, options = {}) {
      const compact = Boolean(options.compact)
      const tagFontSize = Math.round(12 * scale)
      const tagH = Math.round(18 * scale)
      const tagGapY = Math.round(6 * scale)
      const tagPadW = Math.round(7 * scale)

      ctx.save()
      ctx.font = `bold ${tagFontSize}px sans-serif`
      const tagText = '真实时间'
      const tagTextW = ctx.measureText(tagText).width
      const tagW = Math.round(tagTextW + tagPadW * 2)

      ctx.fillStyle = '#FFA000'
      this._drawRoundRect(ctx, x, y, tagW, tagH, Math.round(3 * scale))

      ctx.fillStyle = '#FFFFFF'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(tagText, x + tagPadW, y + tagH / 2)
      ctx.textBaseline = 'alphabetic'

      const timeAreaY = y + tagH + tagGapY
      const barW = Math.max(3, Math.round(4.5 * scale))
      const barH = Math.round(36 * scale)
      const barY = timeAreaY + Math.round(3 * scale)

      ctx.fillStyle = '#FFA000'
      ctx.fillRect(x, barY, barW, barH)

      const timeX = x + barW + Math.round(10 * scale)
      const timeFontSize = Math.round(36 * scale)
      const subFontSize = Math.round(14 * scale)

      ctx.fillStyle = '#FFFFFF'
      ctx.font = `bold ${timeFontSize}px sans-serif`
      ctx.fillText(dateTimeObj.timeStr, timeX, timeAreaY + Math.round(30 * scale))
      const timeW = ctx.measureText(dateTimeObj.timeStr).width

      const dateStr = compact ? dateTimeObj.dateWeekShortStr : dateTimeObj.dateWeekStr
      ctx.font = `${subFontSize}px sans-serif`
      ctx.fillStyle = 'rgba(240, 245, 250, 0.92)'
      ctx.fillText(dateStr, timeX, timeAreaY + Math.round(48 * scale))
      const dateW = ctx.measureText(dateStr).width
      ctx.restore()

      return {
        width: Math.max(tagW, barW + Math.round(10 * scale) + Math.max(timeW, dateW)),
        height: tagH + tagGapY + Math.round(52 * scale)
      }
    },

    /**
     * 方案 A（双数拼图底栏）& 方案 C（横排空白格）：深色左右两栏横排卡片
     */
    _drawHorizontalTwoColumnCard(ctx, box, scale, config, dateTimeObj, options = {}) {
      const { rounded = false, topBorder = false, bgColor = '#161922' } = options
      ctx.save()
      ctx.fillStyle = bgColor
      if (rounded) {
        this._drawRoundRect(ctx, box.x, box.y, box.width, box.height, Math.round(14 * scale))
      } else {
        ctx.fillRect(box.x, box.y, box.width, box.height)
      }

      if (topBorder) {
        ctx.fillStyle = '#2D3343'
        ctx.fillRect(box.x, box.y, box.width, Math.max(1, Math.round(1.5 * scale)))
      }

      const padX = Math.round(22 * scale)
      const padY = Math.round(14 * scale)

      // 测量时间区实际尺寸并垂直居中
      const timeScale = scale * 0.96
      const estTimeH = Math.round(76 * timeScale)
      const timeY = box.y + Math.max(padY, Math.round((box.height - estTimeH) / 2))
      const timeMetrics = this._drawTimeBlock(ctx, box.x + padX, timeY, timeScale, dateTimeObj, { compact: false })

      const gapX = Math.round(20 * scale)
      const divX = box.x + padX + timeMetrics.width + gapX
      ctx.fillStyle = '#2D3343'
      ctx.fillRect(divX, box.y + padY, Math.max(1, Math.round(1.5 * scale)), Math.max(10, box.height - padY * 2))

      const rx = divX + gapX
      const rightMaxW = Math.max(60, box.x + box.width - padX - rx)
      const items = [
        { label: '任务', value: config.taskName },
        { label: '门店', value: config.storeName },
        { label: '地点', value: config.address },
        { label: '记录人', value: config.userName }
      ].filter(item => item.value)

      const fieldFontSize = Math.round((config.fontSize || 16) * scale)
      const lineH = Math.round(24 * scale)
      const blockH = items.length * lineH
      let currY = box.y + Math.max(padY + fieldFontSize, Math.round((box.height - blockH) / 2) + Math.round(fieldFontSize * 0.88))

      const labelW = Math.round(68 * scale)
      const valMaxW = Math.max(40, rightMaxW - labelW)

      ctx.textAlign = 'left'
      items.forEach(item => {
        ctx.font = `${fieldFontSize}px sans-serif`
        ctx.fillStyle = '#94A3B8'
        ctx.fillText(item.label + '：', rx, currY)

        ctx.font = `500 ${fieldFontSize}px sans-serif`
        ctx.fillStyle = '#F8FAFC'
        const safeVal = this._truncateText(ctx, item.value, valMaxW)
        ctx.fillText(safeVal, rx + labelW, currY)
        currY += lineH
      })

      ctx.restore()
    },

    /**
     * 方案 D（单图极简底条）：左时间 + 右侧 3 紧凑行（优先保证门店与地点完整不截断）
     */
    _drawCompactBar(ctx, box, scale, config, dateTimeObj) {
      ctx.save()
      ctx.fillStyle = '#161922'
      ctx.fillRect(box.x, box.y, box.width, box.height)

      ctx.fillStyle = '#2D3343'
      ctx.fillRect(box.x, box.y, box.width, Math.max(1, Math.round(1.5 * scale)))

      const padX = Math.round(18 * scale)
      const padY = Math.round(12 * scale)
      const timeScale = scale * 0.88
      const estTimeH = Math.round(76 * timeScale)
      const timeY = box.y + Math.max(padY, Math.round((box.height - estTimeH) / 2))
      const timeMetrics = this._drawTimeBlock(ctx, box.x + padX, timeY, timeScale, dateTimeObj, { compact: true })

      const gapX = Math.round(16 * scale)
      const divX = box.x + padX + timeMetrics.width + gapX
      ctx.fillStyle = '#2D3343'
      ctx.fillRect(divX, box.y + padY, Math.max(1, Math.round(1.5 * scale)), Math.max(10, box.height - padY * 2))

      const rx = divX + gapX
      const rightMaxW = Math.max(60, box.x + box.width - padX - rx)

      const rows = []
      if (config.storeName) {
        rows.push({ label: '门店', value: config.storeName, highlight: true })
        if (config.address) rows.push({ label: '地点', value: config.address })
        const tailParts = []
        if (config.taskName) tailParts.push(`任务：${config.taskName}`)
        if (config.userName) tailParts.push(`记录人：${config.userName}`)
        if (tailParts.length > 0) rows.push({ plain: tailParts.join('  ·  '), muted: true })
      } else {
        if (config.taskName) rows.push({ label: '任务', value: config.taskName, highlight: true })
        if (config.address) rows.push({ label: '地点', value: config.address })
        if (config.userName) rows.push({ label: '记录人', value: config.userName, muted: true })
      }

      const fontSize = Math.round(15 * scale)
      const lineH = Math.round(23 * scale)
      const blockH = rows.length * lineH
      let currY = box.y + Math.max(padY + fontSize, Math.round((box.height - blockH) / 2) + Math.round(fontSize * 0.88))
      const labelW = Math.round(50 * scale)

      ctx.textAlign = 'left'
      rows.forEach(row => {
        if (row.plain) {
          ctx.font = `${Math.round(fontSize * 0.92)}px sans-serif`
          ctx.fillStyle = '#CBD5E1'
          ctx.fillText(this._truncateText(ctx, row.plain, rightMaxW), rx, currY)
        } else {
          ctx.font = `${fontSize}px sans-serif`
          ctx.fillStyle = '#94A3B8'
          ctx.fillText(row.label + '：', rx, currY)

          ctx.font = row.highlight ? `600 ${fontSize}px sans-serif` : `500 ${fontSize}px sans-serif`
          ctx.fillStyle = row.muted ? '#CBD5E1' : '#F8FAFC'
          ctx.fillText(this._truncateText(ctx, row.value, Math.max(40, rightMaxW - labelW)), rx + labelW, currY)
        }
        currY += lineH
      })

      ctx.restore()
    },

    /**
     * 方案 C（3/5 张拼图右下角空白格嵌合）：竖格用竖排、扁横格自适应切换横排
     */
    _drawGridSlotWatermark(ctx, emptyCell, config, dateTimeObj) {
      ctx.save()
      ctx.fillStyle = '#111111'
      ctx.fillRect(emptyCell.x, emptyCell.y, emptyCell.width, emptyCell.height)

      const cellRatio = emptyCell.width / emptyCell.height
      if (cellRatio > 1.2) {
        const pad = Math.round(Math.min(emptyCell.width, emptyCell.height) * 0.05)
        const box = {
          x: emptyCell.x + pad,
          y: emptyCell.y + pad,
          width: emptyCell.width - pad * 2,
          height: emptyCell.height - pad * 2
        }
        const hScale = Math.max(0.55, Math.min(box.width / 620, box.height / 180))
        this._drawHorizontalTwoColumnCard(ctx, box, hScale, config, dateTimeObj, {
          rounded: true,
          bgColor: '#181C24'
        })
        ctx.restore()
        return
      }

      // 竖格或方格：居中绘制竖版卡片（地址/门店自动最多折2行，利用纵向富余空间）
      const cardScale = Math.max(0.65, Math.min(emptyCell.width / 460, emptyCell.height / 380))
      const outerMargin = Math.round(16 * cardScale)
      const cardPadX = Math.round(24 * cardScale)
      const cardPadY = Math.round(22 * cardScale)
      const cardW = emptyCell.width - outerMargin * 2
      const maxTextW = cardW - cardPadX * 2

      const fieldFontSize = Math.round((config.fontSize || 16) * cardScale)
      const lineH = Math.round(24 * cardScale)
      const labelW = Math.round(68 * cardScale)
      const valMaxW = Math.max(40, maxTextW - labelW)

      const rawItems = [
        { label: '任务', value: config.taskName, maxLines: 1 },
        { label: '门店', value: config.storeName, maxLines: 2 },
        { label: '地点', value: config.address, maxLines: 2 },
        { label: '记录人', value: config.userName, maxLines: 1 }
      ].filter(item => item.value)

      ctx.font = `500 ${fieldFontSize}px sans-serif`
      const wrappedItems = rawItems.map(item => ({
        label: item.label,
        lines: this._wrapText(ctx, item.value, valMaxW, item.maxLines)
      }))

      const totalFieldLines = wrappedItems.reduce((sum, item) => sum + item.lines.length, 0)
      const timeBlockH = Math.round(76 * cardScale)
      const divGap = Math.round(16 * cardScale)
      const contentH = timeBlockH + divGap + totalFieldLines * lineH
      const cardH = Math.min(emptyCell.height - outerMargin * 2, contentH + cardPadY * 2)
      const cardX = emptyCell.x + outerMargin
      const cardY = emptyCell.y + Math.round((emptyCell.height - cardH) / 2)

      ctx.fillStyle = '#181C24'
      this._drawRoundRect(ctx, cardX, cardY, cardW, cardH, Math.round(14 * cardScale))

      const startX = cardX + cardPadX
      const startY = cardY + Math.max(cardPadY, Math.round((cardH - contentH) / 2))
      this._drawTimeBlock(ctx, startX, startY, cardScale, dateTimeObj, { compact: false })

      const divY = startY + timeBlockH + Math.round(6 * cardScale)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
      ctx.lineWidth = Math.max(1, Math.round(1 * cardScale))
      ctx.beginPath()
      ctx.moveTo(startX, divY)
      ctx.lineTo(cardX + cardW - cardPadX, divY)
      ctx.stroke()

      let currY = divY + Math.round(22 * cardScale)
      ctx.textAlign = 'left'
      wrappedItems.forEach(item => {
        ctx.font = `${fieldFontSize}px sans-serif`
        ctx.fillStyle = '#94A3B8'
        ctx.fillText(item.label + '：', startX, currY)

        ctx.font = `500 ${fieldFontSize}px sans-serif`
        ctx.fillStyle = '#F8FAFC'
        item.lines.forEach((lineText, idx) => {
          ctx.fillText(lineText, startX + labelW, currY + idx * lineH)
        })
        currY += item.lines.length * lineH
      })

      ctx.restore()
    },

    /**
     * 底部水印 —— 今日水印相机经典卡片排版
     * 特性：
     * 1. 左下角圆角卡片，紧凑精致，绝不占满半张图；
     * 2. [真实时间] 防伪小标签置于大时间上方，杜绝横向遮挡时间数字；
     * 3. 经典黄色强调竖条 + 大字时间 + 星期标注；
     * 4. 整体位置下沉贴底，整体比例适度放大，增强巡检报表大图权威感；
     * 5. 结构化字段行：任务、门店（可选）、地点、记录人。
     */
    _drawBottomWatermark(ctx, width, height, config, params) {
      const { scale, baseFontSize, dateTimeObj } = params

      // 边距与卡片内边距：底部距离收紧至 12*scale，让整体下沉贴近左下角
      const cardMarginX = Math.round(18 * scale)
      const cardMarginBottom = Math.round(12 * scale)
      const cardPadX = Math.round(20 * scale)
      const cardPadY = Math.round(16 * scale)

      const timeFontSize = Math.round(baseFontSize * 2.3)
      const subFontSize = Math.round(baseFontSize * 0.88)
      const fieldFontSize = Math.round(baseFontSize * 1.0)
      const lineH = Math.round(baseFontSize * 1.55)

      // 提取项目条目
      const items = []
      if (config.taskName) items.push({ label: '任务', value: config.taskName })
      if (config.storeName) items.push({ label: '门店', value: config.storeName })
      if (config.address) items.push({ label: '地点', value: config.address })
      if (config.userName) items.push({ label: '记录人', value: config.userName })

      // 卡片宽度自适应：适度放宽至 580*scale，保证长任务名和详细地址完整展示
      const cardW = Math.min(width - cardMarginX * 2, Math.round(580 * scale))
      const maxTextW = cardW - cardPadX * 2

      // 头部尺寸（真实时间标签行 + 大时间+日期星期区域）
      const tagFontSize = Math.round(baseFontSize * 0.72)
      const tagH = Math.round(18 * scale)
      const tagGapY = Math.round(6 * scale)
      const timeAreaH = Math.round(52 * scale) // 大时间 + 日期星期的垂直高度
      const headerH = tagH + tagGapY + timeAreaH

      const cardH = cardPadY * 2 + headerH + items.length * lineH + Math.round(8 * scale)

      const cardX = cardMarginX
      const cardY = height - cardMarginBottom - cardH

      // 1. 背景处理：默认无大黑框（纯透明），仅当外部显式配置了有色背景时才画底板
      const hasBg = config.bgColor && config.bgColor !== 'transparent' && config.bgColor !== 'none'
      if (hasBg) {
        ctx.fillStyle = config.bgColor
        this._drawRoundRect(ctx, cardX, cardY, cardW, cardH, Math.round(12 * scale))
      }

      // 开启柔和暗色微阴影，确保纯透明纯白文字在任何亮色/复杂货架背景上都清晰立体、不刺眼
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
      ctx.shadowBlur = Math.round(4 * scale)
      ctx.shadowOffsetX = Math.round(1.2 * scale)
      ctx.shadowOffsetY = Math.round(1.2 * scale)

      const contentStartX = cardX + (hasBg ? cardPadX : 0)
      const headerTopY = cardY + (hasBg ? cardPadY : 0)

      // 2. 真实时间防伪标 —— 置于大时间正上方（方案 A）
      ctx.font = `bold ${tagFontSize}px sans-serif`
      const tagText = '真实时间'
      const tagTextW = ctx.measureText(tagText).width
      const tagPadW = Math.round(7 * scale)
      const tagW = Math.round(tagTextW + tagPadW * 2)
      const tagX = contentStartX
      const tagY = headerTopY

      ctx.fillStyle = '#FFA000'
      this._drawRoundRect(ctx, tagX, tagY, tagW, tagH, Math.round(3 * scale))

      ctx.fillStyle = '#FFFFFF'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(tagText, tagX + tagPadW, tagY + tagH / 2)

      // 恢复基线设置
      ctx.textBaseline = 'alphabetic'

      // 3. 黄色强调竖条与大时间
      const timeAreaY = tagY + tagH + tagGapY
      const barW = Math.max(3, Math.round(4.5 * scale))
      const barH = Math.round(36 * scale)
      const barX = contentStartX
      const barY = timeAreaY + Math.round(3 * scale)

      ctx.fillStyle = '#FFA000'
      ctx.fillRect(barX, barY, barW, barH)

      // 大时间 (如 12:48，右侧不再受防伪标挤压遮挡)
      const timeX = barX + barW + Math.round(10 * scale)
      ctx.fillStyle = '#FFFFFF'
      ctx.font = `bold ${timeFontSize}px sans-serif`
      ctx.fillText(dateTimeObj.timeStr, timeX, timeAreaY + Math.round(30 * scale))

      // 4. 时间下方日期与星期 (如 2026.10.30 星期五)
      ctx.font = `${subFontSize}px sans-serif`
      ctx.fillStyle = 'rgba(240, 245, 250, 0.95)'
      ctx.fillText(dateTimeObj.dateWeekStr, timeX, timeAreaY + Math.round(48 * scale))

      // 5. 分割线
      const divY = headerTopY + headerH
      const lineStartX = contentStartX
      const lineEndX = lineStartX + cardW - (hasBg ? cardPadX * 2 : 0)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'
      ctx.lineWidth = Math.max(1, Math.round(1 * scale))
      ctx.beginPath()
      ctx.moveTo(lineStartX, divY)
      ctx.lineTo(lineEndX, divY)
      ctx.stroke()

      // 6. 逐行绘制字段 (任务 / 门店 / 地点 / 记录人)
      let currY = divY + Math.round(18 * scale)
      const labelW = Math.round(70 * scale)
      const valMaxW = maxTextW - labelW

      items.forEach(item => {
        ctx.font = `${fieldFontSize}px sans-serif`
        ctx.fillStyle = 'rgba(225, 230, 240, 0.92)'
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
     * 按最大宽度把文本折成最多 maxLines 行，末行超出时补省略号
     */
    _wrapText(ctx, text, maxWidth, maxLines = 2) {
      if (!text || !maxWidth || maxLines <= 1) {
        return [this._truncateText(ctx, text, maxWidth)]
      }
      if (ctx.measureText(text).width <= maxWidth) {
        return [text]
      }
      const lines = []
      let rest = String(text)
      for (let i = 0; i < maxLines && rest.length > 0; i++) {
        if (i === maxLines - 1) {
          lines.push(this._truncateText(ctx, rest, maxWidth))
          break
        }
        let low = 1
        let high = rest.length
        let fit = 1
        while (low <= high) {
          const mid = Math.floor((low + high) / 2)
          if (ctx.measureText(rest.slice(0, mid)).width <= maxWidth) {
            fit = mid
            low = mid + 1
          } else {
            high = mid - 1
          }
        }
        lines.push(rest.slice(0, fit))
        rest = rest.slice(fit)
      }
      return lines
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
     * 格式化时间（含今日水印专用大时间、年月日与星期）
     */
    _formatDateTime(dateTimeStr) {
      let now = new Date()
      if (typeof dateTimeStr === 'string' && /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(dateTimeStr.trim())) {
        const parsed = new Date(dateTimeStr.trim().replace(/-/g, '/'))
        if (!Number.isNaN(parsed.getTime())) {
          now = parsed
        }
      }
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hour = String(now.getHours()).padStart(2, '0')
      const min = String(now.getMinutes()).padStart(2, '0')
      const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
      const shortWeekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      const dayIdx = now.getDay()

      return {
        timeStr: `${hour}:${min}`,
        dateWeekStr: `${year}.${month}.${day}  ${weekdays[dayIdx]}`,
        dateWeekShortStr: `${year}.${month}.${day} ${shortWeekdays[dayIdx]}`,
        fullStr: `${year}-${month}-${day} ${hour}:${min}`
      }
    }
  }
})

// 便于纯 Node 单元测试复用画布尺寸与分流逻辑（小程序运行时自动忽略）
if (typeof module !== 'undefined' && module.exports) {
  module.exports._layout = { computeCanvasPlan, MAX_CANVAS_DIM }
}
