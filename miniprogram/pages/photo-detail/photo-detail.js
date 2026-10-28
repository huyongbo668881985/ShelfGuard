// pages/photo-detail/photo-detail.js
// 照片明细：复用 getHistory 列表，按业务员/客户/时间筛选

const { formatDate, timeAgo } = require('../../utils/date')
const { formatScoreLevel } = require('../../utils/format')
const app = getApp()

function daysAgoISO(days) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

function dateToStartISO(yyyyMmDd) {
  if (!yyyyMmDd) return ''
  const d = new Date(`${yyyyMmDd}T00:00:00`)
  return isNaN(d.getTime()) ? '' : d.toISOString()
}

function dateToEndISO(yyyyMmDd) {
  if (!yyyyMmDd) return ''
  const d = new Date(`${yyyyMmDd}T23:59:59.999`)
  return isNaN(d.getTime()) ? '' : d.toISOString()
}

function todayStr() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function daysAgoStr(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

Page({
  data: {
    isManager: false,
    filterUserName: '',
    filterCustomerId: '',
    filterStoreName: '',
    startDate: daysAgoStr(30),
    endDate: todayStr(),
    list: [],
    page: 1,
    pageSize: 20,
    total: 0,
    loading: false,
    hasMore: true
  },

  onLoad(options) {
    this.syncManagerFlag()
    if (options && options.customerId) {
      this.setData({
        filterCustomerId: decodeURIComponent(options.customerId),
        filterStoreName: options.storeName ? decodeURIComponent(options.storeName) : ''
      })
    }
    this.refreshList()
  },

  onShow() {
    this.syncManagerFlag()
    const selected = app.globalData.selectedCustomer
    if (selected) {
      app.globalData.selectedCustomer = null
      if (selected.isNoStore) {
        this.setData({ filterCustomerId: '', filterStoreName: '' })
      } else if (selected._id) {
        this.setData({
          filterCustomerId: selected._id,
          filterStoreName: selected.storeName || ''
        })
      }
      this.refreshList()
    }
  },

  onPullDownRefresh() {
    this.refreshList().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadList()
    }
  },

  syncManagerFlag() {
    const role = app.globalData.userInfo && app.globalData.userInfo.role
    const isManager = role === 'admin' || role === 'manager'
    if (isManager !== this.data.isManager) {
      this.setData({ isManager })
    }
  },

  onUserNameInput(e) {
    this.setData({ filterUserName: e.detail.value })
  },

  onPickCustomer() {
    wx.navigateTo({ url: '/pages/customers/customers?mode=select' })
  },

  onClearCustomer() {
    this.setData({ filterCustomerId: '', filterStoreName: '' })
  },

  onStartDateChange(e) {
    this.setData({ startDate: e.detail.value })
  },

  onEndDateChange(e) {
    this.setData({ endDate: e.detail.value })
  },

  onResetFilters() {
    this.setData({
      filterUserName: '',
      filterCustomerId: '',
      filterStoreName: '',
      startDate: daysAgoStr(30),
      endDate: todayStr()
    })
    this.refreshList()
  },

  onApplyFilters() {
    this.refreshList()
  },

  async refreshList() {
    this.setData({ page: 1, list: [], hasMore: true })
    await this.loadList()
  },

  buildWhere() {
    const where = {}
    if (this.data.startDate) {
      where.startDateISO = dateToStartISO(this.data.startDate)
    } else {
      // 无开始日时仍给默认窗口，避免扫全库
      where.startDateISO = daysAgoISO(90)
    }
    if (this.data.endDate) {
      where.endDateISO = dateToEndISO(this.data.endDate)
    }
    if (this.data.filterCustomerId) {
      where.customerId = this.data.filterCustomerId
    }
    return where
  },

  formatItem(item) {
    if (item.createdAt) {
      item.displayDate = timeAgo(item.createdAt)
      item.fullDate = formatDate(item.createdAt, 'MM-DD HH:mm')
    }
    if (item.photoFileIDs && item.photoFileIDs.length > 0) {
      item.thumbnailFileID = item.photoFileIDs[0]
    }
    if (item.aiReport && typeof item.aiReport.score === 'number') {
      const scoreInfo = formatScoreLevel(item.aiReport.score)
      item.scoreColor = scoreInfo.color
      item.scoreLevel = scoreInfo.level
    }
    if (item.sharePercent == null && item.aiReport && item.aiReport.sharePercent != null) {
      item.sharePercent = item.aiReport.sharePercent
    }
    const STATUS_TEXT = {
      pending: '待分析',
      analyzing: '分析中',
      analyze_failed: '分析失败'
    }
    item.statusText = STATUS_TEXT[item.status] || ''
    return item
  },

  async loadList() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'getHistory',
        data: {
          action: 'list',
          page: this.data.page,
          pageSize: this.data.pageSize,
          where: this.buildWhere(),
          targetUserName: this.data.isManager ? (this.data.filterUserName || '') : ''
        }
      })
      const result = res.result || {}
      if (!result.success) {
        wx.showToast({ title: result.error || '加载失败', icon: 'none' })
        return
      }
      if (result.isManager != null && result.isManager !== this.data.isManager) {
        this.setData({ isManager: result.isManager })
      }
      const formatted = (result.list || []).map(item => this.formatItem(item))
      const newList = this.data.list.concat(formatted)
      this.setData({
        list: newList,
        total: result.total || 0,
        page: this.data.page + 1,
        hasMore: newList.length < (result.total || 0)
      })
    } catch (err) {
      console.error('加载照片明细失败:', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onTapItem(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/report/report?id=${id}` })
  }
})
