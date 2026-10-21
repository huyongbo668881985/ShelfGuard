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
//   1. 先把卡在 analyzing 超过 3 分钟的僵尸记录捞回 pending（任何时刻都做，不受窗口限制，否则会卡死）
//   2. 看当前时间是否落在设定的"分析窗口"内（默认 21:00 起 3 小时），不在窗口就只回收不认领新任务
//   3. 在窗口内才领取 pending 记录，实际上一轮只跑得完一条（见 SOFT_DEADLINE_MS）
//
// 为什么不是"到点了一次性全跑完"：
// 微信云函数单次执行最长 60 秒，一条照片分析要 30-45 秒，一次只跑得完一条。
// 所以设计成"高频小批量"——靠定时器反复触发慢慢把队列排空，而不是指望一次跑完。
// 空跑一次只消耗几十毫秒，一天 720 次的成本可以忽略。
//
// ⚠️⚠️ 部署后必须确认 **analyzeImage 和 batchAnalyze 两个函数的超时都是 60 秒** ⚠️⚠️
//    config.json 里已经写了 "timeout": 60，但开发者工具不一定会应用，务必去控制台核对：
//    云开发控制台 → 云函数 → 选中函数 → 版本与配置 → 执行超时时间 → 60 → 保存
//
//    默认值是 20 秒，而一次视觉分析要 30-45 秒 —— 函数会在拿到 AI 结果之前就被杀，
//    进程直接终止，catch 都来不及跑，记录永远停在"分析中"。
//    最坑的是 DashScope 那边其实已经算完并计了费，所以"后台有调用、前端却一直转圈"
//    这个现象几乎可以直接确诊为超时没改。

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
  batchSize: 1            // 每次定时触发最多处理几条，见下方 SOFT_DEADLINE_MS 说明
}

// ⚠️ 单次执行的软性截止线：只要已用时超过它，本轮就不再领新任务。
//
// 为什么是 8 秒这么短（而不是接近 60 秒的值）：
// 本函数是**同步等待** analyzeImage 返回的，而一条照片分析要 30-45 秒。
// 假设截止线设成 48 秒，跑完第一条时已用时 45 秒 —— 45 < 48，于是它会去领第二条，
// 然后在第二条跑到一半时整个函数被 60 秒硬上限杀掉，第二条就永远卡在 analyzing。
// 这不是理论问题，是实际踩过的坑。
//
// 正确的判断标准是"剩余时间够不够再跑完一条"，而 60 秒的预算本来就只够跑一条，
// 所以直接把截止线压到 8 秒：等价于"一轮只处理一条"。
// 队列靠定时器每 2 分钟触发一次慢慢排空，不指望单次跑完。
const SOFT_DEADLINE_MS = 8 * 1000

// 一条记录卡在 analyzing 超过这个时长，判定为僵尸，捞回 pending 重试。
// 云函数最长活 60 秒，所以超过 3 分钟还停在 analyzing，一定是被硬杀了，
// 不可能是"还在跑"。阈值不必留太长，越短用户看到自愈越快。
const STUCK_THRESHOLD_MS = 3 * 60 * 1000

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

  // ⚠️ 先回收僵尸记录，且这一步不受时间窗口限制。
  // 否则窗口外的卡死记录（云函数超时被杀、或那次 analyzeImage 调用异常）
  // 永远没机会被捞回，会一直停在"分析中"无法自愈。
  const reclaimed = await reclaimStuckRecords()

  if (!isInAnalyzeWindow(settings)) {
    if (reclaimed > 0) {
      await recordRun(
        { processed: 0, succeeded: 0, failed: 0, reclaimed, remaining: await countPending() },
        'timer'
      )
    }
    return {
      success: true,
      skipped: true,
      reclaimed,
      reason: `当前不在分析窗口内（${settings.analyzeTime} 起 ${settings.windowMinutes} 分钟），已先回收 ${reclaimed} 条卡死记录`
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

  // 核心特性：集中分析模式下，按业务员（_openid）聚合其待分析的全部巡检照片，生成《今日巡检综合分析日报》
  // 先找到第一位有 pending 记录的业务员，将其名下待分析记录加锁（pending -> analyzing）后统一汇总分析。
  // 单轮只处理一位业务员的汇总，确保单次执行稳稳控制在 60 秒硬上限内。
  try {
    const firstPendingRes = await db.collection('inspections')
      .where({ status: 'pending' })
      .orderBy('createdAt', 'asc')
      .limit(1)
      .field({ _id: true, _openid: true })
      .get()

    if (firstPendingRes.data && firstPendingRes.data.length > 0) {
      const targetOpenid = firstPendingRes.data[0]._openid || ''
      const userPendingRes = await db.collection('inspections')
        .where(targetOpenid ? { status: 'pending', _openid: targetOpenid } : { status: 'pending' })
        .orderBy('createdAt', 'asc')
        .limit(15)
        .field({ _id: true, storeName: true, analyzeAttempts: true, photoFileIDs: true })
        .get()

      const candidates = (userPendingRes.data || []).filter(
        r => Array.isArray(r.photoFileIDs) && r.photoFileIDs.length > 0
      )

      if (candidates.length > 0) {
        const candidateIds = candidates.map(c => c._id)
        // 先加锁：将这批 pending 记录原子更新为 analyzing，防止并发定时器重复认领
        const claimBatchRes = await db.collection('inspections')
          .where({
            _id: _.in(candidateIds),
            status: 'pending'
          })
          .update({
            data: {
              status: 'analyzing',
              analyzeStartedAt: db.serverDate(),
              analyzeAttempts: _.inc(1)
            }
          })

        const claimedCount = (claimBatchRes.stats && claimBatchRes.stats.updated) || 0
        if (claimedCount > 0) {
          console.log(`[batchAnalyze] 已锁定业务员(${targetOpenid})的 ${claimedCount} 条巡检记录，正在聚合生成今日汇总结论...`)
          results.processed += claimedCount
          const summaryRes = await cloud.callFunction({
            name: 'analyzeImage',
            data: {
              action: 'dailySummary',
              inspectionIds: candidateIds
            }
          })
          const ok = summaryRes.result && summaryRes.result.success
          if (ok) {
            console.log('[batchAnalyze] 今日汇总结论生成成功！')
            results.dailyReportGenerated = true
            results.succeeded += claimedCount
          } else {
            results.failed += claimedCount
          }
          results.remaining = await countPending()
          return results
        }
      }
    }
  } catch (summaryErr) {
    console.error('[batchAnalyze] 聚合今日汇总结论异常:', summaryErr)
    results.remaining = await countPending()
    return results
  }

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
    await db.collection('inspections').where({
      _id: record._id,
      status: 'pending'
    }).update({
      data: { status: 'analyze_failed', analyzeError: '记录中没有照片', analyzedAt: db.serverDate() }
    })
    return null
  }

  // 查询和更新之间可能有另一轮定时任务/手动任务抢到同一条记录。
  // 把 status=pending 放进更新条件，只有真正更新成功的一方才获得分析权。
  const claimRes = await db.collection('inspections').where({
    _id: record._id,
    status: 'pending'
  }).update({
    data: {
      status: 'analyzing',
      analyzeStartedAt: db.serverDate(),
      analyzeAttempts: _.inc(1)
    }
  })

  if (!claimRes.stats || claimRes.stats.updated !== 1) {
    return null
  }

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
    // 只认服务端 users 表里的 admin / manager 角色。
    // 不再保留"系统无管理员则任何人可触发"的自举逻辑（安全漏洞，与 README 一致）。
    return res.data.length > 0 && MANAGER_ROLES.includes(res.data[0].role)
  } catch (err) {
    console.error('权限校验失败:', err)
    return false
  }
}
