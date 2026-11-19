// pages/review/review.js
// 管理员专属：手机端看照片校正 AI 识别事实 + 实时预览分数 + 队列跳转下一条

const api = require('../../utils/api')
const app = getApp()

const POSITIONS = ['黄金位', '中层', '上层', '下层', '堆头', '其他']

const FALSE_OWN_REASONS = [
  { key: 'look_alike', label: '瓶身/颜色外观相似' },
  { key: 'similar_name', label: '酒标名称字样相近' },
  { key: 'blur_or_far', label: '照片模糊或拍摄较远' },
  { key: 'other', label: '其他原因' }
]

const MISSED_OWN_REASONS = [
  { key: 'side_or_back_facing', label: '侧摆或背标朝外未认出' },
  { key: 'occlusion_or_glare', label: '反光/遮挡/位置偏远' },
  { key: 'new_package', label: '新包装或新品未入库' },
  { key: 'gift_box', label: '礼盒或整箱陈列形态' },
  { key: 'other', label: '其他原因' }
]

Page({
  data: {
    inspectionId: '',
    loading: true,
    saving: false,
    inspection: null,
    currentPhotoIndex: 0,

    // 可编辑事实
    facts: {
      hasShelfPhoto: true,
      ownBrandPresent: true,
      ownProducts: [],
      competitorProducts: [],
      goldenFacings: 0,
      frontLabelFacings: 0,
      priceTagTier: 'good',
      bannerTier: 'none',
      totalShelfFacingCount: null
    },
    totalOwnFacings: 0,
    activeProducts: [],
    productLabels: [],
    positions: POSITIONS,
    confusableNames: [],
    annotations: [], // 逐项结构化修改原因
    note: '',

    // 分数预览（与原始分对比）
    originalScore: null,
    preview: null,
    showCompetitors: false,

    // 弹窗1：标记「不是我方产品」并填写实际是什么酒
    showFalseOwnModal: false,
    falseOwnTargetIndex: -1,
    falseOwnReason: 'look_alike',
    falseOwnActualProduct: '',
    falseOwnReasons: FALSE_OWN_REASONS,

    // 弹窗2：补充「漏识别的我方产品」
    showAddOwnModal: false,
    addOwnProductIndex: 0,
    addOwnFacings: 1,
    addOwnPosition: '黄金位',
    addOwnReason: 'side_or_back_facing',
    missedOwnReasons: MISSED_OWN_REASONS,

    // 队列进度
    hasNextInQueue: false,
    nextInspectionId: ''
  },

  onLoad(options) {
    if (options && options.id) {
      this.setData({ inspectionId: options.id })
      this.loadReviewContext(options.id)
    }
  },

  computeNextInQueue(currentId) {
    const queue = (app.globalData && Array.isArray(app.globalData.reviewQueue))
      ? app.globalData.reviewQueue
      : []
    const idx = queue.indexOf(currentId)
    if (idx !== -1 && idx + 1 < queue.length) {
      return queue[idx + 1]
    }
    return ''
  },

  async loadReviewContext(id) {
    this.setData({ loading: true })
    try {
      const res = await api.callFunction({
        name: 'reviewReport',
        data: { action: 'get', inspectionId: id }
      })
      const r = res.result
      if (!r || !r.success) {
        wx.showToast({ title: (r && r.error) || '无权访问或加载失败', icon: 'none' })
        this.setData({ loading: false })
        return
      }

      const activeProducts = r.activeProducts || []
      const productLabels = activeProducts.map(p => p.label || [p.brandName, p.productLine].filter(Boolean).join(' '))
      const facts = r.facts || this.data.facts
      const totalOwnFacings = (facts.ownProducts || []).reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
      const nextId = this.computeNextInQueue(id)

      this.setData({
        loading: false,
        inspection: r.inspection,
        facts,
        totalOwnFacings,
        activeProducts,
        productLabels,
        confusableNames: r.confusableNames || [],
        originalScore: r.inspection && r.inspection.aiReport ? r.inspection.aiReport.score : null,
        annotations: [],
        note: '',
        currentPhotoIndex: 0,
        hasNextInQueue: Boolean(nextId),
        nextInspectionId: nextId
      })

      this.refreshPreview()
    } catch (err) {
      this.setData({ loading: false })
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  onSwiperChange(e) {
    this.setData({ currentPhotoIndex: (e.detail && e.detail.current) || 0 })
  },

  previewPhoto(e) {
    const url = e.currentTarget.dataset.url
    const urls = (this.data.inspection && this.data.inspection.photoURLs) || []
    if (url) {
      wx.previewImage({ current: url, urls })
    }
  },

  // 同步更新 totalOwnFacings 并裁剪 goldenFacings / frontLabelFacings，再请求服务端预览分
  syncFacingsAndPreview(nextFacts, extraAnnotations = null) {
    const ownList = Array.isArray(nextFacts.ownProducts) ? nextFacts.ownProducts : []
    const totalOwn = ownList.reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
    nextFacts.ownBrandPresent = nextFacts.hasShelfPhoto ? (totalOwn > 0) : null
    if (nextFacts.goldenFacings > totalOwn) nextFacts.goldenFacings = totalOwn
    if (nextFacts.frontLabelFacings > totalOwn) nextFacts.frontLabelFacings = totalOwn

    const nextData = {
      facts: nextFacts,
      totalOwnFacings: totalOwn
    }
    if (extraAnnotations) {
      nextData.annotations = extraAnnotations
    }
    this.setData(nextData)
    this.refreshPreview()
  },

  async refreshPreview() {
    if (this._previewTimer) clearTimeout(this._previewTimer)
    this._previewTimer = setTimeout(async () => {
      try {
        const res = await api.callFunction({
          name: 'reviewReport',
          data: {
            action: 'preview',
            inspectionId: this.data.inspectionId,
            facts: this.data.facts
          }
        })
        if (res.result && res.result.success) {
          this.setData({ preview: res.result.preview })
        }
      } catch (_) {}
    }, 120)
  },

  // 我方产品：排面数 -/+
  onStepOwnFacing(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const delta = Number(e.currentTarget.dataset.delta) || 0
    const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
    const item = nextFacts.ownProducts[idx]
    if (!item) return
    const nextCount = Math.max(1, Math.min(200, (Number(item.facingCount) || 1) + delta))
    item.facingCount = nextCount
    this.syncFacingsAndPreview(nextFacts)
  },

  // 我方产品：切换层位
  onChangeOwnPosition(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const posIdx = Number(e.detail.value) || 0
    const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
    if (!nextFacts.ownProducts[idx]) return
    nextFacts.ownProducts[idx].position = POSITIONS[posIdx] || '中层'
    this.syncFacingsAndPreview(nextFacts)
  },

  // 我方产品：更换品规（当 AI 把特8认成经典时）
  onChangeOwnProductSku(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const pIdx = Number(e.detail.value) || 0
    const prod = this.data.activeProducts[pIdx]
    if (!prod) return
    const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
    const item = nextFacts.ownProducts[idx]
    if (!item) return
    const prevSku = [item.brand, item.productLine].filter(Boolean).join(' ')
    item.productId = prod._id
    item.brand = prod.brandName
    item.productLine = prod.productLine || ''
    const nextSku = [item.brand, item.productLine].filter(Boolean).join(' ')

    const anns = [...this.data.annotations]
    if (prevSku !== nextSku) {
      anns.push({
        type: 'wrong_sku',
        slotKey: item.slotKey,
        productId: prod._id,
        sku: nextSku,
        aiValue: prevSku,
        humanValue: nextSku,
        reason: 'series_look_alike',
        photoIndex: (this.data.currentPhotoIndex || 0) + 1
      })
    }
    this.syncFacingsAndPreview(nextFacts, anns)
  },

  // 打开「不是我方产品（竞品误认）」弹窗
  onOpenFalseOwnModal(e) {
    const idx = Number(e.currentTarget.dataset.index)
    this.setData({
      showFalseOwnModal: true,
      falseOwnTargetIndex: idx,
      falseOwnReason: 'look_alike',
      falseOwnActualProduct: ''
    })
  },

  onCancelFalseOwnModal() {
    this.setData({ showFalseOwnModal: false, falseOwnTargetIndex: -1 })
  },

  onSelectFalseOwnReason(e) {
    this.setData({ falseOwnReason: e.currentTarget.dataset.key })
  },

  onInputFalseOwnActual(e) {
    this.setData({ falseOwnActualProduct: e.detail.value })
  },

  onPickConfusableChip(e) {
    this.setData({ falseOwnActualProduct: e.currentTarget.dataset.name || '' })
  },

  onConfirmFalseOwn() {
    const idx = this.data.falseOwnTargetIndex
    const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
    const item = nextFacts.ownProducts[idx]
    if (!item) {
      this.onCancelFalseOwnModal()
      return
    }
    const removedSku = [item.brand, item.productLine].filter(Boolean).join(' ')
    const actualName = String(this.data.falseOwnActualProduct || '').trim()

    nextFacts.ownProducts.splice(idx, 1)
    if (actualName) {
      nextFacts.competitorProducts.push({
        slotKey: `comp_from_${item.slotKey}`,
        brand: actualName,
        productLine: '',
        facingCount: item.facingCount,
        position: item.position || '中层',
        confidence: 1
      })
    }

    const anns = [...this.data.annotations, {
      type: 'false_own',
      slotKey: item.slotKey,
      productId: item.productId || '',
      sku: removedSku,
      reason: this.data.falseOwnReason,
      actualProduct: actualName || '未注明竞品',
      photoIndex: (this.data.currentPhotoIndex || 0) + 1
    }]

    this.setData({ showFalseOwnModal: false, falseOwnTargetIndex: -1 })
    this.syncFacingsAndPreview(nextFacts, anns)
  },

  // 打开「补充漏识别的我方产品」弹窗
  onOpenAddOwnModal() {
    if (this.data.activeProducts.length === 0) {
      wx.showToast({ title: '产品库为空，请先在产品库添加我方产品', icon: 'none' })
      return
    }
    this.setData({
      showAddOwnModal: true,
      addOwnProductIndex: 0,
      addOwnFacings: 1,
      addOwnPosition: '黄金位',
      addOwnReason: 'side_or_back_facing'
    })
  },

  onCancelAddOwnModal() {
    this.setData({ showAddOwnModal: false })
  },

  onPickAddOwnProduct(e) {
    this.setData({ addOwnProductIndex: Number(e.detail.value) || 0 })
  },

  onStepAddOwnFacings(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 0
    this.setData({
      addOwnFacings: Math.max(1, Math.min(100, this.data.addOwnFacings + delta))
    })
  },

  onPickAddOwnPosition(e) {
    const pIdx = Number(e.detail.value) || 0
    this.setData({ addOwnPosition: POSITIONS[pIdx] || '黄金位' })
  },

  onSelectAddOwnReason(e) {
    this.setData({ addOwnReason: e.currentTarget.dataset.key })
  },

  onConfirmAddOwn() {
    const prod = this.data.activeProducts[this.data.addOwnProductIndex]
    if (!prod) return
    const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
    const slotKey = `added_${Date.now()}`
    const addedFacings = this.data.addOwnFacings
    const pos = this.data.addOwnPosition

    nextFacts.ownProducts.push({
      slotKey,
      productId: prod._id,
      brand: prod.brandName,
      productLine: prod.productLine || '',
      facingCount: addedFacings,
      position: pos,
      confidence: 1
    })

    if (pos === '黄金位') {
      nextFacts.goldenFacings = (Number(nextFacts.goldenFacings) || 0) + addedFacings
    }
    nextFacts.frontLabelFacings = (Number(nextFacts.frontLabelFacings) || 0) + addedFacings

    const anns = [...this.data.annotations, {
      type: 'missed_own',
      slotKey,
      productId: prod._id,
      sku: [prod.brandName, prod.productLine].filter(Boolean).join(' '),
      reason: this.data.addOwnReason,
      photoIndex: (this.data.currentPhotoIndex || 0) + 1
    }]

    this.setData({ showAddOwnModal: false })
    this.syncFacingsAndPreview(nextFacts, anns)
  },

  toggleCompetitors() {
    this.setData({ showCompetitors: !this.data.showCompetitors })
  },

  // 竞品行点「其实是我方」：将误判为竞品的条目转为我方标准产品
  onConvertCompToOwn(e) {
    const compIdx = Number(e.currentTarget.dataset.index)
    if (this.data.activeProducts.length === 0) {
      wx.showToast({ title: '请先在产品库添加我方产品', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: this.data.productLabels.slice(0, 6),
      success: (res) => {
        const prod = this.data.activeProducts[res.tapIndex]
        if (!prod) return
        const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
        const comp = nextFacts.competitorProducts[compIdx]
        if (!comp) return
        nextFacts.competitorProducts.splice(compIdx, 1)
        const slotKey = comp.slotKey || `comp_conv_${Date.now()}`
        nextFacts.ownProducts.push({
          slotKey,
          productId: prod._id,
          brand: prod.brandName,
          productLine: prod.productLine || '',
          facingCount: comp.facingCount || 1,
          position: comp.position || '中层',
          confidence: 1
        })
        nextFacts.frontLabelFacings = (Number(nextFacts.frontLabelFacings) || 0) + (comp.facingCount || 1)

        const anns = [...this.data.annotations, {
          type: 'own_as_competitor',
          slotKey,
          productId: prod._id,
          sku: [prod.brandName, prod.productLine].filter(Boolean).join(' '),
          aiValue: [comp.brand, comp.productLine].filter(Boolean).join(' '),
          reason: 'side_or_back_facing',
          photoIndex: (this.data.currentPhotoIndex || 0) + 1
        }]
        this.syncFacingsAndPreview(nextFacts, anns)
      }
    })
  },

  // 黄金位排面数 -/+
  onStepGoldenFacings(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 0
    const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
    const max = this.data.totalOwnFacings
    nextFacts.goldenFacings = Math.max(0, Math.min(max, (Number(nextFacts.goldenFacings) || 0) + delta))
    this.syncFacingsAndPreview(nextFacts)
  },

  // 正标朝外排面数 -/+
  onStepFrontLabelFacings(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 0
    const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
    const max = this.data.totalOwnFacings
    nextFacts.frontLabelFacings = Math.max(0, Math.min(max, (Number(nextFacts.frontLabelFacings) || 0) + delta))
    this.syncFacingsAndPreview(nextFacts)
  },

  onSelectPriceTagTier(e) {
    const tier = e.currentTarget.dataset.tier
    const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
    nextFacts.priceTagTier = tier
    this.syncFacingsAndPreview(nextFacts)
  },

  onSelectBannerTier(e) {
    const tier = e.currentTarget.dataset.tier
    const nextFacts = JSON.parse(JSON.stringify(this.data.facts))
    nextFacts.bannerTier = tier
    this.syncFacingsAndPreview(nextFacts)
  },

  onInputNote(e) {
    this.setData({ note: e.detail.value })
  },

  // 确认识别无误（不改数据，直接移出待复核队列并跳下一条）
  async onConfirmAccurate() {
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '正在确认...', mask: true })
    try {
      const res = await api.callFunction({
        name: 'reviewReport',
        data: {
          action: 'confirm',
          inspectionId: this.data.inspectionId,
          expectedRevision: this.data.inspection ? this.data.inspection.reviewRevision : 0,
          note: this.data.note
        }
      })
      wx.hideLoading()
      this.setData({ saving: false })
      if (!res.result || !res.result.success) {
        wx.showToast({ title: (res.result && res.result.error) || '确认失败', icon: 'none' })
        return
      }
      app.globalData.listVersion = ((app.globalData.listVersion) || 0) + 1
      this.afterReviewSaved('已确认无误')
    } catch (err) {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: err.message || '确认失败', icon: 'none' })
    }
  },

  // 保存人工校正并重新生成报告
  async onSaveCorrection() {
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '重算并保存中...', mask: true })
    try {
      const res = await api.callFunction({
        name: 'reviewReport',
        data: {
          action: 'save',
          inspectionId: this.data.inspectionId,
          expectedRevision: this.data.inspection ? this.data.inspection.reviewRevision : 0,
          facts: this.data.facts,
          annotations: this.data.annotations,
          note: this.data.note
        }
      })
      wx.hideLoading()
      this.setData({ saving: false })
      if (!res.result || !res.result.success) {
        wx.showToast({ title: (res.result && res.result.error) || '保存失败', icon: 'none' })
        return
      }
      app.globalData.listVersion = ((app.globalData.listVersion) || 0) + 1
      this.afterReviewSaved('校正已保存，报告已更新')
    } catch (err) {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    }
  },

  // 撤销人工校正，恢复 AI 原始报告
  async onDiscardCorrection() {
    const modalRes = await new Promise(resolve => {
      wx.showModal({
        title: '恢复 AI 原始结果',
        content: '确定撤销当前人工校正，恢复为 AI 最初识别的报告吗？',
        confirmText: '恢复原始',
        confirmColor: '#d32f2f',
        success: resolve
      })
    })
    if (!modalRes || !modalRes.confirm) return

    wx.showLoading({ title: '正在恢复...', mask: true })
    try {
      const res = await api.callFunction({
        name: 'reviewReport',
        data: {
          action: 'discardCorrection',
          inspectionId: this.data.inspectionId
        }
      })
      wx.hideLoading()
      if (res.result && res.result.success) {
        app.globalData.listVersion = ((app.globalData.listVersion) || 0) + 1
        wx.showToast({ title: '已恢复原始报告', icon: 'success' })
        this.loadReviewContext(this.data.inspectionId)
      } else {
        wx.showToast({ title: (res.result && res.result.error) || '恢复失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '恢复失败', icon: 'none' })
    }
  },

  afterReviewSaved(toastTitle) {
    // 从内存队列中移除当前已处理 ID
    if (app.globalData && Array.isArray(app.globalData.reviewQueue)) {
      app.globalData.reviewQueue = app.globalData.reviewQueue.filter(id => id !== this.data.inspectionId)
    }
    const nextId = this.data.nextInspectionId
    if (nextId) {
      wx.showToast({ title: `${toastTitle}，进入下一条`, icon: 'none', duration: 1200 })
      setTimeout(() => {
        this.setData({ inspectionId: nextId })
        this.loadReviewContext(nextId)
      }, 600)
    } else {
      wx.showToast({ title: toastTitle, icon: 'success', duration: 1200 })
      setTimeout(() => {
        wx.navigateBack({ delta: 1 })
      }, 800)
    }
  }
})
