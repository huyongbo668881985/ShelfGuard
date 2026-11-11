// pages/admin/admin.js
// 用户与权限管理后台（仅 admin 可见 + 服务端强制校验）
//
// 入口保护只是 UX：真正的权限边界在 users 云函数——非 admin 调用会被直接拒绝。

const api = require('../../utils/api')
const app = getApp()

Page({
  data: {
    loading: true,
    users: [],
    meRole: '',
    page: 1,
    pageSize: 50,
    hasMore: false,
    total: 0,
    loadingMore: false
  },

  async onShow() {
    // 入口保护：非管理员直接弹回
    let role = (app.globalData.userInfo && app.globalData.userInfo.role)
      || app.globalData.userRole
      || 'sales'

    // 保险：如果 globalData 还是旧角色，触发一次登录刷新（激活 admin 后常见）
    if (role !== 'admin' && app.login) {
      try {
        await app.login()
        role = (app.globalData.userInfo && app.globalData.userInfo.role)
          || app.globalData.userRole
          || 'sales'
      } catch (err) {
        console.error('admin 页刷新登录失败:', err)
      }
    }

    if (role !== 'admin') {
      wx.showToast({ title: '仅管理员可访问', icon: 'none' })
      setTimeout(() => {
        wx.navigateBack({
          fail: () => wx.switchTab({ url: '/pages/home/home' })
        })
      }, 800)
      return
    }
    this.loadUsers({ reset: true })
  },

  onPullDownRefresh() {
    this.loadUsers({ reset: true }).then(() => wx.stopPullDownRefresh())
  },

  async loadUsers({ reset = true } = {}) {
    if (reset) {
      this.setData({ loading: true, page: 1 })
    } else {
      if (!this.data.hasMore || this.data.loadingMore) return
      this.setData({ loadingMore: true })
    }
    const page = reset ? 1 : this.data.page
    const pageSize = this.data.pageSize
    try {
      const res = await api.callFunction({
        name: 'users',
        data: { action: 'listUsers', page, limit: pageSize }
      })
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.error) || '加载失败')
      }
      const list = res.result.list || []
      this.setData({
        loading: false,
        loadingMore: false,
        users: reset ? list : (this.data.users || []).concat(list),
        meRole: res.result.meRole,
        page: page + 1,
        hasMore: !!res.result.hasMore,
        total: res.result.total || 0
      })
    } catch (err) {
      this.setData({ loading: false, loadingMore: false })
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  loadMoreUsers() {
    this.loadUsers({ reset: false })
  },

  // 改角色：弹出选项，调用 users.setRole
  async changeRole(e) {
    const targetId = e.currentTarget.dataset.id
    const current = e.currentTarget.dataset.role
    const roles = ['sales', 'manager', 'admin']
    const labels = ['业务员', '管理者', '管理员']

    wx.showActionSheet({
      itemList: labels,
      success: async (r) => {
        const newRole = roles[r.tapIndex]
        if (newRole === current) return
        wx.showLoading({ title: '更新中', mask: true })
        try {
          const res = await api.callFunction({
            name: 'users',
            data: { action: 'setRole', targetId, role: newRole }
          })
          wx.hideLoading()
          if (!res.result || !res.result.success) {
            throw new Error(res.result && res.result.error || '操作失败')
          }
          wx.showToast({ title: '已更新', icon: 'success' })
          this.loadUsers({ reset: true })
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: err.message || '操作失败', icon: 'none' })
        }
      },
      fail: () => {}
    })
  },

  // 弹出可输入的系统弹窗，返回 { confirm, value }
  askText({ title, value = '', placeholder = '' }) {
    return new Promise(resolve => {
      wx.showModal({
        title,
        content: value,
        editable: true,
        placeholderText: placeholder,
        confirmText: '保存',
        success: r => resolve({ confirm: !!r.confirm, value: String(r.content || '').replace(/\s+/g, ' ').trim() }),
        fail: () => resolve({ confirm: false, value: '' })
      })
    })
  },

  async callUsers(data, okText) {
    wx.showLoading({ title: '保存中', mask: true })
    try {
      const res = await api.callFunction({ name: 'users', data })
      wx.hideLoading()
      if (!res.result || !res.result.success) {
        throw new Error(res.result && res.result.error || '操作失败')
      }
      // success 图标的提示最多显示 7 个字，长提示改用纯文字
      wx.showToast({ title: okText, icon: okText.length > 7 ? 'none' : 'success', duration: okText.length > 7 ? 2500 : 1500 })
      this.loadUsers({ reset: true })
      return true
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
      return false
    }
  },

  // 改姓名：业务员自己填过后不能再改，只能管理员在这里改（users.setName）
  async editName(e) {
    const targetId = e.currentTarget.dataset.id
    const current = e.currentTarget.dataset.name || ''
    const r = await this.askText({
      title: '修改姓名',
      value: current,
      placeholder: '需与进销存里的业务员姓名一致'
    })
    if (!r.confirm) return
    if (!r.value) {
      wx.showToast({ title: '姓名不能为空', icon: 'none' })
      return
    }
    if (r.value === current) return
    await this.callUsers({ action: 'setName', targetId, name: r.value }, '已修改，下次同步后重新分配客户')
  },

  // 绑定进销存业务员：姓名对不上或重名时，手动指定这个账号对应进销存里的哪个业务员
  async editJxcBinding(e) {
    const targetId = e.currentTarget.dataset.id
    const current = e.currentTarget.dataset.binding || ''
    const r = await this.askText({
      title: '绑定进销存业务员',
      value: current,
      placeholder: '填进销存里的业务员姓名，留空表示解除绑定'
    })
    if (!r.confirm) return
    if (r.value === current) return
    await this.callUsers(
      { action: 'setJxcBinding', targetId, jxcOperatorName: r.value },
      r.value ? '已绑定，下次同步后重新分配客户' : '已解除绑定，下次同步后生效'
    )
  },

  // 停用 / 启用：调用 users.setDisabled
  // 批准业务员准入（未批准时显示按钮）
  async toggleApproved(e) {
    const targetId = e.currentTarget.dataset.id
    const approved = e.currentTarget.dataset.approved
    if (approved) return

    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: '批准账号',
        content: '确定批准该用户？批准后其可提交拜访记录。',
        success: x => resolve(x.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirm) return

    wx.showLoading({ title: '处理中', mask: true })
    try {
      const res = await api.callFunction({
        name: 'users',
        data: { action: 'setApproved', targetId, approved: true }
      })
      wx.hideLoading()
      if (!res.result || !res.result.success) {
        throw new Error(res.result && res.result.error || '操作失败')
      }
      wx.showToast({ title: '已批准', icon: 'success' })
      this.loadUsers({ reset: true })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    }
  },

  async toggleDisabled(e) {
    const targetId = e.currentTarget.dataset.id
    const disabled = e.currentTarget.dataset.disabled
    const actionText = disabled ? '启用' : '停用'

    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: `${actionText}账号`,
        content: disabled
          ? '确定启用该用户？启用后其可正常提交与查看记录。'
          : '确定停用该用户？停用后其将无法提交拜访、查看记录与修改设置（历史数据不受影响，已排队的记录仍会被系统分析完）。',
        success: x => resolve(x.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirm) return

    wx.showLoading({ title: '处理中', mask: true })
    try {
      const res = await api.callFunction({
        name: 'users',
        data: { action: 'setDisabled', targetId, disabled: !disabled }
      })
      wx.hideLoading()
      if (!res.result || !res.result.success) {
        throw new Error(res.result && res.result.error || '操作失败')
      }
      wx.showToast({ title: `已${actionText}`, icon: 'success' })
      this.loadUsers({ reset: true })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    }
  }
})
