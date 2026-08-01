// pages/camera/camera.js
// 水印相机页面

const app = getApp()
const { getLocation: fetchLocation } = require('../../utils/location')
const { validateInspection } = require('../../utils/validator')

// 任务名称默认值（用户可随时更改，改动会本机记忆）
const TASK_NAME_DEFAULT = '永丰特8：常规拜访'

Page({
  data: {
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

    // 水印样式配置
    watermarkConfig: {
      position: 'bottom',
      color: '#ffffff',
      bgColor: 'rgba(0, 0, 0, 0.4)',
      opacity: 1,
      fontSize: 16,
      showLogo: true
    },

    // 拍照状态
    photoTempPath: '',
    watermarkedPath: '',
    showPreview: false,
    composing: false,

    // 连拍/拼图：最多拍 maxPhotos 张，完成后如果超过1张就拼成一张网格大图，
    // 只有1张的话跳过拼图步骤，直接走原来的单图水印流程
    capturedPhotos: [],
    maxPhotos: 6,

    // 设置面板
    showSettings: false
  },

  onLoad(options) {
    // 从上一页或全局获取业务员信息
    this.loadUserInfo(options)
    // 获取位置
    this.getLocation()

    // 登录是异步的，camera 作为首页在 onLoad 时可能还没拿到用户信息
    // （业务员默认姓名存在云端 users 集合）。若此刻还没有姓名，等登录完成
    // 后再补一次 loadUserInfo，确保业务员姓名能默认带出来。
    if (!app.globalData.isLoggedIn || !(app.globalData.userInfo && app.globalData.userInfo.name)) {
      app.loginCallback = () => this.loadUserInfo(options)
    }
  },

  onShow() {
    // 从"选择客户"页面（customers 页选择模式）返回时，globalData 里会带着
    // 选中的客户资料，这里取一次就清空，避免下次进相机页误把上次的选择带进来
    const selected = app.globalData.selectedCustomer
    if (selected) {
      app.globalData.selectedCustomer = null
      this.setData({
        storeName: selected.storeName || '',
        address: selected.address || this.data.address,
        selectedCustomerId: selected._id
      })
      wx.showToast({ title: `已选择：${selected.storeName}`, icon: 'none' })
    }
  },

  onReady() {
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
    this.setData({ taskName: e.detail.value })
    // 记住上次填的任务名，下次进入默认带出（可更改）
    wx.setStorageSync('shelfguard_lastTaskName', e.detail.value)
  },

  onUserNameInput(e) {
    this.setData({ userName: e.detail.value })
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

  // 完成拍照：1张直接走原来的单图水印流程；多张先拼成一张网格大图，
  // 再对拼好的这张大图打水印（水印只打一次，不是每张小图各打一次）
  async finishCapture() {
    const { capturedPhotos } = this.data
    if (capturedPhotos.length === 0) {
      wx.showToast({ title: '还没有拍照', icon: 'none' })
      return
    }

    this.setData({ showPreview: true, composing: true })

    try {
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

      this.setData({ photoTempPath: sourcePath })
      await this.composeWatermark(sourcePath)
    } catch (err) {
      console.error('拼图/合成失败:', err)
      this.setData({ composing: false })
      wx.showToast({ title: '处理失败，请重试', icon: 'none' })
    }
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
      showPreview: false,
      capturedPhotos: []
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
    const { watermarkedPath, address, taskName, storeName, userName, selectedCustomerId } = this.data
    wx.navigateTo({
      url: `/pages/upload/upload?` +
        `photoPath=${encodeURIComponent(watermarkedPath)}` +
        `&lat=${location.latitude}` +
        `&lng=${location.longitude}` +
        `&address=${encodeURIComponent(address)}` +
        `&taskName=${encodeURIComponent(taskName)}` +
        `&storeName=${encodeURIComponent(storeName)}` +
        `&userName=${encodeURIComponent(userName)}` +
        `&customerId=${encodeURIComponent(selectedCustomerId || '')}`
    })
    // 提交后重置拍照状态：camera 是 tabBar 页，report 页的"再拍一张"是
    // wx.switchTab 回来，不会重新触发 onLoad，如果不在这里清空，
    // capturedPhotos/showPreview 这些会带着上一次巡检的照片留在页面上
    this.setData({
      capturedPhotos: [],
      photoTempPath: '',
      watermarkedPath: '',
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
                      // 用户在设置页里重新开启了，刷新一下相机组件状态
                      this.setData({ cameraReady: false })
                      wx.showToast({ title: '权限已开启，请重新进入', icon: 'none' })
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
