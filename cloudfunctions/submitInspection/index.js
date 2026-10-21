// 云函数：submitInspection
// 功能：收口巡检记录的创建。之前 upload 页是客户端直写 inspections 集合，
// 服务端拦不到（停用的号、越权的号都能写）。现在统一走这个云函数，
// 服务端先校验身份与账号状态，再落库，彻底消除客户端直写带来的安全盲区。
//
// 注意：照片本身仍由客户端直接上传到云存储（拿到 fileID 数组传进来），
// 这是微信云开发的常规做法；本函数只负责"写一条巡检记录"，并带上 _openid 归属。

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 服务端硬校验：前端校验只是 UX 提示，这里才是真正的边界（云函数公开可调，不能只靠前端）
const MAX_PHOTOS = 9        // 单次巡检照片数上限（与 app.globalData.config.maxPhotosPerInspection 一致）
const MAX_TASK_NAME = 100   // 任务名称长度上限
const MAX_STORE_NAME = 100  // 门店名称长度上限
const MAX_USER_NAME = 50    // 业务员姓名长度上限
const MAX_CUSTOMER_ID = 64  // 客户 _id 长度上限
const MAX_ADDRESS = 300     // 地址文本长度上限

function isValidFileID(id, openid) {
  if (typeof id !== 'string' || !id.startsWith('cloud://')) return false
  // 上传端使用 inspections/<openid>/... 目录，防止把已知的他人 fileID
  // 挂到自己的巡检记录中。旧格式文件不再接受新的巡检提交。
  return id.includes(`/inspections/${openid}/`)
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  if (!openid) {
    return { success: false, error: '未获取到用户身份' }
  }

  const { taskName, storeName, userName, customerId, fileIDs, location } = event

  // ---- 入参校验（防绕过前端直接构造请求） ----
  if (!Array.isArray(fileIDs) || fileIDs.length === 0) {
    return { success: false, error: '缺少照片文件，无法提交' }
  }
  if (fileIDs.length > MAX_PHOTOS) {
    return { success: false, error: `单次巡检最多提交 ${MAX_PHOTOS} 张照片` }
  }
  if (!fileIDs.every(id => isValidFileID(id, openid))) {
    return { success: false, error: '照片文件格式不合法' }
  }

  if (typeof taskName !== 'string' || !taskName.trim()) {
    return { success: false, error: '缺少任务名称' }
  }
  if (taskName.length > MAX_TASK_NAME) {
    return { success: false, error: `任务名称不能超过 ${MAX_TASK_NAME} 个字符` }
  }
  if (typeof storeName === 'string' && storeName.length > MAX_STORE_NAME) {
    return { success: false, error: `门店名称不能超过 ${MAX_STORE_NAME} 个字符` }
  }
  if (typeof userName === 'string' && userName.length > MAX_USER_NAME) {
    return { success: false, error: `业务员姓名不能超过 ${MAX_USER_NAME} 个字符` }
  }
  if (typeof customerId === 'string' && customerId.length > MAX_CUSTOMER_ID) {
    return { success: false, error: '客户信息格式不正确' }
  }

  // 位置信息规范化：非法/缺失时降级为空对象（前端拍照流程已有"不带位置继续"的兜底弹窗）
  let safeLocation = {}
  if (location && typeof location === 'object') {
    const lat = Number(location.latitude)
    const lng = Number(location.longitude)
    safeLocation = {
      latitude: Number.isFinite(lat) ? lat : 0,
      longitude: Number.isFinite(lng) ? lng : 0,
      address: (typeof location.address === 'string' ? location.address : '').slice(0, MAX_ADDRESS)
    }
  }

  // 可空字符串字段收口为非字符串一律当作空，避免恶意传数字/对象时下游 .slice() 抛错
  const safeStoreName = typeof storeName === 'string' ? storeName.slice(0, MAX_STORE_NAME) : ''
  const safeCustomerId = typeof customerId === 'string' ? customerId.slice(0, MAX_CUSTOMER_ID) : ''

  try {
    // 服务端账号状态校验：停用账号一律拒绝提交（前端只是 UX 提示，这里才是硬边界）
    const userRes = await db.collection('users').where({ _openid: openid }).get()
    let user = userRes.data[0]
    if (user && user.disabled) {
      return { success: false, error: '账号已停用，无法提交巡检' }
    }
    // 自动兜底建档：避免新用户初次提交因时序未及时建档而被阻断
    if (!user) {
      const newUser = {
        _openid: openid,
        role: 'sales',
        disabled: false,
        name: typeof userName === 'string' ? userName.slice(0, MAX_USER_NAME) : '',
        phone: '',
        department: '',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      try {
        const uRes = await db.collection('users').add({ data: newUser })
        user = { _id: uRes._id, ...newUser }
      } catch (e) {
        user = newUser
      }
    } else if (!user.name && typeof userName === 'string' && userName.trim()) {
      // 若原账号没有名字，把本次填写的业务员姓名补全
      const trimName = userName.trim().slice(0, MAX_USER_NAME)
      user.name = trimName
      db.collection('users').doc(user._id).update({
        data: { name: trimName, updatedAt: db.serverDate() }
      }).catch(console.error)
    }

    const finalUserName = (user && typeof user.name === 'string' && user.name)
      ? user.name.slice(0, MAX_USER_NAME)
      : (typeof userName === 'string' ? userName.slice(0, MAX_USER_NAME) : '')

    const addRes = await db.collection('inspections').add({
      data: {
        _openid: openid,                 // 显式写入归属，便于 sales 仅看自己的记录
        taskName: taskName.trim(),
        storeName: safeStoreName,
        userName: finalUserName,
        customerId: safeCustomerId,
        photoFileIDs: fileIDs,
        photoCount: fileIDs.length,
        location: safeLocation,
        status: 'pending',              // 待分析，batchAnalyze 领取的唯一依据
        analyzeAttempts: 0,
        createdAt: db.serverDate()
      }
    })

    return { success: true, inspectionId: addRes._id }
  } catch (err) {
    console.error('submitInspection 失败:', err)
    return { success: false, error: err.message }
  }
}
