// 云函数：batchAnalyze
// 功能：每天在指定时间集中分析当天积压的巡检照片，替代"拍完立刻等 AI"的旧流程
//
// ============================================================
// 为什么要有这个云函数
// ============================================================
// 旧流程是业务员点"上传并分析"后要在原地干等 15-40 秒，一天跑十几家店，
// 光等 AI 就浪费大半小时。改成：照片一提交就算完事，业务员直接去下一家；
// AI 分析统一挪到晚上（或任意设定时间）集中跑。
//
// ============================================================
// 运行机制（重要，改之前先看懂）
// ============================================================
// 定时触发器每 2 分钟叫醒这个函数一次（见同目录 config.json），每次醒来做三件事：
//   1. 看当前时间是否落在设定的"分析窗口"内（默认 21:00 起 3 小时），不在就立刻返回
//   2. 把卡在 analyzing 超过 10 分钟的僵尸记录捞回 pending（函数超时被杀会留下这种记录）
//   3. 领取最多 batchSize 条 pending 记录，逐条分析
//
// 为什么不是"到点了一次性全跑完"：
// 微信云函数单次执行最长 60 秒，一条照片分析要 15-40 秒，一次最多也就跑得完 1-2 条。
// 所以设计成"高频小批量"——靠定时器反复触发慢慢把队列排空，而不是指望一次跑完。
// 空跑一次只消耗几十毫秒，一天 720 次的成本可以忽略。
//
// ⚠️ 部署后必须去云开发控制台把本函数的**超时时间改成 60 秒**（默认 20 秒不够用）：
//    云开发控制台 → 云函数 → batchAnalyze → 版本与配置 → 执行超时时间 → 60

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

const SETTINGS_DOC_ID = 'global'
const MANAGER_ROLES = ['admin', 'manager']

// 默认配置：settings 集合里没有记录时用这套
const DEFAULT_SETTINGS = {
  analyzeMode: 'batch',   // batch = 每日集中分析；instant = 提交即分析（退回旧流程）
  analyzeTime: '21:00',   // 集中分析开始时间（北京时间 HH:mm）
  windowMinutes: 180,     // 从开始时间起，允许跑多久（分钟）。队列没排空就等明天继续
  batchSize: 2            // 每次定时触发最多处理几条
}

// 单次执行的软性截止线。云函数硬超时设的是 60 秒，这里留 12 秒余量，
// 到点就不再领新任务，让已完成的状态能正常写回数据库。
const SOFT_DEADLINE_MS = 48 * 1000

// 一条记录卡在 analyzing 超过这个时长，判定为僵尸，捞回 pending 重试
const STUCK_THRESHOLD_MS = 10 * 60 * 1000

// 同一条记录最多重试几次，超过就标记失败，避免一张坏图无限占用额度
const MAX_ATTEMPTS = 3

// ============================================================
// 入口
// ============================================================
exports.main = async (event, context) => {
  const startedAt = Date.now()
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  const isInternalCall = !openid   // 定时触发 / 云函数互调时 OPENID 为空

  // 定时触发器传进来的 event 是 { Type: 'Timer', TriggerName, Time }，没有 action
  const action = event.action || 'timer'

  const settings = await loadSettings()

  // 手动触发：小程序"立即分析"按钮走这条路，忽略时间窗口限制
  if (action === 'runNow') {
    if (!isInternalCall) {
      const allowed = await canManage(openid)
      if (!allowed) {
        return { success: false, error: '只有管理员可以手动触发批量分析' }
      }
    }
    const result = await drainQueue({ settings, startedAt, ignoreDeadlineForFirst: true })
    await recordRun(result, 'manual')
    return { success: true, triggeredBy: 'manual', ...result }
  }

  // 定时触发
  if (settings.analyzeMode !== 'batch') {
    return { success: true, skipped: true, reason: '当前为即时分析模式，定时任务不处理' }
  }

  if (!isInAnalyzeWindow(settings)) {
    return {
      success: true,
      skipped: true,
      reason: `当前不在分析窗口内（${settings.analyzeTime} 起 ${settings.windowMinutes} 分钟）`
    }
  }

  const result = await drainQueue({ settings, startedAt })
  // 只有真的干了活才记一笔，避免窗口内每 2 分钟空转一次都去写数据库
  if (result.processed > 0 || result.reclaimed > 0) {
    await recordRun(result, 'timer')
  }
  return { success: true, triggeredBy: 'timer', ...result }
}

// ============================================================
// 核心：领取并处理待分析队列
// ============================================================
async function drainQueue({ settings, startedAt, ignoreDeadlineForFirst = false }) {
  // 第一步：回收僵尸记录
  const reclaimed = await reclaimStuckRecords()

  const batchSize = Math.max(1, Math.min(10, settings.batchSize || DEFAULT_SETTINGS.batchSize))
  const results = { processed: 0, succeeded: 0, failed: 0, reclaimed, remaining: 0, details: [] }

  for (let i = 0; i < batchSize; i++) {
    // 时间到了就收手，剩下的交给下一次定时触发
    const elapsed = Date.now() - startedAt
    const skipDeadline = ignoreDeadlineForFirst && i === 0
    if (!skipDeadline && elapsed > SOFT_DEADLINE_MS) {
      console.log(`已用时 ${elapsed}ms，接近超时，本轮停止领取新任务`)
      break
    }

    const record = await claimOnePending()
    if (!record) break

    results.processed++
    try {
      const res = await cloud.callFunction({
        name: 'analyzeImage',
        data: { inspectionId: record._id }
      })
      // analyzeImage 内部已经负责把 status 写成 analyzed / analyze_failed，
      // 这里只统计结果，不重复写状态，避免两处写入打架
      const ok = res.result && res.result.success
      if (ok) {
        results.succeeded++
      } else {
        results.failed++
        await markFailedIfNeeded(record, (res.result && res.result.error) || '分析未返回成功')
      }
      results.details.push({
        id: record._id,
        storeName: record.storeName || '',
        ok: !!ok,
        error: ok ? '' : ((res.result && res.result.error) || '')
      })
    } catch (err) {
      // callFunction 本身失败（超时、函数不存在），analyzeImage 可能压根没跑起来，
      // 状态还停在 analyzing，这里要主动写回，否则要等 10 分钟才被回收
      console.error(`分析 ${record._id} 失败:`, err)
      results.failed++
      await markFailedIfNeeded(record, err.message || '调用 analyzeImage 失败')
      results.details.push({
        id: record._id,
        storeName: record.storeName || '',
        ok: false,
        error: err.message || ''
      })
    }
  }

  results.remaining = await countPending()
  console.log('本轮结果:', JSON.stringify(results))
  return results
}

/**
 * 领取一条待分析记录
 * 用「先改状态、再返回」的方式加锁：状态从 pending 改成 analyzing 之后，
 * 后续的查询就选不到它了，避免定时器和手动触发撞车时同一条记录被分析两次。
 */
async function claimOnePending() {
  const res = await db.collection('inspections')
    .where({ status: 'pending' })
    .orderBy('createdAt', 'asc')   // 先提交的先分析
    .limit(1)
    .field({ _id: true, storeName: true, analyzeAttempts: true, photoFileIDs: true })
    .get()

  if (res.data.length === 0) return null
  const record = res.data[0]

  // 没有照片的脏记录直接判失败，别让它在队列里反复占位
  if (!Array.isArray(record.photoFileIDs) || record.photoFileIDs.length === 0) {
    await db.collection('inspections').doc(record._id).update({
      data: { status: 'analyze_failed', analyzeError: '记录中没有照片', analyzedAt: db.serverDate() }
    })
    return null
  }

  await db.collection('inspections').doc(record._id).update({
    data: {
      status: 'analyzing',
      analyzeStartedAt: db.serverDate(),
      analyzeAttempts: _.inc(1)
    }
  })

  record.analyzeAttempts = (record.analyzeAttempts || 0) + 1
  return record
}

/**
 * 回收僵尸记录：函数被超时杀掉时，记录会永远停在 analyzing。
 * 超过阈值就捞回 pending 重试；重试次数用完则判定失败。
 */
async function reclaimStuckRecords() {
  const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS)

  const res = await db.collection('inspections')
    .where({
      status: 'analyzing',
      analyzeStartedAt: _.lt(threshold)
    })
    .limit(20)
    .field({ _id: true, analyzeAttempts: true })
    .get()

  if (res.data.length === 0) return 0

  for (const item of res.data) {
    const attempts = item.analyzeAttempts || 0
    if (attempts >= MAX_ATTEMPTS) {
      await db.collection('inspections').doc(item._id).update({
        data: {
          status: 'analyze_failed',
          analyzeError: `连续 ${attempts} 次分析未完成（疑似图片过大或模型超时），已停止重试`,
          analyzedAt: db.serverDate()
        }
      })
    } else {
      await db.collection('inspections').doc(item._id).update({
        data: { status: 'pending' }
      })
    }
  }

  console.log(`回收僵尸记录 ${res.data.length} 条`)
  return res.data.length
}

async function markFailedIfNeeded(record, errorMsg) {
  try {
    const cur = await db.collection('inspections').doc(record._id).get()
    // analyzeImage 已经写过终态就别覆盖，它的错误信息比这里的更具体
    if (cur.data && cur.data.status === 'analyzing') {
      await db.collection('inspections').doc(record._id).update({
        data: {
          status: record.analyzeAttempts >= MAX_ATTEMPTS ? 'analyze_failed' : 'pending',
          analyzeError: errorMsg,
          analyzedAt: db.serverDate()
        }
      })
    }
  } catch (err) {
    console.error('回写失败状态出错:', err)
  }
}

async function countPending() {
  try {
    const res = await db.collection('inspections').where({ status: 'pending' }).count()
    return res.total
  } catch (err) {
    return -1
  }
}

// ============================================================
// 时间窗口判断
// ============================================================
/**
 * 判断当前是否在分析窗口内
 *
 * ⚠️ 云函数运行环境是 UTC 时区，直接 new Date().getHours() 拿到的是 UTC 小时，
 * 会比北京时间少 8 小时。这里统一先把时间戳 +8 小时，再用 getUTC* 系列方法读，
 * 得到的就是北京时间。不要改成 getHours()，那样在本地开发和云端行为会不一致。
 */
function isInAnalyzeWindow(settings) {
  const nowMin = beijingMinutesOfDay()
  const startMin = parseTimeToMinutes(settings.analyzeTime) 
  if (startMin === null) return false

  const windowMin = Math.max(10, settings.windowMinutes || DEFAULT_SETTINGS.windowMinutes)
  const endMin = startMin + windowMin

  // 窗口跨过零点的情况（比如 23:00 起 3 小时 → 到次日 02:00）
  if (endMin > 1440) {
    return nowMin >= startMin || nowMin < (endMin - 1440)
  }
  return nowMin >= startMin && nowMin < endMin
}

function beijingMinutesOfDay() {
  const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
}

function parseTimeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

// ============================================================
// 配置读写
// ============================================================
async function loadSettings() {
  try {
    const res = await db.collection('settings').doc(SETTINGS_DOC_ID).get()
    return { ...DEFAULT_SETTINGS, ...(res.data || {}) }
  } catch (err) {
    // 集合或文档还不存在，用默认配置跑，不阻断
    return { ...DEFAULT_SETTINGS }
  }
}

async function recordRun(result, triggeredBy) {
  const payload = {
    lastRunAt: db.serverDate(),
    lastRunTriggeredBy: triggeredBy,
    lastRunSummary: {
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      reclaimed: result.reclaimed,
      remaining: result.remaining
    }
  }
  try {
    await db.collection('settings').doc(SETTINGS_DOC_ID).update({ data: payload })
  } catch (err) {
    // 文档不存在则创建
    try {
      await db.collection('settings').add({
        data: { _id: SETTINGS_DOC_ID, ...DEFAULT_SETTINGS, ...payload }
      })
    } catch (addErr) {
      console.error('写入运行记录失败:', addErr)
    }
  }
}

// ============================================================
// 权限
// ============================================================
async function canManage(openid) {
  try {
    const res = await db.collection('users').where({ _openid: openid }).get()
    if (res.data.length > 0 && MANAGER_ROLES.includes(res.data[0].role)) {
      return true
    }
    // 自举场景：系统里还没有任何管理员时，允许任意登录用户操作，
    // 否则第一个用户永远没法配置系统。设了管理员之后这条自动失效。
    const adminRes = await db.collection('users').where({ role: _.in(MANAGER_ROLES) }).count()
    return adminRes.total === 0
  } catch (err) {
    console.error('权限校验失败:', err)
    return false
  }
}
