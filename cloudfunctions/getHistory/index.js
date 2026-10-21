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
const MAX_PAGE_SIZE = 50
const MAX_KEYWORD_LENGTH = 50

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeScore(value) {
  if (value === null || value === undefined || value === '') return null
  const score = Number(value)
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null
}

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

  // 前端只传原语（startDateISO / scoreMin / scoreMax / keyword），
  // db.command 命令对象由服务端重建——命令对象经 callFunction JSON 序列化会丢失
  // 内部字段，前端直接透传 _.gte / _.and / _.lt 会导致筛选条件被静默丢弃。
  let createdAtCondition = _.gte(ninetyDaysAgo)
  if (where && where.startDateISO) {
    const startDate = new Date(where.startDateISO)
    if (!isNaN(startDate.getTime())) {
      createdAtCondition = _.gte(startDate)
    }
  }

  let conditions = {
    createdAt: createdAtCondition
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

  const scoreMin = normalizeScore(where && where.scoreMin)
  const scoreMax = normalizeScore(where && where.scoreMax)
  if (scoreMin !== null) {
    conditions['aiReport.score'] = _.gte(scoreMin)
  }
  if (scoreMax !== null) {
    const cur = conditions['aiReport.score']
    conditions['aiReport.score'] = cur
      ? _.and(cur, _.lte(scoreMax))
      : _.lte(scoreMax)
  }

  // 关键词搜索：前端只传纯文本 keyword，服务端负责拼接 $or（门店名/任务名模糊匹配）。
  // 之前的实现是把 _.or(...) 直接塞进 where._ 再靠 where._._actions 内部字段判断，
  // 但 db.command 经 callFunction JSON 序列化后 _actions 通常不存在，导致搜索条件被静默丢弃。
  // 改为显式传 keyword 由服务端拼 $or，不再依赖序列化内部字段。
  if (where && where.keyword) {
    const keyword = String(where.keyword).trim().slice(0, MAX_KEYWORD_LENGTH)
    if (!keyword) return conditions
    conditions = _.and(conditions, _.or([
      { storeName: db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' }) },
      { taskName: db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' }) }
    ]))
  }

  return conditions
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const { action = 'list', page = 1, pageSize = 20, where = {}, targetUserName = '' } = event

  const safePage = Math.max(1, Math.floor(Number(page) || 1))
  const safePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(pageSize) || 20)))
  const safeWhere = where && typeof where === 'object' && !Array.isArray(where) ? where : {}
  const safeTargetUserName = typeof targetUserName === 'string'
    ? targetUserName.trim().slice(0, 50)
    : ''

  const caller = await getCaller(openid)
  if (caller && caller.disabled) {
    return { success: false, error: '账号已停用，请联系管理员' }
  }
  const role = (caller && MANAGER_ROLES.includes(caller.role)) ? caller.role : 'sales'
  const isManager = MANAGER_ROLES.includes(role)
  const queryConditions = buildBaseConditions({ isManager, openid, targetUserName: safeTargetUserName, where: safeWhere })

  try {
    if (action === 'stats') {
      // 统计口径：排除历史遗留的模拟报告（isMock: true），
      // 防止未配置 API Key 时期写入的假数据污染总巡检数/本周/平均分。
      const statsConditions = _.and(queryConditions, { 'aiReport.metadata.isMock': _.neq(true) })
      const totalRes = await db.collection('inspections').where(statsConditions).count()

      const weekAgo = new Date()
      weekAgo.setDate(weekAgo.getDate() - 7)
      // 注意：queryConditions 在有关键词时是 _.and(...) 命令对象，不能用 { ...queryConditions }
      // 展开（命令对象的内部字段不可枚举，展开会变空对象），必须用 _.and() 包裹拼接。
      const weekConditions = _.and(statsConditions, { createdAt: _.gte(weekAgo) })
      const weekRes = await db.collection('inspections').where(weekConditions).count()

      // 平均分：使用云数据库原生聚合管道直接在引擎层计算平均分，取代循环分页串行查询，毫秒级响应
      const $ = db.command.aggregate
      let avgScore = 0
      try {
        const avgRes = await db.collection('inspections')
          .aggregate()
          .match(_.and(statsConditions, { 'aiReport.score': _.exists(true) }))
          .group({
            _id: null,
            avgScore: $.avg('$aiReport.score')
          })
          .end()
        if (avgRes.list && avgRes.list.length > 0 && avgRes.list[0].avgScore != null) {
          avgScore = Math.round(avgRes.list[0].avgScore)
        }
      } catch (aggErr) {
        console.error('聚合计算平均分失败，降级为空:', aggErr)
      }

      // 顺便获取最新的每日汇总结论，供历史页置顶卡片展示（严格遵守业务员数据隔离）
      let latestDailyReport = null
      const dailyWhere = {}
      if (isManager) {
        if (safeTargetUserName) dailyWhere.userName = safeTargetUserName
      } else {
        dailyWhere._openid = openid
      }
      try {
        const dailyRes = await db.collection('dailyReports')
          .where(dailyWhere)
          .orderBy('generatedAt', 'desc')
          .limit(1)
          .get()
        if (dailyRes.data && dailyRes.data.length > 0) {
          latestDailyReport = dailyRes.data[0]
        }
      } catch (e) {
        try {
          const sRes = await db.collection('settings').doc('global').get()
          const fallbackReport = (sRes.data && sRes.data.latestDailyReport) || null
          if (fallbackReport) {
            // 校验归属：普通业务员只能读取属于自己的快照
            if (isManager || fallbackReport._openid === openid) {
              latestDailyReport = fallbackReport
            }
          }
        } catch (se) {}
      }

      return {
        success: true,
        isManager,
        stats: { total: totalRes.total, thisWeek: weekRes.total, avgScore },
        latestDailyReport
      }
    }

    // action === 'list'
    const countRes = await db.collection('inspections').where(queryConditions).count()
    const total = countRes.total

    const listRes = await db.collection('inspections')
      .where(queryConditions)
      .orderBy('createdAt', 'desc')
      .skip((safePage - 1) * safePageSize)
      .limit(safePageSize)
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

    // 缩略图临时链接：服务端统一取（云函数具备管理员权限）。收紧云存储权限后，
    // 前端直接拿 fileID 当图片 src 只能读到本人上传的文件，管理者看他人记录会裂图。
    const thumbnailIds = listRes.data
      .filter(item => Array.isArray(item.photoFileIDs) && item.photoFileIDs.length > 0)
      .map(item => item.photoFileIDs[0])
    const thumbnailURLMap = {}
    if (thumbnailIds.length > 0) {
      try {
        const fileRes = await cloud.getTempFileURL({ fileList: thumbnailIds })
        fileRes.fileList.forEach(f => {
          if (f.tempFileURL) thumbnailURLMap[f.fileID] = f.tempFileURL
        })
      } catch (err) {
        console.error('获取缩略图临时链接失败:', err)
      }
    }
    const list = listRes.data.map(item => {
      if (Array.isArray(item.photoFileIDs) && item.photoFileIDs.length > 0) {
        item.thumbnailURL = thumbnailURLMap[item.photoFileIDs[0]] || ''
      }
      return item
    })

    return {
      success: true,
      isManager,
      total,
      page: safePage,
      pageSize: safePageSize,
      list
    }
  } catch (err) {
    console.error('查询历史失败:', err)
    return { success: false, error: err.message, list: [] }
  }
}
