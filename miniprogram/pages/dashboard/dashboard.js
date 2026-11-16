// pages/dashboard/dashboard.js
// 排面看板：只读 shelfStats 预计算快照；不下钻全库现算

const api = require('../../utils/api')
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
    storeTrend: null,

    // 拜访不足 N 次门店交互抽屉
    showLowVisitModal: false,
    lowVisitUserFilter: '',
    lowVisitKeyword: '',
    lowVisitUserGroups: [],
    lowVisitFiltered: []
  },

  onLoad() {
    this.syncManagerFlag()
    this.loadDashboard()
  },

  onShow() {
    this.syncManagerFlag()
    const selected = this._pendingSelectedCustomer || app.globalData.selectedCustomer
    if (selected) {
      this._pendingSelectedCustomer = null
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
      const res = await api.callFunction({
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
        isManager: result.isManager != null ? result.isManager : this.data.isManager,
        lowVisitUserFilter: '',
        lowVisitKeyword: ''
      })
      this.computeLowVisitView()
    } catch (err) {
      console.error('加载看板失败:', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  computeLowVisitView() {
    const overall = this.data.overall
    const rawList = (overall && Array.isArray(overall.lowVisitCustomers)) ? overall.lowVisitCustomers : []
    const threshold = (overall && overall.lowVisitThreshold) || this.data.defaultN || 2

    // 按业务员统计拜访不足门店数
    const countMap = new Map()
    rawList.forEach(c => {
      const uName = (c && c.userName && String(c.userName).trim()) || ''
      if (uName) {
        countMap.set(uName, (countMap.get(uName) || 0) + 1)
      }
    })
    const lowVisitUserGroups = Array.from(countMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))

    const uFilter = (this.data.lowVisitUserFilter || '').trim()
    const kw = (this.data.lowVisitKeyword || '').trim().toLowerCase()

    const lowVisitFiltered = rawList
      .filter(c => {
        if (!c) return false
        if (uFilter && (c.userName || '') !== uFilter) return false
        if (kw) {
          const sName = String(c.storeName || c.customerId || '').toLowerCase()
          const uName = String(c.userName || '').toLowerCase()
          if (!sName.includes(kw) && !uName.includes(kw)) return false
        }
        return true
      })
      .map(c => ({
        ...c,
        lackCount: Math.max(1, threshold - (Number(c.visitCount) || 0))
      }))

    this.setData({ lowVisitUserGroups, lowVisitFiltered })
  },

  onTapLowVisit() {
    const overall = this.data.overall
    if (!overall) return
    const list = overall.lowVisitCustomers || []
    if (!list.length) {
      wx.showToast({ title: '本月无拜访不足门店', icon: 'none' })
      return
    }
    this.computeLowVisitView()
    this.setData({ showLowVisitModal: true })
  },

  closeLowVisitModal() {
    this.setData({ showLowVisitModal: false })
  },

  onSelectLowVisitUser(e) {
    const name = e.currentTarget.dataset.name || ''
    const next = (name && this.data.lowVisitUserFilter === name) ? '' : name
    this.setData({ lowVisitUserFilter: next })
    this.computeLowVisitView()
  },

  onLowVisitKeywordInput(e) {
    this.setData({ lowVisitKeyword: e.detail.value || '' })
    this.computeLowVisitView()
  },

  onClearLowVisitKeyword() {
    this.setData({ lowVisitKeyword: '' })
    this.computeLowVisitView()
  },

  onInspectLowVisitTrend(e) {
    const cid = e.currentTarget.dataset.id || ''
    const sName = e.currentTarget.dataset.name || ''
    if (!cid) return
    this.setData({
      showLowVisitModal: false,
      customerId: cid,
      storeName: sName
    })
    this.loadStoreTrend()
  },

  onInspectLowVisitPhotos(e) {
    const cid = e.currentTarget.dataset.id || ''
    const sName = e.currentTarget.dataset.name || ''
    if (!cid) return
    wx.navigateTo({
      url: `/pages/photo-detail/photo-detail?customerId=${encodeURIComponent(cid)}&storeName=${encodeURIComponent(sName)}`
    })
  },

  copyLowVisitList() {
    const overall = this.data.overall
    const list = this.data.lowVisitFiltered || []
    if (!overall || !list.length) {
      wx.showToast({ title: '当前筛选下无门店', icon: 'none' })
      return
    }
    const threshold = overall.lowVisitThreshold || this.data.defaultN || 2
    const header = `⚠️【${this.data.yearMonth} 拜访不足 ${threshold} 次门店督办单】`
    const sub = this.data.lowVisitUserFilter
      ? `👤 业务员：${this.data.lowVisitUserFilter}（共 ${list.length} 家）`
      : `📊 共计 ${list.length} 家门店待补访`

    // 按业务员分组输出，方便直接发微信群@对应负责人
    const grouped = new Map()
    list.forEach(item => {
      const key = (item.userName && item.userName.trim()) || '未标注负责人'
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(item)
    })

    const lines = [header, sub, '']
    for (const [uName, items] of grouped.entries()) {
      if (grouped.size > 1 || uName !== '未标注负责人') {
        lines.push(`▸ ${uName}（${items.length}家）：`)
      }
      items.forEach((c, idx) => {
        const shareStr = c.avgSharePercent != null ? ` · 排面${c.avgSharePercent}%` : ''
        lines.push(`  ${idx + 1}. ${c.storeName || c.customerId}（已拜访${c.visitCount}次，差${c.lackCount || (threshold - c.visitCount)}次${shareStr}）`)
      })
    }

    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => {
        wx.showToast({ title: '督办名单已复制，可发微信群', icon: 'none', duration: 2500 })
      }
    })
  },

  onPickStore() {
    this._pendingSelectedCustomer = null
    wx.navigateTo({
      url: '/pages/customers/customers?mode=select',
      events: {
        selectCustomer: (selected) => {
          this._pendingSelectedCustomer = selected
        }
      }
    })
  },

  onClearStore() {
    this.setData({ customerId: '', storeName: '', storeTrend: null })
  },

  async loadStoreTrend() {
    if (!this.data.customerId) return
    try {
      const res = await api.callFunction({
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
      const res = await api.callFunction({
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
