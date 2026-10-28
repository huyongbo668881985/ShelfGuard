// components/privacy-auth/index.js
// 自定义隐私授权弹窗：由 app.js 的 wx.onNeedPrivacyAuthorize 拦截触发。
// 用户点「同意并继续」时，调用 app.globalData._privacyResolve({ event, resolve })
// 放行被微信隐私网关拦住的原始接口（相机 / 位置授权）。

Component({
  data: {
    show: false
  },

  methods: {
    show() {
      this.setData({ show: true })
    },

    hide() {
      this.setData({ show: false })
    },

    // 防止弹窗内滚动穿透到下层页面
    noop() {},

    // 打开微信官方《小程序隐私保护指引》全文
    openContract() {
      if (typeof wx.openPrivacyContract === 'function') {
        wx.openPrivacyContract({
          fail: () => {
            wx.showToast({ title: '打开协议失败', icon: 'none' })
          }
        })
      }
    },

    onAgree(e) {
      const app = getApp()
      const resolve = app.globalData._privacyResolve
      this.hide()
      if (typeof resolve === 'function') {
        // 调用 resolve 表示用户已同意隐私协议，让原本被拦截的接口继续授权
        resolve({ event: 'agree', buttonId: 'agree-btn' })
        app.globalData._privacyResolve = null
        app.globalData._privacyEvent = null
      }
    },

    onRefuse() {
      const app = getApp()
      const resolve = app.globalData._privacyResolve
      this.hide()
      if (typeof resolve === 'function') {
        // 必须 resolve disagree，否则被拦截的隐私 API Promise 会永久挂起
        resolve({ event: 'disagree' })
        app.globalData._privacyResolve = null
        app.globalData._privacyEvent = null
      }
      wx.showToast({ title: '已取消，将无法使用需授权的功能', icon: 'none' })
    }
  }
})
