// pages/admin/admin.js
// 用户与权限管理后台（仅 admin 可见 + 服务端强制校验）
//
// 入口保护只是 UX：真正的权限边界在 users 云函数——非 admin 调用会被直接拒绝。

const app = getApp()

Page({
  data: {
    loading: true,
    users: [],
    meRole: ''
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
          fail: () => wx.switchTab({ url: '/pages/camera/camera' })
        })
      }, 800)
      return
    }
    this.loadUsers()
  },

  onPullDownRefresh() {
    this.loadUsers().then(() => wx.stopPullDownRefresh())
  },

  async loadUsers() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({ name: 'users', data: { action: 'listUsers' } })
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.error) || '加载失败')
      }
      this.setData({
        loading: false,
        users: res.result.list,
        meRole: res.result.meRole
      })
    } catch (err) {
      this.setData({ loading: false })
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
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
          const res = await wx.cloud.callFunction({
            name: 'users',
            data: { action: 'setRole', targetId, role: newRole }
          })
          wx.hideLoading()
          if (!res.result || !res.result.success) {
            throw new Error(res.result && res.result.error || '操作失败')
          }
          wx.showToast({ title: '已更新', icon: 'success' })
          this.loadUsers()
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: err.message || '操作失败', icon: 'none' })
        }
      },
      fail: () => {}
    })
  },

  // 停用 / 启用：调用 users.setDisabled
  async toggleDisabled(e) {
    const targetId = e.currentTarget.dataset.id
    const disabled = e.currentTarget.dataset.disabled
    const actionText = disabled ? '启用' : '停用'

    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: `${actionText}账号`,
        content: disabled
          ? '确定启用该用户？启用后其可正常提交与查看记录。'
          : '确定停用该用户？停用后其将无法提交巡检、查看记录与修改设置（历史数据不受影响，已排队的记录仍会被系统分析完）。',
        success: x => resolve(x.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirm) return

    wx.showLoading({ title: '处理中', mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'users',
        data: { action: 'setDisabled', targetId, disabled: !disabled }
      })
      wx.hideLoading()
      if (!res.result || !res.result.success) {
        throw new Error(res.result && res.result.error || '操作失败')
      }
      wx.showToast({ title: `已${actionText}`, icon: 'success' })
      this.loadUsers()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    }
  }
})
