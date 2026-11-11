// app.js
// 应用入口 - 全局状态管理、登录

const api = require('./utils/api')
const offlineQueue = require('./utils/offlineQueue')

// 统一错误处理工具
const toast = (title, icon = 'none', duration = 2000) => {
  wx.showToast({ title, icon, duration })
}

const showLoading = (title = '加载中...') => {
  wx.showLoading({ title, mask: true })
}

const hideLoading = () => {
  wx.hideLoading()
}

// 团队统一的拍照上传策略缓存（服务端 settings.global.imageMode 的本机副本）
const TEAM_IMAGE_MODE_KEY = 'shelfguard_teamImageMode'
const DEFAULT_IMAGE_MODE = 'traffic'
const NAME_MAX_LEN = 20

function normalizeName(raw) {
  return String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim()
}

App({
  onLaunch: function () {
    // 隐私授权拦截：自微信基础库 2.32.3 起，调用相机/位置等敏感接口前
    // 必须先让用户同意《隐私保护指引》。这里注册全局拦截，当小程序首次
    // 触发隐私协议时，在当前页（相机页）弹出自定义同意窗，同意后调用
    // resolve({ event, resolve }) 让被拦截的接口继续授权。
    if (typeof wx.onNeedPrivacyAuthorize === 'function') {
      wx.onNeedPrivacyAuthorize((resolve, event) => {
        const app = getApp()
        app.globalData._privacyResolve = resolve
        app.globalData._privacyEvent = event
        const pages = getCurrentPages()
        const curPage = pages[pages.length - 1]
        if (curPage && typeof curPage.showPrivacyAuthorize === 'function') {
          curPage.showPrivacyAuthorize()
        } else {
          // 当前页还没挂载弹窗组件，记下标记等 onShow 补弹
          app.globalData._privacyPending = true
        }
      })
    }

    // 网络恢复时自动冲刷离线待上传
    if (typeof wx.onNetworkStatusChange === 'function') {
      wx.onNetworkStatusChange((res) => {
        if (res.isConnected) {
          this.flushOfflineQueueQuiet()
        }
      })
    }

    // 旧版本里「拍照上传策略」是每台手机各自选的（本机偏好 shelfguard_imageMode），
    // 现在改成管理员在「管理」里统一设置、全员生效，清掉旧的本机偏好，避免它盖过团队设置
    try { wx.removeStorageSync('shelfguard_imageMode') } catch (_) {}
    // 任务名称已固定为默认值，清掉旧版本记住的「上次任务名」
    try { wx.removeStorageSync('shelfguard_lastTaskName') } catch (_) {}
    // 先用上次缓存的团队设置，登录后再从服务端刷新
    try {
      const cachedMode = wx.getStorageSync(TEAM_IMAGE_MODE_KEY)
      if (cachedMode === 'quality' || cachedMode === 'traffic') {
        this.globalData.systemConfig.imageMode = cachedMode
      }
    } catch (_) {}

    // 用户登录
    this.login()
  },

  globalData: {
    // 用户信息
    userInfo: null,
    openid: null,
    isLoggedIn: false,
    // 当前用户的角色与停用状态（登录后由 login 云函数返回；权限边界以服务端为准）
    userRole: 'sales',
    userDisabled: false,
    userApproved: false,
    // 还没填业务员姓名（首次登录）：弹出必填的姓名输入框
    needsName: false,
    
    // 当前巡检任务
    currentTask: {
      taskName: '',
      storeName: '',
      userName: ''
    },

    // 客户选择器（camera 页 -> customers 页选择模式 -> 选完返回）用来中转数据的字段，
    // 用完即清空，不要指望它长期存值
    selectedCustomer: null,

    // 「继续拜访下一家」通信标记：upload 页提交后点了继续，回相机页 onShow 读它并清空
    startNextVisit: false,

    // 隐私授权拦截回调暂存：wx.onNeedPrivacyAuthorize 触发时填入 resolve/event，
    // 弹窗「同意」后调用 resolve({ event, resolve }) 放行被拦截的接口；
    // _privacyPending 用于组件尚未挂载时的补弹标记
    _privacyResolve: null,
    _privacyEvent: null,
    _privacyPending: false,

    // 分析模式/集中分析时间缓存（upload 页首屏先用它避免闪烁，由 settings 云函数刷新）
    // analyzeMode: 'batch' 每日集中分析（默认） | 'instant' 提交即分析
    systemConfig: {
      analyzeMode: 'batch',
      analyzeTime: '21:00',
      // traffic=拼图省流量；quality=多图直传提高识别精度。
      // 由管理员在「管理」里统一设置，登录后从服务端刷新（refreshClientConfig）
      imageMode: 'traffic'
    },

    // 全局配置
    config: {
      maxPhotosPerInspection: 9,  // 每次巡检最多照片数
      compressTargetSize: 700,    // 压缩目标大小 KB
      aiModel: 'qwen'             // AI 模型（实际以云函数 analyzeImage 的 CURRENT_MODEL 为准）
    }
  },

  // 用户登录
  async login() {
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({
          success: (res) => res.code ? resolve(res.code) : reject(new Error('未取得登录凭证')),
          fail: reject
        })
      })
      const result = await api.loginWithCode(code)
      this.globalData.openid = result.openid
      this.globalData.isLoggedIn = true

      // 如果用户信息存在，更新全局状态
      if (result.userInfo) {
        this.globalData.userInfo = result.userInfo
        // 角色与停用状态供前端判断入口（真正的鉴权在服务端）
        this.globalData.userRole = result.userInfo.role || 'sales'
        this.globalData.userDisabled = !!result.userInfo.disabled
        // 准入批准：与云端 isUserApproved 规则对齐（无字段时 admin/manager 视为已批准）
        const _role = result.userInfo.role || 'sales'
        const _ap = result.userInfo.approved
        this.globalData.userApproved = _ap === true || (
          (_ap === undefined || _ap === null) && (_role === 'admin' || _role === 'manager')
        )
        // 同步业务员信息到当前任务
        if (result.userInfo.name) {
          this.globalData.currentTask.userName = result.userInfo.name
        }
        this.globalData.needsName = !normalizeName(result.userInfo.name) && !result.userInfo.disabled
      }

      console.log('[登录] 成功:', result.openid)

      // 登录成功后静默刷离线待上传队列
      this.flushOfflineQueueQuiet()

      // 拉一次团队统一设置（拍照上传策略等），失败就沿用缓存/默认值
      this.refreshClientConfig()

      // 首次登录还没有姓名：弹出必填输入框
      if (this.globalData.needsName) {
        this.promptForName()
      }

      // 触发登录成功事件
      this.loginCallback && this.loginCallback(result)

    } catch (err) {
      console.error('[登录] 失败:', err)
      toast('登录失败，请检查网络')
    }
  },

  // 从服务端读取团队统一设置（只读，所有已登录用户都能读；修改只有管理员能在「管理」里改）
  async refreshClientConfig() {
    try {
      const res = await api.callFunction({ name: 'settings', data: { action: 'get' } })
      const r = res && res.result
      if (!r || !r.success || !r.settings) return this.globalData.systemConfig
      const s = r.settings
      const imageMode = s.imageMode === 'quality' ? 'quality' : DEFAULT_IMAGE_MODE
      this.globalData.systemConfig = {
        ...(this.globalData.systemConfig || {}),
        analyzeMode: s.analyzeMode,
        analyzeTime: s.analyzeTime,
        imageMode
      }
      try { wx.setStorageSync(TEAM_IMAGE_MODE_KEY, imageMode) } catch (_) {}
    } catch (err) {
      console.warn('[团队设置] 读取失败，沿用缓存/默认值', err)
    }
    return this.globalData.systemConfig
  },

  // 团队统一的拍照上传策略：内存 → 本机缓存 → 默认 traffic
  getImageMode() {
    const cfg = this.globalData.systemConfig || {}
    if (cfg.imageMode === 'quality' || cfg.imageMode === 'traffic') return cfg.imageMode
    try {
      const cached = wx.getStorageSync(TEAM_IMAGE_MODE_KEY)
      if (cached === 'quality' || cached === 'traffic') return cached
    } catch (_) {}
    return DEFAULT_IMAGE_MODE
  },

  // 首次登录必填姓名：用可输入的系统弹窗，业务员没有「取消」按钮，填好才能继续用。
  // 管理员可以点「稍后」跳过（本次打开不再弹），保证管理员随时能去批准新人。
  promptForName(prefill = '', errorTitle = '') {
    if (this._namePrompting || !this.globalData.needsName) return
    const isAdmin = this.globalData.userRole === 'admin'
    if (isAdmin && this._nameSkipped) return
    this._namePrompting = true

    const retry = (value, title) => {
      setTimeout(() => this.promptForName(value, title), 300)
    }

    wx.showModal({
      title: errorTitle || '请输入你的姓名',
      content: prefill,
      editable: true,
      placeholderText: '需与进销存里的业务员姓名一致',
      showCancel: isAdmin,
      cancelText: '稍后',
      confirmText: '保存',
      success: async (r) => {
        this._namePrompting = false
        if (!r.confirm) {
          if (isAdmin) {
            this._nameSkipped = true
          } else {
            retry(prefill)
          }
          return
        }
        const name = normalizeName(r.content)
        if (!name) {
          retry('', '姓名不能为空，请重新输入')
          return
        }
        if (name.length > NAME_MAX_LEN) {
          retry(name.slice(0, NAME_MAX_LEN), `姓名不能超过 ${NAME_MAX_LEN} 个字`)
          return
        }

        showLoading('保存中...')
        let result = null
        try {
          const res = await api.callFunction({
            name: 'login',
            data: { action: 'update', userInfo: { name } }
          })
          result = res && res.result
        } catch (err) {
          console.error('[姓名] 保存失败:', err)
        }
        hideLoading()

        if (result && result.success !== false) {
          this.globalData.userInfo = { ...(this.globalData.userInfo || {}), name }
          this.globalData.currentTask.userName = name
          this.globalData.needsName = false
          toast('姓名已保存', 'success')
          this.notifyUserNameReady()
          return
        }
        if (result && result.nameLocked) {
          // 服务端已经有姓名了（比如管理员刚帮你填了），重新登录拿最新资料
          this.globalData.needsName = false
          await this.login()
          this.notifyUserNameReady()
          return
        }
        retry(name, (result && result.error) || '保存失败，请重试')
      },
      fail: () => {
        this._namePrompting = false
        retry(prefill)
      }
    })
  },

  // 姓名保存后通知当前页面刷新显示（页面实现了 onUserNameReady 才会调用）
  notifyUserNameReady() {
    try {
      const pages = getCurrentPages()
      pages.forEach(p => {
        if (p && typeof p.onUserNameReady === 'function') p.onUserNameReady()
      })
    } catch (_) {}
  },

  // 更新用户信息
  async updateUserInfo(userInfo) {
    try {
      const res = await api.callFunction({
        name: 'login',
        data: {
          action: 'update',
          userInfo: userInfo
        }
      })
      // 服务端可能拒绝（比如业务员已有姓名不能自己改），这时不要改本地显示
      if (res && res.result && res.result.success === false) {
        console.warn('[用户信息] 服务端拒绝:', res.result.error)
        return false
      }

      this.globalData.userInfo = {
        ...this.globalData.userInfo,
        ...userInfo
      }

      // 同步到当前任务
      if (userInfo.name) {
        this.globalData.currentTask.userName = userInfo.name
      }

      console.log('[用户信息] 更新成功')
      return true
    } catch (err) {
      console.error('[用户信息] 更新失败:', err)
      return false
    }
  },

  // 设置当前任务
  setCurrentTask(taskInfo) {
    this.globalData.currentTask = {
      ...this.globalData.currentTask,
      ...taskInfo
    }
  },

  // 获取当前任务
  getCurrentTask() {
    return { ...this.globalData.currentTask }
  },


  // 静默冲刷客户端离线待上传队列（与云端 pending 分析队列无关）
  async flushOfflineQueueQuiet() {
    try {
      if (offlineQueue.count() === 0) return
      const online = await offlineQueue.isOnline()
      if (!online) return
      const result = await offlineQueue.flushAll({ openid: this.globalData.openid || '' })
      if (result && result.succeeded > 0) {
        console.log('[离线队列] 静默补传成功', result.succeeded, '条')
      }
      if (result && result.failed > 0) {
        console.warn('[离线队列] 静默补传失败', result.failed, '条')
      }
    } catch (err) {
      console.warn('[离线队列] 静默补传异常', err)
    }
  },

  // 统一工具方法
  utils: {
    toast,
    showLoading,
    hideLoading,
    
    // 安全调用云函数
    async callCloud(name, data = {}) {
      try {
        showLoading()
        const res = await api.callFunction({ name, data })
        hideLoading()
        return res.result
      } catch (err) {
        hideLoading()
        console.error(`[云函数] ${name} 失败:`, err)
        toast('网络请求失败')
        throw err
      }
    }
  }
})
