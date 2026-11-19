// pages/reflection/reflection.js
// 管理员专属：查看定期 AI 复盘统计、误认/漏认根因分析、审批修正提案、一键撤销知识库变更

const api = require('../../utils/api')
const { formatDate } = require('../../utils/date')

const FIX_TYPE_LABELS = {
  confusable_add: '新增易混淆竞品',
  confusable_update: '更新易混淆竞品',
  confusable_retire: '下线易混淆竞品',
  product_confusion_notes: '补充我方区分要点',
  product_visual_features: '补充瓶身视觉特征',
  product_ref_photo: '补拍参考图待办',
  product_add_todo: '新品入库待办',
  ref_priority: '提升参考图优先级',
  alias_remove: '移除过宽别名',
  material_visual_features: '补充物料视觉特征',
  learned_rule_add: '新增识别规则补丁',
  learned_rule_retire: '下线规则补丁',
  threshold_adjust: '调整复核置信阈值',
  sales_tip: '拍照规范提醒',
  needs_dev: '需程序开发'
}

Page({
  data: {
    activeTab: 'report', // 'report' | 'changes'
    loading: true,
    runningReflection: false,
    knowledgeOverview: null,
    reportList: [],
    selectedReportId: '',
    currentReport: null,
    changesList: [],
    fixTypeLabels: FIX_TYPE_LABELS
  },

  onLoad(options) {
    this.loadOverviewAndList(options && options.id)
  },

  onPullDownRefresh() {
    this.loadOverviewAndList(this.data.selectedReportId).finally(() => wx.stopPullDownRefresh())
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab })
    if (tab === 'changes') {
      this.loadChanges()
    }
  },

  async loadOverviewAndList(preferredId = '') {
    this.setData({ loading: true })
    try {
      const res = await api.callFunction({
        name: 'reflection',
        data: { action: 'list', limit: 15 }
      })
      const r = res.result
      if (!r || !r.success) {
        wx.showToast({ title: (r && r.error) || '加载失败', icon: 'none' })
        this.setData({ loading: false })
        return
      }

      const list = (r.list || []).map(item => ({
        ...item,
        dateLabel: formatDate(item.createdAtIso || item.createdAt, 'MM-DD HH:mm')
      }))

      const targetId = preferredId || (list[0] && list[0]._id) || ''
      this.setData({
        knowledgeOverview: r.knowledgeOverview,
        reportList: list,
        selectedReportId: targetId,
        loading: false
      })

      if (targetId) {
        await this.loadReportDetail(targetId)
      } else {
        this.setData({ currentReport: null })
      }
    } catch (err) {
      this.setData({ loading: false })
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  async loadReportDetail(reflectionId) {
    if (!reflectionId) return
    try {
      const res = await api.callFunction({
        name: 'reflection',
        data: { action: 'get', reflectionId }
      })
      if (res.result && res.result.success && res.result.report) {
        const rep = res.result.report
        rep.createdAtFormatted = formatDate(rep.createdAtIso || rep.createdAt, 'YYYY-MM-DD HH:mm')
        this.setData({
          selectedReportId: reflectionId,
          currentReport: rep
        })
      }
    } catch (_) {}
  },

  onSelectReport(e) {
    const id = e.currentTarget.dataset.id
    if (id && id !== this.data.selectedReportId) {
      this.loadReportDetail(id)
    }
  },

  // 手动触发一次 AI 复盘
  async onRunReflectionNow() {
    if (this.data.runningReflection) return
    this.setData({ runningReflection: true })
    wx.showLoading({ title: 'AI 正在复盘总结...', mask: true })
    try {
      const res = await api.callFunction({
        name: 'reflection',
        data: { action: 'run', skipReplay: false }
      })
      wx.hideLoading()
      this.setData({ runningReflection: false })
      const r = res.result
      if (!r || !r.success) {
        wx.showToast({ title: (r && r.error) || '复盘失败', icon: 'none', duration: 2500 })
        return
      }
      if (r.skipped) {
        wx.showModal({
          title: '暂未生成新复盘',
          content: r.reason || '本期校正样本不足',
          showCancel: false
        })
        return
      }
      wx.showToast({ title: '复盘报告已生成', icon: 'success' })
      await this.loadOverviewAndList(r.reflectionId)
    } catch (err) {
      wx.hideLoading()
      this.setData({ runningReflection: false })
      wx.showToast({ title: err.message || '复盘失败', icon: 'none' })
    }
  },

  // 采纳或驳回提案
  async onDecideProposal(e) {
    const proposalId = e.currentTarget.dataset.id
    const decision = e.currentTarget.dataset.decision
    const fixType = e.currentTarget.dataset.fixtype
    const productId = e.currentTarget.dataset.productid
    const reflectionId = this.data.selectedReportId
    if (!reflectionId || !proposalId || !decision) return

    wx.showLoading({ title: decision === 'approve' ? '正在应用修正...' : '正在处理...', mask: true })
    try {
      const res = await api.callFunction({
        name: 'reflection',
        data: {
          action: 'decide',
          reflectionId,
          proposalId,
          decision
        }
      })
      wx.hideLoading()
      const r = res.result
      if (!r || !r.success) {
        wx.showToast({ title: (r && r.error) || '操作失败', icon: 'none' })
        return
      }
      wx.showToast({
        title: decision === 'approve' ? '已采纳并生效' : '已驳回',
        icon: 'success'
      })
      await this.loadOverviewAndList(reflectionId)

      // 如果是补拍产品参考图或新增产品待办，提示是否直接跳转产品库
      if (decision === 'approve' && (fixType === 'product_ref_photo' || fixType === 'product_add_todo')) {
        wx.showModal({
          title: '前往产品库处理',
          content: '该提案需要上传参考照片或新增品规，是否现在前往产品库？',
          confirmText: '去产品库',
          success: (mRes) => {
            if (mRes.confirm) {
              wx.navigateTo({
                url: `/pages/products/products${productId ? '?productId=' + productId : ''}`
              })
            }
          }
        })
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    }
  },

  async loadChanges() {
    try {
      const res = await api.callFunction({
        name: 'reflection',
        data: { action: 'changes', limit: 30 }
      })
      if (res.result && res.result.success) {
        const list = (res.result.list || []).map(c => ({
          ...c,
          appliedAtFormatted: formatDate(c.appliedAt, 'MM-DD HH:mm')
        }))
        this.setData({ changesList: list })
      }
    } catch (_) {}
  },

  async onUndoChange(e) {
    const changeId = e.currentTarget.dataset.id
    if (!changeId) return
    const modalRes = await new Promise(resolve => {
      wx.showModal({
        title: '撤销知识库修正',
        content: '撤销后将恢复该项修改前的配置，确定撤销吗？',
        confirmText: '确定撤销',
        confirmColor: '#d32f2f',
        success: resolve
      })
    })
    if (!modalRes || !modalRes.confirm) return

    wx.showLoading({ title: '正在撤销...', mask: true })
    try {
      const res = await api.callFunction({
        name: 'reflection',
        data: { action: 'undo', changeId }
      })
      wx.hideLoading()
      if (res.result && res.result.success) {
        wx.showToast({ title: '已撤销', icon: 'success' })
        this.loadChanges()
        this.loadOverviewAndList(this.data.selectedReportId)
      } else {
        wx.showToast({ title: (res.result && res.result.error) || '撤销失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '撤销失败', icon: 'none' })
    }
  },

  openEvidenceInspection(e) {
    const id = e.currentTarget.dataset.id
    if (id) {
      wx.navigateTo({ url: `/pages/report/report?id=${id}` })
    }
  },

  goProductsConfusables() {
    wx.navigateTo({ url: '/pages/products/products?tab=confusables' })
  }
})
