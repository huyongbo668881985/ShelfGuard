// pages/upload/upload.js
// 上传页面 - 支持多图压缩上传 + AI 分析

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
    status: 'ready', // ready | compressing | uploading | analyzing | success | error
    compressProgress: 0,
    uploadProgress: 0,
    currentPhotoIndex: 0,
    totalPhotos: 0,
    // 结果
    inspectionId: '',
    fileIDs: [],
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

    this.setData({
      photos,
      totalPhotos: photos.length,
      lat: parseFloat(options.lat) || 0,
      lng: parseFloat(options.lng) || 0,
      address: decodeURIComponent(options.address || ''),
      taskName: decodeURIComponent(options.taskName || ''),
      storeName: decodeURIComponent(options.storeName || ''),
      userName: decodeURIComponent(options.userName || ''),
      customerId: decodeURIComponent(options.customerId || '')
    })
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

      // 3. 创建巡检记录
      const inspectionId = await this.createInspection()

      // 4. 触发 AI 分析
      this.setData({ status: 'analyzing' })
      await this.triggerAnalysis(inspectionId)

      // 5. 完成
      this.setData({
        status: 'success',
        inspectionId: inspectionId
      })

      // 延迟跳转到报告页
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/report/report?id=${inspectionId}`
        })
      }, 1500)

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
        const fileName = `inspections/${Date.now()}-${i}-${Math.random().toString(36).substr(2, 6)}.jpg`

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
  async createInspection() {
    const { fileIDs, lat, lng, address, taskName, storeName, userName, customerId } = this.data

    const db = wx.cloud.database()
    const addRes = await db.collection('inspections').add({
      data: {
        taskName,
        storeName,
        userName,
        customerId: customerId || '', // 关联客户库的 _id，可能为空（手打门店名、没走客户库选择的情况）
        photoFileIDs: fileIDs,
        photoCount: fileIDs.length,
        location: {
          latitude: lat,
          longitude: lng,
          address: address
        },
        status: 'uploaded',
        createdAt: db.serverDate()
      }
    })

    return addRes._id
  },

  // 触发 AI 分析
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
      // 不中断流程：云函数可能仍在后台继续跑，report 页面的轮询会捕获最终结果
    }
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
