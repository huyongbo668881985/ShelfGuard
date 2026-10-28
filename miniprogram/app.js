// app.js
// 应用入口 - 全局状态管理、云开发初始化、用户登录

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

App({
  onLaunch: function () {
    // 初始化云开发
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }

    wx.cloud.init({
      env: this.globalData.cloudEnv,
      traceUser: true
    })

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

    // 用户登录
    this.login()
  },

  globalData: {
    // 云开发环境 ID（请替换为实际环境 ID）
    cloudEnv: 'cloud1-d8gop997sa25927c4',
    
    // 用户信息
    userInfo: null,
    openid: null,
    isLoggedIn: false,
    // 当前用户的角色与停用状态（登录后由 login 云函数返回；权限边界以服务端为准）
    userRole: 'sales',
    userDisabled: false,
    userApproved: false,
    
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
      // traffic=拼图省流量；quality=多图直传提高识别精度
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
      const res = await wx.cloud.callFunction({
        name: 'login'
      })

      const result = res.result
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
      }

      console.log('[登录] 成功:', result.openid)

      // 登录成功后静默刷离线待上传队列
      this.flushOfflineQueueQuiet()

      // 触发登录成功事件
      this.loginCallback && this.loginCallback(result)

    } catch (err) {
      console.error('[登录] 失败:', err)
      toast('登录失败，请检查网络')
    }
  },

  // 更新用户信息
  async updateUserInfo(userInfo) {
    try {
      await wx.cloud.callFunction({
        name: 'login',
        data: {
          action: 'update',
          userInfo: userInfo
        }
      })

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
        const res = await wx.cloud.callFunction({ name, data })
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
