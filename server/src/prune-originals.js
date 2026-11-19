'use strict'

const defaultDb = require('./docdb')
const defaultFiles = require('./files')

const ANALYZED_RETENTION_MS = 72 * 60 * 60 * 1000
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DEFAULT_BATCH_LIMIT = 300
const DEFAULT_CONCURRENCY = 3

function toTimestampMs(val) {
  if (val == null || val === '') return null
  if (val instanceof Date) {
    const t = val.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null
  }
  if (typeof val === 'string') {
    const t = Date.parse(val)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/**
 * 返回 nowMs 所在北京时间自然日的 00:00:00.000 对应 UTC 毫秒时间戳。
 * 用于上下班打卡记录「次日凌晨定时清理」判定：createdAt < 今日 00:00（北京时间）即纳入清理。
 */
function startOfShanghaiDayMs(nowMs = Date.now()) {
  const shanghaiMs = nowMs + SHANGHAI_OFFSET_MS
  const d = new Date(shanghaiMs)
  const dayStartUtcMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
  return dayStartUtcMs - SHANGHAI_OFFSET_MS
}

function isClockRecord(doc) {
  if (!doc || typeof doc !== 'object') return false
  return doc.recordType === 'clock_in' || doc.recordType === 'clock_out' || doc.status === 'clocked'
}

/**
 * 判定单条巡检/打卡记录是否满足原图分级清理条件。
 */
function classifyEligibility(doc, nowMs = Date.now()) {
  if (!doc || typeof doc !== 'object') {
    return { eligible: false, reason: 'invalid_doc' }
  }
  if (doc.originPrunedAt) {
    return { eligible: false, reason: 'already_pruned' }
  }

  // 待分析 / 分析中 / 历史 uploaded 状态绝不清理原图，确保 AI 分析与重试有原图可用
  if (doc.status === 'pending' || doc.status === 'analyzing' || doc.status === 'uploaded') {
    return { eligible: false, reason: 'protected_status' }
  }

  // 上下班打卡照片：次日凌晨定时清理（createdAt 早于今日北京时间 00:00）
  if (isClockRecord(doc)) {
    const refMs = toTimestampMs(doc.createdAt)
    if (refMs === null) {
      return { eligible: false, reason: 'missing_timestamp' }
    }
    if (refMs < startOfShanghaiDayMs(nowMs)) {
      return { eligible: true, category: 'clock' }
    }
    return { eligible: false, reason: 'clock_same_day' }
  }

  // 已分析成功的拜访：analyzedAt（历史缺省回退 createdAt）超过 72 小时
  if (doc.status === 'analyzed') {
    const refMs = toTimestampMs(doc.analyzedAt) ?? toTimestampMs(doc.createdAt)
    if (refMs === null) {
      return { eligible: false, reason: 'missing_timestamp' }
    }
    if (nowMs - refMs >= ANALYZED_RETENTION_MS) {
      return { eligible: true, category: 'analyzed' }
    }
    return { eligible: false, reason: 'within_retention' }
  }

  // 分析失败的拜访：超过 30 天仍未重排，仅删原图、保留缩略图与数据库记录
  if (doc.status === 'analyze_failed') {
    const refMs = toTimestampMs(doc.analyzedAt) ?? toTimestampMs(doc.analyzeStartedAt) ?? toTimestampMs(doc.createdAt)
    if (refMs === null) {
      return { eligible: false, reason: 'missing_timestamp' }
    }
    if (nowMs - refMs >= FAILED_RETENTION_MS) {
      return { eligible: true, category: 'analyze_failed' }
    }
    return { eligible: false, reason: 'within_retention' }
  }

  return { eligible: false, reason: 'unsupported_status' }
}

async function fetchEligibleBatch(db, nowMs, batchLimit) {
  const _ = db.command
  const seen = new Set()
  const eligible = []
  let scanned = 0

  // 按顶层 status 拆分查询以命中 SQLite idx_docs_collection_status 索引，避免顶层 _.or 全表扫描
  const queries = [
    { status: 'clocked', originPrunedAt: _.exists(false) },
    { status: 'analyzed', originPrunedAt: _.exists(false) },
    { status: 'analyze_failed', originPrunedAt: _.exists(false) },
    { recordType: _.in(['clock_in', 'clock_out']), originPrunedAt: _.exists(false) }
  ]

  for (const where of queries) {
    if (eligible.length >= batchLimit) break
    const remaining = batchLimit - eligible.length
    const fetchLimit = Math.min(5000, Math.max(remaining * 2, 500))
    const res = await db.collection('inspections')
      .where(where)
      .orderBy('createdAt', 'asc')
      .limit(fetchLimit)
      .field({
        _id: true,
        status: true,
        recordType: true,
        photoFileIDs: true,
        createdAt: true,
        analyzedAt: true,
        analyzeStartedAt: true,
        originPrunedAt: true
      })
      .get()

    const rows = (res && res.data) || []
    for (const doc of rows) {
      if (!doc || !doc._id || seen.has(doc._id)) continue
      seen.add(doc._id)
      scanned += 1
      const verdict = classifyEligibility(doc, nowMs)
      if (verdict.eligible) {
        eligible.push({ doc, category: verdict.category })
        if (eligible.length >= batchLimit) break
      }
    }
  }

  return { scanned, eligible }
}

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      await worker(items[idx], idx)
    }
  })
  await Promise.all(workers)
}

/**
 * 执行一轮巡检与打卡原图分级清理（仅删原图，保留数据库记录与 thumb/preview 缓存）。
 */
async function pruneOriginals(options = {}) {
  const db = options.db || defaultDb
  const files = options.files || defaultFiles
  const nowMs = options.now != null ? toTimestampMs(options.now) : Date.now()
  const batchLimit = Math.max(1, Math.min(2000, Number(options.batchLimit) || DEFAULT_BATCH_LIMIT))
  const concurrency = Math.max(1, Math.min(10, Number(options.concurrency) || DEFAULT_CONCURRENCY))
  const pruneFileDeps = options.pruneFileDeps || {}

  const sharpAvailable = typeof pruneFileDeps.isSharpAvailable === 'function'
    ? pruneFileDeps.isSharpAvailable()
    : files.isSharpAvailable()

  const summary = {
    success: true,
    scanned: 0,
    eligible: 0,
    prunedRecords: 0,
    prunedFiles: 0,
    alreadyPrunedFiles: 0,
    missingFiles: 0,
    freedBytes: 0,
    skippedFailed: 0,
    sharpAvailable,
    byCategory: {
      clock: 0,
      analyzed: 0,
      analyze_failed: 0
    }
  }

  if (!sharpAvailable) {
    console.warn('[pruneOriginals] sharp 不可用，跳过存在原图文件的清理以避免缺失缩略图')
  }

  const { scanned, eligible } = await fetchEligibleBatch(db, nowMs, batchLimit)
  summary.scanned = scanned
  summary.eligible = eligible.length

  if (eligible.length === 0) {
    return summary
  }

  await runWithConcurrency(eligible, concurrency, async ({ doc }) => {
    // 执行前重新读取最新状态，防止并发重排（retryFailed）或重新分析期间误删
    let freshDoc = doc
    try {
      const latest = await db.collection('inspections').doc(doc._id).get()
      if (latest && latest.data) freshDoc = latest.data
    } catch (_) {
      return
    }

    const recheck = classifyEligibility(freshDoc, nowMs)
    if (!recheck.eligible) {
      return
    }

    const fileIDs = Array.isArray(freshDoc.photoFileIDs)
      ? freshDoc.photoFileIDs.filter(id => typeof id === 'string' && id.trim())
      : []

    let recordPruned = 0
    let recordAlready = 0
    let recordMissing = 0
    let recordFailed = 0
    let recordFreed = 0

    for (const fileID of fileIDs) {
      const res = await files.pruneInspectionOriginal(fileID, pruneFileDeps)
      if (res.status === 'pruned') {
        recordPruned += 1
        recordFreed += res.freedBytes || 0
      } else if (res.status === 'already_pruned' || res.status === 'already_pruned_partial') {
        recordAlready += 1
      } else if (res.status === 'missing') {
        recordMissing += 1
      } else if (res.status === 'skipped_non_inspection' || res.status === 'skipped_invalid') {
        // 白名单保护：忽略非 inspections/ 路径，绝不误删产品/物料参考照
      } else {
        recordFailed += 1
      }
    }

    summary.prunedFiles += recordPruned
    summary.alreadyPrunedFiles += recordAlready
    summary.missingFiles += recordMissing
    summary.freedBytes += recordFreed

    // 任一照片变体生成或删文件失败，不写入 originPrunedAt，等待下次定时任务重试
    if (recordFailed > 0) {
      summary.skippedFailed += 1
      console.warn(`[pruneOriginals] 记录 ${freshDoc._id} 有 ${recordFailed} 张照片未满足清理条件，已跳过并保留原图`)
      return
    }

    const pruneStatus = (fileIDs.length > 0 && recordPruned === 0 && recordAlready === 0 && recordMissing === fileIDs.length)
      ? 'missing'
      : 'pruned'

    await db.collection('inspections').doc(freshDoc._id).update({
      data: {
        originPrunedAt: db.serverDate(),
        originPrunedCount: recordPruned,
        originPruneCategory: recheck.category,
        originPruneStatus: pruneStatus
      }
    })

    summary.prunedRecords += 1
    if (Object.prototype.hasOwnProperty.call(summary.byCategory, recheck.category)) {
      summary.byCategory[recheck.category] += 1
    }
  })

  return summary
}

module.exports = {
  pruneOriginals,
  classifyEligibility,
  startOfShanghaiDayMs,
  isClockRecord,
  ANALYZED_RETENTION_MS,
  FAILED_RETENTION_MS,
  DEFAULT_BATCH_LIMIT,
  DEFAULT_CONCURRENCY
}
