'use strict'

const cloud = require('./cloud-shim')

const HANDLERS_READY = () => require('./handlers')

function shanghaiParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })
  const bag = {}
  fmt.formatToParts(date).forEach(part => {
    if (part.type !== 'literal') bag[part.type] = part.value
  })
  return {
    year: bag.year,
    month: bag.month,
    day: bag.day,
    weekday: bag.weekday || '',
    hour: parseInt(bag.hour, 10),
    minute: parseInt(bag.minute, 10),
    second: parseInt(bag.second, 10)
  }
}

function decideJobs(parts, state) {
  const jobs = []
  const minuteKey = `${parts.year}-${parts.month}-${parts.day}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`
  if (parts.minute % 2 === 0 && state.lastBatch !== minuteKey) jobs.push({ name: 'batchAnalyze', key: minuteKey })
  if (parts.minute % 10 === 0 && state.lastReviewMaint !== minuteKey) jobs.push({ name: 'reviewMaintenance', key: minuteKey })
  if (parts.minute % 30 === 0 && state.lastJxc !== minuteKey) jobs.push({ name: 'syncJxc', key: minuteKey })
  if (parts.hour === 3 && parts.minute === 0 && state.lastStats !== dateKey) jobs.push({ name: 'shelfStats', key: dateKey })
  if (parts.hour === 3 && parts.minute >= 30 && state.lastPrune !== dateKey) jobs.push({ name: 'pruneOriginals', key: dateKey })
  if (parts.weekday === 'Mon' && parts.hour === 4 && parts.minute >= 30 && state.lastReflection !== dateKey) {
    jobs.push({ name: 'reflection', key: dateKey })
  }
  return jobs
}

function createScheduler() {
  const state = { lastBatch: '', lastReviewMaint: '', lastJxc: '', lastStats: '', lastPrune: '', lastReflection: '' }
  const running = { batchAnalyze: false, reviewMaintenance: false, syncJxc: false, shelfStats: false, pruneOriginals: false, reflection: false }
  let timer = null
  let warnedJxc = false

  async function runJob(name) {
    if (running[name]) return
    running[name] = true
    const handlers = HANDLERS_READY()
    try {
      if (name === 'batchAnalyze') {
        const result = await cloud.runWithContext({ openid: '', source: 'timer' }, () => (
          handlers.batchAnalyze({ Type: 'Timer', TriggerName: 'batchAnalyzeTimer' })
        ))
        if (result && (result.processed > 0 || result.reclaimed > 0 || result.success === false)) {
          console.log('[cron] batchAnalyze', JSON.stringify({
            skipped: !!result.skipped,
            processed: result.processed || 0,
            succeeded: result.succeeded || 0,
            failed: result.failed || 0,
            reclaimed: result.reclaimed || 0
          }))
        }
      } else if (name === 'syncJxc') {
        const result = await cloud.runWithContext({ openid: '', source: 'timer' }, () => (
          handlers.syncJxcCustomers({ Type: 'Timer', TriggerName: 'syncJxcCustomersTimer' })
        ))
        if (result && result.success) {
          console.log('[cron] syncJxc', JSON.stringify(result.summary || {}))
        } else if (result && result.error && !/尚未配置/.test(result.error)) {
          console.warn('[cron] syncJxc', result.error)
        } else if (result && result.error && !warnedJxc) {
          warnedJxc = true
          console.log('[cron] syncJxc 跳过：尚未配置进销存地址或 API Key')
        }
      } else if (name === 'shelfStats') {
        const result = await cloud.runWithContext({ openid: '', source: 'timer' }, () => (
          handlers.shelfStats({ Type: 'Timer', TriggerName: 'shelfStatsNightly', action: 'rebuild' })
        ))
        console.log('[cron] shelfStats', JSON.stringify({
          success: !!(result && result.success),
          storeDocs: result && result.storeDocs,
          overallDocs: result && result.overallDocs,
          error: result && result.error
        }))
      } else if (name === 'pruneOriginals') {
        const { pruneOriginals } = require('./prune-originals')
        const result = await pruneOriginals()
        console.log('[cron] pruneOriginals', JSON.stringify({
          scanned: result && result.scanned,
          prunedRecords: result && result.prunedRecords,
          prunedFiles: result && result.prunedFiles,
          freedBytes: result && result.freedBytes,
          skippedFailed: result && result.skippedFailed,
          sharpAvailable: result && result.sharpAvailable
        }))
      } else if (name === 'reviewMaintenance') {
        const result = await cloud.runWithContext({ openid: '', source: 'timer' }, () => (
          handlers.reviewReport({ Type: 'Timer', action: 'maintenance' })
        ))
        if (result && (result.retriedNarratives > 0 || result.rebuiltDailyReports > 0 || result.rebuiltShelfStats)) {
          console.log('[cron] reviewMaintenance', JSON.stringify(result))
        }
      } else if (name === 'reflection') {
        const result = await cloud.runWithContext({ openid: '', source: 'timer' }, () => (
          handlers.reflection({ Type: 'Timer', action: 'run' })
        ))
        console.log('[cron] reflection', JSON.stringify({
          success: !!(result && result.success),
          skipped: !!(result && result.skipped),
          reflectionId: result && result.reflectionId,
          reason: result && result.reason
        }))
      }
    } catch (err) {
      console.error(`[cron] ${name} 失败:`, err)
    } finally {
      running[name] = false
    }
  }

  async function tick() {
    const jobs = decideJobs(shanghaiParts(), state)
    for (const job of jobs) {
      if (job.name === 'batchAnalyze') state.lastBatch = job.key
      if (job.name === 'reviewMaintenance') state.lastReviewMaint = job.key
      if (job.name === 'syncJxc') state.lastJxc = job.key
      if (job.name === 'shelfStats') state.lastStats = job.key
      if (job.name === 'pruneOriginals') state.lastPrune = job.key
      if (job.name === 'reflection') state.lastReflection = job.key
      await runJob(job.name)
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        tick().catch(err => console.error('[cron] tick 失败:', err))
      }, 20 * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      console.log('[cron] 已启动：批量分析每 2 分钟，进销存每 30 分钟，排面统计每天 03:00，原图分级清理每天 03:30（Asia/Shanghai）')
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}

module.exports = {
  shanghaiParts,
  decideJobs,
  createScheduler
}
