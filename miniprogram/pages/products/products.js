// pages/products/products.js
// 产品库页面：录入自家产品的品牌名/别名/正背侧面参考照，
// 供 AI 分析货架照片时做品牌识别归一化匹配（见 cloudfunctions/analyzeImage）。

Page({
  data: {
    loading: true,
    list: [],
    page: 1,
    limit: 50,
    total: 0,
    hasMore: false,
    loadingMore: false,

    // 编辑面板状态
    showEditor: false,
    editingId: '', // 空字符串表示"新增"，非空表示"编辑"
    form: {
      brandName: '',
      productLine: '',
      aliasesText: '', // 输入框里是逗号分隔的文本，提交时再拆成数组
      photos: {
        front: '',
        back: '',
        side: ''
      },
      photoURLs: {
        front: '',
        back: '',
        side: ''
      }
    },
    saving: false,
    isAdmin: false
  },

  onLoad() {
    const app = getApp()
    const role = (app.globalData.userInfo && app.globalData.userInfo.role) || app.globalData.userRole || 'sales'
    this.setData({ isAdmin: role === 'admin' })
    this.loadProducts()
  },

  onShow() {
    const app = getApp()
    const role = (app.globalData.userInfo && app.globalData.userInfo.role) || app.globalData.userRole || 'sales'
    this.setData({ isAdmin: role === 'admin' })
  },

  onPullDownRefresh() {
    this.loadProducts({ reset: true }).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.loading) {
      this.loadProducts({ append: true })
    }
  },

  async loadProducts({ reset = true, append = false } = {}) {
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
        name: 'products',
        data: { action: 'list', page, limit }
      })
      if (res.result && res.result.success) {
        let list = res.result.list || []
        if (append) list = (this.data.list || []).concat(list)
        this.setData({
          list,
          page,
          total: res.result.total || list.length,
          hasMore: !!res.result.hasMore,
          loading: false,
          loadingMore: false
        })
      } else {
        wx.showToast({ title: (res.result && res.result.error) || '加载失败', icon: 'none' })
        this.setData({ loading: false, loadingMore: false })
      }
    } catch (err) {
      console.error('加载产品库失败:', err)
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
      this.setData({ loading: false, loadingMore: false })
    }
  },

  // 打开"新增产品"面板
  onAddProduct() {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅管理员可维护产品库', icon: 'none' })
      return
    }
    this.setData({
      showEditor: true,
      editingId: '',
      form: {
        brandName: '',
        productLine: '',
        aliasesText: '',
        photos: { front: '', back: '', side: '' },
        photoURLs: { front: '', back: '', side: '' }
      }
    })
  },

  // 打开"编辑产品"面板
  onEditProduct(e) {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅管理员可维护产品库', icon: 'none' })
      return
    }
    const item = e.currentTarget.dataset.item
    this.setData({
      showEditor: true,
      editingId: item._id,
      form: {
        brandName: item.brandName || '',
        productLine: item.productLine || '',
        aliasesText: (item.aliases || []).join('，'),
        photos: {
          front: (item.photos && item.photos.front) || '',
          back: (item.photos && item.photos.back) || '',
          side: (item.photos && item.photos.side) || ''
        },
        photoURLs: {
          front: (item.photoURLs && item.photoURLs.front) || (item.photos && item.photos.front) || '',
          back: (item.photoURLs && item.photoURLs.back) || (item.photos && item.photos.back) || '',
          side: (item.photoURLs && item.photoURLs.side) || (item.photos && item.photos.side) || ''
        }
      }
    })
  },

  closeEditor() {
    if (this.data.saving) return
    this.setData({ showEditor: false })
  },

  onBrandNameInput(e) {
    this.setData({ 'form.brandName': e.detail.value })
  },

  onProductLineInput(e) {
    this.setData({ 'form.productLine': e.detail.value })
  },

  onAliasesInput(e) {
    this.setData({ 'form.aliasesText': e.detail.value })
  },

  // 选择参考照：先存本地路径，保存时再 uploadFile，避免未保存就造孤儿云文件
  async onChoosePhoto(e) {
    if (!this.data.isAdmin) return
    const slot = e.currentTarget.dataset.slot // 'front' | 'back' | 'side'
    try {
      const chooseRes = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera']
      })
      const tempPath = chooseRes.tempFiles[0].tempFilePath
      this.setData({
        // photos 槽位暂存本地路径；以非 cloud:// 标记待上传
        [`form.photos.${slot}`]: tempPath,
        [`form.photoURLs.${slot}`]: tempPath
      })
    } catch (err) {
      if (err.errMsg && err.errMsg.includes('cancel')) return
      console.error('选择参考照失败:', err)
      wx.showToast({ title: '选择失败，请重试', icon: 'none' })
    }
  },

  async uploadPendingPhotos(photos) {
    const next = { ...(photos || {}) }
    for (const slot of ['front', 'back', 'side']) {
      const v = next[slot]
      if (!v) continue
      if (typeof v === 'string' && v.indexOf('cloud://') === 0) continue
      const cloudPath = `products/${slot}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`
      const uploadRes = await wx.cloud.uploadFile({ cloudPath, filePath: v })
      next[slot] = uploadRes.fileID
    }
    return next
  },

  onRemovePhoto(e) {
    const slot = e.currentTarget.dataset.slot
    this.setData({
      [`form.photos.${slot}`]: '',
      [`form.photoURLs.${slot}`]: ''
    })
  },

  onPreviewPhoto(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ urls: [url], current: url })
  },

  // 保存（新增或更新）
  async onSave() {
    const { form, editingId } = this.data

    const brandName = form.brandName.trim()
    if (!brandName) {
      wx.showToast({ title: '请填写品牌名称', icon: 'none' })
      return
    }

    const aliases = form.aliasesText
      .split(/[，,]/)
      .map(s => s.trim())
      .filter(Boolean)

    this.setData({ saving: true })
    try {
      wx.showLoading({ title: '保存中...', mask: true })
      const photos = await this.uploadPendingPhotos(form.photos)
      const productPayload = {
        brandName,
        productLine: form.productLine.trim(),
        aliases,
        photos
      }
      const res = await wx.cloud.callFunction({
        name: 'products',
        data: editingId
          ? { action: 'update', productId: editingId, product: productPayload }
          : { action: 'add', product: productPayload }
      })

      if (res.result && res.result.success) {
        wx.showToast({ title: '已保存', icon: 'success' })
        this.setData({ showEditor: false })
        this.loadProducts()
      } else {
        wx.showToast({ title: (res.result && res.result.error) || '保存失败', icon: 'none' })
      }
    } catch (err) {
      console.error('保存产品失败:', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ saving: false })
    }
  },

  // 下架产品（软删除）
  onRemoveProduct(e) {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅管理员可维护产品库', icon: 'none' })
      return
    }
    const item = e.currentTarget.dataset.item
    wx.showModal({
      title: '下架产品',
      content: `确定要下架「${item.brandName}」吗？下架后 AI 分析将不再参考这条产品资料，历史巡检报告不受影响。`,
      success: async (res) => {
        if (!res.confirm) return
        try {
          const result = await wx.cloud.callFunction({
            name: 'products',
            data: { action: 'remove', productId: item._id }
          })
          if (result.result && result.result.success) {
            wx.showToast({ title: '已下架', icon: 'success' })
            this.loadProducts()
          } else {
            wx.showToast({ title: '操作失败', icon: 'none' })
          }
        } catch (err) {
          console.error('下架产品失败:', err)
          wx.showToast({ title: '操作失败，请重试', icon: 'none' })
        }
      }
    })
  }
})
