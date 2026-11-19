// pages/history/history.js
// 历史记录页面 - 支持搜索筛选、分页加载

const api = require('../../utils/api')
const { formatDate, timeAgo } = require('../../utils/date')
const { formatScoreLevel } = require('../../utils/format')
const app = getApp()

// 旧日报（改名前生成并存进数据库的）标题和结论里还带「巡检」字样，
// 只在显示时换成「拜访」，不改库里的数据
function toVisitWording(daily) {
  if (!daily) return daily
  try {
    return JSON.parse(JSON.stringify(daily).replace(/沿街巡检/g, '常规拜访').replace(/巡检/g, '拜访'))
  } catch (_) {
    return daily
  }
}

Page({
  data: {
    // 列表数据
    list: [],
    page: 1,
    pageSize: 20,
    total: 0,
    loading: false,
    hasMore: true,
    
    // 搜索筛选
    searchKeyword: '',
    filterDate: '',      // 日期筛选：'' | 'today' | 'week' | 'month'
    filterScore: '',     // 评分筛选：'' | 'high' | 'medium' | 'low'
    showFilter: false,

    // 管理者视角：isManager 为 true 时才会显示"按业务员筛选"，
    // 普通业务员看不到这个入口，且服务端也会强制忽略该参数只返回本人数据
    isManager: false,
    filterUserName: '',   // 管理者选择/填写，为空表示"看全部业务员"
    salesUsers: [],       // 在册业务员姓名列表（胶囊选择器数据源）
    
    // 统计信息
    stats: {
      total: 0,
      avgScore: null,
      avgFacingCount: null,
      inStockRate: null,
      thisWeek: 0
    },

    // 晚间集中分析：今日全天巡检汇总结论日报
    latestDailyReport: null,
    showDailyModal: false
  },

  onLoad() {
    this._lastRefreshAt = 0
    this._seenListVersion = -1
    this.syncManagerFlag()
  },

  onShow() {
    // 每次显示时按需刷新：首次进入 / 角色刚更新 / 有新提交 / 超过 60 秒才重拉，
    // 避免 onLoad+onShow 双重请求，也避免从报告页返回时反复清空重刷图片。
    const roleChanged = this.syncManagerFlag()
    const listVersion = (app.globalData && app.globalData.listVersion) || 0
    const dirty = this._seenListVersion !== listVersion
    const stale = !this._lastRefreshAt || (Date.now() - this._lastRefreshAt > 60000)
    if (roleChanged || dirty || stale) {
      this.refreshList()
    }
  },

  // 从全局登录态读取当前用户角色。app.js 的 login() 是异步的，
  // 如果这个页面在登录完成前就加载了，这里会先按"非管理者"处理，
  // onShow 时会重新同步一次，基本能覆盖冷启动的时序问题。
  syncManagerFlag() {
    const role = app.globalData.userInfo && app.globalData.userInfo.role
    const isManager = role === 'admin' || role === 'manager'
    if (isManager !== this.data.isManager) {
      this.setData({ isManager })
      return true
    }
    return false
  },

  onPullDownRefresh() {
    this.refreshList()
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadHistory(false)
    }
  },

  // 刷新列表（不再先清空 list，等新数据回来再整体替换，避免已有缩略图 DOM 卸载重载）
  async refreshList() {
    this._lastRefreshAt = Date.now()
    this._seenListVersion = (app.globalData && app.globalData.listVersion) || 0
    await Promise.all([
      this.loadHistory(true),
      this.loadStats()
    ])
    wx.stopPullDownRefresh()
  },

  // 加载历史记录
  async loadHistory(reset = false) {
    if (reset) {
      this._reqSeq = (this._reqSeq || 0) + 1
    } else if (this.data.loading) {
      return
    }
    const seq = this._reqSeq || 0
    const targetPage = reset ? 1 : this.data.page
    this.setData({ loading: true })

    try {
      // 构建查询条件
      const where = this.buildWhereCondition()
      
      const res = await api.callFunction({
        name: 'getHistory',
        data: {
          action: 'list',
          page: targetPage,
          pageSize: this.data.pageSize,
          where: where,
          // 非管理者传了也没用，服务端会强制忽略只返回本人数据
          targetUserName: this.data.isManager ? this.data.filterUserName : ''
        }
      })
      if (seq !== (this._reqSeq || 0)) return

      const result = res.result
      if (result.success) {
        // 格式化列表数据
        const formattedList = result.list.map(item => this.formatItem(item))
        const newList = reset ? formattedList : this.data.list.concat(formattedList)
        const nextData = {
          list: newList,
          total: result.total,
          page: targetPage + 1,
          hasMore: newList.length < result.total
        }
        if (result.isManager != null && result.isManager !== this.data.isManager) {
          nextData.isManager = result.isManager
        }
        if (Array.isArray(result.salesUsers) && result.salesUsers.length > 0) {
          nextData.salesUsers = result.salesUsers
        }
        this.setData(nextData)
      }
    } catch (err) {
      if (seq !== (this._reqSeq || 0)) return
      console.error('加载历史失败:', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }

    if (seq === (this._reqSeq || 0)) {
      this.setData({ loading: false })
    }
  },

  // 构建查询条件
  buildWhereCondition() {
    const conditions = {}

    // 日期筛选：只传原始值（ISO 字符串），由服务端重建 db.command。
    // db.command 命令对象经 callFunction JSON 序列化会丢失内部字段（见 BUG_REVIEW.md），
    // 不能直接透传给云函数，否则筛选条件会被静默丢弃。无筛选时服务端自带 90 天默认窗口。
    if (this.data.filterDate) {
      const now = new Date()
      let startDate

      if (this.data.filterDate === 'today') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      } else if (this.data.filterDate === 'week') {
        startDate = new Date(now.getTime() - 7 * 864e5)
      } else if (this.data.filterDate === 'month') {
        startDate = new Date(now)
        startDate.setMonth(now.getMonth() - 1)
      }

      if (startDate) {
        conditions.startDateISO = startDate.toISOString()
      }
    }

    // 评分筛选：只传数值区间，由服务端拼 _.gte / _.lte
    if (this.data.filterScore === 'high') {
      conditions.scoreMin = 80
    } else if (this.data.filterScore === 'medium') {
      conditions.scoreMin = 60
      conditions.scoreMax = 79
    } else if (this.data.filterScore === 'low') {
      conditions.scoreMax = 59
    }

    // 关键词搜索（门店名称或任务名称）：只传纯文本 keyword，由服务端拼 $or
    if (this.data.searchKeyword) {
      conditions.keyword = this.data.searchKeyword
    }

    return conditions
  },

  // 格式化列表项
  formatItem(item) {
    // 格式化时间
    if (item.createdAt) {
      item.displayDate = timeAgo(item.createdAt)
      item.fullDate = formatDate(item.createdAt, 'MM-DD HH:mm')
    }

    // 获取缩略图（第一张照片）
    if (item.photoFileIDs && item.photoFileIDs.length > 0) {
      item.thumbnailFileID = item.photoFileIDs[0]
    }

    // 评分等级与颜色（统一用 utils/format 的 formatScoreLevel，与 AI 报告口径一致）
    if (item.aiReport && typeof item.aiReport.score === 'number') {
      const scoreInfo = formatScoreLevel(item.aiReport.score)
      item.scoreColor = scoreInfo.color
      item.scoreLevel = scoreInfo.level
    } else if (item.aiReport && item.status === 'analyzed') {
      if (item.aiReport.hasShelfPhoto === false || item.aiReport.scoreLevel === '无货架照') {
        item.nonScoredTag = '无货架照'
        item.nonScoredType = 'noshelf'
      } else if (item.aiReport.ownBrandPresent === false || item.aiReport.scoreLevel === '未上柜') {
        item.nonScoredTag = '未上柜'
        item.nonScoredType = 'oos'
      }
    }

    // 独立排面指标
    const fm = item.aiReport && item.aiReport.facingMetrics
    const fc = item.ownFacingCount != null
      ? item.ownFacingCount
      : (fm && fm.ownFacingCount != null ? fm.ownFacingCount : null)
    item.displayFacingCount = (fc !== null && fc !== undefined) ? fc : null

    // 列表项状态标记：还没出报告的记录用轻量文案提示，避免用户以为"丢单了"
    const STATUS_TEXT = {
      pending: '已提交',
      uploaded: '已提交',
      analyzing: '分析中',
      analyze_failed: '分析失败',
      clocked: '已打卡'
    }
    item.statusText = STATUS_TEXT[item.status] || ''

    return item
  },

  // 加载统计信息与今日汇总结论
  async loadStats() {
    try {
      const where = this.buildWhereCondition()
      const res = await api.callFunction({
        name: 'getHistory',
        data: {
          action: 'stats',
          where,
          targetUserName: this.data.isManager ? this.data.filterUserName : ''
        }
      })

      if (res.result && res.result.success) {
        const nextData = {
          stats: res.result.stats,
          latestDailyReport: toVisitWording(res.result.latestDailyReport || null)
        }
        if (res.result.isManager != null) {
          nextData.isManager = res.result.isManager
        }
        if (Array.isArray(res.result.salesUsers) && res.result.salesUsers.length > 0) {
          nextData.salesUsers = res.result.salesUsers
        }
        this.setData(nextData)
      }
    } catch (err) {
      console.error('加载统计失败:', err)
    }
  },

  // 打开今日巡检汇总结论完整弹窗
  viewDailyReportDetail() {
    this.setData({ showDailyModal: true })
  },

  closeDailyModal() {
    this.setData({ showDailyModal: false })
  },

  // 复制日报结论文字到剪贴板，方便一键转发到微信工作群
  copyDailySummary() {
    const report = this.data.latestDailyReport && this.data.latestDailyReport.report
    if (!report) return

    const ov = report.ownBrandOverview || {}
    const scoreLine = (report.overallScore !== null && report.overallScore !== undefined)
      ? `⭐ 综合评分：${report.overallScore}分（${report.overallLevel || '良好'}）`
      : `⭐ 综合评分：${report.overallLevel || '暂无评分'}`

    const lines = [
      `📋【${report.summaryTitle || '白酒终端拜访综合分析日报'}】`,
      `📅 日期：${this.data.latestDailyReport.date || '今日'}`,
      scoreLine,
      `🏬 拜访门店：${this.data.latestDailyReport.inspectionCount || 0}家`
    ]
    if (ov.avgFacingCount !== null && ov.avgFacingCount !== undefined) {
      lines.push(`📦 平均排面：${ov.avgFacingCount}面${ov.inStockRate != null ? ` · 在架率 ${ov.inStockRate}%` : ''}`)
    }
    lines.push(`\n💡 核心结论：\n${report.summaryConclusion || '暂无'}`)

    if (Array.isArray(report.commonIssues) && report.commonIssues.length > 0) {
      lines.push(`\n⚠️ 今日共性问题：`)
      report.commonIssues.forEach((issue, idx) => {
        lines.push(`${idx + 1}. [${issue.category}] ${issue.description} (${issue.affectStores || ''})`)
      })
    }

    if (Array.isArray(report.actionPlanTomorrow) && report.actionPlanTomorrow.length > 0) {
      lines.push(`\n🎯 明日行动指南：`)
      report.actionPlanTomorrow.forEach((act, idx) => {
        lines.push(`${idx + 1}. ${act.action}`)
      })
    }

    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => {
        wx.showToast({ title: '日报文字已复制，可直接发微信群', icon: 'none', duration: 2500 })
      }
    })
  },

  // 点击记录
  onTapItem(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/report/report?id=${id}`
    })
  },

  // 搜索输入
  onSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value })
  },

  // 执行搜索
  onSearch() {
    this.refreshList()
  },

  // 清空搜索
  onClearSearch() {
    this.setData({ searchKeyword: '' })
    this.refreshList()
  },

  // 显示筛选面板
  onShowFilter() {
    this.setData({ showFilter: true })
  },

  // 关闭筛选面板
  onCloseFilter() {
    this.setData({ showFilter: false })
  },

  // 选择日期筛选
  onSelectDateFilter(e) {
    const value = e.currentTarget.dataset.value
    this.setData({ 
      filterDate: this.data.filterDate === value ? '' : value,
      showFilter: false
    })
    this.refreshList()
  },

  // 选择评分筛选
  onSelectScoreFilter(e) {
    const value = e.currentTarget.dataset.value
    this.setData({ 
      filterScore: this.data.filterScore === value ? '' : value,
      showFilter: false
    })
    this.refreshList()
  },

  // 管理者：点击业务员胶囊一键切换筛选
  onSelectUserPill(e) {
    const name = e.currentTarget.dataset.name || ''
    const next = (name && this.data.filterUserName === name) ? '' : name
    this.setData({
      filterUserName: next,
      showFilter: false
    })
    this.refreshList()
  },

  // 管理者：按业务员姓名筛选（输入框失焦或点确认时触发）
  onFilterUserNameInput(e) {
    this.setData({ filterUserName: e.detail.value })
  },

  onApplyUserNameFilter() {
    this.setData({ showFilter: false })
    this.refreshList()
  },

  onClearUserNameFilter() {
    this.setData({ filterUserName: '' })
    this.refreshList()
  },

  // 清除所有筛选
  onClearFilter() {
    this.setData({
      filterDate: '',
      filterScore: '',
      filterUserName: '',
      showFilter: false
    })
    this.refreshList()
  },

  // 「管理」入口：只有管理员 / 管理者能看到（页面里还会再按服务端角色拦一次）
  goManage() {
    wx.navigateTo({ url: '/pages/settings/settings' })
  },

  goDashboard() {
    wx.navigateTo({ url: '/pages/dashboard/dashboard' })
  },

  goPhotoDetail() {
    wx.navigateTo({ url: '/pages/photo-detail/photo-detail' })
  },

  goVisitMap() {
    wx.navigateTo({ url: '/pages/visit-map/visit-map' })
  }
})
