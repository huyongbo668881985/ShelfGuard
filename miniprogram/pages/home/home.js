// pages/home/home.js
// 首页：开始拜访 + 拜访记录（默认今天，可切换到之前的日期）
//
// 拜访流程：首页「开始拜访」→ 选择门店（可选无门店）→ 拍照 → 上传 → 报告。
// 选门店复用 customers 页的选择模式：选完通过 globalData.selectedCustomer 回传，
// 首页 onShow 读取后带着门店信息 navigateTo 相机页。

const api = require('../../utils/api')
const { formatDate } = require('../../utils/date')
const { formatScoreLevel } = require('../../utils/format')
const offlineQueue = require('../../utils/offlineQueue')
const { getLocation } = require('../../utils/location')
const app = getApp()

const PAGE_SIZE = 50
const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const STATUS_TEXT = { pending: '已提交', uploaded: '已提交', analyzing: '已提交', analyze_failed: '已提交' }

function pad(n) {
  return String(n).padStart(2, '0')
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

Page({
  data: {
    userName: '',
    isManager: false,
    needsApproval: false,

    // 当前查看的日期（YYYY-MM-DD），默认今天
    selectedDate: '',
    todayStr: '',
    isToday: true,
    dateTitle: '今日拜访',
    dateLabel: '',

    list: [],
    total: 0,
    avgScore: 0,
    analyzedCount: 0,
    pendingCount: 0,
    loading: false,
    loaded: false,
    hasMore: false,
    page: 1,

    todayClockIn: null,
    todayClockOut: null,

    offlineCount: 0,
    starting: false
  },

  onLoad() {
    const todayStr = toDateStr(new Date())
    this.setData({ todayStr, selectedDate: todayStr })
    this.updateDateLabels(todayStr)
    this.syncUser()
    // 登录是异步的：冷启动时 userInfo 可能还没回来，登录完成后补刷新
    if (!app.globalData.isLoggedIn) {
      app.loginCallback = () => {
        this.syncUser()
        this.refresh()
      }
    }
  },

  onShow() {
    // 跨天后「今天」要跟着变（小程序后台驻留过夜的情况）
    const nowStr = toDateStr(new Date())
    if (nowStr !== this.data.todayStr) {
      const wasToday = this.data.isToday
      this.setData({ todayStr: nowStr })
      if (wasToday) {
        this.setData({ selectedDate: nowStr })
        this.updateDateLabels(nowStr)
      }
    }

    this.syncUser()
    this.refreshOfflineCount()

    // 隐私授权补弹（app.js 拦截时组件尚未挂载会置标记）
    if (app.globalData._privacyPending) {
      app.globalData._privacyPending = false
      this.showPrivacyAuthorize()
    }

    // 选门店页返回：只在「正在开始拜访」时才消费选择结果
    if (this._selecting) {
      this._selecting = false
      const selected = app.globalData.selectedCustomer
      app.globalData.selectedCustomer = null
      if (selected) {
        this.openCamera(selected)
        return
      }
      // 未选择就返回了：视为取消
    }

    // 上传/报告页的「继续拜访下一家」：直接进入选门店
    if (app.globalData.startNextVisit) {
      app.globalData.startNextVisit = false
      this.refresh()
      this.startVisit()
      return
    }

    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadList(false)
  },

  showPrivacyAuthorize() {
    const comp = this.selectComponent('#privacyAuth')
    if (comp) comp.show()
    else app.globalData._privacyPending = true
  },

  syncUser() {
    const me = app.globalData.userInfo || {}
    const role = me.role || app.globalData.userRole || 'sales'
    const isManager = role === 'admin' || role === 'manager'
    const approvedOk = me.approved === true ||
      ((me.approved === undefined || me.approved === null) && isManager)
    // 尚未拿到用户信息时不提示待审批，避免冷启动闪一下
    const needsApproval = !!app.globalData.userInfo && !approvedOk
    this.setData({ userName: me.name || '', isManager, needsApproval })
  },

  // 首次登录填完姓名后由 app.js 通知：刷新问候语里的姓名
  onUserNameReady() {
    this.syncUser()
  },

  refreshOfflineCount() {
    try {
      this.setData({ offlineCount: offlineQueue.count() })
    } catch (e) {}
  },

  async flushOffline() {
    wx.showLoading({ title: '上传中...', mask: true })
    try {
      const online = await offlineQueue.isOnline()
      if (!online) {
        wx.showToast({ title: '当前无网络', icon: 'none' })
        return
      }
      const r = await offlineQueue.flushAll({ openid: app.globalData.openid || '' })
      wx.hideLoading()
      wx.showToast({
        title: r && r.failed > 0 ? `成功${r.succeeded}条，失败${r.failed}条` : '补传完成',
        icon: 'none'
      })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '补传失败', icon: 'none' })
    }
    this.refreshOfflineCount()
    this.refresh()
  },

  // ---------- 日期 ----------

  updateDateLabels(dateStr) {
    const isToday = dateStr === this.data.todayStr
    const d = new Date(`${dateStr.replace(/-/g, '/')} 00:00:00`)
    const label = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_NAMES[d.getDay()]}`
    this.setData({
      isToday,
      dateLabel: label,
      dateTitle: isToday ? '今日拜访' : `${d.getMonth() + 1}月${d.getDate()}日拜访`
    })
  },

  onDateChange(e) {
    const v = e.detail.value
    this.setData({ selectedDate: v })
    this.updateDateLabels(v)
    this.refresh()
  },

  backToToday() {
    this.setData({ selectedDate: this.data.todayStr })
    this.updateDateLabels(this.data.todayStr)
    this.refresh()
  },

  shiftDay(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 0
    const d = new Date(`${this.data.selectedDate.replace(/-/g, '/')} 00:00:00`)
    d.setDate(d.getDate() + delta)
    const next = toDateStr(d)
    if (next > this.data.todayStr) return
    this.setData({ selectedDate: next })
    this.updateDateLabels(next)
    this.refresh()
  },

  // ---------- 数据 ----------

  refresh() {
    return this.loadList(true)
  },

  async loadList(reset) {
    // 日期切换/刷新时用序号丢弃过期响应，避免快速切换日期时列表错乱
    if (reset) {
      this._reqSeq = (this._reqSeq || 0) + 1
    } else if (this.data.loading) {
      return
    }
    const seq = this._reqSeq
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })

    try {
      const start = new Date(`${this.data.selectedDate.replace(/-/g, '/')} 00:00:00`)
      const end = new Date(start.getTime() + 864e5 - 1)
      const res = await api.callFunction({
        name: 'getHistory',
        data: {
          action: 'list',
          page,
          pageSize: PAGE_SIZE,
          where: { startDateISO: start.toISOString(), endDateISO: end.toISOString() }
        }
      })
      if (seq !== this._reqSeq) return

      const result = res.result || {}
      if (!result.success) throw new Error(result.error || '加载失败')

      const items = (result.list || []).map(it => this.formatItem(it))
      const list = reset ? items : this.data.list.concat(items)
      const visitItems = list.filter(it => !it.isClock)
      const scored = visitItems.filter(it => typeof it.score === 'number')
      const avg = scored.length
        ? Math.round(scored.reduce((s, it) => s + it.score, 0) / scored.length)
        : 0
      const pendingCount = Math.max(0, visitItems.length - scored.length)

      const nextData = {
        list,
        total: visitItems.length,
        avgScore: avg,
        analyzedCount: scored.length,
        pendingCount,
        page: page + 1,
        hasMore: list.length < (result.total || 0),
        loaded: true
      }

      // 若当前加载的是今天的数据，同步更新顶部「上班打卡 / 下班打卡」状态
      if (this.data.selectedDate === this.data.todayStr) {
        const myName = this.data.userName
        const myClockItems = list.filter(it => {
          if (!it.isClock) return false
          if (!this.data.isManager) return true
          return myName && it.userName === myName
        })
        // 列表按时间倒序：上班取最早一条（或最新一条），下班取最新一条
        const clockInList = myClockItems.filter(it => it.recordType === 'clock_in')
        const clockOutList = myClockItems.filter(it => it.recordType === 'clock_out')
        const ci = clockInList.length > 0 ? clockInList[clockInList.length - 1] : null
        const co = clockOutList.length > 0 ? clockOutList[0] : null
        nextData.todayClockIn = ci
          ? { _id: ci._id, timeText: ci.timeText, address: (ci.location && ci.location.address) || '' }
          : null
        nextData.todayClockOut = co
          ? { _id: co._id, timeText: co.timeText, address: (co.location && co.location.address) || '' }
          : null
      }

      this.setData(nextData)
    } catch (err) {
      console.error('加载拜访记录失败:', err)
      if (seq === this._reqSeq) {
        this.setData({ loaded: true })
        wx.showToast({ title: '加载失败，下拉重试', icon: 'none' })
      }
    }
    if (seq === this._reqSeq) this.setData({ loading: false })
  },

  formatItem(item) {
    const isClock = item.recordType === 'clock_in' || item.recordType === 'clock_out' || item.status === 'clocked'
    item.isClock = isClock
    if (!item.recordType) {
      item.recordType = isClock ? 'clock_in' : 'visit'
    }
    const ar = item.aiReport
    if (!isClock && ar && typeof ar.score === 'number') {
      const info = formatScoreLevel(ar.score)
      item.score = ar.score
      item.scoreColor = info.color
      item.scoreLevel = info.level
    }
    item.timeText = formatDate(item.createdAt, 'HH:mm')
    item.statusText = isClock ? '已打卡' : (STATUS_TEXT[item.status] || '')
    if (isClock) {
      item.displayStore = item.recordType === 'clock_out' ? '下班打卡' : '上班打卡'
    } else {
      item.displayStore = item.storeName || '无门店（常规拜访）'
    }
    return item
  },

  // ---------- 上下班打卡 ----------

  onTapClock(e) {
    const type = e.currentTarget.dataset.type || 'clock_in'
    if (this.data.needsApproval) {
      wx.showToast({ title: '账号待管理员审批，批准前无法打卡', icon: 'none' })
      return
    }
    const existing = type === 'clock_out' ? this.data.todayClockOut : this.data.todayClockIn
    const label = type === 'clock_out' ? '下班打卡' : '上班打卡'
    if (existing && existing._id) {
      wx.showActionSheet({
        itemList: [`查看今日${label}照片 (${existing.timeText})`, `重新拍照${label}`],
        success: (res) => {
          if (res.tapIndex === 0) {
            wx.navigateTo({ url: `/pages/report/report?id=${existing._id}` })
          } else if (res.tapIndex === 1) {
            wx.navigateTo({ url: `/pages/camera/camera?recordType=${type}&noStore=1` })
          }
        }
      })
      return
    }
    wx.navigateTo({ url: `/pages/camera/camera?recordType=${type}&noStore=1` })
  },

  onTapItem(e) {
    wx.navigateTo({ url: `/pages/report/report?id=${e.currentTarget.dataset.id}` })
  },

  goHistory() {
    wx.switchTab({ url: '/pages/history/history' })
  },

  // ---------- 开始拜访 ----------

  async startVisit() {
    if (this.data.starting) return
    if (this.data.needsApproval) {
      wx.showToast({ title: '账号待管理员审批，批准前无法提交', icon: 'none' })
    }
    this.setData({ starting: true })

    // 带上当前定位让门店列表按距离排序；拿不到就算了，不阻塞流程
    let query = ''
    try {
      const loc = await Promise.race([
        getLocation(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
      ])
      this._location = loc
      query = `&lat=${loc.latitude}&lng=${loc.longitude}`
    } catch (err) {
      console.warn('开始拜访时定位失败，门店列表将不按距离排序:', err)
    }

    this._selecting = true
    app.globalData.selectedCustomer = null
    wx.navigateTo({
      url: `/pages/customers/customers?mode=select${query}`,
      fail: () => { this._selecting = false },
      complete: () => this.setData({ starting: false })
    })
  },

  openCamera(selected) {
    const params = []
    if (selected.isNoStore) {
      params.push('noStore=1')
    } else {
      params.push(`storeName=${encodeURIComponent(selected.storeName || '')}`)
      params.push(`customerId=${encodeURIComponent(selected._id || '')}`)
      params.push(`storeAddress=${encodeURIComponent(selected.address || '')}`)
    }
    wx.navigateTo({ url: `/pages/camera/camera?${params.join('&')}` })
  }
})
