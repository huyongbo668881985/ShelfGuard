// app.js
// 应用入口 - 全局状态管理、云开发初始化、用户登录

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

    // 用户登录
    this.login()
  },

  globalData: {
    // 云开发环境 ID（请替换为实际环境 ID）
    cloudEnv: 'your-env-id',
    
    // 用户信息
    userInfo: null,
    openid: null,
    isLoggedIn: false,
    
    // 当前巡检任务
    currentTask: {
      taskName: '',
      storeName: '',
      userName: ''
    },

    // 客户选择器（camera 页 -> customers 页选择模式 -> 选完返回）用来中转数据的字段，
    // 用完即清空，不要指望它长期存值
    selectedCustomer: null,
    
    // 全局配置
    config: {
      maxPhotosPerInspection: 9,  // 每次巡检最多照片数
      compressTargetSize: 700,    // 压缩目标大小 KB
      aiModel: 'openai'           // AI 模型选择
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
        // 同步业务员信息到当前任务
        if (result.userInfo.name) {
          this.globalData.currentTask.userName = result.userInfo.name
        }
      }

      console.log('[登录] 成功:', result.openid)
      
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
