// pages/dashboard/dashboard.js
// 排面看板：只读 shelfStats 预计算快照；不下钻全库现算

const app = getApp()

function currentYearMonth() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${m}`
}

Page({
  data: {
    isManager: false,
    yearMonth: currentYearMonth(),
    compareYearMonth: '',
    loading: false,
    rebuilding: false,
    empty: false,
    overall: null,
    mom: {},
    yoy: {},
    vsMonth: null,
    defaultN: 2,
    customerId: '',
    storeName: '',
    storeTrend: null
  },

  onLoad() {
    this.syncManagerFlag()
    this.loadDashboard()
  },

  onShow() {
    this.syncManagerFlag()
    const selected = app.globalData.selectedCustomer
    if (selected) {
      app.globalData.selectedCustomer = null
      if (selected.isNoStore) {
        this.setData({ customerId: '', storeName: '', storeTrend: null })
      } else if (selected._id) {
        this.setData({
          customerId: selected._id,
          storeName: selected.storeName || ''
        })
        this.loadStoreTrend()
      }
    }
  },

  onPullDownRefresh() {
    Promise.all([this.loadDashboard(), this.data.customerId ? this.loadStoreTrend() : Promise.resolve()])
      .finally(() => wx.stopPullDownRefresh())
  },

  syncManagerFlag() {
    const role = app.globalData.userInfo && app.globalData.userInfo.role
    const isManager = role === 'admin' || role === 'manager'
    if (isManager !== this.data.isManager) {
      this.setData({ isManager })
    }
  },

  onYearMonthChange(e) {
    // picker fields=month 返回 YYYY-MM
    const v = (e.detail && e.detail.value) || ''
    const ym = v.length >= 7 ? v.slice(0, 7) : v
    if (!ym) return
    this.setData({ yearMonth: ym })
    this.loadDashboard()
  },

  onCompareMonthChange(e) {
    const v = (e.detail && e.detail.value) || ''
    const ym = v.length >= 7 ? v.slice(0, 7) : v
    if (!ym || ym === this.data.yearMonth) {
      this.setData({ compareYearMonth: '', vsMonth: null })
      this.loadDashboard()
      return
    }
    this.setData({ compareYearMonth: ym })
    this.loadDashboard()
  },

  async loadDashboard() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'shelfStats',
        data: {
          action: 'dashboard',
          yearMonth: this.data.yearMonth,
          compareYearMonth: this.data.compareYearMonth || undefined
        }
      })
      const result = res.result || {}
      if (!result.success) {
        wx.showToast({ title: result.error || '加载失败', icon: 'none' })
        this.setData({ empty: true, overall: null })
        return
      }
      const overall = result.overall
      this.setData({
        empty: !!result.empty,
        overall,
        mom: result.mom || {},
        yoy: result.yoy || {},
        vsMonth: result.vsMonth || null,
        defaultN: (overall && overall.lowVisitThreshold) || 2,
        isManager: result.isManager != null ? result.isManager : this.data.isManager
      })
    } catch (err) {
      console.error('加载看板失败:', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onTapLowVisit() {
    const overall = this.data.overall
    if (!overall) return
    const list = overall.lowVisitCustomers || []
    if (!list.length) {
      wx.showToast({ title: '本月无拜访不足门店', icon: 'none' })
      return
    }
    const lines = list.slice(0, 15).map((c, i) =>
      `${i + 1}. ${c.storeName || c.customerId}（${c.visitCount}次）`
    )
    const more = list.length > 15 ? `\n…共 ${list.length} 家` : ''
    wx.showModal({
      title: `拜访不足 ${overall.lowVisitThreshold} 次`,
      content: lines.join('\n') + more,
      showCancel: false
    })
  },

  onPickStore() {
    wx.navigateTo({ url: '/pages/customers/customers?mode=select' })
  },

  onClearStore() {
    this.setData({ customerId: '', storeName: '', storeTrend: null })
  },

  async loadStoreTrend() {
    if (!this.data.customerId) return
    try {
      const res = await wx.cloud.callFunction({
        name: 'shelfStats',
        data: {
          action: 'storeTrend',
          customerId: this.data.customerId,
          months: 12
        }
      })
      const result = res.result || {}
      if (!result.success) {
        wx.showToast({ title: result.error || '单店加载失败', icon: 'none' })
        return
      }
      this.setData({
        storeTrend: result,
        storeName: result.storeName || this.data.storeName
      })
    } catch (err) {
      console.error('加载单店趋势失败:', err)
      wx.showToast({ title: '单店加载失败', icon: 'none' })
    }
  },

  goPhotoDetail() {
    wx.navigateTo({ url: '/pages/photo-detail/photo-detail' })
  },

  async onRebuild() {
    if (!this.data.isManager || this.data.rebuilding) return
    this.setData({ rebuilding: true })
    wx.showLoading({ title: '重建中…', mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'shelfStats',
        data: { action: 'rebuild' }
      })
      const result = res.result || {}
      wx.hideLoading()
      if (!result.success) {
        wx.showToast({ title: result.error || '重建失败', icon: 'none' })
        return
      }
      const tip = result.timedOut
        ? `已部分重建（超时续跑），店月 ${result.storeDocs} 条`
        : `重建完成：店月 ${result.storeDocs} · 整体 ${result.overallDocs}`
      wx.showToast({ title: tip, icon: 'none', duration: 2500 })
      await this.loadDashboard()
      if (this.data.customerId) await this.loadStoreTrend()
    } catch (err) {
      wx.hideLoading()
      console.error('重建失败:', err)
      wx.showToast({ title: '重建失败', icon: 'none' })
    } finally {
      this.setData({ rebuilding: false })
    }
  }
})
