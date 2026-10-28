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
    imageMode: 'traffic', // traffic | quality

    // API Key（明文只在输入时存在于本页，保存后服务端只回掩码）
    hasApiKey: false,
    apiKeyMasked: '',
    apiKeyInput: '',

    // 队列统计（sales 为本人；admin/manager 为团队）
    queue: { pending: 0, analyzing: 0, failed: 0, scope: 'self' },
    queueScopeLabel: '我的队列',

    // 上次运行信息
    lastRunText: '',
    lastRunSummaryText: '',

    // 进销存同步相关
    jxcBaseUrl: '',
    hasJxcApiKey: false,
    jxcApiKeyMasked: '',
    jxcApiKeyInput: '',
    jxcLastSyncText: '',
    jxcLastSyncSummaryText: '',
    syncingJxc: false,

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

      // 同步到全局，供相机页读取
      app.globalData.systemConfig = {
        ...(app.globalData.systemConfig || {}),
        analyzeMode: s.analyzeMode,
        analyzeTime: s.analyzeTime,
        imageMode: s.imageMode === 'quality' ? 'quality' : 'traffic'
      }

      this.setData({
        loading: false,
        canEdit: result.canEdit,
        hasAdmin: result.hasAdmin,
        showActivate: (!result.canEdit && !result.hasAdmin),
        analyzeMode: s.analyzeMode,
        analyzeTime: s.analyzeTime,
        windowMinutes: s.windowMinutes,
        batchSize: s.batchSize,
        imageMode: s.imageMode === 'quality' ? 'quality' : 'traffic',
        hasApiKey: s.hasApiKey,
        apiKeyMasked: s.apiKeyMasked,
        queue: result.queue || { pending: 0, analyzing: 0, failed: 0, scope: 'self' },
        queueScopeLabel: (result.queue && result.queue.scope === 'team') ? '团队队列' : '我的队列',
        lastRunText: this.formatLastRun(s.lastRunAt, s.lastRunTriggeredBy),
        lastRunSummaryText: this.formatSummary(s.lastRunSummary),
        jxcBaseUrl: s.jxcBaseUrl || '',
        hasJxcApiKey: s.hasJxcApiKey || false,
        jxcApiKeyMasked: s.jxcApiKeyMasked || '',
        jxcLastSyncText: this.formatLastRun(s.jxcLastSyncAt, s.jxcLastSyncTriggeredBy),
        jxcLastSyncSummaryText: this.formatJxcSummary(s.jxcLastSyncSummary)
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

  formatJxcSummary(summary) {
    if (!summary) return ''
    return `拉取 ${summary.totalFetched} 条，新增 ${summary.added}，更新 ${summary.updated}，无变动 ${summary.unchanged}${summary.errors ? '，异常 ' + summary.errors : ''}`
  },

  // ---------- 表单交互 ----------

  onSelectMode(e) {
    if (!this.checkEditable()) return
    this.setData({ analyzeMode: e.currentTarget.dataset.mode })
  },

  onSelectImageMode(e) {
    // 识别精度 vs 流量：所有人可改本机偏好；管理员保存时还会写入团队默认
    const mode = e.currentTarget.dataset.mode
    if (mode !== 'quality' && mode !== 'traffic') return
    this.setData({ imageMode: mode })
    try { wx.setStorageSync('shelfguard_imageMode', mode) } catch (_) {}
    app.globalData.systemConfig = {
      ...(app.globalData.systemConfig || {}),
      imageMode: mode
    }
    if (!this.data.canEdit) {
      wx.showToast({ title: mode === 'quality' ? '已选精度优先' : '已选流量优先', icon: 'none' })
    }
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

  onJxcBaseUrlInput(e) {
    this.setData({ jxcBaseUrl: e.detail.value })
  },

  onJxcApiKeyInput(e) {
    this.setData({ jxcApiKeyInput: e.detail.value })
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
      batchSize: this.data.batchSize,
      imageMode: this.data.imageMode,
      jxcBaseUrl: this.data.jxcBaseUrl
    }
    // 输入框留空表示"不改动已有 Key"，不要把空值传上去覆盖掉
    if (this.data.apiKeyInput && this.data.apiKeyInput.trim()) {
      payload.dashscopeApiKey = this.data.apiKeyInput.trim()
    }
    if (this.data.jxcApiKeyInput && this.data.jxcApiKeyInput.trim()) {
      payload.jxcApiKey = this.data.jxcApiKeyInput.trim()
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
      this.setData({ apiKeyInput: '', jxcApiKeyInput: '' })
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

  async onClearJxcApiKey() {
    if (!this.checkEditable()) return
    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: '清除进销存 API Key',
        content: '清除后将暂停自动拉取进销存客户。确定清除？',
        success: r => resolve(r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirm) return

    try {
      const res = await wx.cloud.callFunction({
        name: 'settings',
        data: { action: 'save', settings: { clearJxcApiKey: true } }
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

  async onManualSyncJxc() {
    if (!this.checkEditable()) return
    if (this.data.syncingJxc) return

    this.setData({ syncingJxc: true })
    wx.showLoading({ title: '正在同步客户...', mask: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'syncJxcCustomers',
        data: { manual: true }
      })
      wx.hideLoading()

      const result = res.result
      if (!result || !result.success) {
        throw new Error((result && result.error) || '同步失败')
      }

      const s = result.summary || {}
      wx.showModal({
        title: '同步完成',
        content: `成功从进销存拉取 ${s.totalFetched || 0} 家客户\n新增: ${s.added || 0} 家\n更新: ${s.updated || 0} 家\n无变动: ${s.unchanged || 0} 家${s.errors ? '\n异常: ' + s.errors + ' 家' : ''}`,
        showCancel: false
      })
      this.loadSettings()
    } catch (err) {
      wx.hideLoading()
      console.error('手动同步进销存失败:', err)
      wx.showModal({
        title: '同步失败',
        content: err.message || '网络连接或接口配置异常，请检查服务地址与 API Key',
        showCancel: false
      })
    } finally {
      this.setData({ syncingJxc: false })
    }
  },

  // ---------- 手动触发分析 ----------

  async onRunNow() {
    if (!this.checkEditable()) return
    if (this.data.running) return

    // analyzing > 0 时也放行：云函数会在开跑前先回收卡死的记录，
    // 回收完它们就变成 pending 可以立刻处理。这里若只看 pending 会把用户挡在门外，
    // 明明界面上有 3 条转圈的记录，却提示"没有待分析的记录"。
    if (this.data.queue.pending === 0 && this.data.queue.analyzing === 0) {
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
      // 一条记录要跑 30-45 秒，客户端等待很容易先一步超时。
      // 这种情况云端其实还在正常跑，不能让用户以为失败了又反复点，
      // 那样只会堆积重复触发。提示他过一会儿刷新看结果。
      const msg = String(err.message || '')
      if (/timeout|超时/i.test(msg)) {
        wx.showModal({
          title: '云端仍在分析',
          content: '等待响应超时，但云端任务通常还在继续跑。请稍等 1 分钟后下拉刷新查看结果，不要重复点击。',
          showCancel: false
        })
      } else {
        wx.showToast({ title: msg || '触发失败', icon: 'none' })
      }
    }

    this.setData({ running: false })
  },

  // ---------- 重排失败记录 ----------

  async onRetryFailed() {
    if (!this.checkEditable()) return

    // 卡在"分析中"的记录也算需要重排的对象：云函数被超时杀掉时来不及写失败状态，
    // 这类记录会一直转圈但 failed 计数是 0。只看 failed 会让按钮点不动。
    const { failed = 0, analyzing = 0 } = this.data.queue
    if (failed === 0 && analyzing === 0) {
      wx.showToast({ title: '没有需要重排的记录', icon: 'none' })
      return
    }

    const parts = []
    if (failed > 0) parts.push(`${failed} 条分析失败`)
    if (analyzing > 0) parts.push(`${analyzing} 条卡在分析中（超过 3 分钟的）`)

    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: '重新分析',
        content: `将把 ${parts.join('、')} 的记录放回待分析队列，重试次数清零。`,
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
      const r = res.result
      wx.showToast({
        title: r.updated > 0 ? `已重排 ${r.updated} 条` : '没有符合条件的记录',
        icon: 'none'
      })
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
