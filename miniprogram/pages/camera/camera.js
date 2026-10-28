// pages/camera/camera.js
// 水印相机页面

const app = getApp()
const { getLocation: fetchLocation } = require('../../utils/location')
const { validateInspection } = require('../../utils/validator')

// 任务名称默认值（用户可随时更改，改动会本机记忆）
const TASK_NAME_DEFAULT = '永丰特8：常规拜访'

Page({
  data: {
    needsApproval: false,
    approvalBannerText: '',
    // 相机配置
    devicePosition: 'back',
    flashMode: 'auto',
    cameraReady: false,

    // 水印信息（可编辑）
    taskName: '',
    storeName: '',
    userName: '',
    address: '',
    location: null,
    selectedCustomerId: '', // 从客户库选中的客户 _id，跟着这次巡检一起提交，方便以后按客户查

    // 水印样式配置（默认无黑框纯透明悬浮，带立体微阴影）
    watermarkConfig: {
      position: 'bottom',
      color: '#ffffff',
      bgColor: 'transparent',
      opacity: 1,
      fontSize: 16,
      showLogo: true
    },

    // 拍照状态
    photoTempPath: '',
    watermarkedPath: '',
    watermarkedPaths: [],
    previewIndex: 0,
    confirmBtnText: '下一步',
    showPreview: false,
    composing: false,

    // 连拍/拼图：最多拍 maxPhotos 张，完成后如果超过1张就拼成一张网格大图，
    // 只有1张的话跳过拼图步骤，直接走原来的单图水印流程
    capturedPhotos: [],
    maxPhotos: 6,

    // 设置面板
    showSettings: false,

    // traffic=拼图；quality=多图各自打水印后直传
    imageMode: 'traffic'
  },

  onLoad(options) {
    // 从上一页或全局获取业务员信息
    this.loadUserInfo(options)
    // 获取位置
    this.getLocation()
    this.loadImageMode()

    // 登录是异步的，camera 作为首页在 onLoad 时可能还没拿到用户信息
    // （业务员默认姓名存在云端 users 集合）。若此刻还没有姓名，等登录完成
    // 后再补一次 loadUserInfo，确保业务员姓名能默认带出来。
    if (!app.globalData.isLoggedIn || !(app.globalData.userInfo && app.globalData.userInfo.name)) {
      app.loginCallback = () => this.loadUserInfo(options)
    }
  },

  
  refreshApprovalBanner() {
    const app = getApp()
    const me = app.globalData.userInfo
    if (!me) {
      this.setData({ needsApproval: false, approvalBannerText: '' })
      return
    }
    const role = me.role || app.globalData.userRole || 'sales'
    const approvedOk = (
      me.approved === true ||
      ((me.approved === undefined || me.approved === null) && (role === 'admin' || role === 'manager'))
    )
    this.setData({
      needsApproval: !approvedOk,
      approvalBannerText: approvedOk ? '' : '账号待管理员审批，批准前无法提交巡检'
    })
  },

  onShow() {
    this.refreshApprovalBanner()
    // 隐私授权补弹：app.js 的 wx.onNeedPrivacyAuthorize 拦截触发时，
    // 若当时弹窗组件尚未挂载会置 _privacyPending 标记，这里在页面显示时补弹一次
    if (app.globalData._privacyPending) {
      app.globalData._privacyPending = false
      this.showPrivacyAuthorize()
    }

    // "继续拜访下一家"回传标记：upload 页提交完成后点了继续，回到相机页应当
    // 清空上一家门店信息并直接进入下一家拍照阶段（自动弹出客户选择）。
    // 用 globalData.startNextVisit 通信，因为相机是 tabBar 页，navigateBack
    // 只触发 onShow 不触发 onLoad，没法用页面参数传。
    if (app.globalData.startNextVisit) {
      app.globalData.startNextVisit = false
      this.setData({
        storeName: '',
        selectedCustomerId: '',
        // 门店地址回退到当前定位地址，避免沿用上一家门店地址
        address: (this.data.location && this.data.location.address) || this.data.address
      })
      wx.showToast({ title: '请选择下一家门店', icon: 'none' })
      // 自动进入客户选择阶段
      this.chooseCustomer()
      return
    }

    // 从"选择客户"页面（customers 页选择模式）返回时，globalData 里会带着
    // 选中的客户资料，这里取一次就清空，避免下次进相机页误把上次的选择带进来
    const selected = app.globalData.selectedCustomer
    if (selected) {
      app.globalData.selectedCustomer = null
      if (selected.isNoStore) {
        this.setData({
          storeName: '',
          selectedCustomerId: '',
          address: (this.data.location && this.data.location.address) || this.data.address
        })
        wx.showToast({ title: '已切换为无门店模式', icon: 'none' })
      } else {
        this.setData({
          storeName: selected.storeName || '',
          address: selected.address || this.data.address,
          selectedCustomerId: selected._id
        })
        wx.showToast({ title: `已选择：${selected.storeName}`, icon: 'none' })
      }
    }
  },

  onReady() {
    this.setData({ cameraReady: true })
  },

  // 弹出隐私授权窗：由 app.js 全局隐私拦截回调触发，也用于 _privacyPending 补弹。
  // 用户「同意并继续」时，privacy-auth 组件内部会调用 app.globalData._privacyResolve
  // 放行被微信隐私网关拦住的原始接口（相机/位置授权）。
  showPrivacyAuthorize() {
    const comp = this.selectComponent('#privacyAuth')
    if (comp) {
      comp.show()
    } else {
      // 极端情况下组件尚未挂载，回到标记，下一轮 onShow 再补弹
      app.globalData._privacyPending = true
    }
  },

  // 相机初始化完成（wx 相机组件 initdone 事件）：比 onReady 更可靠地表示
  // 相机已可拍照。将 cameraReady 置 true，保证首次进入页面即可拍。
  onCameraInitDone() {
    this.setData({ cameraReady: true })
  },

  // 加载用户信息
  loadUserInfo(options) {
    const globalData = app.globalData
    const userInfo = globalData.userInfo || {}
    // 任务名称：上次填过的优先（本机记忆），否则用固定默认值，用户可随时更改
    const lastTaskName = wx.getStorageSync('shelfguard_lastTaskName') || ''

    this.setData({
      userName: options.userName || userInfo.name || '',
      storeName: options.storeName || '',
      taskName: options.taskName || lastTaskName || TASK_NAME_DEFAULT
    })
  },

  // 获取位置（复用 utils/location.js：失败时会自动引导用户去设置里开权限）
  async getLocation() {
    try {
      const location = await fetchLocation()
      this.setData({
        location,
        // 优先显示逆地理编码得到的路名/地标，失败则退回坐标
        address: location.address || `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`
      })
      // 临时诊断：逆地理编码失败时把原因弹到手机上，方便定位问题（确认修复后可删）
      if (location.geoReason) {
        const reasonText = {
          NO_KEY: '云函数未配置地图Key',
          API_ERROR: '地图服务返回错误',
          DEP_OR_API_ERROR: '云函数依赖异常',
          CALL_FAIL: '逆地理编码调用失败',
          GEOCODE_FAIL: '逆地理编码失败'
        }
        const msg = reasonText[location.geoReason.split('(')[0]] || '逆地理编码未生效'
        console.warn('[逆地理编码诊断]', location.geoReason)
        wx.showToast({ title: `定位地址: ${msg}`, icon: 'none', duration: 2500 })
      }
    } catch (err) {
      console.error('获取位置失败:', err)
      wx.showToast({ title: '位置获取失败', icon: 'none' })
      // location 保持为 null，confirmPhoto 里会做兜底处理，不会导致崩溃
    }
  },

  // 切换前后摄像头
  switchCamera() {
    this.setData({
      devicePosition: this.data.devicePosition === 'back' ? 'front' : 'back'
    })
  },

  // 切换闪光灯
  switchFlash() {
    const modes = ['auto', 'on', 'off']
    const current = modes.indexOf(this.data.flashMode)
    this.setData({ flashMode: modes[(current + 1) % modes.length] })
  },

  // 打开设置面板
  openSettings() {
    this.setData({ showSettings: true })
  },

  // 关闭设置面板
  closeSettings() {
    // 业务员姓名变更时回写云端（按 openid 绑定），下次登录即默认带出；
    // 不同微信登录 = 不同业务员，自然显示各自姓名。
    const newName = (this.data.userName || '').trim()
    const oldName = (app.globalData.userInfo && app.globalData.userInfo.name) || ''
    if (newName && newName !== oldName) {
      app.updateUserInfo({ name: newName }).then((ok) => {
        if (ok) wx.showToast({ title: '业务员姓名已保存', icon: 'none' })
      })
    }
    this.setData({ showSettings: false })
  },

  // 输入处理
  onTaskNameInput(e) {
    const v = String(e.detail.value || '').replace(/[\r\n]+/g, ' ').slice(0, 50)
    this.setData({ taskName: v })
    // 记住上次填的任务名，下次进入默认带出（可更改）
    wx.setStorageSync('shelfguard_lastTaskName', v)
  },

  onUserNameInput(e) {
    const v = String(e.detail.value || '').replace(/[\r\n]+/g, ' ').slice(0, 50)
    this.setData({ userName: v })
  },

  // 切换水印位置
  switchPosition() {
    const positions = ['bottom', 'top', 'full']
    const current = positions.indexOf(this.data.watermarkConfig.position)
    const next = positions[(current + 1) % positions.length]
    this.setData({
      'watermarkConfig.position': next
    })
  },

  // 跳转产品库管理页
  goToProducts() {
    wx.navigateTo({ url: '/pages/products/products' })
  },

  // 客户管理入口（跟产品库一样，正常管理模式，不带 select 参数）
  goToCustomers() {
    wx.navigateTo({ url: '/pages/customers/customers' })
  },

  // 分析设置入口：集中分析时间、API Key、待分析队列
  // 走 closeSettings() 而不是直接 setData，是为了顺带把改过的业务员姓名存下来，
  // 同时关掉水印设置面板——否则从设置页返回后面板还盖在相机上
  goToAnalyzeSettings() {
    this.closeSettings()
    wx.navigateTo({ url: '/pages/settings/settings' })
  },

  // 选客户：带上当前定位，customers 页会按距离由近到远排好序
  async chooseCustomer() {
    let lat = this.data.location && this.data.location.latitude
    let lng = this.data.location && this.data.location.longitude

    if (lat == null || lng == null) {
      // 相机页 onLoad 时定位可能还没成功，这里补一次，拿不到也不阻塞——
      // 无非是列表没法按距离排序，客户还是能正常选
      try {
        const loc = await fetchLocation()
        lat = loc.latitude
        lng = loc.longitude
      } catch (err) {
        console.warn('选客户时定位失败，列表将不按距离排序:', err)
      }
    }

    const query = (lat != null && lng != null) ? `&lat=${lat}&lng=${lng}` : ''
    wx.navigateTo({ url: `/pages/customers/customers?mode=select${query}` })
  },

  // 一键清空门店（切换为无门店/沿街巡检模式）
  onClearStore() {
    this.setData({
      storeName: '',
      selectedCustomerId: '',
      address: (this.data.location && this.data.location.address) || this.data.address
    })
    wx.showToast({ title: '已清空门店', icon: 'none' })
  },

  // 拍照：每次拍一张加入 capturedPhotos 数组，不立即预览，方便连续拍多张
  takePhoto() {
    if (this.data.capturedPhotos.length >= this.data.maxPhotos) {
      wx.showToast({ title: `最多拍 ${this.data.maxPhotos} 张`, icon: 'none' })
      return
    }

    // 相机组件还没就绪（onReady 之前）就拍照会静默失败，先拦一下
    if (!this.data.cameraReady) {
      wx.showToast({ title: '相机未就绪，请稍候', icon: 'none' })
      return
    }

    // 权限前置检查：未授权先引导开启，避免像之前那样静默失败只弹“拍照失败”
    this.checkCameraAuth().then((authorized) => {
      if (!authorized) return

      const camera = wx.createCameraContext()
      camera.takePhoto({
        quality: 'high',
        success: (res) => {
          const capturedPhotos = [...this.data.capturedPhotos, res.tempImagePath]
          this.setData({ capturedPhotos })
          wx.vibrateShort({ type: 'light' })
        },
        fail: (err) => {
          console.error('拍照失败:', err)
          wx.showToast({ title: '拍照失败', icon: 'none' })
        }
      })
    })
  },

  // 拍照前检查相机权限：未授权则引导去设置页开启，开启后才允许拍照。
  // 返回 true 表示已授权（或刚在设置页开启成功），false 表示用户拒绝/未处理。
  checkCameraAuth() {
    return new Promise((resolve) => {
      wx.getSetting({
        success: (res) => {
          if (res.authSetting['scope.camera'] === false) {
            // 之前被明确拒绝过，引导去设置页重新开启
            wx.showModal({
              title: '无法使用相机',
              content: '相机权限已被关闭，需要重新开启才能拍照，是否前往设置？',
              confirmText: '去设置',
              success: (modalRes) => {
                if (modalRes.confirm) {
                  wx.openSetting({
                    success: (settingRes) => {
                      if (settingRes.authSetting['scope.camera']) {
                        // 相机组件实例从未被卸载，权限刚开启即处于可用状态，
                        // 不要把 cameraReady 置为 false，否则本次之后的每次拍照都会
                        // 被“未就绪”拦截（onReady 只触发一次，没有恢复时机）。
                        resolve(true)
                      } else {
                        resolve(false)
                      }
                    },
                    fail: () => resolve(false)
                  })
                } else {
                  resolve(false)
                }
              }
            })
          } else {
            // 未询问过或已授权，直接放行
            resolve(true)
          }
        },
        fail: () => resolve(true)
      })
    })
  },

  // 删除某一张已拍的照片（拼图之前反悔）
  removeCapturedPhoto(e) {
    const index = e.currentTarget.dataset.index
    const capturedPhotos = this.data.capturedPhotos.filter((_, i) => i !== index)
    this.setData({ capturedPhotos })
  },


  loadImageMode() {
    let mode = 'traffic'
    try {
      const local = wx.getStorageSync('shelfguard_imageMode')
      if (local === 'quality' || local === 'traffic') mode = local
      else if (app.globalData.systemConfig && app.globalData.systemConfig.imageMode) {
        mode = app.globalData.systemConfig.imageMode === 'quality' ? 'quality' : 'traffic'
      }
    } catch (_) {}
    this.setData({ imageMode: mode })
    // 后台刷新团队默认
    wx.cloud.callFunction({ name: 'settings', data: { action: 'get' } }).then(res => {
      if (res.result && res.result.success && res.result.settings) {
        const s = res.result.settings
        app.globalData.systemConfig = {
          ...(app.globalData.systemConfig || {}),
          analyzeMode: s.analyzeMode,
          analyzeTime: s.analyzeTime,
          imageMode: s.imageMode === 'quality' ? 'quality' : 'traffic'
        }
        // 本地无显式偏好时跟随团队设置
        try {
          const local = wx.getStorageSync('shelfguard_imageMode')
          if (!local) {
            this.setData({ imageMode: app.globalData.systemConfig.imageMode })
          }
        } catch (_) {}
      }
    }).catch(() => {})
  },

  // 完成拍照：1张直接走原来的单图水印流程；
  // 流量优先(traffic)：多张拼成网格大图再打水印；
  // 精度优先(quality)：跳过拼图，每张各自打水印后多 fileID 直传。
  async finishCapture() {
    const { capturedPhotos } = this.data
    if (capturedPhotos.length === 0) {
      wx.showToast({ title: '还没有拍照', icon: 'none' })
      return
    }

    this.setData({ showPreview: true, composing: true })

    try {
      const qualityMode = this.data.imageMode === 'quality' && capturedPhotos.length > 1

      if (qualityMode) {
        // 精度优先：每张单独打水印，确认时带多路径去上传页
        const watermarkedList = []
        for (let i = 0; i < capturedPhotos.length; i++) {
          const wm = await this.composeWatermarkPath(capturedPhotos[i])
          watermarkedList.push(wm)
        }
        this.setData({
          photoTempPath: watermarkedList[0],
          watermarkedPath: watermarkedList[0],
          watermarkedPaths: watermarkedList,
          previewIndex: 0,
          confirmBtnText: `下一步（${watermarkedList.length}张）`,
          composing: false
        })
      } else {
        let sourcePath
        if (capturedPhotos.length === 1) {
          sourcePath = capturedPhotos[0]
        } else {
          const gridComp = this.selectComponent('#photoGridCanvas')
          if (!gridComp) {
            throw new Error('拼图组件未找到')
          }
          gridComp.setData({ imagePaths: capturedPhotos })
          sourcePath = await gridComp.compose()
        }

        this.setData({
          photoTempPath: sourcePath,
          watermarkedPaths: [],
          previewIndex: 0,
          confirmBtnText: '下一步'
        })
        await this.composeWatermark(sourcePath)
      }
    } catch (err) {
      console.error('拼图/合成失败:', err)
      this.setData({ composing: false })
      wx.showToast({ title: '处理失败，请重试', icon: 'none' })
    }
  },

  // 只返回水印路径，不写页面状态（精度模式连拍用）
  async composeWatermarkPath(imagePath) {
    const watermarkComp = this.selectComponent('#watermarkCanvas')
    if (!watermarkComp) throw new Error('水印组件未找到')
    const now = new Date()
    const dateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const watermark = {
      ...this.data.watermarkConfig,
      taskName: this.data.taskName,
      storeName: this.data.storeName,
      userName: this.data.userName,
      address: this.data.address,
      dateTime
    }
    watermarkComp.setData({ imagePath, watermark })
    return await watermarkComp.compose()
  },

  // 合成水印
  async composeWatermark(imagePath) {
    this.setData({ composing: true })

    try {
      // 获取水印组件实例
      const watermarkComp = this.selectComponent('#watermarkCanvas')
      if (!watermarkComp) {
        throw new Error('水印组件未找到')
      }

      // 准备水印配置
      const now = new Date()
      const dateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

      const watermark = {
        ...this.data.watermarkConfig,
        taskName: this.data.taskName,
        storeName: this.data.storeName,
        userName: this.data.userName,
        address: this.data.address,
        dateTime: dateTime
      }

      // 设置组件属性
      watermarkComp.setData({
        imagePath: imagePath,
        watermark: watermark
      })

      // 调用合成方法
      const watermarkedPath = await watermarkComp.compose()
      this.setData({
        watermarkedPath: watermarkedPath,
        composing: false
      })

    } catch (err) {
      console.error('水印合成失败:', err)
      this.setData({
        watermarkedPath: imagePath, // 失败时使用原图
        composing: false
      })
      wx.showToast({ title: '水印添加失败', icon: 'none' })
    }
  },

  // 重新拍照：重置整个连拍状态，回到连拍模式从头开始，不是只回退一步
  retakePhoto() {
    this.setData({
      photoTempPath: '',
      watermarkedPath: '',
      watermarkedPaths: [],
      previewIndex: 0,
      confirmBtnText: '下一步',
      showPreview: false,
      capturedPhotos: []
    })
  },

  onPreviewSwiperChange(e) {
    const idx = (e.detail && e.detail.current) || 0
    const paths = this.data.watermarkedPaths || []
    this.setData({
      previewIndex: idx,
      watermarkedPath: paths[idx] || this.data.watermarkedPath
    })
  },

  onSelectPreviewThumb(e) {
    const idx = Number(e.currentTarget.dataset.index) || 0
    const paths = this.data.watermarkedPaths || []
    this.setData({
      previewIndex: idx,
      watermarkedPath: paths[idx] || this.data.watermarkedPath
    })
  },

  currentPreviewPath() {
    const paths = this.data.watermarkedPaths || []
    if (paths.length > 1) {
      return paths[this.data.previewIndex] || paths[0] || this.data.watermarkedPath
    }
    return this.data.watermarkedPath
  },

  // 快捷分享当前预览图到微信（原生发送给朋友/收藏/保存）
  shareToWechat() {
    const path = this.currentPreviewPath()
    if (!path) {
      wx.showToast({ title: '照片尚未合成完成', icon: 'none' })
      return
    }
    const urls = (this.data.watermarkedPaths && this.data.watermarkedPaths.length)
      ? this.data.watermarkedPaths
      : [path]

    if (typeof wx.showShareImageMenu === 'function') {
      wx.showShareImageMenu({
        path,
        fail: (err) => {
          if (err && err.errMsg && !err.errMsg.includes('cancel')) {
            wx.previewImage({ current: path, urls })
          }
        }
      })
    } else {
      wx.previewImage({ current: path, urls })
    }
  },

  // 保存当前预览图到手机相册
  saveToAlbum() {
    const path = this.currentPreviewPath()
    if (!path) {
      wx.showToast({ title: '照片尚未合成完成', icon: 'none' })
      return
    }

    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => {
        wx.showToast({ title: '已存入系统相册', icon: 'success' })
      },
      fail: (err) => {
        if (err && err.errMsg && err.errMsg.includes('auth deny')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中开启相册权限，用于保存带水印的巡检照片',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting() }
          })
        } else if (err && err.errMsg && !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '保存失败', icon: 'none' })
        }
      }
    })
  },

  // 精度模式：把所有水印图逐张存入相册
  async saveAllToAlbum() {
    const paths = this.data.watermarkedPaths || []
    if (paths.length === 0) {
      wx.showToast({ title: '没有可保存的照片', icon: 'none' })
      return
    }
    wx.showLoading({ title: `保存中 0/${paths.length}`, mask: true })
    let ok = 0
    let denied = false
    for (let i = 0; i < paths.length; i++) {
      wx.showLoading({ title: `保存中 ${i + 1}/${paths.length}`, mask: true })
      try {
        await new Promise((resolve, reject) => {
          wx.saveImageToPhotosAlbum({
            filePath: paths[i],
            success: resolve,
            fail: reject
          })
        })
        ok++
      } catch (err) {
        if (err && err.errMsg && err.errMsg.includes('auth deny')) {
          denied = true
          break
        }
      }
    }
    wx.hideLoading()
    if (denied) {
      wx.showModal({
        title: '需要相册权限',
        content: '请在设置中开启相册权限，用于保存带水印的巡检照片',
        confirmText: '去设置',
        success: (r) => { if (r.confirm) wx.openSetting() }
      })
      return
    }
    wx.showToast({
      title: ok === paths.length ? `已全部存入（${ok}张）` : `已保存 ${ok}/${paths.length} 张`,
      icon: ok === paths.length ? 'success' : 'none'
    })
  },

  // 确认照片，跳转上传页
  confirmPhoto() {
    const { watermarkedPath, location, taskName } = this.data

    if (!watermarkedPath) {
      wx.showToast({ title: '照片未准备好', icon: 'none' })
      return
    }

    // 校验基础信息（不含位置，位置单独用弹窗兜底，避免因定位失败卡死流程）
    const { valid, errors } = validateInspection({
      photoPath: watermarkedPath,
      taskName
    })
    if (!valid) {
      wx.showModal({ title: '信息不完整', content: errors.join('\n'), showCancel: false })
      return
    }

    // 位置获取失败时（location 为 null），给用户选择：不带位置继续 / 重新定位，
    // 而不是像之前那样直接访问 location.latitude 导致白屏崩溃。
    if (!location) {
      wx.showModal({
        title: '未获取到位置信息',
        content: '当前巡检记录将不包含门店定位，是否仍要继续？',
        confirmText: '继续',
        cancelText: '重新定位',
        success: (res) => {
          if (res.confirm) {
            this.navigateToUpload({ latitude: 0, longitude: 0 })
          } else {
            this.getLocation()
          }
        }
      })
      return
    }

    this.navigateToUpload(location)
  },

  // 跳转到上传页
  navigateToUpload(location) {
    const { watermarkedPath, watermarkedPaths, address, taskName, storeName, userName, selectedCustomerId } = this.data
    const multi = Array.isArray(watermarkedPaths) && watermarkedPaths.length > 1
    let url = `/pages/upload/upload?` +
      `lat=${location.latitude}` +
      `&lng=${location.longitude}` +
      `&address=${encodeURIComponent(address)}` +
      `&taskName=${encodeURIComponent(taskName)}` +
      `&storeName=${encodeURIComponent(storeName)}` +
      `&userName=${encodeURIComponent(userName)}` +
      `&customerId=${encodeURIComponent(selectedCustomerId || '')}`
    if (multi) {
      url += `&photoPaths=${encodeURIComponent(JSON.stringify(watermarkedPaths))}`
    } else {
      url += `&photoPath=${encodeURIComponent(watermarkedPath)}`
    }
    wx.navigateTo({ url })
    // 提交后重置拍照状态：camera 是 tabBar 页，report 页的"再拍一张"是
    // wx.switchTab 回来，不会重新触发 onLoad，如果不在这里清空，
    // capturedPhotos/showPreview 这些会带着上一次巡检的照片留在页面上
    this.setData({
      capturedPhotos: [],
      photoTempPath: '',
      watermarkedPath: '',
      watermarkedPaths: [],
      previewIndex: 0,
      confirmBtnText: '下一步',
      showPreview: false
    })
  },

  // 相机错误处理
  // 最常见的触发场景是用户拒绝了相机权限（或系统层面禁用了相机）。
  // 之前只弹一个 toast，用户没有任何恢复路径；现在检查一下授权状态，
  // 如果确实是权限被拒，引导去 wx.openSetting() 重新开启。
  onCameraError(e) {
    console.error('相机错误:', e.detail)

    wx.getSetting({
      success: (res) => {
        const authorized = res.authSetting['scope.camera']
        if (authorized === false) {
          // 明确是被拒绝过，引导去设置页重新开启
          wx.showModal({
            title: '无法使用相机',
            content: '相机权限已被关闭，需要重新开启才能拍照，是否前往设置？',
            confirmText: '去设置',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.openSetting({
                  success: (settingRes) => {
                    if (settingRes.authSetting['scope.camera']) {
                      // 用户在设置页里重新开启了：相机组件实例从未被卸载，
                      // 权限刚开启即处于可用状态，应当把 cameraReady 恢复为 true。
                      // （旧逻辑误置为 false，导致之后每次拍照都被"未就绪"拦截，
                      // 必须杀进程重进小程序才能恢复——这是之前"有时候相机失败"的隐藏 bug。）
                      this.setData({ cameraReady: true })
                      wx.showToast({ title: '权限已开启', icon: 'none' })
                    }
                  }
                })
              }
            }
          })
        } else {
          // 不是权限问题（比如系统相机被占用、设备异常），给个能重试的提示
          wx.showToast({ title: '相机启动失败，请重试', icon: 'none' })
        }
      },
      fail: () => {
        wx.showToast({ title: '相机启动失败', icon: 'none' })
      }
    })
  }
})
