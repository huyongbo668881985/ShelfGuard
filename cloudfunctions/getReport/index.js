// 云函数：getReport
// 功能：获取单条巡检详情（含 AI 报告），供 report 详情页的加载与轮询使用。
//
// 为什么必须走云函数、不能直接在前端连数据库：
// 前端 wx.cloud.database() 查询受集合安全规则约束。若 inspections 集合是
// “仅创建者可读写”（项目权限模型的核心设定），管理者打开他人的巡检记录会被
// 安全规则拦截，详情页直接 catch 报错，导致刚做好的“管理者视角”实质失效。
// 云函数以管理员权限运行、绕过安全规则，因此必须在这里显式做归属校验。
//
// 权限模型与 analyzeImage / getHistory 一致：
// - 记录本人（_openid）可直接读取；
// - 管理者（role: admin / manager）可读全员；
// - 其他情况拒绝，不信任任何客户端传来的角色声明。

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

const MANAGER_ROLES = ['admin', 'manager']

async function getCaller(openid) {
  try {
    const res = await db.collection('users').where({ _openid: openid }).get()
    return res.data[0] || null
  } catch (err) {
    console.error('查询用户失败，按普通业务员处理:', err)
    return null
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const { inspectionId } = event

  if (!inspectionId) {
    return { success: false, error: '缺少 inspectionId' }
  }

  // 停用账号拦截：停用的号不能读取任何巡检详情
  const caller = await getCaller(openid)
  if (caller && caller.disabled) {
    return { success: false, error: '账号已停用，请联系管理员' }
  }

  let doc
  try {
    const res = await db.collection('inspections').doc(inspectionId).get()
    doc = res.data
  } catch (err) {
    console.error('查询巡检详情失败:', err)
    return { success: false, error: '巡检记录不存在或无权访问' }
  }

  if (!doc) {
    return { success: false, error: '巡检记录不存在' }
  }

  // 归属校验：本人可直接读；管理者可读全员；其余拒绝
  if (doc._openid !== openid) {
    const role = (caller && MANAGER_ROLES.includes(caller.role)) ? caller.role : 'sales'
    if (!MANAGER_ROLES.includes(role)) {
      console.warn(`拒绝越权读取: caller=${openid} 试图读取 inspection=${inspectionId}（属于 ${doc._openid}）`)
      return { success: false, error: '无权访问该巡检记录' }
    }
  }

  return { success: true, detail: doc }
}
