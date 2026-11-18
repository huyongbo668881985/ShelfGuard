// 云函数：getHistory
// 功能：查询巡检记录（分页列表 + 汇总统计），支持基于角色的可见范围
//
// 权限模型：
// - 普通业务员（role: 'sales' 或未设置）：无论前端传什么筛选参数，服务端都强制
//   只返回自己（_openid）的记录——这是修过的漏洞，不能再开回去。
// - 管理者（role: 'manager'）：可以看 manager / sales 的记录，不可看 admin 的记录。
// - 管理员（role: 'admin'）：可以看全部人员的记录，也可以传 targetUserName 只看某个人。
// 角色永远从服务端 users 表按 openid 查出来，不信任客户端传的任何角色声明。

const cloud = require('../../cloud-shim')

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


function extractListSharePercent(aiReport) {
  if (!aiReport || typeof aiReport !== 'object') return null
  const ov = aiReport.ownBrandOverview
  if (ov && ov.facingSharePercent != null) {
    const n = Number(ov.facingSharePercent)
    if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n * 10) / 10
  }
  const brands = aiReport.competitiveAnalysis && aiReport.competitiveAnalysis.brands
  if (Array.isArray(brands)) {
    const own = brands.find(b => b && (b.brand === '我方品牌' || b.isOwn === true))
    if (own && own.sharePercent != null) {
      const n = Number(own.sharePercent)
      if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n * 10) / 10
    }
    // 列表展示：若只有一个品牌带份额，作为参考展示（完整我方识别在 shelfStats 重建时做）
    const withShare = brands.filter(b => b && b.sharePercent != null && Number.isFinite(Number(b.sharePercent)))
    if (withShare.length === 1) {
      const n = Number(withShare[0].sharePercent)
      if (n >= 0 && n <= 100) return Math.round(n * 10) / 10
    }
  }
  return null
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

async function loadAdminOpenids() {
  try {
    const res = await db.collection('users').where({ role: 'admin' }).limit(200).get()
    return (res.data || []).map(u => u && u._openid).filter(Boolean)
  } catch (err) {
    console.warn('查询管理员列表失败:', err.message)
    return []
  }
}

// 供管理者端胶囊/下拉筛选业务员：汇总在册已审批人员 + 历史记录中出现过的姓名
async function loadManagerUserNames(extraList = [], { excludeAdmins = false } = {}) {
  const nameSet = new Set()
  try {
    const uRes = await db.collection('users').orderBy('createdAt', 'asc').limit(300).get()
    ;(uRes.data || []).forEach(u => {
      if (!u || u.disabled) return
      if (excludeAdmins && u.role === 'admin') return
      const isApproved = u.approved === true || (
        (u.approved === undefined || u.approved === null) &&
        (u.role === 'admin' || u.role === 'manager')
      )
      if (!isApproved) return
      const n = (u.name && String(u.name).trim()) || ''
      if (n) nameSet.add(n)
    })
  } catch (e) {
    console.warn('读取在册业务员姓名列表失败:', e.message)
  }
  ;(extraList || []).forEach(item => {
    const n = item && item.userName && String(item.userName).trim()
    if (n) nameSet.add(n)
  })
  return Array.from(nameSet).sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

// 构建通用查询条件（列表和统计共用）
function buildBaseConditions({ isManager, openid, targetUserName, where, excludeOpenids = [] }) {
  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

  // 前端只传原语（startDateISO / endDateISO / customerId / scoreMin / scoreMax / keyword），
  // db.command 命令对象由服务端重建——命令对象经 callFunction JSON 序列化会丢失
  // 内部字段，前端直接透传 _.gte / _.and / _.lt 会导致筛选条件被静默丢弃。
  let startDate = ninetyDaysAgo
  if (where && where.startDateISO) {
    const parsed = new Date(where.startDateISO)
    if (!isNaN(parsed.getTime())) startDate = parsed
  }
  let endDate = null
  if (where && where.endDateISO) {
    const parsed = new Date(where.endDateISO)
    if (!isNaN(parsed.getTime())) endDate = parsed
  }

  let createdAtCondition = endDate
    ? _.and(_.gte(startDate), _.lte(endDate))
    : _.gte(startDate)

  let conditions = {
    createdAt: createdAtCondition
  }

  if (isManager) {
    // 管理者：默认看全部可见人员；如果指定了 targetUserName，只看这个人的
    if (Array.isArray(excludeOpenids) && excludeOpenids.length > 0) {
      conditions._openid = _.nin(excludeOpenids)
    }
    if (targetUserName) {
      conditions.userName = targetUserName
    }
  } else {
    // 普通业务员：忽略任何 targetUserName，强制只能看自己
    conditions._openid = openid
  }

  // 按客户库门店精确筛选（照片明细 / 单店历史）
  if (where && where.customerId) {
    const customerId = String(where.customerId).trim().slice(0, 64)
    if (customerId) conditions.customerId = customerId
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
  const excludeAdmins = role === 'manager'
  const excludeOpenids = excludeAdmins ? await loadAdminOpenids() : []
  const queryConditions = buildBaseConditions({
    isManager,
    openid,
    targetUserName: safeTargetUserName,
    where: safeWhere,
    excludeOpenids
  })

  try {
    if (action === 'stats') {
      // 顶部看板固定口径：不受列表的今日/评分/关键词筛选影响，避免选「今日」后总=本周
      const boardWhere = {}
      const boardConditions = buildBaseConditions({
        isManager,
        openid,
        targetUserName: safeTargetUserName,
        where: boardWhere,
        excludeOpenids
      })
      // 统计口径：排除历史遗留的模拟报告（isMock: true）以及上下班考勤打卡记录（status: 'clocked'）
      const statsConditions = _.and(boardConditions, {
        'aiReport.metadata.isMock': _.neq(true),
        status: _.neq('clocked')
      })
      const totalRes = await db.collection('inspections').where(statsConditions).count()

      const weekAgo = new Date()
      weekAgo.setDate(weekAgo.getDate() - 7)
      const weekConditions = _.and(statsConditions, { createdAt: _.gte(weekAgo) })
      const weekRes = await db.collection('inspections').where(weekConditions).count()

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
        if (excludeOpenids.length > 0) dailyWhere._openid = _.nin(excludeOpenids)
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
            // 校验归属：普通业务员只能读取属于自己的快照；manager 不可读 admin 的快照
            const canSeeFallback = (isManager && !(excludeAdmins && excludeOpenids.includes(fallbackReport._openid))) ||
              fallbackReport._openid === openid
            if (canSeeFallback) {
              latestDailyReport = fallbackReport
            }
          }
        } catch (se) {}
      }

      const salesUsers = isManager ? await loadManagerUserNames([], { excludeAdmins }) : []

      return {
        success: true,
        isManager,
        salesUsers,
        stats: { total: totalRes.total, thisWeek: weekRes.total, avgScore },
        latestDailyReport
      }
    }

    if (action === 'mapRoute') {
      const now = new Date()
      let startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
      let endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
      if (safeWhere.startDateISO) {
        const p = new Date(safeWhere.startDateISO)
        if (!isNaN(p.getTime())) startDate = p
      }
      if (safeWhere.endDateISO) {
        const p = new Date(safeWhere.endDateISO)
        if (!isNaN(p.getTime())) endDate = p
      }

      const dayCond = {
        createdAt: _.and(_.gte(startDate), _.lte(endDate)),
        'aiReport.metadata.isMock': _.neq(true)
      }
      if (!isManager) {
        dayCond._openid = openid
      } else if (excludeOpenids.length > 0) {
        dayCond._openid = _.nin(excludeOpenids)
      }

      const dayRes = await db.collection('inspections')
        .where(dayCond)
        .orderBy('createdAt', 'asc')
        .limit(500)
        .field({
          _id: true,
          _openid: true,
          recordType: true,
          taskName: true,
          storeName: true,
          userName: true,
          customerId: true,
          photoFileIDs: true,
          photoCount: true,
          location: true,
          status: true,
          createdAt: true,
          aiReport: true
        })
        .get()

      const allDayRecords = dayRes.data || []
      let usersList = []
      let selectedUserId = ''
      let selectedUserName = (caller && caller.name) || ''
      let personRecords = allDayRecords

      if (isManager) {
        // 汇总人员列表：结合 users 表在册人员 + 当日实际有记录的人员
        const userMap = new Map() // key: openid || ('name:' + userName)
        try {
          const uRes = await db.collection('users').orderBy('createdAt', 'asc').limit(200).get()
          ;(uRes.data || []).forEach(u => {
            if (u.disabled) return
            if (excludeAdmins && u.role === 'admin') return
            const isApproved = u.approved === true || (
              (u.approved === undefined || u.approved === null) &&
              (u.role === 'admin' || u.role === 'manager')
            )
            if (!isApproved) return
            const key = u._openid || `id:${u._id}`
            userMap.set(key, {
              userId: u._id || key,
              _openid: u._openid || '',
              name: (u.name && u.name.trim()) ? u.name.trim() : '未命名业务员',
              visitCount: 0,
              clockCount: 0,
              totalCount: 0
            })
          })
        } catch (uErr) {
          console.warn('读取业务员列表失败:', uErr)
        }

        allDayRecords.forEach(r => {
          const key = r._openid || `name:${r.userName || '未知'}`
          if (!userMap.has(key)) {
            userMap.set(key, {
              userId: key,
              _openid: r._openid || '',
              name: (r.userName && r.userName.trim()) ? r.userName.trim() : '未命名业务员',
              visitCount: 0,
              clockCount: 0,
              totalCount: 0
            })
          }
          const entry = userMap.get(key)
          if ((!entry.name || entry.name === '未命名业务员') && r.userName) {
            entry.name = r.userName.trim()
          }
          const isClock = r.recordType === 'clock_in' || r.recordType === 'clock_out' || r.status === 'clocked'
          if (isClock) entry.clockCount++
          else entry.visitCount++
          entry.totalCount++
        })

        // 排序：当日有记录的排前面，同条件下按记录数降序
        const entries = Array.from(userMap.values()).sort((a, b) => {
          if ((b.totalCount > 0) !== (a.totalCount > 0)) return b.totalCount > 0 ? 1 : -1
          if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount
          return String(a.name).localeCompare(String(b.name), 'zh-CN')
        })

        const reqUserId = typeof event.targetUserId === 'string' ? event.targetUserId.trim() : ''
        let targetEntry = null
        if (reqUserId) {
          targetEntry = entries.find(e => e.userId === reqUserId)
        }
        if (!targetEntry && safeTargetUserName) {
          targetEntry = entries.find(e => e.name === safeTargetUserName)
        }
        if (!targetEntry && entries.length > 0) {
          targetEntry = entries[0]
        }

        if (targetEntry) {
          selectedUserId = targetEntry.userId
          selectedUserName = targetEntry.name
          personRecords = allDayRecords.filter(r => {
            if (targetEntry._openid && r._openid) return r._openid === targetEntry._openid
            return (r.userName || '未命名业务员') === targetEntry.name
          })
        } else {
          personRecords = []
        }

        usersList = entries.map(e => ({
          userId: e.userId,
          name: e.name,
          visitCount: e.visitCount,
          clockCount: e.clockCount,
          totalCount: e.totalCount
        }))
      } else {
        selectedUserId = (caller && caller._id) || 'me'
        selectedUserName = (caller && caller.name) || (personRecords[0] && personRecords[0].userName) || '我'
      }

      // 批量换取选中人员当日所有照片的临时链接：
      // - photoURLs:      高清原图（点击放大预览）
      // - photoThumbURLs: 中等预览图（底部卡片横向列表）
      // - thumbnailURL:   小缩略图（列表/时间轴小图）
      const allPhotoIds = []
      personRecords.forEach(item => {
        if (Array.isArray(item.photoFileIDs)) {
          item.photoFileIDs.forEach(fid => {
            if (fid && !allPhotoIds.includes(fid)) allPhotoIds.push(fid)
          })
        }
      })
      const photoURLMap = {}
      const previewURLMap = {}
      const thumbURLMap = {}
      if (allPhotoIds.length > 0) {
        try {
          const [origRes, previewRes, thumbRes] = await Promise.all([
            cloud.getTempFileURL({ fileList: allPhotoIds }),
            cloud.getTempFileURL({ fileList: allPhotoIds, variant: 'preview' }),
            cloud.getTempFileURL({ fileList: allPhotoIds, variant: 'thumb' })
          ])
          ;(origRes.fileList || []).forEach(f => {
            if (f.tempFileURL) photoURLMap[f.fileID] = f.tempFileURL
          })
          ;(previewRes.fileList || []).forEach(f => {
            if (f.tempFileURL) previewURLMap[f.fileID] = f.tempFileURL
          })
          ;(thumbRes.fileList || []).forEach(f => {
            if (f.tempFileURL) thumbURLMap[f.fileID] = f.tempFileURL
          })
        } catch (err) {
          console.error('获取地图点位照片临时链接失败:', err)
        }
      }

      const points = personRecords.map(item => {
        const fids = Array.isArray(item.photoFileIDs) ? item.photoFileIDs : []
        const photoURLs = fids.map(fid => photoURLMap[fid] || '').filter(Boolean)
        const photoThumbURLs = fids.map(fid => previewURLMap[fid] || photoURLMap[fid] || '').filter(Boolean)
        const firstFid = fids[0] || ''
        const thumbnailURL = (firstFid && (thumbURLMap[firstFid] || photoURLMap[firstFid])) || photoURLs[0] || ''
        const recordType = (item.recordType === 'clock_in' || item.recordType === 'clock_out')
          ? item.recordType
          : 'visit'
        let aiSummary = null
        if (item.aiReport && typeof item.aiReport === 'object') {
          const ar = item.aiReport
          const sharePercent = extractListSharePercent(ar)
          aiSummary = {
            score: ar.score,
            scoreLevel: ar.scoreLevel,
            summary: ar.summary,
            sharePercent
          }
        }
        return {
          _id: item._id,
          recordType,
          taskName: item.taskName || '',
          storeName: item.storeName || '',
          userName: item.userName || selectedUserName || '',
          customerId: item.customerId || '',
          photoCount: item.photoCount || photoURLs.length,
          photoURLs,
          photoThumbURLs,
          thumbnailURL,
          location: item.location || {},
          status: item.status || '',
          createdAt: item.createdAt,
          aiReport: aiSummary
        }
      })

      return {
        success: true,
        isManager,
        selectedUserId,
        selectedUserName,
        usersList,
        points
      }
    }

    // action === 'list'：与 stats 同样排除 isMock，避免列表出现假分而看板不计
    const listConditions = _.and(queryConditions, { 'aiReport.metadata.isMock': _.neq(true) })
    const countRes = await db.collection('inspections').where(listConditions).count()
    const total = countRes.total

    const listRes = await db.collection('inspections')
      .where(listConditions)
      .orderBy('createdAt', 'desc')
      .skip((safePage - 1) * safePageSize)
      .limit(safePageSize)
      .field({
        _id: true,
        recordType: true,
        taskName: true,
        storeName: true,
        userName: true,
        customerId: true,
        photoFileIDs: true,
        photoCount: true,
        location: true,
        status: true,
        createdAt: true,
        aiReport: true
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
        const fileRes = await cloud.getTempFileURL({ fileList: thumbnailIds, variant: 'thumb' })
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
      if (item.aiReport && typeof item.aiReport === 'object') {
        const ar = item.aiReport
        const sharePercent = extractListSharePercent(ar)
        item.sharePercent = sharePercent
        item.aiReport = {
          score: ar.score,
          scoreLevel: ar.scoreLevel,
          summary: ar.summary,
          metadata: ar.metadata,
          sharePercent
        }
      } else {
        item.sharePercent = null
      }
      return item
    })

    const salesUsers = (isManager && safePage === 1) ? await loadManagerUserNames(list, { excludeAdmins }) : undefined

    return {
      success: true,
      isManager,
      salesUsers,
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
