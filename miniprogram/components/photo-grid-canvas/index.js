// components/photo-grid-canvas/index.js
// 把 1~6 张照片按原图比例完整拼接成一张网格大图（离屏 canvas，用法跟 watermark-canvas 一致）
//
// 关键原则：绝不使用 cover 裁剪，改用自适应格子比例 + contain 完整绘制，
// 防止横拍货架左右两侧排面或竖拍顶/底层被硬裁成正方形丢掉关键酒瓶。

// 固定的网格布局表：无论多少张照片（2~6张），固定每排 2 张合成
const GRID_LAYOUTS = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  3: { cols: 2, rows: 2 }, // 第 1 排 2 张，第 2 排 1 张
  4: { cols: 2, rows: 2 }, // 第 1 排 2 张，第 2 排 2 张
  5: { cols: 2, rows: 3 }, // 2 + 2 + 1
  6: { cols: 2, rows: 3 }  // 2 + 2 + 2
}

const CELL_LONG_EDGE = 1000 // 单格长边目标像素（按照片比例自适应宽/高，避免裁边）
const MAX_CANVAS_DIM = 3600 // 小程序 Canvas 单边安全上限，防止部分机型导出失败
const GAP = 8               // 格子之间的缝隙（px）
const MIN_CELL_RATIO = 0.56 // 9:16 竖图下限
const MAX_CELL_RATIO = 1.78 // 16:9 横图上限

/**
 * 根据待拼接图片的实际宽高计算零裁边网格尺寸
 * @param {Array<{width: number, height: number}>} images
 * @returns {{ cols: number, rows: number, cellWidth: number, cellHeight: number, width: number, height: number }}
 */
function computeGridLayout(images) {
  const count = Math.max(1, Array.isArray(images) ? images.length : 1)
  const layout = GRID_LAYOUTS[count] || { cols: 2, rows: Math.ceil(count / 2) }
  const { cols, rows } = layout

  // 取各张图宽高比的中位数作为格子比例，兼顾纯横拍、纯竖拍及混合拍摄
  const ratios = (images || [])
    .map(img => (img && img.width > 0 && img.height > 0 ? img.width / img.height : 1))
    .sort((a, b) => a - b)
  const mid = ratios.length > 0
    ? (ratios.length % 2 === 1
        ? ratios[(ratios.length - 1) / 2]
        : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2)
    : 1
  const cellRatio = Math.max(MIN_CELL_RATIO, Math.min(MAX_CELL_RATIO, mid))

  let cellWidth
  let cellHeight
  if (cellRatio >= 1) {
    cellWidth = CELL_LONG_EDGE
    cellHeight = Math.round(CELL_LONG_EDGE / cellRatio)
  } else {
    cellHeight = CELL_LONG_EDGE
    cellWidth = Math.round(CELL_LONG_EDGE * cellRatio)
  }

  let width = cols * cellWidth + (cols + 1) * GAP
  let height = rows * cellHeight + (rows + 1) * GAP

  // 防止总尺寸超过小程序 Canvas 安全上限
  const maxDim = Math.max(width, height)
  if (maxDim > MAX_CANVAS_DIM) {
    const shrink = (MAX_CANVAS_DIM - (Math.max(cols, rows) + 1) * GAP) / Math.max(cols * cellWidth, rows * cellHeight)
    cellWidth = Math.max(100, Math.floor(cellWidth * shrink))
    cellHeight = Math.max(100, Math.floor(cellHeight * shrink))
    width = cols * cellWidth + (cols + 1) * GAP
    height = rows * cellHeight + (rows + 1) * GAP
  }

  return {
    cols,
    rows,
    cellWidth,
    cellHeight,
    width,
    height,
    emptyCell: count < cols * rows
      ? {
          x: GAP + (cols - 1) * (cellWidth + GAP),
          y: GAP + (rows - 1) * (cellHeight + GAP),
          width: cellWidth,
          height: cellHeight
        }
      : null
  }
}

/**
 * 计算 contain 绘制矩形：完整保留 100% 画面，不裁切任何边缘，不拉伸变形
 */
function computeContainRect(imgWidth, imgHeight, x, y, w, h) {
  const safeW = imgWidth > 0 ? imgWidth : w
  const safeH = imgHeight > 0 ? imgHeight : h
  const scale = Math.min(w / safeW, h / safeH)
  const drawWidth = safeW * scale
  const drawHeight = safeH * scale
  const drawX = x + (w - drawWidth) / 2
  const drawY = y + (h - drawHeight) / 2
  return { drawX, drawY, drawWidth, drawHeight }
}

Component({
  properties: {
    // 待拼接的照片临时路径数组，1~6 张
    imagePaths: { type: Array, value: [] }
  },

  data: {
    composing: false
  },

  methods: {
    /**
     * 拼接照片（对外调用，仅返回临时文件路径）
     * @returns {Promise<string>} 拼好的临时文件路径
     */
    async compose() {
      const { tempPath } = await this.composeWithLayout()
      return tempPath
    },

    /**
     * 拼接照片并返回布局信息（含 3/5 张拼图时的右下角 emptyCell 坐标）
     * @returns {Promise<{ tempPath: string, layout: Object }>}
     */
    async composeWithLayout() {
      const imagePaths = this.properties.imagePaths
      if (!imagePaths || imagePaths.length === 0) {
        throw new Error('缺少图片')
      }

      this.setData({ composing: true })

      try {
        const query = this.createSelectorQuery()
        const canvasRes = await new Promise(resolve => {
          query.select('#photoGridCanvas')
            .fields({ node: true, size: true })
            .exec(res => resolve(res[0]))
        })

        if (!canvasRes || !canvasRes.node) {
          throw new Error('Canvas 节点获取失败')
        }

        const canvas = canvasRes.node
        const ctx = canvas.getContext('2d')

        // 并行加载所有原图
        const images = await Promise.all(
          imagePaths.map(path => this._loadImage(canvas, path))
        )

        const layout = computeGridLayout(images)
        const { cols, cellWidth, cellHeight, width, height } = layout

        canvas.width = width
        canvas.height = height

        // 缝隙及留白背景色
        ctx.fillStyle = '#111111'
        ctx.fillRect(0, 0, width, height)

        images.forEach((img, index) => {
          const col = index % cols
          const row = Math.floor(index / cols)
          const x = GAP + col * (cellWidth + GAP)
          const y = GAP + row * (cellHeight + GAP)
          this._drawContain(ctx, img, x, y, cellWidth, cellHeight)
        })

        // 等待一帧渲染缓冲后再导出，避免部分机型导出空白图
        await new Promise(resolve => {
          if (typeof canvas.requestAnimationFrame === 'function') {
            canvas.requestAnimationFrame(resolve)
          } else {
            setTimeout(resolve, 30)
          }
        })

        const tempPath = await new Promise((resolve, reject) => {
          wx.canvasToTempFilePath({
            canvas,
            fileType: 'jpg',
            quality: 0.92,
            success: res => resolve(res.tempFilePath),
            fail: reject
          })
        })

        this.setData({ composing: false })
        this.triggerEvent('compose', { tempPath, layout })
        return { tempPath, layout }

      } catch (err) {
        this.setData({ composing: false })
        console.error('拼图失败:', err)
        this.triggerEvent('error', { error: err })
        throw err
      }
    },

    _loadImage(canvas, path) {
      return new Promise((resolve, reject) => {
        const img = canvas.createImage()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = path
      })
    },

    // "contain" 方式绘制：完整保留原图 100% 画面，绝不裁切货架左右或上下边缘，不拉伸变形
    _drawContain(ctx, img, x, y, w, h) {
      const { drawX, drawY, drawWidth, drawHeight } = computeContainRect(img.width, img.height, x, y, w, h)

      ctx.save()
      ctx.fillStyle = '#000000'
      ctx.fillRect(x, y, w, h)
      ctx.beginPath()
      ctx.rect(x, y, w, h)
      ctx.clip()
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
      ctx.restore()
    }
  }
})

// 便于纯 Node 单元测试直接复用几何布局函数（小程序运行时自动忽略）
if (typeof module !== 'undefined' && module.exports) {
  module.exports._layout = { computeGridLayout, computeContainRect }
}
