'use strict'

// ============================================================
// 云函数：reviewReport
// 功能：管理员（role === 'admin'）在手机端对 AI 陈列分析结果进行复核与人工校正
//
// 支持 action：
// - get                读取巡检详情 + 可编辑事实 + 产品库 + 易混淆联想词 + 修订历史
// - preview            基于候选 facts 纯确定性重算 5 维得分与总分（不调 AI、不落库）
// - confirm            确认 AI 原始/当前识别无误（记入正样本 reviewLogs，永久保留原图）
// - save               保存人工校正事实 → 确定性重算覆盖 aiReport → 记 reviewLogs → 后台重写文字 + 标记日报/统计待刷新
// - discardCorrection  撤销人工校正，恢复 aiReportOriginal
// - maintenance        内部定时任务：重算 stale 日报、防抖重建 shelfStats、重试卡住的 narrative
// ============================================================

const cloud = require('../../cloud-shim')
const {
  normalizeScoringRules,
  computeReviewLevel,
  computeSpotCheck
} = require('../analyzeImage/scoring')
const { PROMPT_VERSION } = require('../analyzeImage/prompt')
const {
  extractFacts,
  validateFacts,
  buildCorrectedReport,
  diffFacts
} = require('./facts')
const { regenerateCorrectedNarrative } = require('./narrative')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

const SHELF_STATS_DEBOUNCE_MS = 10 * 60 * 1000

async function getCaller(openid) {
  if (!openid) return null
  try {
    const res = await db.collection('users').where({ _openid: openid }).get()
    return (res.data && res.data[0]) || null
  } catch (err) {
    return null
  }
}

function isApprovedAdmin(user) {
  if (!user || user.disabled) return false
  if (user.role !== 'admin') return false
  if (user.approved === false) return false
  return true
}

async function loadActiveProducts() {
  try {
    const res = await db.collection('products').where({ isActive: true }).get()
    return res.data || []
  } catch (_) {
    return []
  }
}

async function loadActiveMaterials() {
  try {
    const res = await db.collection('adMaterials').where({ isActive: true }).get()
    return res.data || []
  } catch (_) {
    return []
  }
}

async function loadConfusableCompetitorNames() {
  const names = new Set()
  try {
    const res = await db.collection('confusableProducts').where({ isActive: true }).limit(100).get()
    ;(res.data || []).forEach(c => {
      if (!c) return
      const full = [c.competitorBrand, c.competitorName].filter(Boolean).join(' ').trim()
      if (full) names.add(full)
      else if (c.competitorName) names.add(String(c.competitorName).trim())
    })
  } catch (_) {}
  try {
    const logRes = await db.collection('reviewLogs')
      .where({ action: 'correct' })
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()
    ;(logRes.data || []).forEach(log => {
      ;(Array.isArray(log.changes) ? log.changes : []).forEach(ch => {
        if (ch && ch.actualProduct && String(ch.actualProduct).trim()) {
          names.add(String(ch.actualProduct).trim())
        }
      })
    })
  } catch (_) {}
  return Array.from(names).slice(0, 30)
}

async function loadSettingsAndBrandSet(activeProducts = []) {
  let settingsDoc = null
  try {
    const sRes = await db.collection('settings').doc('global').get()
    settingsDoc = (sRes && sRes.data) || null
  } catch (_) {}
  const scoringRules = normalizeScoringRules(settingsDoc && settingsDoc.scoringRules)
  const rawKv = settingsDoc && settingsDoc.knowledgeVersion
  const knowledgeVersion = (rawKv !== undefined && rawKv !== null && Number.isFinite(Number(rawKv)))
    ? Math.max(1, Math.round(Number(rawKv)))
    : 1

  const ownBrandNames = new Set()
  activeProducts.forEach(p => {
    if (!p) return
    if (p.brandName) ownBrandNames.add(String(p.brandName).trim().toLowerCase())
    if (Array.isArray(p.aliases)) {
      p.aliases.forEach(a => {
        const k = String(a || '').trim().toLowerCase()
        if (k) ownBrandNames.add(k)
      })
    }
  })

  return { settingsDoc, scoringRules, knowledgeVersion, ownBrandNames }
}

async function markDownstreamStale(inspectionDoc) {
  const nowIso = new Date().toISOString()
  // 1. 标记 settings.global.shelfStatsDirtyAt
  try {
    await db.collection('settings').doc('global').update({
      data: {
        shelfStatsDirtyAt: nowIso
      }
    })
  } catch (e) {
    try {
      await db.collection('settings').doc('global').set({
        data: { shelfStatsDirtyAt: nowIso }
      })
    } catch (_) {}
  }

  // 2. 标记关联的 dailyReport 为 stale
  const dailyReportId = inspectionDoc && inspectionDoc.dailyReportId
  if (dailyReportId) {
    try {
      await db.collection('dailyReports').doc(dailyReportId).update({
        data: { stale: true, staleAt: nowIso }
      })
    } catch (_) {}
  }
}

/**
 * 若管理员在校正「竞品误认为我方（false_own）」时填写了 actualProduct，自动在易混淆竞品库累加 hitCount 或创建草稿条目
 */
async function recordConfusableHitFromChanges(changes = [], activeProducts = []) {
  const falseOwnWithActual = (Array.isArray(changes) ? changes : []).filter(
    ch => ch && ch.type === 'false_own' && ch.actualProduct && String(ch.actualProduct).trim()
  )
  if (falseOwnWithActual.length === 0) return

  for (const ch of falseOwnWithActual) {
    const actualName = String(ch.actualProduct).trim().slice(0, 60)
    if (!actualName) continue
    try {
      const existingRes = await db.collection('confusableProducts')
        .where({ competitorName: actualName })
        .limit(1)
        .get()
      const existing = existingRes.data && existingRes.data[0]
      if (existing) {
        await db.collection('confusableProducts').doc(existing._id).update({
          data: {
            hitCount: _.inc(1),
            updatedAt: db.serverDate()
          }
        })
      }
    } catch (_) {}
  }
}

/**
 * 定时维护：
 * 1. 重试 narrativeStatus === 'pending' 的记录
 * 2. 重算 stale === true 的 dailyReports（按原日期、原 inspectionIds 整体替换）
 * 3. 若 shelfStatsDirtyAt 已静置 >= debounceMs（或 force=true），触发一次 shelfStats rebuild 并清空脏标记
 */
async function runReviewMaintenance(options = {}) {
  const force = Boolean(options.force)
  const debounceMs = Number.isFinite(Number(options.debounceMs))
    ? Math.max(0, Number(options.debounceMs))
    : SHELF_STATS_DEBOUNCE_MS
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()

  let retriedNarratives = 0
  let rebuiltDailyReports = 0
  let rebuiltShelfStats = false

  // 1. 重试 pending narrative
  try {
    const pendingRes = await db.collection('inspections')
      .where({ narrativeStatus: 'pending' })
      .limit(10)
      .get()
    const rows = pendingRes.data || []
    for (const doc of rows) {
      await regenerateCorrectedNarrative(doc._id, doc.reviewRevision || null)
      retriedNarratives++
    }
  } catch (err) {
    console.warn('[reviewMaintenance] 重试 narrative 失败:', err.message || err)
  }

  // 2. 重算 stale dailyReports
  try {
    const staleRes = await db.collection('dailyReports')
      .where({ stale: true })
      .limit(10)
      .get()
    const staleDocs = staleRes.data || []
    for (const dr of staleDocs) {
      if (!dr || !Array.isArray(dr.inspectionIds) || dr.inspectionIds.length === 0) {
        await db.collection('dailyReports').doc(dr._id).update({ data: { stale: false } }).catch(() => {})
        continue
      }
      await cloud.callFunction({
        name: 'analyzeImage',
        data: {
          action: 'dailySummary',
          inspectionIds: dr.inspectionIds,
          date: dr.date,
          reportDocId: dr._id,
          replace: true
        }
      })
      rebuiltDailyReports++
    }
  } catch (err) {
    console.warn('[reviewMaintenance] 重算 stale 日报失败:', err.message || err)
  }

  // 3. 防抖重建 shelfStats
  try {
    const sRes = await db.collection('settings').doc('global').get()
    const settingsDoc = (sRes && sRes.data) || null
    const dirtyAtStr = settingsDoc && settingsDoc.shelfStatsDirtyAt
    if (dirtyAtStr) {
      const dirtyMs = new Date(dirtyAtStr).getTime()
      const elapsed = Number.isFinite(dirtyMs) ? (nowMs - dirtyMs) : debounceMs
      if (force || elapsed >= debounceMs) {
        const rebuildRes = await cloud.callFunction({
          name: 'shelfStats',
          data: { action: 'rebuild', Type: 'Timer' }
        })
        if (rebuildRes && rebuildRes.result && rebuildRes.result.success) {
          rebuiltShelfStats = true
          await db.collection('settings').doc('global').update({
            data: { shelfStatsDirtyAt: '' }
          })
        }
      }
    }
  } catch (err) {
    console.warn('[reviewMaintenance] 防抖重建 shelfStats 失败:', err.message || err)
  }

  return {
    success: true,
    retriedNarratives,
    rebuiltDailyReports,
    rebuiltShelfStats
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  const source = String(wxContext.SOURCE || '')
  const isInternalCall = !openid && (source === 'timer' || source === 'internal' || event.Type === 'Timer')

  const { action = 'get' } = event || {}

  if (action === 'maintenance') {
    if (!isInternalCall) {
      const caller = await getCaller(openid)
      if (!isApprovedAdmin(caller)) {
        return { success: false, error: '仅管理员可执行维护任务', code: 'FORBIDDEN' }
      }
    }
    return await runReviewMaintenance(event)
  }

  // 全部复核与校正接口严格限定为已审批且未停用的 admin
  const caller = await getCaller(openid)
  if (!isApprovedAdmin(caller)) {
    return {
      success: false,
      error: '仅管理员可进行 AI 识别复核与人工校正',
      code: 'FORBIDDEN'
    }
  }

  const adminName = String(caller.nickName || caller.name || '管理员').trim()

  // ============================================================
  // action === 'queueStats'：供管理页展示待复核数量概览
  // ============================================================
  if (action === 'queueStats') {
    const unreviewedCond = {
      status: 'analyzed',
      'aiReport.metadata.isMock': _.neq(true),
      reviewStatus: _.nin(['confirmed', 'corrected'])
    }
    const [lowRes, midRes, spotRes, correctedRes, confirmedRes] = await Promise.all([
      db.collection('inspections').where(_.and(unreviewedCond, { reviewLevel: 'low' })).count(),
      db.collection('inspections').where(_.and(unreviewedCond, { reviewLevel: 'mid' })).count(),
      db.collection('inspections').where(_.and(unreviewedCond, { spotCheck: true })).count(),
      db.collection('inspections').where({ status: 'analyzed', reviewStatus: 'corrected' }).count(),
      db.collection('inspections').where({ status: 'analyzed', reviewStatus: 'confirmed' }).count()
    ])
    return {
      success: true,
      stats: {
        pendingLow: lowRes.total || 0,
        pendingMid: midRes.total || 0,
        pendingSpotCheck: spotRes.total || 0,
        totalPending: (lowRes.total || 0) + (midRes.total || 0),
        correctedCount: correctedRes.total || 0,
        confirmedCount: confirmedRes.total || 0
      }
    }
  }

  // ============================================================
  // action === 'batchConfirmDate'：按北京自然日一键将该日其余未改已分析记录标为「确认无误」正样本
  // ============================================================
  if (action === 'batchConfirmDate') {
    const dateStr = String((event && event.date) || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return { success: false, error: '请提供合法日期（格式 YYYY-MM-DD）' }
    }
    const startDate = new Date(`${dateStr}T00:00:00.000+08:00`)
    if (Number.isNaN(startDate.getTime())) {
      return { success: false, error: '日期无效' }
    }
    const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000)

    const dayRes = await db.collection('inspections')
      .where(_.and([
        { status: 'analyzed' },
        { createdAt: _.gte(startDate.toISOString()) },
        { createdAt: _.lt(endDate.toISOString()) }
      ]))
      .limit(500)
      .get()

    const validDocs = (dayRes.data || []).filter(d => (
      d &&
      d.aiReport &&
      typeof d.aiReport === 'object' &&
      !(d.aiReport.metadata && d.aiReport.metadata.isMock === true)
    ))
    const correctedList = validDocs.filter(d => d.reviewStatus === 'corrected')
    const confirmedList = validDocs.filter(d => d.reviewStatus === 'confirmed')
    const unreviewedList = validDocs.filter(d => !['corrected', 'confirmed'].includes(d.reviewStatus))

    if (event && event.dryRun === true) {
      return {
        success: true,
        date: dateStr,
        totalAnalyzed: validDocs.length,
        correctedCount: correctedList.length,
        alreadyConfirmedCount: confirmedList.length,
        unreviewedCount: unreviewedList.length
      }
    }

    const activeProductsForBatch = await loadActiveProducts()
    const { knowledgeVersion: kvBatch } = await loadSettingsAndBrandSet(activeProductsForBatch)
    const batchNote = String((event && event.note) || `按日(${dateStr})批量确认未改记录无误`).trim().slice(0, 200)

    for (const item of unreviewedList) {
      const nextRev = (Number(item.reviewRevision) || 0) + 1
      const baseForLog = item.aiReportOriginal || item.aiReport
      const currentFacts = extractFacts(item.aiReport, activeProductsForBatch)
      const rvLevel = item.reviewLevel || computeReviewLevel(baseForLog)
      const spCheck = typeof item.spotCheck === 'boolean'
        ? item.spotCheck
        : computeSpotCheck(item._id, undefined, rvLevel)
      const meta = (baseForLog && baseForLog.metadata) || {}
      const fm = (baseForLog && baseForLog.facingMetrics) || {}

      await db.collection('inspections').doc(item._id).update({
        data: {
          reviewLevel: rvLevel,
          spotCheck: spCheck,
          reviewStatus: 'confirmed',
          reviewRevision: nextRev,
          reviewedAt: db.serverDate(),
          reviewedBy: openid,
          reviewedByName: adminName,
          keepOriginal: true
        }
      })

      await db.collection('reviewLogs').add({
        data: {
          inspectionId: item._id,
          revision: nextRev,
          action: 'confirm',
          adminOpenid: openid,
          adminName,
          createdAt: db.serverDate(),
          storeName: item.storeName || '',
          customerId: item.customerId || '',
          salesOpenid: item._openid || '',
          userName: item.userName || '',
          aiMeta: {
            model: item.analyzedModel || '',
            promptVersion: meta.promptVersion || PROMPT_VERSION,
            knowledgeVersion: meta.knowledgeVersion || kvBatch,
            countingConfidence: fm.countingConfidence != null ? fm.countingConfidence : null,
            reviewLevel: rvLevel,
            spotCheck: spCheck,
            imageQuality: meta.imageQuality || 'good',
            framingType: meta.framingType || 'panorama',
            needsReview: Boolean(meta.needsReview)
          },
          beforeFacts: currentFacts,
          afterFacts: currentFacts,
          changes: [],
          note: batchNote
        }
      })
    }

    return {
      success: true,
      date: dateStr,
      confirmedNowCount: unreviewedList.length,
      totalAnalyzed: validDocs.length,
      correctedCount: correctedList.length,
      alreadyConfirmedCount: confirmedList.length
    }
  }

  const { inspectionId } = event || {}
  if (!inspectionId) {
    return { success: false, error: '缺少必要参数 inspectionId' }
  }

  let doc
  try {
    const res = await db.collection('inspections').doc(inspectionId).get()
    doc = res && res.data
  } catch (err) {
    return { success: false, error: '拜访记录不存在' }
  }
  if (!doc) {
    return { success: false, error: '拜访记录不存在' }
  }
  if (!doc.aiReport || typeof doc.aiReport !== 'object') {
    return { success: false, error: '该记录尚未生成 AI 分析报告，无法进行复核校正' }
  }

  const activeProducts = await loadActiveProducts()
  const activeMaterials = await loadActiveMaterials()
  const { scoringRules, knowledgeVersion, ownBrandNames } = await loadSettingsAndBrandSet(activeProducts)

  // ============================================================
  // action === 'get'：获取校正页所需的完整上下文
  // ============================================================
  if (action === 'get') {
    let photoURLs = []
    let photoThumbURLs = []
    if (Array.isArray(doc.photoFileIDs) && doc.photoFileIDs.length > 0) {
      try {
        const [origRes, previewRes] = await Promise.all([
          cloud.getTempFileURL({ fileList: doc.photoFileIDs }),
          cloud.getTempFileURL({ fileList: doc.photoFileIDs, variant: 'preview' })
        ])
        photoURLs = origRes.fileList.map(f => f.tempFileURL || '')
        photoThumbURLs = previewRes.fileList.map((f, i) => f.tempFileURL || photoURLs[i] || '')
      } catch (_) {}
    }

    const facts = extractFacts(doc.aiReport, activeProducts)
    const originalFacts = doc.aiReportOriginal
      ? extractFacts(doc.aiReportOriginal, activeProducts)
      : facts
    const confusableNames = await loadConfusableCompetitorNames()

    let logs = []
    try {
      const logRes = await db.collection('reviewLogs')
        .where({ inspectionId })
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get()
      logs = logRes.data || []
    } catch (_) {}

    const reviewLevel = doc.reviewLevel || computeReviewLevel(doc.aiReport)
    const spotCheck = typeof doc.spotCheck === 'boolean'
      ? doc.spotCheck
      : computeSpotCheck(doc._id, undefined, reviewLevel)

    return {
      success: true,
      inspection: {
        _id: doc._id,
        storeName: doc.storeName || '未命名门店',
        taskName: doc.taskName || '',
        userName: doc.userName || '',
        customerId: doc.customerId || '',
        createdAt: doc.createdAt,
        analyzedAt: doc.analyzedAt,
        analyzedModel: doc.analyzedModel || '',
        photoURLs,
        photoThumbURLs,
        reviewLevel,
        spotCheck,
        reviewStatus: doc.reviewStatus || 'unreviewed',
        reviewRevision: doc.reviewRevision || 0,
        reviewedAt: doc.reviewedAt || null,
        reviewedByName: doc.reviewedByName || '',
        narrativeStatus: doc.narrativeStatus || 'done',
        hasOriginalBackup: Boolean(doc.aiReportOriginal),
        aiReport: doc.aiReport
      },
      facts,
      originalFacts,
      scoringRules,
      activeProducts: activeProducts.map(p => ({
        _id: p._id,
        brandName: p.brandName,
        productLine: p.productLine || '',
        aliases: p.aliases || [],
        label: [p.brandName, p.productLine].filter(Boolean).join(' ')
      })),
      confusableNames,
      logs
    }
  }

  // ============================================================
  // action === 'preview'：纯确定性计算预览分（不落库、不调 AI）
  // ============================================================
  if (action === 'preview') {
    const vRes = validateFacts(event.facts, activeProducts)
    if (!vRes.ok) {
      return { success: false, error: vRes.error }
    }
    const baseReport = doc.aiReportOriginal || doc.aiReport
    const previewReport = buildCorrectedReport(baseReport, vRes.facts, {
      scoringRules,
      activeMaterials,
      ownBrandNames,
      revision: (doc.reviewRevision || 0) + 1,
      knowledgeVersion
    })
    return {
      success: true,
      facts: vRes.facts,
      preview: {
        score: previewReport.score,
        scoreLevel: previewReport.scoreLevel,
        ownBrandPresent: previewReport.ownBrandPresent,
        hasShelfPhoto: previewReport.hasShelfPhoto,
        facingMetrics: previewReport.facingMetrics,
        displayCompliance: previewReport.displayCompliance,
        summary: previewReport.summary
      }
    }
  }

  // ============================================================
  // action === 'confirm'：确认识别无误（正样本沉淀 + 移出待复核队列）
  // ============================================================
  if (action === 'confirm') {
    const currentRevision = Number(doc.reviewRevision) || 0
    if (event.expectedRevision !== undefined && event.expectedRevision !== null) {
      if (Number(event.expectedRevision) !== currentRevision) {
        return {
          success: false,
          error: '该记录已被其他管理员更新，请刷新后重试',
          code: 'REVISION_CONFLICT',
          currentRevision
        }
      }
    }

    const nextRevision = currentRevision + 1
    const baseForLog = doc.aiReportOriginal || doc.aiReport
    const currentFacts = extractFacts(doc.aiReport, activeProducts)
    const reviewLevel = doc.reviewLevel || computeReviewLevel(baseForLog)
    const spotCheck = typeof doc.spotCheck === 'boolean'
      ? doc.spotCheck
      : computeSpotCheck(doc._id, undefined, reviewLevel)
    const nextStatus = doc.reviewStatus === 'corrected' ? 'corrected' : 'confirmed'

    await db.collection('inspections').doc(inspectionId).update({
      data: {
        reviewLevel,
        spotCheck,
        reviewStatus: nextStatus,
        reviewRevision: nextRevision,
        reviewedAt: db.serverDate(),
        reviewedBy: openid,
        reviewedByName: adminName,
        keepOriginal: true
      }
    })

    const meta = (baseForLog && baseForLog.metadata) || {}
    const fm = (baseForLog && baseForLog.facingMetrics) || {}
    await db.collection('reviewLogs').add({
      data: {
        inspectionId,
        revision: nextRevision,
        action: 'confirm',
        adminOpenid: openid,
        adminName,
        createdAt: db.serverDate(),
        storeName: doc.storeName || '',
        customerId: doc.customerId || '',
        salesOpenid: doc._openid || '',
        userName: doc.userName || '',
        aiMeta: {
          model: doc.analyzedModel || '',
          promptVersion: meta.promptVersion || PROMPT_VERSION,
          knowledgeVersion: meta.knowledgeVersion || knowledgeVersion,
          countingConfidence: fm.countingConfidence != null ? fm.countingConfidence : null,
          reviewLevel,
          spotCheck,
          imageQuality: meta.imageQuality || 'good',
          framingType: meta.framingType || 'panorama',
          needsReview: Boolean(meta.needsReview)
        },
        beforeFacts: currentFacts,
        afterFacts: currentFacts,
        changes: [],
        note: String(event.note || '').trim().slice(0, 200)
      }
    })

    return {
      success: true,
      reviewStatus: nextStatus,
      reviewRevision: nextRevision
    }
  }

  // ============================================================
  // action === 'save'：保存人工校正 → 重算分数 → 记日志 → 后台重写文字
  // ============================================================
  if (action === 'save') {
    const currentRevision = Number(doc.reviewRevision) || 0
    if (event.expectedRevision !== undefined && event.expectedRevision !== null) {
      if (Number(event.expectedRevision) !== currentRevision) {
        return {
          success: false,
          error: '该记录已被其他管理员修改，请刷新后重试',
          code: 'REVISION_CONFLICT',
          currentRevision
        }
      }
    }

    const vRes = validateFacts(event.facts, activeProducts)
    if (!vRes.ok) {
      return { success: false, error: vRes.error }
    }

    const aiReportOriginal = doc.aiReportOriginal || doc.aiReport
    const beforeFacts = extractFacts(aiReportOriginal, activeProducts)
    const afterFacts = vRes.facts
    const nextRevision = currentRevision + 1

    const correctedReport = buildCorrectedReport(aiReportOriginal, afterFacts, {
      scoringRules,
      activeMaterials,
      ownBrandNames,
      revision: nextRevision,
      knowledgeVersion
    })

    const origLevel = doc.reviewLevel || computeReviewLevel(aiReportOriginal)
    const origSpotCheck = typeof doc.spotCheck === 'boolean'
      ? doc.spotCheck
      : computeSpotCheck(doc._id, undefined, origLevel)

    const changes = diffFacts(beforeFacts, afterFacts, event.annotations || event.reasons || [])

    await db.collection('inspections').doc(inspectionId).update({
      data: {
        aiReportOriginal,
        aiReport: correctedReport,
        reviewLevel: origLevel,
        spotCheck: origSpotCheck,
        reviewStatus: 'corrected',
        reviewRevision: nextRevision,
        reviewedAt: db.serverDate(),
        reviewedBy: openid,
        reviewedByName: adminName,
        narrativeStatus: 'pending',
        keepOriginal: true
      }
    })

    const origMeta = (aiReportOriginal && aiReportOriginal.metadata) || {}
    const origFm = (aiReportOriginal && aiReportOriginal.facingMetrics) || {}
    await db.collection('reviewLogs').add({
      data: {
        inspectionId,
        revision: nextRevision,
        action: 'correct',
        adminOpenid: openid,
        adminName,
        createdAt: db.serverDate(),
        storeName: doc.storeName || '',
        customerId: doc.customerId || '',
        salesOpenid: doc._openid || '',
        userName: doc.userName || '',
        aiMeta: {
          model: doc.analyzedModel || '',
          promptVersion: origMeta.promptVersion || PROMPT_VERSION,
          knowledgeVersion: origMeta.knowledgeVersion || knowledgeVersion,
          countingConfidence: origFm.countingConfidence != null ? origFm.countingConfidence : null,
          reviewLevel: origLevel,
          spotCheck: origSpotCheck,
          imageQuality: origMeta.imageQuality || 'good',
          framingType: origMeta.framingType || 'panorama',
          needsReview: Boolean(origMeta.needsReview)
        },
        beforeFacts,
        afterFacts,
        changes,
        note: String(event.note || '').trim().slice(0, 200)
      }
    })

    await recordConfusableHitFromChanges(changes, activeProducts)
    await markDownstreamStale(doc)

    // 异步重写文字（若调用方传 awaitNarrative: true，例如单元测试，则同步等待）
    if (event.awaitNarrative) {
      await regenerateCorrectedNarrative(inspectionId, nextRevision)
    } else {
      regenerateCorrectedNarrative(inspectionId, nextRevision).catch(err => {
        console.warn('[reviewReport] 异步重写文字异常:', err.message || err)
      })
    }

    const latestRes = await db.collection('inspections').doc(inspectionId).get()
    const latestDoc = (latestRes && latestRes.data) || doc

    return {
      success: true,
      reviewStatus: 'corrected',
      reviewRevision: nextRevision,
      narrativeStatus: latestDoc.narrativeStatus || 'pending',
      changesCount: changes.length,
      report: latestDoc.aiReport || correctedReport
    }
  }

  // ============================================================
  // action === 'discardCorrection'：恢复原始 AI 报告
  // ============================================================
  if (action === 'discardCorrection') {
    if (!doc.aiReportOriginal) {
      return { success: false, error: '该记录没有原始 AI 报告备份，无需恢复' }
    }
    const nextRevision = (Number(doc.reviewRevision) || 0) + 1
    const origLevel = computeReviewLevel(doc.aiReportOriginal)
    const origSpotCheck = computeSpotCheck(doc._id, undefined, origLevel)

    await db.collection('inspections').doc(inspectionId).update({
      data: {
        aiReport: doc.aiReportOriginal,
        reviewLevel: origLevel,
        spotCheck: origSpotCheck,
        reviewStatus: 'unreviewed',
        reviewRevision: nextRevision,
        reviewedAt: db.serverDate(),
        reviewedBy: openid,
        reviewedByName: adminName,
        narrativeStatus: 'done'
      }
    })

    await markDownstreamStale(doc)

    return {
      success: true,
      reviewStatus: 'unreviewed',
      reviewRevision: nextRevision,
      report: doc.aiReportOriginal
    }
  }

  return { success: false, error: `未知 action: ${action}` }
}

exports._internal = {
  runReviewMaintenance
}
