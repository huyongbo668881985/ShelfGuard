// pages/report/report.js
// 巡检报告详情页

const { formatDate } = require('../../utils/date')

Page({
  data: {
    inspectionId: '',
    detail: null,
    loading: true,
    refreshTimer: null,
    analyzeTime: '21:00',
    currentPhotoIndex: 0,
    _shouldResumePolling: false
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ inspectionId: options.id })
      this.loadDetail(options.id)
    }
  },

  onUnload() {
    if (this.data.refreshTimer) {
      clearInterval(this.data.refreshTimer)
      this.setData({ refreshTimer: null })
    }
  },

  onHide() {
    if (this.data.refreshTimer) {
      clearInterval(this.data.refreshTimer)
      this.setData({ refreshTimer: null, _shouldResumePolling: true })
    }
  },

  onShow() {
    if (!this.data._shouldResumePolling) return
    const detail = this.data.detail
    const id = this.data.inspectionId
    if (!detail || !id) return
    const realtimeAnalyzing = detail.status === 'analyzing' || detail.status === 'uploaded'
    if (!detail.aiReport && realtimeAnalyzing) {
      this.setData({ _shouldResumePolling: false })
      this.startPolling(id)
    } else {
      this.setData({ _shouldResumePolling: false })
    }
  },

  onPullDownRefresh() {
    const id = this.data.inspectionId
    if (!id) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadDetail(id).finally(() => wx.stopPullDownRefresh())
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

      this.setData({ detail, loading: false, currentPhotoIndex: 0 })

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
        } else if (detail.status === 'analyze_failed') {
          // 熔断：云端已确定分析失败，立即中止轮询，避免持续空转 90 秒
          clearInterval(timer)
          if (this.data.refreshTimer === timer) this.setData({ refreshTimer: null })
          this.setData({ detail })
          wx.showToast({ title: 'AI 分析未成功，可点击重试', icon: 'none' })
        }
      } catch (err) {
        console.error('轮询失败:', err)
      }
    }, 3000)

    this.setData({ refreshTimer: timer })
  },

  // 真正的重试 AI 分析（不再只是空刷页面）
  async retryAnalysis() {
    const { detail, inspectionId } = this.data
    if (!detail) return

    wx.showLoading({ title: '正在重新触发...', mask: true })
    try {
      this.setData({
        'detail.status': 'analyzing',
        'detail.analyzeError': ''
      })
      // 触发 analyzeImage 云函数
      wx.cloud.callFunction({
        name: 'analyzeImage',
        data: {
          inspectionId,
          fileIDs: detail.photoFileIDs || []
        }
      }).catch(err => console.error('后台分析请求:', err))

      wx.hideLoading()
      wx.showToast({ title: '已开始重新分析', icon: 'none' })
      this.startPolling(inspectionId)
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '重试失败', icon: 'none' })
    }
  },

  onPhotoSwiperChange(e) {
    const idx = (e.detail && e.detail.current) || 0
    this.setData({ currentPhotoIndex: idx })
  },

  currentPhotoUrl() {
    const urls = (this.data.detail && this.data.detail.photoURLs) || []
    const idx = this.data.currentPhotoIndex || 0
    return urls[idx] || urls[0] || ''
  },

  // 分享单张照片到微信（原生菜单：发送给朋友/收藏/保存）
  async sharePhoto(e) {
    const url = e.currentTarget.dataset.url || this.currentPhotoUrl()
    if (!url) {
      wx.showToast({ title: '未找到照片', icon: 'none' })
      return
    }

    wx.showLoading({ title: '准备图片中...' })
    try {
      // 微信 showShareImageMenu 需要本地文件路径
      const localPath = await this.downloadImageToLocal(url)
      wx.hideLoading()

      if (typeof wx.showShareImageMenu === 'function') {
        wx.showShareImageMenu({
          path: localPath,
          fail: (err) => {
            if (err && err.errMsg && !err.errMsg.includes('cancel')) {
              // 降级为大图预览长按保存/转发
              wx.previewImage({ current: url, urls: this.data.detail.photoURLs || [url] })
            }
          }
        })
      } else {
        // 低版本基础库降级预览长按发微信
        wx.previewImage({ current: url, urls: this.data.detail.photoURLs || [url] })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('准备分享图片失败:', err)
      wx.showToast({ title: '图片加载失败', icon: 'none' })
    }
  },

  // 保存照片到系统相册
  async savePhoto(e) {
    const url = e.currentTarget.dataset.url || this.currentPhotoUrl()
    if (!url) return

    wx.showLoading({ title: '正在保存...' })
    try {
      const localPath = await this.downloadImageToLocal(url)
      wx.saveImageToPhotosAlbum({
        filePath: localPath,
        success: () => {
          wx.hideLoading()
          wx.showToast({ title: '已存入系统相册', icon: 'success' })
        },
        fail: (err) => {
          wx.hideLoading()
          if (err && err.errMsg && err.errMsg.includes('auth deny')) {
            wx.showModal({
              title: '需要相册权限',
              content: '请在设置中开启相册权限，用于保存巡检照片',
              confirmText: '去设置',
              success: (r) => { if (r.confirm) wx.openSetting() }
            })
          } else {
            wx.showToast({ title: '保存失败', icon: 'none' })
          }
        }
      })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '下载照片失败', icon: 'none' })
    }
  },

  // 多图：逐张存入相册
  async saveAllPhotos() {
    const urls = (this.data.detail && this.data.detail.photoURLs) || []
    if (urls.length === 0) {
      wx.showToast({ title: '没有可保存的照片', icon: 'none' })
      return
    }
    wx.showLoading({ title: `保存中 0/${urls.length}`, mask: true })
    let ok = 0
    let denied = false
    for (let i = 0; i < urls.length; i++) {
      wx.showLoading({ title: `保存中 ${i + 1}/${urls.length}`, mask: true })
      try {
        const localPath = await this.downloadImageToLocal(urls[i])
        await new Promise((resolve, reject) => {
          wx.saveImageToPhotosAlbum({
            filePath: localPath,
            success: resolve,
            fail: reject
          })
        })
        ok++
      } catch (err) {
        if (err && err.errMsg && String(err.errMsg).includes('auth deny')) {
          denied = true
          break
        }
      }
    }
    wx.hideLoading()
    if (denied) {
      wx.showModal({
        title: '需要相册权限',
        content: '请在设置中开启相册权限，用于保存巡检照片',
        confirmText: '去设置',
        success: (r) => { if (r.confirm) wx.openSetting() }
      })
      return
    }
    wx.showToast({
      title: ok === urls.length ? `已全部存入（${ok}张）` : `已保存 ${ok}/${urls.length} 张`,
      icon: ok === urls.length ? 'success' : 'none'
    })
  },

    // 工具：下载网络图片为本地临时文件
  downloadImageToLocal(url) {
    return new Promise((resolve, reject) => {
      if (url.startsWith('wxfile://') || url.startsWith('http://tmp') || url.startsWith('/tmp/')) {
        return resolve(url)
      }
      wx.downloadFile({
        url,
        success: (res) => {
          if (res.statusCode === 200) resolve(res.tempFilePath)
          else reject(new Error('下载失败'))
        },
        fail: reject
      })
    })
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
  onSelectPhoto(e) {
    const idx = e.currentTarget.dataset.index
    if (idx !== undefined && idx !== null) {
      this.setData({ currentPhotoIndex: Number(idx) || 0 })
    }
    this.previewImage(e)
  },

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
