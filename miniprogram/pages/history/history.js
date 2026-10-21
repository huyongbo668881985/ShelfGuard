// pages/history/history.js
// 历史记录页面 - 支持搜索筛选、分页加载

const { formatDate, timeAgo } = require('../../utils/date')
const { formatScoreLevel } = require('../../utils/format')
const app = getApp()

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
    filterUserName: '',   // 管理者填写，为空表示"看全部业务员"
    
    // 统计信息
    stats: {
      total: 0,
      avgScore: 0,
      thisWeek: 0
    },

    // 晚间集中分析：今日全天巡检汇总结论日报
    latestDailyReport: null,
    showDailyModal: false
  },

  onLoad() {
    this.syncManagerFlag()
    this.loadHistory()
    this.loadStats()
  },

  onShow() {
    // 每次显示时刷新列表（角色可能在设置页刚更新过）
    this.syncManagerFlag()
    this.refreshList()
  },

  // 从全局登录态读取当前用户角色。app.js 的 login() 是异步的，
  // 如果这个页面在登录完成前就加载了，这里会先按"非管理者"处理，
  // onShow 时会重新同步一次，基本能覆盖冷启动的时序问题。
  syncManagerFlag() {
    const role = app.globalData.userInfo && app.globalData.userInfo.role
    const isManager = role === 'admin' || role === 'manager'
    if (isManager !== this.data.isManager) {
      this.setData({ isManager })
    }
  },

  onPullDownRefresh() {
    this.refreshList()
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadHistory()
    }
  },

  // 刷新列表
  async refreshList() {
    this.setData({ page: 1, list: [], hasMore: true })
    await this.loadHistory()
    await this.loadStats()
    wx.stopPullDownRefresh()
  },

  // 加载历史记录
  async loadHistory() {
    if (this.data.loading) return
    this.setData({ loading: true })

    try {
      // 构建查询条件
      const where = this.buildWhereCondition()
      
      const res = await wx.cloud.callFunction({
        name: 'getHistory',
        data: {
          action: 'list',
          page: this.data.page,
          pageSize: this.data.pageSize,
          where: where,
          // 非管理者传了也没用，服务端会强制忽略只返回本人数据
          targetUserName: this.data.isManager ? this.data.filterUserName : ''
        }
      })

      const result = res.result
      if (result.success) {
        // 格式化列表数据
        const formattedList = result.list.map(item => this.formatItem(item))
        const newList = this.data.list.concat(formattedList)
        
        this.setData({
          list: newList,
          total: result.total,
          page: this.data.page + 1,
          hasMore: newList.length < result.total
        })
      }
    } catch (err) {
      console.error('加载历史失败:', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }

    this.setData({ loading: false })
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
    }

    // 列表项状态标记：还没出报告的记录用轻量文案提示，避免用户以为"丢单了"
    const STATUS_TEXT = {
      pending: '待分析',
      analyzing: '分析中',
      analyze_failed: '分析失败'
    }
    item.statusText = STATUS_TEXT[item.status] || ''

    return item
  },

  // 加载统计信息与今日汇总结论
  async loadStats() {
    try {
      const where = this.buildWhereCondition()
      const res = await wx.cloud.callFunction({
        name: 'getHistory',
        data: {
          action: 'stats',
          where,
          targetUserName: this.data.isManager ? this.data.filterUserName : ''
        }
      })

      if (res.result && res.result.success) {
        this.setData({
          stats: res.result.stats,
          latestDailyReport: res.result.latestDailyReport || null
        })
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

    const lines = [
      `📋【${report.summaryTitle || '白酒终端巡检综合分析日报'}】`,
      `📅 日期：${this.data.latestDailyReport.date || '今日'}`,
      `⭐ 综合评分：${report.overallScore}分（${report.overallLevel || '良好'}）`,
      `🏬 巡检门店：${this.data.latestDailyReport.inspectionCount || 0}家`,
      `\n💡 核心结论：\n${report.summaryConclusion || '暂无'}`,
      `\n⚠️ 今日共性问题：`
    ]

    if (Array.isArray(report.commonIssues)) {
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
  }
})
