// pages/settings/settings.js
// 系统设置页 - 配置 AI 分析模式与集中分析时间、查看待分析队列、手动触发分析

const app = getApp()

function syncRole(role) {
  if (!role) return
  app.globalData.userRole = role
  if (app.globalData.userInfo) {
    app.globalData.userInfo.role = role
  }
}

Page({
  data: {
    loading: true,
    saving: false,
    running: false,
    canEdit: false,

    // 配置项
    analyzeMode: 'batch',       // batch = 每日集中分析；instant = 提交即分析
    analyzeTime: '21:00',
    windowMinutes: 180,
    batchSize: 2,

    // API Key（明文只在输入时存在于本页，保存后服务端只回掩码）
    hasApiKey: false,
    apiKeyMasked: '',
    apiKeyInput: '',

    // 队列统计
    queue: { pending: 0, analyzing: 0, failed: 0 },

    // 上次运行信息
    lastRunText: '',
    lastRunSummaryText: '',

    // 首管理员激活（仅当系统还没有任何管理员、且当前用户不是管理员时展示）
    showActivate: false,
    hasAdmin: false,
    activateCode: '',
    activating: false
  },

  onLoad() {
    this.loadSettings()
  },

  onShow() {
    // 从别的页面回来时刷新一下队列数字
    if (!this.data.loading) {
      this.loadSettings()
    }
  },

  onPullDownRefresh() {
    this.loadSettings().then(() => wx.stopPullDownRefresh())
  },

  async loadSettings() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'settings',
        data: { action: 'get' }
      })

      const result = res.result
      if (!result || !result.success) {
        throw new Error((result && result.error) || '读取设置失败')
      }

      const s = result.settings
      // 把服务端认定的最新角色同步到全局，避免激活后跳转到 admin 页时被旧角色拦住
      syncRole(result.role)

      this.setData({
        loading: false,
        canEdit: result.canEdit,
        hasAdmin: result.hasAdmin,
        showActivate: (!result.canEdit && !result.hasAdmin),
        analyzeMode: s.analyzeMode,
        analyzeTime: s.analyzeTime,
        windowMinutes: s.windowMinutes,
        batchSize: s.batchSize,
        hasApiKey: s.hasApiKey,
        apiKeyMasked: s.apiKeyMasked,
        queue: result.queue,
        lastRunText: this.formatLastRun(s.lastRunAt, s.lastRunTriggeredBy),
        lastRunSummaryText: this.formatSummary(s.lastRunSummary)
      })
    } catch (err) {
      console.error('读取设置失败:', err)
      this.setData({ loading: false })
      wx.showToast({ title: err.message || '读取设置失败', icon: 'none' })
    }
  },

  formatLastRun(lastRunAt, triggeredBy) {
    if (!lastRunAt) return '尚未运行过'
    const d = new Date(lastRunAt)
    const pad = n => String(n).padStart(2, '0')
    const text = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    return `${text}（${triggeredBy === 'manual' ? '手动' : '定时'}）`
  },

  formatSummary(summary) {
    if (!summary) return ''
    return `处理 ${summary.processed} 条，成功 ${summary.succeeded}，失败 ${summary.failed}，剩余 ${summary.remaining}`
  },

  // ---------- 表单交互 ----------

  onSelectMode(e) {
    if (!this.checkEditable()) return
    this.setData({ analyzeMode: e.currentTarget.dataset.mode })
  },

  onTimeChange(e) {
    if (!this.checkEditable()) return
    this.setData({ analyzeTime: e.detail.value })
  },

  onWindowInput(e) {
    this.setData({ windowMinutes: e.detail.value })
  },

  onBatchSizeInput(e) {
    this.setData({ batchSize: e.detail.value })
  },

  onApiKeyInput(e) {
    this.setData({ apiKeyInput: e.detail.value })
  },

  checkEditable() {
    if (!this.data.canEdit) {
      wx.showToast({ title: '只有管理员可以修改', icon: 'none' })
      return false
    }
    return true
  },

  // ---------- 保存 ----------

  async onSave() {
    if (!this.checkEditable()) return
    if (this.data.saving) return

    const payload = {
      analyzeMode: this.data.analyzeMode,
      analyzeTime: this.data.analyzeTime,
      windowMinutes: this.data.windowMinutes,
      batchSize: this.data.batchSize
    }
    // 输入框留空表示"不改动已有 Key"，不要把空值传上去覆盖掉
    if (this.data.apiKeyInput && this.data.apiKeyInput.trim()) {
      payload.dashscopeApiKey = this.data.apiKeyInput.trim()
    }

    this.setData({ saving: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'settings',
        data: { action: 'save', settings: payload }
      })
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.error) || '保存失败')
      }
      this.setData({ apiKeyInput: '' })
      wx.showToast({ title: '已保存', icon: 'success' })
      this.loadSettings()
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    }
    this.setData({ saving: false })
  },

  async onClearApiKey() {
    if (!this.checkEditable()) return
    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: '清除 API Key',
        content: '清除后将改用云函数环境变量里的 Key；若环境变量也没配置，分析会返回模拟报告。确定清除？',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirm) return

    try {
      const res = await wx.cloud.callFunction({
        name: 'settings',
        data: { action: 'save', settings: { clearApiKey: true } }
      })
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.error) || '清除失败')
      }
      wx.showToast({ title: '已清除', icon: 'success' })
      this.loadSettings()
    } catch (err) {
      wx.showToast({ title: err.message || '清除失败', icon: 'none' })
    }
  },

  // ---------- 手动触发分析 ----------

  async onRunNow() {
    if (!this.checkEditable()) return
    if (this.data.running) return

    if (this.data.queue.pending === 0) {
      wx.showToast({ title: '没有待分析的记录', icon: 'none' })
      return
    }

    this.setData({ running: true })
    wx.showLoading({ title: '分析中...', mask: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'batchAnalyze',
        data: { action: 'runNow' }
      })
      wx.hideLoading()

      const r = res.result || {}
      if (!r.success) {
        throw new Error(r.error || '触发失败')
      }

      wx.showModal({
        title: '本轮完成',
        content: `成功 ${r.succeeded} 条，失败 ${r.failed} 条，还剩 ${r.remaining} 条待分析。\n\n` +
          (r.remaining > 0 ? '单次调用受云函数超时限制，可以再点一次继续处理剩余记录。' : '队列已清空。'),
        showCancel: false
      })
      this.loadSettings()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '触发失败', icon: 'none' })
    }

    this.setData({ running: false })
  },

  // ---------- 重排失败记录 ----------

  async onRetryFailed() {
    if (!this.checkEditable()) return
    if (this.data.queue.failed === 0) {
      wx.showToast({ title: '没有失败的记录', icon: 'none' })
      return
    }

    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: '重新分析失败记录',
        content: `将把 ${this.data.queue.failed} 条分析失败的记录重新放回待分析队列，下次集中分析时再试一遍。`,
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirm) return

    try {
      const res = await wx.cloud.callFunction({
        name: 'settings',
        data: { action: 'retryFailed' }
      })
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.error) || '操作失败')
      }
      wx.showToast({ title: `已重排 ${res.result.updated} 条`, icon: 'none' })
      this.loadSettings()
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    }
  },

  // ---------- 首管理员激活 ----------

  onActivateInput(e) {
    this.setData({ activateCode: e.detail.value })
  },

  async onActivate() {
    if (this.data.activating) return
    if (!this.data.activateCode || !this.data.activateCode.trim()) {
      wx.showToast({ title: '请输入激活码', icon: 'none' })
      return
    }
    this.setData({ activating: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'settings',
        data: { action: 'activateAdmin', code: this.data.activateCode.trim() }
      })
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.error) || '激活失败')
      }
      wx.showToast({ title: '已激活为管理员', icon: 'success' })
      // 激活成功后立即同步全局角色，避免此时点进 admin 页被旧角色拦住
      syncRole('admin')
      // 刷新一下页面（canEdit 会变 true、隐藏激活卡片）
      this.setData({ activateCode: '' })
      this.loadSettings()
    } catch (err) {
      wx.showToast({ title: err.message || '激活失败', icon: 'none' })
    }
    this.setData({ activating: false })
  },

  // ---------- 进入用户与权限管理后台（仅管理员） ----------

  goAdmin() {
    if (!this.data.canEdit) {
      wx.showToast({ title: '只有管理员可以访问', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/admin/admin' })
  }
})
