// components/photo-grid-canvas/index.js
// 把 1~6 张照片拼接成一张网格大图（离屏 canvas，用法跟 watermark-canvas 一致）
//
// 取舍说明：拼成一张图之后，每张原图在最终图里只占一个格子，分辨率会被压缩，
// 如果货架上文字/价签比较密集，AI 识别精度可能会比"多张原图各自全分辨率
// 分析"要差一些。如果实测发现精度不够用，不需要重新开发——analyzeImage
// 云函数本来就支持一次传多张原图、AI 自动合并成一份报告，把这一步"拼图"
// 跳过、直接把 photos 数组原样传给上传流程即可切换回那条路径。

// 固定的网格布局表：n 张图对应几列几行。用固定表而不是自动算 sqrt，
// 是为了让常见的 1~6 张场景拼出来的比例更好看（比如3张用一行三列，
// 而不是2x2里空一格）。
const GRID_LAYOUTS = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  3: { cols: 3, rows: 1 },
  4: { cols: 2, rows: 2 },
  5: { cols: 3, rows: 2 },
  6: { cols: 3, rows: 2 }
}

const CELL_SIZE = 900 // 每个格子的边长（px），固定方形格子，跟原图比例无关
const GAP = 6         // 格子之间的缝隙（px）

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
     * 拼接照片（对外调用）
     * @returns {Promise<string>} 拼好的临时文件路径
     */
    async compose() {
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

        const layout = GRID_LAYOUTS[images.length] || GRID_LAYOUTS[6]
        const { cols, rows } = layout

        const width = cols * CELL_SIZE + (cols + 1) * GAP
        const height = rows * CELL_SIZE + (rows + 1) * GAP

        canvas.width = width
        canvas.height = height

        // 缝隙背景色
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, width, height)

        images.forEach((img, index) => {
          const col = index % cols
          const row = Math.floor(index / cols)
          const x = GAP + col * (CELL_SIZE + GAP)
          const y = GAP + row * (CELL_SIZE + GAP)
          this._drawCover(ctx, img, x, y, CELL_SIZE, CELL_SIZE)
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
        this.triggerEvent('compose', { tempPath })
        return tempPath

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

    // "cover" 方式绘制：铺满目标格子，超出部分居中裁剪，不拉伸变形
    // （跟 CSS 的 object-fit: cover 是一个道理）
    _drawCover(ctx, img, x, y, w, h) {
      const scale = Math.max(w / img.width, h / img.height)
      const drawWidth = img.width * scale
      const drawHeight = img.height * scale
      const drawX = x + (w - drawWidth) / 2
      const drawY = y + (h - drawHeight) / 2

      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, w, h)
      ctx.clip()
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
      ctx.restore()
    }
  }
})
