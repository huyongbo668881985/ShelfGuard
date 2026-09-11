// pages/report/report.js
// 巡检报告详情页

const { formatDate } = require('../../utils/date')

Page({
  data: {
    inspectionId: '',
    detail: null,
    loading: true,
    refreshTimer: null,
    analyzeTime: '21:00'   // 集中分析时间，用于"排队中"提示，report 页加载时拉取
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ inspectionId: options.id })
      this.loadDetail(options.id)
    }
  },

  onUnload() {
    // 清除轮询定时器
    if (this.data.refreshTimer) {
      clearInterval(this.data.refreshTimer)
    }
  },

  // 底部操作栏：这两个页面都在 tabBar 里，必须用 switchTab 而不是 navigateTo
  goToHistory() {
    wx.switchTab({ url: '/pages/history/history' })
  },

  goToCamera() {
    wx.switchTab({ url: '/pages/camera/camera' })
  },

  // 加载巡检详情
  async loadDetail(id) {
    if (this.data.refreshTimer) {
      clearInterval(this.data.refreshTimer)
      this.setData({ refreshTimer: null })
    }
    this.setData({ loading: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getReport',
        data: { inspectionId: id }
      })
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.error) || '加载失败')
      }
      const detail = res.result.detail

      // 格式化日期
      if (detail.createdAt) {
        detail.createdAtFormatted = formatDate(detail.createdAt, 'YYYY-MM-DD HH:mm')
      }
      if (detail.analyzedAt) {
        detail.analyzedAtFormatted = formatDate(detail.analyzedAt, 'YYYY-MM-DD HH:mm')
      }

      // 照片临时链接由 getReport 云函数在服务端统一获取（photoURLs 字段）。
      // 收紧云存储权限后，前端直连 wx.cloud.getTempFileURL 只能读本人文件，
      // 管理者查看他人巡检记录的照片会被存储安全规则拦截，所以这里不再自己取。

      this.setData({ detail, loading: false })

      // 最佳努力获取集中分析时间，用于"排队中"提示（失败不影响主流程）
      this.refreshAnalyzeTime()

      // 还没出报告且处于实时分析状态（即时模式的 analyzing / 旧字段 uploaded）才轮询，
      // pending（集中模式排队中）不轮询——它只会在设定时间被定时任务处理，
      // 轮询也只是空转；用户可下拉刷新查看。
      const realtimeAnalyzing = detail.status === 'analyzing' || detail.status === 'uploaded'
      if (!detail.aiReport && realtimeAnalyzing) {
        this.startPolling(id)
      }

    } catch (err) {
      console.error('加载详情失败:', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 轮询检查分析状态
  startPolling(id) {
    if (this.data.refreshTimer) {
      clearInterval(this.data.refreshTimer)
    }
    let attempts = 0
    const maxAttempts = 30 // 最多轮询 30 次（约 1 分钟）

    const timer = setInterval(async () => {
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(timer)
        if (this.data.refreshTimer === timer) this.setData({ refreshTimer: null })
        wx.showToast({ title: '分析耗时较长，请稍后下拉刷新查看', icon: 'none', duration: 3000 })
        return
      }

      try {
        const res = await wx.cloud.callFunction({
          name: 'getReport',
          data: { inspectionId: id }
        })
        if (!res.result || !res.result.success) return
        const detail = res.result.detail

        if (detail.status === 'analyzed' || detail.aiReport) {
          clearInterval(timer)
          if (this.data.refreshTimer === timer) this.setData({ refreshTimer: null })
          // 重新加载完整详情
          this.loadDetail(id)
        }
      } catch (err) {
        console.error('轮询失败:', err)
      }
    }, 3000)

    this.setData({ refreshTimer: timer })
  },

  // 拉取集中分析时间（用于报告页"排队中"提示）
  async refreshAnalyzeTime() {
    try {
      const res = await wx.cloud.callFunction({ name: 'settings', data: { action: 'get' } })
      if (res.result && res.result.success && res.result.settings && res.result.settings.analyzeTime) {
        this.setData({ analyzeTime: res.result.settings.analyzeTime })
      }
    } catch (err) {
      // 不影响主流程
    }
  },

  // 预览图片
  previewImage(e) {
    const url = e.currentTarget.dataset.url
    wx.previewImage({
      current: url,
      urls: this.data.detail.photoURLs
    })
  },

  // 手动刷新
  refresh() {
    this.loadDetail(this.data.inspectionId)
  },

  // 分享报告
  onShareAppMessage() {
    const { detail } = this.data
    return {
      title: `巡检报告 - ${detail.taskName || '白酒终端巡检'}`,
      path: `/pages/report/report?id=${this.data.inspectionId}`
    }
  }
})
