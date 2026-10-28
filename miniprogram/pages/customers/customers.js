// pages/customers/customers.js
// 客户（门店）管理页面：供拍照时就近选择；列表范围由云函数按角色决定
// （admin/manager=全部客户，sales=我的客户）。页面只展示文案，不做权限判断。
//
// 这个页面身兼两职：
// - 正常模式（不带参数）：管理客户资料，增删改查。
// - 选择模式（url 带 mode=select&lat=xx&lng=xx）：从相机页跳转过来，
//   按距离当前坐标由近到远排序，点一下卡片就选中并返回相机页，
//   不会进编辑态。这样不用另外做一个"选择器"页面，复用同一份列表。

const { getLocation } = require('../../utils/location')
const app = getApp()

// 直线距离，单位公里（Haversine 公式）。客户数量一般就几十个，
// 前端算完全够用，不需要后端搞地理索引这种重量级方案。
function distanceInKm(lat1, lng1, lat2, lng2) {
  const toRad = deg => (deg * Math.PI) / 180
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

Page({
  data: {
    loading: true,
    list: [],
    page: 1,
    limit: 50,
    total: 0,
    hasMore: false,
    loadingMore: false,
    // all | self —— 与云函数 list 返回的 scope 对齐；文案用
    listScope: 'self',
    listTitle: '我的客户',

    // 选择模式相关
    selectMode: false,
    currentLat: null,
    currentLng: null,

    showEditor: false,
    editingId: '',
    form: {
      storeName: '',
      address: '',
      contactName: '',
      contactPhone: '',
      location: null // { latitude, longitude }，可选
    },
    locating: false,
    saving: false
  },

  onLoad(options) {
    if (options.mode === 'select') {
      this.setData({
        selectMode: true,
        currentLat: options.lat ? Number(options.lat) : null,
        currentLng: options.lng ? Number(options.lng) : null
      })
      wx.setNavigationBarTitle({ title: '选择客户' })
    } else {
      this.applyScopeTitle(this.resolveLocalScope())
    }
    this.loadCustomers()
  },

  resolveLocalScope() {
    const role = (app.globalData.userInfo && app.globalData.userInfo.role)
      || app.globalData.userRole
      || 'sales'
    return (role === 'admin' || role === 'manager') ? 'all' : 'self'
  },

  applyScopeTitle(scope) {
    const listScope = scope === 'all' ? 'all' : 'self'
    const listTitle = listScope === 'all' ? '全部客户' : '我的客户'
    this.setData({ listScope, listTitle })
    if (!this.data.selectMode) {
      wx.setNavigationBarTitle({ title: listTitle })
    }
  },

  onPullDownRefresh() {
    this.loadCustomers({ reset: true }).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.loading) {
      this.loadCustomers({ append: true })
    }
  },

  decorateList(list) {
    const { selectMode, currentLat, currentLng } = this.data
    if (!(selectMode && currentLat != null && currentLng != null)) return list
    const decorated = list.map(item => {
      if (item.location) {
        const km = distanceInKm(currentLat, currentLng, item.location.latitude, item.location.longitude)
        return {
          ...item,
          distanceKm: km,
          distanceText: km < 1 ? `${Math.round(km * 1000)}米` : `${km.toFixed(1)}公里`
        }
      }
      return { ...item, distanceKm: 999999, distanceText: '' }
    })
    decorated.sort((a, b) => a.distanceKm - b.distanceKm)
    return decorated
  },

  async loadCustomers({ reset = true, append = false } = {}) {
    if (append) {
      if (!this.data.hasMore || this.data.loadingMore) return
      this.setData({ loadingMore: true })
    } else {
      this.setData({ loading: true, page: 1 })
    }

    const page = append ? (this.data.page + 1) : 1
    const limit = this.data.limit

    try {
      const res = await wx.cloud.callFunction({
        name: 'customers',
        data: { action: 'list', page, limit }
      })
      if (res.result && res.result.success) {
        let list = this.decorateList(res.result.list || [])
        if (append) {
          // 合并后再按距离重排整表，避免第 2 页近店排在第 1 页远店后面
          // TODO: 云端按距离分页（geo）后可去掉前端全量重排
          list = this.decorateList((this.data.list || []).concat(res.result.list || []))
        }
        const scope = res.result.scope || this.resolveLocalScope()
        const listTitle = scope === 'all' ? '全部客户' : '我的客户'
        this.setData({
          list,
          page,
          total: res.result.total || list.length,
          hasMore: !!res.result.hasMore,
          listScope: scope === 'all' ? 'all' : 'self',
          listTitle,
          loading: false,
          loadingMore: false
        })
        if (!this.data.selectMode) {
          wx.setNavigationBarTitle({ title: listTitle })
        }
      } else {
        wx.showToast({ title: (res.result && res.result.error) || '加载失败', icon: 'none' })
        this.setData({ loading: false, loadingMore: false })
      }
    } catch (err) {
      console.error('加载客户列表失败:', err)
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
      this.setData({ loading: false, loadingMore: false })
    }
  },

  // 选择模式下点卡片：直接选中，带着资料返回相机页
  onSelectCustomer(e) {
    if (!this.data.selectMode) return
    const item = e.currentTarget.dataset.item
    app.globalData.selectedCustomer = item
    wx.navigateBack()
  },

  // 选择模式下选择"不关联门店"
  onSelectNoStore() {
    if (!this.data.selectMode) return
    app.globalData.selectedCustomer = {
      isNoStore: true,
      storeName: '',
      address: '',
      _id: ''
    }
    wx.navigateBack()
  },

  onAddCustomer() {
    this.setData({
      showEditor: true,
      editingId: '',
      form: {
        storeName: '',
        address: '',
        contactName: '',
        contactPhone: '',
        location: null
      }
    })
  },

  onEditCustomer(e) {
    const item = e.currentTarget.dataset.item
    this.setData({
      showEditor: true,
      editingId: item._id,
      form: {
        storeName: item.storeName || '',
        address: item.address || '',
        contactName: item.contactName || '',
        contactPhone: item.contactPhone || '',
        location: item.location || null
      }
    })
  },

  closeEditor() {
    if (this.data.saving) return
    this.setData({ showEditor: false })
  },

  onStoreNameInput(e) {
    this.setData({ 'form.storeName': e.detail.value })
  },

  onAddressInput(e) {
    this.setData({ 'form.address': e.detail.value })
  },

  onContactNameInput(e) {
    this.setData({ 'form.contactName': e.detail.value })
  },

  onContactPhoneInput(e) {
    this.setData({ 'form.contactPhone': e.detail.value })
  },

  // 获取当前位置作为这个客户的坐标——建议站在门店门口点这个按钮，
  // 后面"拍照时按距离排序"就是靠这个坐标算出来的，不填的话这个客户
  // 不会出现在"就近排序"列表里（排序逻辑见 camera 页）。
  async onFetchLocation() {
    this.setData({ locating: true })
    try {
      const location = await getLocation()
      this.setData({ 'form.location': location })
      wx.showToast({ title: '已获取当前位置', icon: 'success' })
    } catch (err) {
      console.error('获取位置失败:', err)
      wx.showToast({ title: '获取位置失败', icon: 'none' })
    } finally {
      this.setData({ locating: false })
    }
  },

  onClearLocation() {
    this.setData({ 'form.location': null })
  },

  async onSave() {
    const { form, editingId } = this.data

    const storeName = form.storeName.trim()
    if (!storeName) {
      wx.showToast({ title: '请填写门店名称', icon: 'none' })
      return
    }

    const customerPayload = {
      storeName,
      address: form.address.trim(),
      contactName: form.contactName.trim(),
      contactPhone: form.contactPhone.trim(),
      location: form.location
    }

    this.setData({ saving: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'customers',
        data: editingId
          ? { action: 'update', customerId: editingId, customer: customerPayload }
          : { action: 'add', customer: customerPayload }
      })

      if (res.result && res.result.success) {
        wx.showToast({ title: '已保存', icon: 'success' })
        this.setData({ showEditor: false })
        this.loadCustomers()
      } else {
        wx.showToast({ title: (res.result && res.result.error) || '保存失败', icon: 'none' })
      }
    } catch (err) {
      console.error('保存客户失败:', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  onRemoveCustomer(e) {
    const item = e.currentTarget.dataset.item
    wx.showModal({
      title: '删除客户',
      content: `确定要删除「${item.storeName}」吗？历史巡检记录不受影响。`,
      success: async (res) => {
        if (!res.confirm) return
        try {
          const result = await wx.cloud.callFunction({
            name: 'customers',
            data: { action: 'remove', customerId: item._id }
          })
          if (result.result && result.result.success) {
            wx.showToast({ title: '已删除', icon: 'success' })
            this.loadCustomers()
          } else {
            wx.showToast({ title: '操作失败', icon: 'none' })
          }
        } catch (err) {
          console.error('删除客户失败:', err)
          wx.showToast({ title: '操作失败，请重试', icon: 'none' })
        }
      }
    })
  }
})
