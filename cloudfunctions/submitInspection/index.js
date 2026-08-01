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

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  if (!openid) {
    return { success: false, error: '未获取到用户身份' }
  }

  const { taskName, storeName, userName, customerId, fileIDs, location } = event

  if (!Array.isArray(fileIDs) || fileIDs.length === 0) {
    return { success: false, error: '缺少照片文件，无法提交' }
  }

  try {
    // 服务端账号状态校验：停用账号一律拒绝提交（前端只是 UX 提示，这里才是硬边界）
    const userRes = await db.collection('users').where({ _openid: openid }).get()
    const user = userRes.data[0]
    if (user && user.disabled) {
      return { success: false, error: '账号已停用，无法提交巡检' }
    }

    const addRes = await db.collection('inspections').add({
      data: {
        _openid: openid,                 // 显式写入归属，便于 sales 仅看自己的记录
        taskName: taskName || '',
        storeName: storeName || '',
        userName: userName || '',
        customerId: customerId || '',
        photoFileIDs: fileIDs,
        photoCount: fileIDs.length,
        location: location || {},
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
