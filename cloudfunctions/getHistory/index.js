// 云函数：getHistory
// 功能：查询巡检记录（分页列表 + 汇总统计），支持基于角色的可见范围
//
// 权限模型：
// - 普通业务员（role: 'sales' 或未设置）：无论前端传什么筛选参数，服务端都强制
//   只返回自己（_openid）的记录——这是修过的漏洞，不能再开回去。
// - 管理者（role: 'admin' / 'manager'）：可以看全部业务员的记录，也可以传
//   targetUserName 只看某个业务员的。
// 角色永远从服务端 users 表按 openid 查出来，不信任客户端传的任何角色声明。

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

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

// 构建通用查询条件（列表和统计共用）
function buildBaseConditions({ isManager, openid, targetUserName, where }) {
  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

  let conditions = {
    createdAt: (where && where.createdAt) || _.gte(ninetyDaysAgo)
  }

  if (isManager) {
    // 管理者：默认看全部业务员；如果指定了 targetUserName，只看这个人的
    if (targetUserName) {
      conditions.userName = targetUserName
    }
  } else {
    // 普通业务员：忽略任何 targetUserName，强制只能看自己
    conditions._openid = openid
  }

  if (where && where['aiReport.score']) {
    conditions['aiReport.score'] = where['aiReport.score']
  }

  // 关键词搜索：前端只传纯文本 keyword，服务端负责拼接 $or（门店名/任务名模糊匹配）。
  // 之前的实现是把 _.or(...) 直接塞进 where._ 再靠 where._._actions 内部字段判断，
  // 但 db.command 经 callFunction JSON 序列化后 _actions 通常不存在，导致搜索条件被静默丢弃。
  // 改为显式传 keyword 由服务端拼 $or，不再依赖序列化内部字段。
  if (where && where.keyword) {
    conditions = _.and(conditions, _.or([
      { storeName: db.RegExp({ regexp: where.keyword, options: 'i' }) },
      { taskName: db.RegExp({ regexp: where.keyword, options: 'i' }) }
    ]))
  }

  return conditions
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const { action = 'list', page = 1, pageSize = 20, where = {}, targetUserName = '' } = event

  const caller = await getCaller(openid)
  if (caller && caller.disabled) {
    return { success: false, error: '账号已停用，请联系管理员' }
  }
  const role = (caller && MANAGER_ROLES.includes(caller.role)) ? caller.role : 'sales'
  const isManager = MANAGER_ROLES.includes(role)
  const queryConditions = buildBaseConditions({ isManager, openid, targetUserName, where })

  try {
    if (action === 'stats') {
      const totalRes = await db.collection('inspections').where(queryConditions).count()

      const weekAgo = new Date()
      weekAgo.setDate(weekAgo.getDate() - 7)
      // 注意：queryConditions 在有关键词时是 _.and(...) 命令对象，不能用 { ...queryConditions }
      // 展开（命令对象的内部字段不可枚举，展开会变空对象），必须用 _.and() 包裹拼接。
      const weekConditions = _.and(queryConditions, { createdAt: _.gte(weekAgo) })
      const weekRes = await db.collection('inspections').where(weekConditions).count()

      // 平均分：游标遍历全部有分数的记录再求平均，避免之前 .limit(100) 截断导致
      // 业务员记录一多或管理者看全员时平均分明显失真。
      let avgScore = 0
      let totalScore = 0
      let scoreCount = 0
      const BATCH_SIZE = 100
      for (let skip = 0; ; skip += BATCH_SIZE) {
        const batch = await db.collection('inspections')
          .where(_.and(queryConditions, { 'aiReport.score': _.exists(true) }))
          .field({ 'aiReport.score': true })
          .skip(skip)
          .limit(BATCH_SIZE)
          .get()

        if (batch.data.length === 0) break
        for (const item of batch.data) {
          totalScore += (item.aiReport?.score || 0)
          scoreCount++
        }
        if (batch.data.length < BATCH_SIZE) break
      }
      if (scoreCount > 0) {
        avgScore = Math.round(totalScore / scoreCount)
      }

      return {
        success: true,
        isManager,
        stats: { total: totalRes.total, thisWeek: weekRes.total, avgScore }
      }
    }

    // action === 'list'
    const countRes = await db.collection('inspections').where(queryConditions).count()
    const total = countRes.total

    const listRes = await db.collection('inspections')
      .where(queryConditions)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .field({
        _id: true,
        taskName: true,
        storeName: true,
        userName: true,
        photoFileIDs: true,
        photoCount: true,
        location: true,
        status: true,
        aiReport: true,
        createdAt: true
      })
      .get()

    return {
      success: true,
      isManager,
      total,
      page,
      pageSize,
      list: listRes.data
    }
  } catch (err) {
    console.error('查询历史失败:', err)
    return { success: false, error: err.message, list: [] }
  }
}
