// pages/camera/camera.js
// 水印相机页面

const app = getApp()
const api = require('../../utils/api')
const { getLocation: fetchLocation } = require('../../utils/location')
const { validateInspection } = require('../../utils/validator')
const { smartCompress } = require('../../utils/compress')
const offlineQueue = require('../../utils/offlineQueue')

// 任务名称：统一固定为默认值，业务员不能改（拍照页没有任何修改入口）
const TASK_NAME_DEFAULT = '永丰特8：常规拜访'

Page({
  data: {
    needsApproval: false,
    approvalBannerText: '',
    // 相机配置（默认关闭闪光灯）
    devicePosition: 'back',
    flashMode: 'off',
    cameraReady: false,

    // 水印信息（可编辑）
    taskName: '',
    storeName: '',
    userName: '',
    address: '',
    location: null,
    selectedCustomerId: '', // 从客户库选中的客户 _id，跟着这次巡检一起提交，方便以后按客户查

    // 水印样式配置（默认无黑框纯透明悬浮，带立体微阴影）；位置固定在底部，没有修改入口
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
    uploadPhotoPaths: [],
    previewIndex: 0,
    confirmBtnText: '下一步',
    showPreview: false,
    composing: false,
    clockStatusText: '',

    // 连拍/拼图：最多拍 maxPhotos 张，完成后如果超过1张就拼成一张网格大图，
    // 只有1张的话跳过拼图步骤，直接走原来的单图水印流程
    capturedPhotos: [],
    maxPhotos: 6,

    // traffic=拼图；quality=多图各自打水印后直传
    imageMode: 'quality',

    // 记录类型：visit（门店拜访）| clock_in（上班打卡）| clock_out（下班打卡）
    recordType: 'visit'
  },

  onLoad(options) {
    const recordType = (options.recordType === 'clock_in' || options.recordType === 'clock_out')
      ? options.recordType
      : 'visit'
    // 从首页「开始拜访」带来的门店信息：storeName / customerId / storeAddress，
    // noStore=1 表示选了「无门店」。门店地址优先用于水印地址，定位只作兜底。
    this.storeAddressFromHome = options.storeAddress ? decodeURIComponent(options.storeAddress) : ''
    this.setData({
      recordType,
      maxPhotos: recordType === 'visit' ? 6 : 1,
      selectedCustomerId: options.customerId ? decodeURIComponent(options.customerId) : '',
      address: this.storeAddressFromHome
    })
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
      approvalBannerText: approvedOk ? '' : '账号待管理员审批，批准前无法提交拜访'
    })
  },

  onShow() {
    this.refreshApprovalBanner()
    this.loadImageMode()
    // 隐私授权补弹：app.js 的 wx.onNeedPrivacyAuthorize 拦截触发时，
    // 若当时弹窗组件尚未挂载会置 _privacyPending 标记，这里在页面显示时补弹一次
    if (app.globalData._privacyPending) {
      app.globalData._privacyPending = false
      this.showPrivacyAuthorize()
    }

    // 从"选择客户"页面（customers 页选择模式）返回时，优先消费页面事件通道，兼容 globalData 兜底
    const selected = this._pendingSelectedCustomer || app.globalData.selectedCustomer
    if (selected) {
      this._pendingSelectedCustomer = null
      app.globalData.selectedCustomer = null
      // 在相机页内改了门店：不再沿用首页带来的门店地址
      this.storeAddressFromHome = ''
      if (selected.isNoStore) {
        this.setData({
          storeName: '',
          selectedCustomerId: '',
          address: (this.data.location && this.data.location.address) || this.data.address
        })
      } else {
        this.setData({
          storeName: selected.storeName || '',
          address: selected.address || this.data.address,
          selectedCustomerId: selected._id
        })
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
    const recordType = (options && (options.recordType === 'clock_in' || options.recordType === 'clock_out'))
      ? options.recordType
      : (this.data.recordType || 'visit')

    if (recordType === 'clock_in' || recordType === 'clock_out') {
      const clockLabel = recordType === 'clock_in' ? '上班打卡' : '下班打卡'
      this.setData({
        userName: (options && options.userName ? decodeURIComponent(options.userName) : '') || userInfo.name || '',
        storeName: clockLabel,
        taskName: `考勤打卡：${clockLabel}`
      })
      wx.setNavigationBarTitle({ title: clockLabel })
      return
    }

    // 任务名称固定用默认值：不读页面参数，也不再沿用上次填写的名称
    this.setData({
      userName: (options && options.userName ? decodeURIComponent(options.userName) : '') || userInfo.name || '',
      storeName: (options && options.storeName ? decodeURIComponent(options.storeName) : '') || '',
      taskName: TASK_NAME_DEFAULT
    })
  },

  // 获取位置（静默模式：逆地理失败时已在 location.js 自动降级为经纬度，彻底失败时复用缓存或留空，不弹框打断）
  getLocation() {
    const p = (async () => {
      try {
        const location = await fetchLocation({ silent: true })
        app.globalData.lastLocation = {
          latitude: location.latitude,
          longitude: location.longitude,
          address: location.address || '',
          updatedAt: Date.now()
        }
        this.setData({
          location,
          // 优先显示逆地理编码得到的路名/地标，失败则退回坐标
          // 首页选了有地址的门店时，水印保持用门店地址，不被当前定位覆盖
          address: this.storeAddressFromHome || location.address || `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`
        })
      } catch (err) {
        console.warn('获取位置失败，静默兜底:', err)
        const cached = app.globalData.lastLocation
        if (cached && cached.latitude != null && cached.longitude != null) {
          this.setData({
            location: this.data.location || cached,
            address: this.storeAddressFromHome || this.data.address || cached.address || `${Number(cached.latitude).toFixed(6)}, ${Number(cached.longitude).toFixed(6)}`
          })
        }
      }
    })()
    this._locationPromise = p
    return p
  },

  // 切换前后摄像头
  switchCamera() {
    this.setData({
      devicePosition: this.data.devicePosition === 'back' ? 'front' : 'back'
    })
  },

  // 切换闪光灯（默认关 -> 开 -> 自动）
  switchFlash() {
    const modes = ['off', 'on', 'auto']
    const current = modes.indexOf(this.data.flashMode)
    this.setData({ flashMode: modes[(current + 1) % modes.length] })
  },

  // 选客户：秒开客户列表（先带已有缓存定位，customers 页内后台静默刷新最新距离）
  chooseCustomer() {
    const loc = this.data.location || app.globalData.lastLocation || null
    const lat = loc && loc.latitude
    const lng = loc && loc.longitude
    const query = (lat != null && lng != null) ? `&lat=${lat}&lng=${lng}` : ''

    this._pendingSelectedCustomer = null
    wx.navigateTo({
      url: `/pages/customers/customers?mode=select${query}`,
      events: {
        selectCustomer: (selected) => {
          this._pendingSelectedCustomer = selected
        }
      }
    })
  },

  // 拍照：门店拜访支持连拍多张；上下班打卡拍完 1 张直接走一键极速打卡
  takePhoto() {
    if (this.data.composing) return
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
          wx.vibrateShort({ type: 'light' })
          const isClock = this.data.recordType === 'clock_in' || this.data.recordType === 'clock_out'
          if (isClock) {
            this.submitClockExpress(res.tempImagePath, false)
            return
          }
          const capturedPhotos = [...this.data.capturedPhotos, res.tempImagePath]
          this.setData({ capturedPhotos })
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


  // 拍照上传策略：由管理员在「管理」里统一设置、全员生效（不再有本机偏好）。
  // 先用 app 里缓存的团队设置（没有就默认 quality），再后台刷新一次服务端最新值。
  loadImageMode() {
    this.setData({ imageMode: app.getImageMode() })
    app.refreshClientConfig().then(() => {
      this.setData({ imageMode: app.getImageMode() })
    }).catch(() => {})
  },

  // 首次登录填完姓名后由 app.js 通知：把姓名带进水印
  onUserNameReady() {
    const name = (app.globalData.userInfo && app.globalData.userInfo.name) || ''
    if (name && !this.data.userName) {
      this.setData({ userName: name })
    }
  },

  // 完成拍照：1张直接走原来的单图水印流程；
  // 流量优先(traffic)：多张拼成网格大图再打水印，只上传这 1 张拼图；
  // 精度优先(quality)：先拼成 1 张带水印网格大图（用于预览、存相册、发微信），
  //                    同时每张原图各自打水印后作为多张高清图传给上传页供 AI 分析。
  async finishCapture() {
    const { capturedPhotos } = this.data
    if (capturedPhotos.length === 0) {
      wx.showToast({ title: '还没有拍照', icon: 'none' })
      return
    }

    this.setData({ showPreview: true, composing: true })

    try {
      const qualityMode = this.data.imageMode === 'quality' && capturedPhotos.length > 1

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

      if (qualityMode) {
        // 1. 先给拼好的网格大图打水印（用于预览、存入系统相册、发微信好友）
        const stitchedWatermarked = await this.composeWatermarkPath(sourcePath)
        // 2. 再为每张高清原图单独打水印，确认时传给上传页供 AI 逐张识别
        const watermarkedList = []
        for (let i = 0; i < capturedPhotos.length; i++) {
          const wm = await this.composeWatermarkPath(capturedPhotos[i])
          watermarkedList.push(wm)
        }
        this.setData({
          photoTempPath: sourcePath,
          watermarkedPath: stitchedWatermarked,
          watermarkedPaths: [],
          uploadPhotoPaths: watermarkedList,
          previewIndex: 0,
          confirmBtnText: '下一步',
          composing: false
        })
      } else {
        this.setData({
          photoTempPath: sourcePath,
          watermarkedPaths: [],
          uploadPhotoPaths: [],
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
      uploadPhotoPaths: [],
      previewIndex: 0,
      confirmBtnText: '下一步',
      showPreview: false,
      composing: false,
      clockStatusText: '',
      capturedPhotos: []
    })
  },

  // 上下班打卡：一键极速模式（拍完即合成水印 → 压缩上传 → 提交打卡 → 自动回首页）
  async submitClockExpress(rawPath, isRetry = false) {
    if (this.data.composing) return
    const clockLabel = this.data.recordType === 'clock_out' ? '下班打卡' : '上班打卡'
    this.setData({
      showPreview: true,
      composing: true,
      clockStatusText: `正在合成${clockLabel}水印...`,
      photoTempPath: rawPath || this.data.photoTempPath,
      capturedPhotos: rawPath ? [rawPath] : this.data.capturedPhotos,
      confirmBtnText: `重试${clockLabel}`
    })

    let uploadedFileID = ''
    try {
      // 1. 确保已登录且账号已审批（若本地仍缓存未批准，先向服务端复核一次最新审批状态）
      let me = app.globalData.userInfo
      if (!me && typeof app.login === 'function') {
        await app.login()
        me = app.globalData.userInfo
      }
      if (!me) throw new Error('登录状态失效，请重试')
      if ((!app.isUserApproved(me) || me.disabled) && typeof app.refreshUserStatus === 'function') {
        await app.refreshUserStatus()
        me = app.globalData.userInfo || me
        this.refreshApprovalBanner()
      }
      if (me.disabled) throw new Error('账号已停用，无法打卡')
      if (!app.isUserApproved(me)) {
        const err = new Error('等待管理员审批，暂时无法打卡')
        err.code = 'NOT_APPROVED'
        throw err
      }

      // 2. 若进页面极速拍照时定位尚在进行中，最多等 2 秒让水印和记录尽量带上真实地址
      if (!this.data.location && this._locationPromise) {
        await Promise.race([
          this._locationPromise,
          new Promise(resolve => setTimeout(resolve, 2000))
        ])
      }

      // 3. 合成水印（重试时若已有水印图则直接复用）
      let wmPath = isRetry && this.data.watermarkedPath ? this.data.watermarkedPath : ''
      if (!wmPath) {
        try {
          wmPath = await this.composeWatermarkPath(rawPath || this.data.photoTempPath)
        } catch (wmErr) {
          console.warn('极速打卡水印合成失败，降级使用原图:', wmErr)
          wmPath = rawPath || this.data.photoTempPath
        }
        this.setData({ watermarkedPath: wmPath })
      }

      // 4. 压缩与上传
      this.setData({ clockStatusText: `正在提交${clockLabel}...` })
      let uploadSourcePath = wmPath
      try {
        const compRes = await smartCompress(wmPath, {
          targetSize: 700,
          minSize: 600,
          maxSize: 800
        })
        if (compRes && compRes.tempFilePath) {
          uploadSourcePath = compRes.tempFilePath
        }
      } catch (_) {}

      const owner = app.globalData.openid
      if (!owner) throw new Error('登录状态已失效，请重新进入小程序')
      const fileName = `inspections/${owner}/${Date.now()}-clock-${Math.random().toString(36).substr(2, 6)}.jpg`
      const uploadRes = await api.uploadFile({
        cloudPath: fileName,
        filePath: uploadSourcePath
      })
      uploadedFileID = uploadRes.fileID

      // 5. 写入打卡记录
      const loc = this.data.location || app.globalData.lastLocation || { latitude: 0, longitude: 0 }
      const subRes = await api.callFunction({
        name: 'submitInspection',
        data: {
          recordType: this.data.recordType,
          taskName: this.data.taskName || `考勤打卡：${clockLabel}`,
          storeName: this.data.storeName || clockLabel,
          userName: this.data.userName || (me && me.name) || '',
          customerId: '',
          fileIDs: [uploadedFileID],
          location: {
            latitude: Number(loc.latitude) || 0,
            longitude: Number(loc.longitude) || 0,
            address: this.data.address || loc.address || ''
          }
        }
      })

      if (!subRes.result || !subRes.result.success) {
        const err = new Error((subRes.result && subRes.result.error) || `${clockLabel}提交失败`)
        err.code = (subRes.result && subRes.result.code) || ''
        throw err
      }

      this.setData({ composing: false, clockStatusText: '' })
      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: `${clockLabel}成功`, icon: 'success', duration: 1500 })

      setTimeout(() => {
        wx.navigateBack({
          fail: () => wx.switchTab({ url: '/pages/home/home' })
        })
      }, 600)
    } catch (err) {
      console.error('极速打卡失败:', err)
      if (uploadedFileID) {
        await offlineQueue.safeDeleteCloudFiles([uploadedFileID])
      }
      const msg = (err && err.message) || '打卡失败'
      const code = (err && err.code) || ''
      const online = await offlineQueue.isOnline()
      const isNetErr = !online || /网络|fail|timeout|超时|ENOENT|uploadFile/i.test(String(msg + ((err && err.errMsg) || '')))

      if (code !== 'NOT_APPROVED' && isNetErr) {
        try {
          const loc = this.data.location || app.globalData.lastLocation || { latitude: 0, longitude: 0 }
          const finalPath = this.data.watermarkedPath || rawPath || this.data.photoTempPath
          await offlineQueue.enqueue({
            photoPaths: [finalPath].filter(Boolean),
            meta: {
              recordType: this.data.recordType,
              taskName: this.data.taskName || `考勤打卡：${clockLabel}`,
              storeName: this.data.storeName || clockLabel,
              userName: this.data.userName || '',
              customerId: '',
              lat: Number(loc.latitude) || 0,
              lng: Number(loc.longitude) || 0,
              address: this.data.address || loc.address || '',
              analyzeMode: 'batch'
            }
          })
          this.setData({ composing: false, clockStatusText: '' })
          wx.showToast({ title: '无网络，已存入待上传队列', icon: 'none', duration: 2200 })
          setTimeout(() => {
            wx.navigateBack({
              fail: () => wx.switchTab({ url: '/pages/home/home' })
            })
          }, 1200)
          return
        } catch (qErr) {
          console.warn('打卡入离线队列失败:', qErr)
        }
      }

      this.setData({
        composing: false,
        clockStatusText: '',
        confirmBtnText: `重试${clockLabel}`
      })
      wx.showToast({ title: msg, icon: 'none', duration: 2500 })
    }
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

  // 确认照片，跳转上传页（上下班打卡模式下若首次提交失败，点击此按钮直接重试极速打卡）
  confirmPhoto() {
    if (this.data.recordType === 'clock_in' || this.data.recordType === 'clock_out') {
      this.submitClockExpress(this.data.photoTempPath || this.data.watermarkedPath, true)
      return
    }
    const { watermarkedPath, location, taskName } = this.data

    if (!watermarkedPath) {
      wx.showToast({ title: '照片未准备好', icon: 'none' })
      return
    }

    // 校验基础信息（不含位置，无定位时静默使用缓存或 {0,0} 兜底放行）
    const { valid, errors } = validateInspection({
      photoPath: watermarkedPath,
      taskName
    })
    if (!valid) {
      wx.showModal({ title: '信息不完整', content: errors.join('\n'), showCancel: false })
      return
    }

    const fallbackLoc = location || app.globalData.lastLocation || { latitude: 0, longitude: 0 }
    this.navigateToUpload(fallbackLoc)
  },

  // 跳转到上传页
  navigateToUpload(location) {
    const { watermarkedPath, watermarkedPaths, uploadPhotoPaths, address, taskName, storeName, userName, selectedCustomerId, recordType } = this.data
    const uploadList = (Array.isArray(uploadPhotoPaths) && uploadPhotoPaths.length > 1)
      ? uploadPhotoPaths
      : ((Array.isArray(watermarkedPaths) && watermarkedPaths.length > 1) ? watermarkedPaths : [])
    const multi = uploadList.length > 1
    let url = `/pages/upload/upload?` +
      `lat=${location.latitude}` +
      `&lng=${location.longitude}` +
      `&address=${encodeURIComponent(address)}` +
      `&taskName=${encodeURIComponent(taskName)}` +
      `&storeName=${encodeURIComponent(storeName)}` +
      `&userName=${encodeURIComponent(userName)}` +
      `&customerId=${encodeURIComponent(selectedCustomerId || '')}` +
      `&recordType=${encodeURIComponent(recordType || 'visit')}`
    if (multi) {
      url += `&photoPaths=${encodeURIComponent(JSON.stringify(uploadList))}`
      if (watermarkedPath) {
        url += `&sharePhotoPath=${encodeURIComponent(watermarkedPath)}`
      }
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
      uploadPhotoPaths: [],
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
