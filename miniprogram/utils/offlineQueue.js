// utils/offlineQueue.js
// 客户端未提交成功的巡检离线队列（与云端 pending 分析队列语义分开）
//
// 存什么：
// - 元数据：客户、位置、任务名等
// - 照片：尽量拷到 USER_DATA_PATH 持久化；拷失败则仍记 temp 路径（冷启动可能失效）
//
// 何时入队：无网 / uploadFile 失败 / submitInspection 失败（且用户选「稍后上传」）
// 何时出队：app 启动、上传页 onShow、手动「一键重试」成功后

const STORAGE_KEY = 'shelfguard_offline_queue_v1'
const MAX_ITEMS = 30

function getFs() {
  try {
    return wx.getFileSystemManager()
  } catch (_) {
    return null
  }
}

function queueDir() {
  const base = (typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH) || ''
  return base ? `${base}/offline-queue` : ''
}

function loadRaw() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    return Array.isArray(raw) ? raw : []
  } catch (_) {
    return []
  }
}

function saveRaw(list) {
  let next = Array.isArray(list) ? list.slice() : []
  // 超出上限时淘汰最旧项，并清理其本地持久化目录，避免存储泄漏
  if (next.length > MAX_ITEMS) {
    const dropped = next.slice(MAX_ITEMS)
    next = next.slice(0, MAX_ITEMS)
    dropped.forEach(item => {
      if (item && item.id) removePersistedDir(item.id)
    })
    try {
      wx.showToast({
        title: `队列已满，已丢弃最旧 ${dropped.length} 条`,
        icon: 'none',
        duration: 2500
      })
    } catch (_) {}
  }
  wx.setStorageSync(STORAGE_KEY, next)
}

function genId() {
  return `oq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 把临时图拷到用户目录，返回持久路径；失败则回退原路径 */
function persistPhoto(tempPath, itemId, index) {
  return new Promise((resolve) => {
    const fs = getFs()
    const dir = queueDir()
    if (!fs || !dir || !tempPath) {
      resolve(tempPath)
      return
    }
    try {
      try { fs.accessSync(dir) } catch (_) { fs.mkdirSync(dir, true) }
      const itemDir = `${dir}/${itemId}`
      try { fs.accessSync(itemDir) } catch (_) { fs.mkdirSync(itemDir, true) }
      const dest = `${itemDir}/${index}.jpg`
      fs.copyFile({
        srcPath: tempPath,
        destPath: dest,
        success: () => resolve(dest),
        fail: () => {
          // saveFile 作为次选（会挪走原文件，谨慎）
          try {
            fs.saveFile({
              tempFilePath: tempPath,
              success: (r) => resolve(r.savedFilePath || tempPath),
              fail: () => resolve(tempPath)
            })
          } catch (_) {
            resolve(tempPath)
          }
        }
      })
    } catch (_) {
      resolve(tempPath)
    }
  })
}

function removePersistedDir(itemId) {
  const fs = getFs()
  const dir = queueDir()
  if (!fs || !dir || !itemId) return
  try {
    fs.rmdirSync(`${dir}/${itemId}`, true)
  } catch (_) {
    try {
      const files = fs.readdirSync(`${dir}/${itemId}`)
      ;(files || []).forEach(name => {
        try { fs.unlinkSync(`${dir}/${itemId}/${name}`) } catch (__) {}
      })
      fs.rmdirSync(`${dir}/${itemId}`)
    } catch (__) {}
  }
}

/**
 * 入队
 * @param {object} payload
 * @param {string[]} payload.photoPaths 本地照片路径（压缩后优先）
 * @param {object} payload.meta { taskName, storeName, userName, customerId, lat, lng, address, analyzeMode }
 */
async function enqueue(payload) {
  const photoPaths = (payload && payload.photoPaths) || []
  if (!photoPaths.length) {
    throw new Error('离线队列需要至少一张照片')
  }
  const id = genId()
  const persisted = []
  for (let i = 0; i < photoPaths.length; i++) {
    const p = await persistPhoto(photoPaths[i], id, i)
    persisted.push(p)
  }

  const item = {
    id,
    createdAt: Date.now(),
    attempts: 0,
    lastError: '',
    photoPaths: persisted,
    meta: {
      taskName: (payload.meta && payload.meta.taskName) || '',
      storeName: (payload.meta && payload.meta.storeName) || '',
      userName: (payload.meta && payload.meta.userName) || '',
      customerId: (payload.meta && payload.meta.customerId) || '',
      lat: (payload.meta && payload.meta.lat) || 0,
      lng: (payload.meta && payload.meta.lng) || 0,
      address: (payload.meta && payload.meta.address) || '',
      analyzeMode: (payload.meta && payload.meta.analyzeMode) || 'batch'
    }
  }

  const list = loadRaw()
  list.unshift(item)
  saveRaw(list)
  return item
}

function list() {
  return loadRaw()
}

function count() {
  return loadRaw().length
}

function remove(id) {
  const list = loadRaw().filter(x => x.id !== id)
  saveRaw(list)
  removePersistedDir(id)
}

function updateItem(id, patch) {
  const list = loadRaw()
  const idx = list.findIndex(x => x.id === id)
  if (idx < 0) return
  list[idx] = { ...list[idx], ...patch }
  saveRaw(list)
}

function isOnline() {
  return new Promise((resolve) => {
    wx.getNetworkType({
      success: (res) => resolve(res.networkType !== 'none'),
      fail: () => resolve(true) // 拿不到时先当有网，让重试自己暴露错误
    })
  })
}

/** 尽力删除云文件，忽略失败 */
async function safeDeleteCloudFiles(fileIDs) {
  const ids = (fileIDs || []).filter(Boolean)
  if (!ids.length) return
  try {
    await wx.cloud.deleteFile({ fileList: ids })
  } catch (err) {
    console.warn('清理云文件失败:', err)
  }
}

/**
 * 上传一张本地图到云存储
 */
async function uploadOne(localPath, openid, index) {
  if (!openid) {
    throw new Error('未登录')
  }
  const owner = openid
  const cloudPath = `inspections/${owner}/${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const uploadRes = await wx.cloud.uploadFile({
    cloudPath,
    filePath: localPath
  })
  return uploadRes.fileID
}

/**
 * 刷新单条队列项：upload → submitInspection → 成功出队
 * @returns {{ ok: boolean, error?: string, inspectionId?: string }}
 */
async function flushOne(item, options = {}) {
  const openid = options.openid || ''
  const fileIDs = []
  try {
    if (!openid) {
      return { ok: false, error: '未登录' }
    }
    const online = await isOnline()
    if (!online) {
      return { ok: false, error: '当前无网络' }
    }

    for (let i = 0; i < item.photoPaths.length; i++) {
      const path = item.photoPaths[i]
      const fileID = await uploadOne(path, openid, i)
      fileIDs.push(fileID)
    }

    const meta = item.meta || {}
    const res = await wx.cloud.callFunction({
      name: 'submitInspection',
      data: {
        taskName: meta.taskName,
        storeName: meta.storeName,
        userName: meta.userName,
        customerId: meta.customerId || '',
        fileIDs,
        location: {
          latitude: meta.lat || 0,
          longitude: meta.lng || 0,
          address: meta.address || ''
        }
      }
    })

    if (!res.result || !res.result.success) {
      await safeDeleteCloudFiles(fileIDs)
      const err = (res.result && res.result.error) || '提交失败'
      updateItem(item.id, {
        attempts: (item.attempts || 0) + 1,
        lastError: err
      })
      return { ok: false, error: err }
    }

    // 即时分析模式：尽力触发，不阻塞出队
    if (meta.analyzeMode === 'instant' && res.result.inspectionId) {
      try {
        await wx.cloud.callFunction({
          name: 'analyzeImage',
          data: { fileIDs, inspectionId: res.result.inspectionId }
        })
      } catch (_) {}
    }

    remove(item.id)
    return { ok: true, inspectionId: res.result.inspectionId }
  } catch (err) {
    await safeDeleteCloudFiles(fileIDs)
    const msg = (err && err.message) || '上传失败'
    updateItem(item.id, {
      attempts: (item.attempts || 0) + 1,
      lastError: msg
    })
    return { ok: false, error: msg }
  }
}

/**
 * 依次刷新整队
 * @returns {{ total, succeeded, failed, errors: string[] }}
 */
async function flushAll(options = {}) {
  const items = loadRaw()
  let succeeded = 0
  let failed = 0
  const errors = []
  for (const item of items) {
    const r = await flushOne(item, options)
    if (r.ok) succeeded++
    else {
      failed++
      if (r.error) errors.push(r.error)
    }
  }
  return { total: items.length, succeeded, failed, errors }
}

module.exports = {
  enqueue,
  list,
  count,
  remove,
  flushOne,
  flushAll,
  isOnline,
  safeDeleteCloudFiles,
  STORAGE_KEY
}
