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

    _flushPrivacyQueue(payload) {
      const app = getApp()
      const queue = Array.isArray(app.globalData._privacyQueue)
        ? app.globalData._privacyQueue.splice(0)
        : []
      if (queue.length > 0) {
        queue.forEach(item => {
          if (item && typeof item.resolve === 'function') {
            item.resolve(payload)
          }
        })
      } else if (typeof app.globalData._privacyResolve === 'function') {
        app.globalData._privacyResolve(payload)
      }
      app.globalData._privacyResolve = null
      app.globalData._privacyEvent = null
      app.globalData._privacyPending = false
    },

    onAgree(e) {
      this.hide()
      // 一次性放行所有因隐私授权挂起的接口（相机/位置/相册等）
      this._flushPrivacyQueue({ event: 'agree', buttonId: 'agree-btn' })
    },

    onRefuse() {
      this.hide()
      // 必须 resolve disagree，否则被拦截的隐私 API Promise 会永久挂起
      this._flushPrivacyQueue({ event: 'disagree' })
      wx.showToast({ title: '已取消，将无法使用需授权的功能', icon: 'none' })
    }
  }
})
