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
    }
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
    const db = wx.cloud.database()
    const _ = db.command
    const conditions = {}

    // 90 天内
    const ninetyDaysAgo = new Date()
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
    conditions.createdAt = _.gte(ninetyDaysAgo)

    // 日期筛选
    if (this.data.filterDate) {
      const now = new Date()
      let startDate
      
      if (this.data.filterDate === 'today') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      } else if (this.data.filterDate === 'week') {
        startDate = new Date(now)
        startDate.setDate(now.getDate() - 7)
      } else if (this.data.filterDate === 'month') {
        startDate = new Date(now)
        startDate.setMonth(now.getMonth() - 1)
      }
      
      if (startDate) {
        conditions.createdAt = _.and(_.gte(startDate), _.gte(ninetyDaysAgo))
      }
    }

    // 评分筛选
    if (this.data.filterScore) {
      let scoreCondition
      if (this.data.filterScore === 'high') {
        scoreCondition = _.gte(80)
      } else if (this.data.filterScore === 'medium') {
        scoreCondition = _.and(_.gte(60), _.lt(80))
      } else if (this.data.filterScore === 'low') {
        scoreCondition = _.lt(60)
      }
      
      if (scoreCondition) {
        conditions['aiReport.score'] = scoreCondition
      }
    }

    // 关键词搜索（门店名称或任务名称）：只传纯文本 keyword，
    // 由服务端拼 $or，避免依赖 db.command 序列化内部字段导致条件丢失。
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

    return item
  },

  // 加载统计信息
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
        this.setData({ stats: res.result.stats })
      }
    } catch (err) {
      console.error('加载统计失败:', err)
    }
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
