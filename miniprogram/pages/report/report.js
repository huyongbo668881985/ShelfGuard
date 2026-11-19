// pages/report/report.js
// 巡检报告详情页

const api = require('../../utils/api')
const { formatDate } = require('../../utils/date')
const { saveImagesToAlbum } = require('../../utils/album')

const V2_DIMENSIONS = [
  { key: 'facingCount', name: '排面数量', defaultMax: 50 },
  { key: 'goldenPosition', name: '黄金位置', defaultMax: 20 },
  { key: 'labelOrientation', name: '正标朝向', defaultMax: 10 },
  { key: 'priceTag', name: '价签规范', defaultMax: 10 },
  { key: 'horizontalBanner', name: '横签露出', defaultMax: 10 }
]

const LEGACY_DIMENSIONS = [
  { key: 'labelOrientation', name: '正标朝向', defaultMax: 100 },
  { key: 'neatness', name: '整齐度', defaultMax: 100 },
  { key: 'goldenPosition', name: '黄金位置', defaultMax: 100 },
  { key: 'brandConcentration', name: '集中陈列', defaultMax: 100 },
  { key: 'priceTagMatch', name: '价签对应', defaultMax: 100 },
  { key: 'shelfFullness', name: '货架饱满度', defaultMax: 100 }
]

function ratioColor(ratio) {
  if (ratio >= 0.8) return '#2e7d32'
  if (ratio >= 0.5) return '#ff9800'
  return '#f44336'
}

function statusColor(status, ratio) {
  if (status === 'good') return '#2e7d32'
  if (status === 'medium') return '#ff9800'
  if (status === 'poor') return '#f44336'
  return ratioColor(ratio)
}

function buildReportViewModel(aiReport) {
  if (!aiReport || typeof aiReport !== 'object') {
    return {
      scoreState: 'none',
      isV2: false,
      complianceList: [],
      facingSummary: null,
      qualityNotices: []
    }
  }

  const hasScore = typeof aiReport.score === 'number' && !isNaN(aiReport.score)
  let scoreState = 'scored'
  if (!hasScore) {
    if (aiReport.hasShelfPhoto === false || aiReport.scoreLevel === '无货架照') {
      scoreState = 'no_shelf'
    } else if (aiReport.ownBrandPresent === false || aiReport.scoreLevel === '未上柜') {
      scoreState = 'out_of_stock'
    } else {
      scoreState = 'other'
    }
  }

  const dc = aiReport.displayCompliance && typeof aiReport.displayCompliance === 'object'
    ? aiReport.displayCompliance
    : {}
  const isV2 = aiReport.scoringVersion === 'v2' ||
    Boolean(dc.facingCount || dc.horizontalBanner || dc.priceTag)

  const schema = isV2 ? V2_DIMENSIONS : LEGACY_DIMENSIONS
  const complianceList = []
  schema.forEach(dim => {
    const entry = dc[dim.key]
    if (!entry || typeof entry.score !== 'number') return
    const maxScore = (typeof entry.maxScore === 'number' && entry.maxScore > 0)
      ? entry.maxScore
      : dim.defaultMax
    const pct = Math.max(0, Math.min(100, Math.round((entry.score / maxScore) * 100)))
    complianceList.push({
      key: dim.key,
      name: dim.name,
      score: entry.score,
      maxScore,
      scoreText: isV2 ? `${entry.score}/${maxScore}分` : `${entry.score}分`,
      percent: pct,
      color: statusColor(entry.status, entry.score / maxScore),
      detail: entry.detail || ''
    })
  })

  // 独立核心指标：陈列排面
  let facingSummary = null
  const fm = aiReport.facingMetrics && typeof aiReport.facingMetrics === 'object'
    ? aiReport.facingMetrics
    : null
  if (fm && (fm.ownFacingCount !== null && fm.ownFacingCount !== undefined)) {
    const conf = typeof fm.countingConfidence === 'number' ? fm.countingConfidence : null
    let confidenceLabel = ''
    let confidenceLevel = 'high'
    if (conf !== null) {
      if (conf >= 0.8) {
        confidenceLabel = '高置信'
        confidenceLevel = 'high'
      } else if (conf >= 0.6) {
        confidenceLabel = '中置信'
        confidenceLevel = 'mid'
      } else {
        confidenceLabel = '低置信(建议核对)'
        confidenceLevel = 'low'
      }
    }
    facingSummary = {
      ownFacingCount: fm.ownFacingCount,
      ownSkuCount: fm.ownSkuCount != null ? fm.ownSkuCount : '--',
      ownFacingShare: fm.ownFacingShare != null ? `${fm.ownFacingShare}%` : '--',
      confidenceLabel,
      confidenceLevel
    }
  }

  // 照片质量、局部取景控制与复核提示（不阻断）
  const qualityNotices = []
  const meta = aiReport.metadata && typeof aiReport.metadata === 'object' ? aiReport.metadata : {}
  if (Array.isArray(meta.reviewReasons) && meta.reviewReasons.length > 0) {
    meta.reviewReasons.forEach(r => {
      const text = String(r || '').trim()
      if (text && !qualityNotices.includes(text)) qualityNotices.push(text)
    })
  } else {
    if (meta.imageQuality === 'poor') {
      const reason = meta.imageQualityReason ? `（${meta.imageQualityReason}）` : ''
      qualityNotices.push(`照片偏模糊/反光${reason}，可能影响排面计数与价签识别，可清晰重拍或重新分析。`)
    }
    if (meta.framingType === 'closeup') {
      qualityNotices.push('当前仅拍到货架局部特写，黄金位得分已防虚高封顶且排面占比不计入统计，建议下次补充货架全景照。')
    }
  }

  return {
    scoreState,
    isV2,
    complianceList,
    facingSummary,
    qualityNotices
  }
}

Page({
  data: {
    inspectionId: '',
    detail: null,
    reportView: {
      scoreState: 'none',
      isV2: false,
      complianceList: [],
      facingSummary: null,
      qualityNotices: []
    },
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
    if (this._needReloadOnShow && this.data.inspectionId) {
      this._needReloadOnShow = false
      this.loadDetail(this.data.inspectionId)
      return
    }
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

  // 底部操作栏：首页和历史都在 tabBar 里，必须用 switchTab 而不是 navigateTo
  goToHistory() {
    wx.switchTab({ url: '/pages/history/history' })
  },

  // 再拍一张：回首页并直接进入「选门店 → 拍照」流程
  goToCamera() {
    getApp().globalData.startNextVisit = true
    wx.switchTab({ url: '/pages/home/home' })
  },

  // 加载巡检详情
  async loadDetail(id) {
    if (this.data.refreshTimer) {
      clearInterval(this.data.refreshTimer)
      this.setData({ refreshTimer: null })
    }
    this.setData({ loading: true })

    try {
      const res = await api.callFunction({
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

      const reportView = buildReportViewModel(detail.aiReport)
      this.setData({ detail, reportView, loading: false, currentPhotoIndex: 0 })

      // 最佳努力获取集中分析时间，用于"排队中"提示（失败不影响主流程）
      this.refreshAnalyzeTime()

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
  // waitForNewerThan：对已有报告点击「重新分析」时传入旧的 analyzedAt，
  // 防止第一次轮询读到旧 aiReport 就误判已完成而提前退出。
  startPolling(id, { waitForNewerThan = '' } = {}) {
    if (this.data.refreshTimer) {
      clearInterval(this.data.refreshTimer)
    }
    let attempts = 0
    const maxAttempts = 45 // 最多轮询 45 次（约 135 秒，匹配服务端 120 秒有界思考超时）

    const timer = setInterval(async () => {
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(timer)
        if (this.data.refreshTimer === timer) this.setData({ refreshTimer: null })
        return
      }

      try {
        const res = await api.callFunction({
          name: 'getReport',
          data: { inspectionId: id }
        })
        if (!res.result || !res.result.success) return
        const detail = res.result.detail

        const isNewResult = !waitForNewerThan || (detail.analyzedAt && detail.analyzedAt !== waitForNewerThan)
        if (isNewResult && (detail.status === 'analyzed' || detail.aiReport)) {
          clearInterval(timer)
          if (this.data.refreshTimer === timer) this.setData({ refreshTimer: null })
          // 重新加载完整详情
          this.loadDetail(id)
        } else if (isNewResult && detail.status === 'analyze_failed') {
          // 熔断：云端已确定分析失败，立即中止轮询，避免持续空转 90 秒
          clearInterval(timer)
          if (this.data.refreshTimer === timer) this.setData({ refreshTimer: null })
          this.setData({ detail })
        }
      } catch (err) {
        console.error('轮询失败:', err)
      }
    }, 3000)

    this.setData({ refreshTimer: timer })
  },

  // 真正的重试 AI 分析（不再只是空刷页面；同时兼容对已有报告点击「重新分析」）
  async retryAnalysis() {
    const { detail, inspectionId } = this.data
    if (!detail) return

    let forceDiscardCorrection = false
    if (detail.reviewStatus === 'corrected' && detail.isAdminViewer) {
      const confirmRes = await new Promise(resolve => {
        wx.showModal({
          title: '该报告已人工校正',
          content: '重新进行 AI 分析将覆盖管理员人工校正的结果，确定继续吗？',
          confirmText: '放弃校正',
          confirmColor: '#d32f2f',
          success: resolve
        })
      })
      if (!confirmRes || !confirmRes.confirm) return
      forceDiscardCorrection = true
    }

    const prevAnalyzedAt = detail.analyzedAt || ''
    wx.showLoading({ title: '正在重新分析...', mask: true })
    try {
      this.setData({
        'detail.status': 'analyzing',
        'detail.analyzeError': ''
      })
      // 先启动带版本号守卫的轮询兜底（应对网络超时但服务端仍在跑的场景）
      this.startPolling(inspectionId, { waitForNewerThan: prevAnalyzedAt })
      wx.hideLoading()
      wx.showToast({ title: '已开始重新分析，请稍候', icon: 'none' })

      // 触发 analyzeImage 云函数，完成后立即停止轮询并刷新最新报告
      const res = await api.callFunction({
        name: 'analyzeImage',
        data: {
          inspectionId,
          fileIDs: detail.photoFileIDs || [],
          forceDiscardCorrection
        }
      })
      if (this.data.refreshTimer) {
        clearInterval(this.data.refreshTimer)
        this.setData({ refreshTimer: null })
      }
      if (res && res.result && !res.result.success) {
        wx.showToast({ title: res.result.error || '重新分析失败', icon: 'none' })
      }
      this.loadDetail(inspectionId)
    } catch (err) {
      wx.hideLoading()
      console.error('后台分析请求异常（轮询将继续兜底）:', err)
    }
  },

  // 管理员：进入人工校正页
  goToReview() {
    const id = this.data.inspectionId
    if (!id) return
    this._needReloadOnShow = true
    wx.navigateTo({
      url: `/pages/review/review?id=${id}`
    })
  },

  // 管理员：一键确认当前报告识别无误
  async confirmReportAccurate() {
    const { inspectionId, detail } = this.data
    if (!inspectionId || !detail) return
    wx.showLoading({ title: '提交确认...', mask: true })
    try {
      const res = await api.callFunction({
        name: 'reviewReport',
        data: {
          action: 'confirm',
          inspectionId,
          expectedRevision: detail.reviewRevision || 0
        }
      })
      wx.hideLoading()
      if (res.result && res.result.success) {
        getApp().globalData.listVersion = ((getApp().globalData.listVersion) || 0) + 1
        wx.showToast({ title: '已标记为确认无误', icon: 'success' })
        this.loadDetail(inspectionId)
      } else {
        wx.showToast({ title: (res.result && res.result.error) || '操作失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
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

    wx.showLoading({ title: '准备图片中...' })
    try {
      const localPath = await this.downloadImageToLocal(url)
      wx.hideLoading()
      await saveImagesToAlbum([localPath])
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
    wx.showLoading({ title: '准备照片中...', mask: true })
    const localPaths = []
    for (let i = 0; i < urls.length; i++) {
      try {
        localPaths.push(await this.downloadImageToLocal(urls[i]))
      } catch (_) {}
    }
    wx.hideLoading()
    if (localPaths.length === 0) {
      wx.showToast({ title: '下载照片失败', icon: 'none' })
      return
    }
    await saveImagesToAlbum(localPaths)
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
      const res = await api.callFunction({ name: 'settings', data: { action: 'get' } })
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
      title: `拜访报告 - ${detail.taskName || '白酒终端拜访'}`,
      path: `/pages/report/report?id=${this.data.inspectionId}`
    }
  }
})
