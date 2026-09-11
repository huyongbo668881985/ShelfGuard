// pages/upload/upload.js
// 上传页面 - 多图压缩上传 + 提交入队（默认不在此等待 AI 分析）
//
// 【流程说明】
// 默认走"每日集中分析"模式：压缩 → 上传云存储 → 写巡检记录（status: pending）→ 直接显示"已提交"。
// 业务员不用在这里干等 AI，点"继续拜访下一家"就能去下一个客户。
// 真正的 AI 分析由 batchAnalyze 云函数在设定时间（默认 21:00）集中跑。
//
// 如果管理员在「分析设置」里把模式切成 instant，才会退回旧流程：
// 提交后原地等 AI 出结果，再自动跳报告页。

const app = getApp()
const { smartCompress } = require('../../utils/compress')
// 展示用格式化统一使用 utils/format.formatFileSize（入参为字节），
// 与下方 photo.compressedSize（字节）引用同一单位来源，避免 KB/字节混用造成误解。
const { formatFileSize } = require('../../utils/format')

Page({
  data: {
    // 照片列表（支持多张）
    photos: [],
    // 基本信息
    lat: 0,
    lng: 0,
    address: '',
    taskName: '',
    storeName: '',
    userName: '',
    // 上传状态
    // ready | compressing | uploading | analyzing | submitted | success | error
    // submitted = 集中分析模式下的终态（已入队，等待定时分析）
    // success   = 即时分析模式下的终态（AI 已出结果，马上跳报告页）
    status: 'ready',
    compressProgress: 0,
    uploadProgress: 0,
    currentPhotoIndex: 0,
    totalPhotos: 0,
    // 结果
    inspectionId: '',
    fileIDs: [],
    // 分析模式与提示文案
    analyzeMode: 'batch',
    analyzeTime: '21:00',
    // 错误信息
    errorMsg: ''
  },

  onLoad(options) {
    // 解析单张或多张照片
    const photoPath = decodeURIComponent(options.photoPath || '')
    const photoPaths = options.photoPaths
      ? JSON.parse(decodeURIComponent(options.photoPaths))
      : (photoPath ? [photoPath] : [])

    const photos = photoPaths.map(path => ({
      originalPath: path,
      compressedPath: '',
      fileID: '',
      size: 0,
      compressedSize: 0,
      status: 'pending' // pending | compressed | uploaded | error
    }))

    // 先用全局缓存的模式渲染，避免首屏闪烁；随后再异步拉一次最新配置
    const cached = (app.globalData.systemConfig) || {}

    this.setData({
      photos,
      totalPhotos: photos.length,
      lat: parseFloat(options.lat) || 0,
      lng: parseFloat(options.lng) || 0,
      address: decodeURIComponent(options.address || ''),
      taskName: decodeURIComponent(options.taskName || ''),
      storeName: decodeURIComponent(options.storeName || ''),
      userName: decodeURIComponent(options.userName || ''),
      customerId: decodeURIComponent(options.customerId || ''),
      analyzeMode: cached.analyzeMode || 'batch',
      analyzeTime: cached.analyzeTime || '21:00'
    })

    // 不阻塞页面：模式只在整个上传流程的最后一步才用得上，
    // 等用户压缩+上传完，这个请求早就回来了
    this.refreshAnalyzeMode()
  },

  // 拉取最新的分析模式配置（失败就沿用缓存/默认值，不打断流程）
  async refreshAnalyzeMode() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'settings',
        data: { action: 'get' }
      })
      if (res.result && res.result.success) {
        const s = res.result.settings
        app.globalData.systemConfig = {
          analyzeMode: s.analyzeMode,
          analyzeTime: s.analyzeTime
        }
        this.setData({
          analyzeMode: s.analyzeMode,
          analyzeTime: s.analyzeTime
        })
      }
    } catch (err) {
      console.warn('读取分析模式失败，按默认的集中分析模式处理:', err)
    }
  },

  // 预览图片
  previewImage(e) {
    const index = e.currentTarget.dataset.index
    const urls = this.data.photos.map(p => p.compressedPath || p.originalPath)
    wx.previewImage({
      current: urls[index],
      urls: urls
    })
  },

  // 开始上传流程
  async handleUpload() {
    if (this.data.status !== 'ready' && this.data.status !== 'error') {
      return
    }

    // 账号停用前置拦截（真正硬边界在 submitInspection 云函数里，这里是 UX 提示）
    const me = app.globalData.userInfo
    if (me && me.disabled) {
      wx.showModal({
        title: '账号已停用',
        content: '你的账号已被管理员停用，无法提交巡检记录。如有疑问请联系管理员。',
        showCancel: false
      })
      return
    }

    this.setData({
      status: 'compressing',
      compressProgress: 0,
      errorMsg: ''
    })

    try {
      // 1. 压缩所有照片
      await this.compressAllPhotos()

      // 2. 上传到云存储
      this.setData({ status: 'uploading', uploadProgress: 0 })
      await this.uploadAllPhotos()

      // 3. 创建巡检记录（状态 pending = 已入队待分析）
      const inspectionId = await this.createInspection()
      this.setData({ inspectionId })

      // 4. 分流：集中分析模式到此为止，即时分析模式继续等 AI
      if (this.data.analyzeMode === 'instant') {
        this.setData({ status: 'analyzing' })
        await this.triggerAnalysis(inspectionId)
        this.setData({ status: 'success' })
        setTimeout(() => {
          wx.redirectTo({ url: `/pages/report/report?id=${inspectionId}` })
        }, 1200)
      } else {
        // 集中分析：不调用 AI，直接告诉用户已提交
        this.setData({ status: 'submitted' })
        wx.vibrateShort({ type: 'light' })
      }

    } catch (err) {
      console.error('上传流程失败:', err)
      this.setData({
        status: 'error',
        errorMsg: err.message || '上传失败'
      })
    }
  },

  // 压缩所有照片
  async compressAllPhotos() {
    const photos = this.data.photos
    const total = photos.length

    for (let i = 0; i < total; i++) {
      const photo = photos[i]
      this.setData({
        currentPhotoIndex: i + 1,
        compressProgress: Math.round((i / total) * 100)
      })

      try {
        const result = await smartCompress(photo.originalPath, {
          targetSize: 700,
          minSize: 600,
          maxSize: 800
        })

        photo.compressedPath = result.tempFilePath
        // 统一单位：smartCompress 返回的 result.size 单位是 KB，这里换算成字节，
        // 与下面 photo.size（来自 wx.getFileInfo，单位字节）保持一致，避免 UI 同时展示时混淆。
        photo.compressedSize = Math.round(result.size * 1024)
        // 展示文本直接复用字节值 photo.compressedSize，与上面的数值字段同一来源，
        // 不再单独引用 result.size（KB），彻底避免 KB/字节混用。
        photo.compressedSizeText = formatFileSize(photo.compressedSize)
        photo.status = 'compressed'

        // 获取原图大小（字节）
        const imgInfo = await new Promise(resolve => {
          wx.getFileInfo({
            filePath: photo.originalPath,
            success: res => resolve(res),
            fail: () => resolve({ size: 0 })
          })
        })
        photo.size = imgInfo.size

      } catch (err) {
        console.error(`压缩第 ${i + 1} 张照片失败:`, err)
        photo.status = 'error'
        photo.compressedPath = photo.originalPath // 使用原图
      }

      // 更新视图
      this.setData({ photos: [...photos] })
    }

    this.setData({ compressProgress: 100 })
  },

  // 上传所有照片到云存储
  async uploadAllPhotos() {
    const photos = this.data.photos
    const total = photos.length
    const fileIDs = []

    for (let i = 0; i < total; i++) {
      const photo = photos[i]
      this.setData({
        currentPhotoIndex: i + 1,
        uploadProgress: Math.round((i / total) * 100)
      })

      try {
        const filePath = photo.compressedPath || photo.originalPath
        const owner = app.globalData.openid
        if (!owner) throw new Error('登录状态已失效，请重新进入小程序')
        const fileName = `inspections/${owner}/${Date.now()}-${i}-${Math.random().toString(36).substr(2, 6)}.jpg`

        const uploadRes = await wx.cloud.uploadFile({
          cloudPath: fileName,
          filePath: filePath
        })

        photo.fileID = uploadRes.fileID
        photo.status = 'uploaded'
        fileIDs.push(uploadRes.fileID)

      } catch (err) {
        console.error(`上传第 ${i + 1} 张照片失败:`, err)
        photo.status = 'error'
        throw new Error(`第 ${i + 1} 张照片上传失败`)
      }

      this.setData({ photos: [...photos] })
    }

    this.setData({
      fileIDs: fileIDs,
      uploadProgress: 100
    })
  },

  // 创建巡检记录
  // 统一走 submitInspection 云函数落库：服务端会先校验账号状态（停用拦截）、
  // 写入归属 _openid。status 一律是 pending（待分析），这是 batchAnalyze 领取任务的唯一依据。
  // 即时分析模式下 analyzeImage 会很快把它改成 analyzed；万一即时分析没跑成，
  // 记录还留在 pending，仍然会被定时任务捡起来兜底，不会丢单。
  //
  // 注：照片文件本身在 uploadAllPhotos 里已由客户端直传云存储拿到 fileID 数组，
  // 这里只把 fileID + 元数据交给云函数写一条记录，符合微信云开发常规做法。
  async createInspection() {
    const { fileIDs, lat, lng, address, taskName, storeName, userName, customerId } = this.data

    const res = await wx.cloud.callFunction({
      name: 'submitInspection',
      data: {
        taskName,
        storeName,
        userName,
        customerId: customerId || '',
        fileIDs,
        location: {
          latitude: lat,
          longitude: lng,
          address: address
        }
      }
    })

    if (!res.result || !res.result.success) {
      throw new Error((res.result && res.result.error) || '提交巡检记录失败')
    }

    return res.result.inspectionId
  },

  // 触发 AI 分析（仅即时分析模式使用）
  // 注意：一次巡检的所有照片一起打包传给云函数，由 AI 合并成一份报告。
  // 不要按张循环调用——那样每次都会用最新结果覆盖同一条巡检记录的 aiReport，
  // 前面几张照片的分析结果和调用成本都会被白白浪费。
  async triggerAnalysis(inspectionId) {
    const { fileIDs } = this.data

    try {
      await wx.cloud.callFunction({
        name: 'analyzeImage',
        data: { fileIDs, inspectionId }
      })
    } catch (err) {
      console.error('AI 分析触发失败:', err)
      // 不中断流程：云函数可能仍在后台继续跑，report 页面的轮询会捕获最终结果；
      // 即便真的没跑起来，记录还是 pending，定时任务会兜底
    }
  },

  // ============================================================
  // 提交完成后的两个出口
  // ============================================================

  // 继续拜访下一家：回到相机页并清空上一家的门店信息，直接弹出客户选择
  continueVisit() {
    // 用全局标记跟相机页通信。相机页是 tabBar 页，navigateBack 回去只会触发
    // onShow 不会触发 onLoad，没法用页面参数传，只能走 globalData。
    app.globalData.startNextVisit = true
    wx.navigateBack({
      fail: () => {
        // 页面栈异常（比如从分享链接直接进来的）时兜底
        wx.switchTab({ url: '/pages/camera/camera' })
      }
    })
  },

  // 查看这条记录：集中分析模式下此时还没有报告，进去看到的是"排队中"
  viewReport() {
    const { inspectionId } = this.data
    if (!inspectionId) return
    wx.redirectTo({ url: `/pages/report/report?id=${inspectionId}` })
  },

  // 重试上传
  retryUpload() {
    this.setData({
      status: 'ready',
      errorMsg: ''
    })
    this.handleUpload()
  },

  // 返回重拍
  goBack() {
    wx.navigateBack()
  },

  // 格式化文件大小
  formatSize(bytes) {
    if (!bytes) return ''
    if (bytes < 1024) return bytes + 'B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
  }
})
