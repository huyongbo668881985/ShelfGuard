'use strict'

// ============================================================
// 云函数：reflection
// 功能：定期（或管理员手动触发）AI 识别复盘总结、根因分析、提案审批与知识库变更追踪
//
// 支持 action：
// - run       触发一次复盘（收集 reviewLogs → 确定性统计 → 聚类 → AI 归因 → 回放验证 → 落库 reflectionReports）
// - list      查询历史复盘报告列表 + 当前知识库版本与概览
// - get       获取单份复盘报告详情
// - decide    管理员审批单条提案（decision: 'approve' | 'reject'）
// - undo      管理员一键撤销已采纳的变更（changeId）
// - changes   查询知识库变更审计记录（knowledgeChanges）
// ============================================================

const cloud = require('../../cloud-shim')
const { normalizeReviewThresholds } = require('../analyzeImage/scoring')
const {
  computeReflectionStats,
  buildErrorClusters,
  computeProposalEffectTracking
} = require('./stats')
const { attributeErrorCluster } = require('./attribution')
const { verifyProposalWithReplay } = require('./replay')
const { applyProposal, undoKnowledgeChange } = require('./apply')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

const DEFAULT_MIN_CORRECTIONS = 8
const DEFAULT_REPLAY_MAX_CALLS = 60

let reflectionRunning = false

async function getCaller(openid) {
  if (!openid) return null
  try {
    const res = await db.collection('users').where({ _openid: openid }).get()
    return (res.data && res.data[0]) || null
  } catch (_) {
    return null
  }
}

function isApprovedAdmin(user) {
  if (!user || user.disabled) return false
  if (user.role !== 'admin') return false
  if (user.approved === false) return false
  return true
}

async function loadKnowledgeSnapshot() {
  let settingsDoc = {}
  try {
    const sRes = await db.collection('settings').doc('global').get()
    settingsDoc = (sRes && sRes.data) || {}
  } catch (_) {}

  let products = []
  try {
    const pRes = await db.collection('products').where({ isActive: true }).limit(200).get()
    products = pRes.data || []
  } catch (_) {}

  let confusableProducts = []
  try {
    const cRes = await db.collection('confusableProducts').where({ isActive: true }).limit(200).get()
    confusableProducts = cRes.data || []
  } catch (_) {}

  let adMaterials = []
  try {
    const mRes = await db.collection('adMaterials').where({ isActive: true }).limit(200).get()
    adMaterials = mRes.data || []
  } catch (_) {}

  const learnedRules = Array.isArray(settingsDoc.learnedRules)
    ? settingsDoc.learnedRules.filter(r => r && r.isActive !== false)
    : []
  const reviewThresholds = normalizeReviewThresholds(settingsDoc.reviewThresholds)
  const knowledgeVersion = Number(settingsDoc.knowledgeVersion) || 1

  return {
    settingsDoc,
    knowledgeVersion,
    products: products.map(p => ({
      _id: p._id,
      brandName: p.brandName,
      productLine: p.productLine || '',
      aliases: p.aliases || [],
      visualFeatures: p.visualFeatures || '',
      confusionNotes: p.confusionNotes || '',
      refPriority: Number(p.refPriority) || 0,
      hasFrontPhoto: Boolean(p.photos && p.photos.front),
      hasSidePhoto: Boolean(p.photos && p.photos.side),
      hasBackPhoto: Boolean(p.photos && p.photos.back)
    })),
    confusableProducts: confusableProducts.map(c => ({
      _id: c._id,
      competitorName: c.competitorName,
      competitorBrand: c.competitorBrand || '',
      lookalikeProductId: c.lookalikeProductId || '',
      lookalikeProductName: c.lookalikeProductName || '',
      distinguishingFeatures: c.distinguishingFeatures || '',
      hitCount: Number(c.hitCount) || 1
    })),
    adMaterials: adMaterials.map(m => ({
      _id: m._id,
      materialName: m.materialName,
      category: m.category || '',
      aliases: m.aliases || [],
      visualFeatures: m.visualFeatures || ''
    })),
    learnedRules,
    reviewThresholds
  }
}

async function runReflectionCycle(options = {}) {
  if (reflectionRunning) {
    return { success: false, error: '当前已有复盘任务正在运行，请稍候', code: 'ALREADY_RUNNING' }
  }
  reflectionRunning = true
  try {
    const isManual = Boolean(options.manual)
    const skipReplay = Boolean(options.skipReplay)
    const snapshot = await loadKnowledgeSnapshot()
    const settingsDoc = snapshot.settingsDoc || {}

    const minCorrections = Number.isFinite(Number(settingsDoc.reflectionMinCorrections))
      ? Math.max(1, Math.round(Number(settingsDoc.reflectionMinCorrections)))
      : DEFAULT_MIN_CORRECTIONS
    const replayMaxCalls = Number.isFinite(Number(settingsDoc.reflectionReplayMaxCalls))
      ? Math.max(0, Math.round(Number(settingsDoc.reflectionReplayMaxCalls)))
      : DEFAULT_REPLAY_MAX_CALLS

    // 确定本期统计起点：默认从上次复盘时间起；若手动触发且指定 lookbackDays，或上次复盘后样本不足，则取最近 30 天
    const lastReflectionAt = settingsDoc.lastReflectionAt ? new Date(settingsDoc.lastReflectionAt) : null
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const sinceDate = (!isManual && lastReflectionAt && !isNaN(lastReflectionAt.getTime()))
      ? lastReflectionAt
      : thirtyDaysAgo

    const periodLogsRes = await db.collection('reviewLogs')
      .where({ createdAt: _.gte(sinceDate) })
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get()
    let periodLogs = periodLogsRes.data || []

    // 若手动触发且最近 30 天为空，放宽取全量最近 200 条
    if (isManual && periodLogs.length === 0) {
      const allRes = await db.collection('reviewLogs')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get()
      periodLogs = allRes.data || []
    }

    const stats = computeReflectionStats(periodLogs)
    if (!isManual && stats.correctedCount < minCorrections) {
      return {
        success: true,
        skipped: true,
        reason: `本期新增人工校正 ${stats.correctedCount} 条，未达自动复盘门槛（${minCorrections} 条），已顺延至下期累积`,
        correctedCount: stats.correctedCount,
        minCorrections
      }
    }

    if (periodLogs.length === 0) {
      return {
        success: false,
        error: '暂无人工复核或校正记录可供复盘，请先在拜访记录中复核若干报告'
      }
    }

    // 手动触发且样本较少时允许单条成簇（minClusterSize=1），定时自动复盘要求 >= 2
    const minClusterSize = (isManual && stats.correctedCount < 4) ? 1 : 2
    let clusters = buildErrorClusters(periodLogs, { minClusterSize, maxClusters: 6 })
    if (clusters.length === 0 && stats.correctedCount > 0) {
      clusters = buildErrorClusters(periodLogs, { minClusterSize: 1, maxClusters: 6 })
    }

    const attributedClusters = []
    const allProposals = []
    const budgetTracker = { usedCalls: 0, maxCalls: skipReplay ? 0 : replayMaxCalls }

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i]
      const attr = await attributeErrorCluster(cluster, snapshot, { settingsDoc })
      const proposalsWithReplay = []
      for (const prop of (attr.proposals || [])) {
        const uniqueProp = {
          ...prop,
          proposalId: `prop_${i + 1}_${proposalsWithReplay.length + 1}`
        }
        if (!skipReplay && uniqueProp.replayable) {
          uniqueProp.replayResult = await verifyProposalWithReplay(
            uniqueProp,
            cluster,
            periodLogs,
            snapshot,
            { settingsDoc, budgetTracker }
          )
        } else {
          uniqueProp.replayResult = {
            status: 'skipped',
            reason: skipReplay ? 'skip_requested' : 'non_replayable',
            summaryText: uniqueProp.replayable ? '本次复盘未开启在线回放' : '待办/提醒类提案无需回放'
          }
        }
        proposalsWithReplay.push(uniqueProp)
        allProposals.push(uniqueProp)
      }
      attributedClusters.push({
        ...attr,
        proposals: proposalsWithReplay
      })
    }

    // 如果高置信抽检发现错误率偏高（>= 20%），额外生成一条阈值收紧提案
    const spotStats = stats.byConfidenceLevel && stats.byConfidenceLevel.spotCheckHigh
    if (spotStats && spotStats.total >= 3 && spotStats.errorRate !== null && spotStats.errorRate >= 20) {
      const curT = snapshot.reviewThresholds
      const nextMidCount = Math.min(0.92, Math.round((curT.midCountingConfidence + 0.05) * 100) / 100)
      const nextMidSku = Math.min(0.92, Math.round((curT.midSkuConfidence + 0.05) * 100) / 100)
      if (nextMidCount > curT.midCountingConfidence || nextMidSku > curT.midSkuConfidence) {
        allProposals.push({
          proposalId: `prop_thresh_1`,
          clusterKey: 'spot_check_high_error',
          clusterTitle: `高置信抽检错误率偏高（${spotStats.errorRate}%）`,
          fixType: 'threshold_adjust',
          summary: `收紧中置信复核阈值至 ${nextMidCount}，拦截更多潜在误判`,
          target: {},
          payload: {
            ...curT,
            midCountingConfidence: nextMidCount,
            midSkuConfidence: nextMidSku
          },
          rationale: `高置信抽检 ${spotStats.total} 条中发现 ${spotStats.corrected} 条有误，适当上调中置信门槛可减少漏标`,
          evidenceCount: spotStats.corrected,
          evidenceInspectionIds: [],
          replayable: false,
          replayResult: {
            status: 'skipped',
            reason: 'threshold_only',
            summaryText: '阈值调整立即作用于后续复核分级'
          },
          status: 'pending'
        })
      }
    }

    // 效果追踪：对比过往已采纳的知识库变更前后的错误率
    let effectTracking = []
    try {
      const [allLogsRes, changesRes] = await Promise.all([
        db.collection('reviewLogs').orderBy('createdAt', 'desc').limit(500).get(),
        db.collection('knowledgeChanges').orderBy('appliedAt', 'desc').limit(30).get()
      ])
      effectTracking = computeProposalEffectTracking(allLogsRes.data || [], changesRes.data || [])
    } catch (_) {}

    const nowIso = new Date().toISOString()
    const reportDoc = {
      createdAt: db.serverDate(),
      createdAtIso: nowIso,
      triggeredBy: options.triggeredBy || (isManual ? 'manual' : 'timer'),
      knowledgeVersionAtRun: snapshot.knowledgeVersion,
      periodStartIso: sinceDate.toISOString(),
      periodEndIso: nowIso,
      stats,
      clusters: attributedClusters,
      proposals: allProposals,
      effectTracking,
      replayCallsUsed: budgetTracker.usedCalls
    }

    const addRes = await db.collection('reflectionReports').add({
      data: reportDoc
    })

    try {
      await db.collection('settings').doc('global').update({
        data: { lastReflectionAt: nowIso }
      })
    } catch (e) {
      await db.collection('settings').doc('global').set({
        data: { lastReflectionAt: nowIso }
      }).catch(() => {})
    }

    return {
      success: true,
      reflectionId: addRes._id,
      report: {
        _id: addRes._id,
        ...reportDoc
      }
    }
  } finally {
    reflectionRunning = false
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  const source = String(wxContext.SOURCE || '')
  const isInternalCall = !openid && (source === 'timer' || source === 'internal' || (event && event.Type === 'Timer'))

  const { action = 'list' } = event || {}

  if (!isInternalCall) {
    const caller = await getCaller(openid)
    if (!isApprovedAdmin(caller)) {
      return {
        success: false,
        error: '仅管理员可访问 AI 复盘与知识库演进功能',
        code: 'FORBIDDEN'
      }
    }
  }

  // ============================================================
  // action === 'run'：执行一次周期复盘
  // ============================================================
  if (action === 'run') {
    return await runReflectionCycle({
      manual: !isInternalCall,
      skipReplay: Boolean(event && event.skipReplay),
      triggeredBy: isInternalCall ? 'timer' : openid
    })
  }

  // ============================================================
  // action === 'list'：获取复盘报告列表 + 当前知识库状态
  // ============================================================
  if (action === 'list') {
    const limit = Math.min(30, Math.max(1, Number(event && event.limit) || 10))
    const [repRes, snapshot, logCountRes] = await Promise.all([
      db.collection('reflectionReports').orderBy('createdAt', 'desc').limit(limit).get(),
      loadKnowledgeSnapshot(),
      db.collection('reviewLogs').count()
    ])

    const list = (repRes.data || []).map(r => {
      const proposals = Array.isArray(r.proposals) ? r.proposals : []
      return {
        _id: r._id,
        createdAt: r.createdAt,
        createdAtIso: r.createdAtIso,
        triggeredBy: r.triggeredBy,
        knowledgeVersionAtRun: r.knowledgeVersionAtRun,
        stats: r.stats,
        clusterCount: Array.isArray(r.clusters) ? r.clusters.length : 0,
        proposalCount: proposals.length,
        pendingProposals: proposals.filter(p => p && p.status === 'pending').length,
        approvedProposals: proposals.filter(p => p && p.status === 'approved').length
      }
    })

    return {
      success: true,
      knowledgeOverview: {
        knowledgeVersion: snapshot.knowledgeVersion,
        activeProductsCount: snapshot.products.length,
        confusablesCount: snapshot.confusableProducts.length,
        learnedRulesCount: snapshot.learnedRules.length,
        reviewThresholds: snapshot.reviewThresholds,
        totalReviewLogs: logCountRes.total || 0,
        lastReflectionAt: (snapshot.settingsDoc && snapshot.settingsDoc.lastReflectionAt) || null
      },
      list
    }
  }

  // ============================================================
  // action === 'get'：获取单份复盘报告详情
  // ============================================================
  if (action === 'get') {
    const reflectionId = event && event.reflectionId
    if (!reflectionId) {
      return { success: false, error: '缺少 reflectionId' }
    }
    try {
      const res = await db.collection('reflectionReports').doc(reflectionId).get()
      if (!res.data) return { success: false, error: '复盘报告不存在' }
      return { success: true, report: res.data }
    } catch (e) {
      return { success: false, error: '复盘报告不存在' }
    }
  }

  // ============================================================
  // action === 'decide'：审批单条提案（approve / reject）
  // ============================================================
  if (action === 'decide') {
    const { reflectionId, proposalId, decision, payloadOverride } = event || {}
    if (!reflectionId || !proposalId || !['approve', 'reject'].includes(decision)) {
      return { success: false, error: '参数不完整（需提供 reflectionId、proposalId 与 decision）' }
    }

    let refDoc
    try {
      const res = await db.collection('reflectionReports').doc(reflectionId).get()
      refDoc = res && res.data
    } catch (_) {}
    if (!refDoc) {
      return { success: false, error: '复盘报告不存在' }
    }

    const proposals = Array.isArray(refDoc.proposals) ? [...refDoc.proposals] : []
    const idx = proposals.findIndex(p => p && p.proposalId === proposalId)
    if (idx === -1) {
      return { success: false, error: '未找到对应的提案' }
    }
    const targetProposal = { ...proposals[idx] }
    if (targetProposal.status === 'approved') {
      return { success: false, error: '该提案已采纳，请勿重复操作' }
    }

    const caller = await getCaller(openid)
    const adminName = String((caller && (caller.nickName || caller.name)) || '管理员').trim()

    if (decision === 'reject') {
      targetProposal.status = 'rejected'
      targetProposal.decidedAt = new Date().toISOString()
      targetProposal.decidedByName = adminName
      proposals[idx] = targetProposal
      await db.collection('reflectionReports').doc(reflectionId).update({
        data: { proposals }
      })
      return { success: true, proposal: targetProposal }
    }

    // decision === 'approve'
    if (payloadOverride && typeof payloadOverride === 'object') {
      targetProposal.payload = { ...(targetProposal.payload || {}), ...payloadOverride }
    }

    const applyRes = await applyProposal(targetProposal, {
      openid,
      adminName,
      reflectionId
    })
    if (!applyRes.ok) {
      return { success: false, error: applyRes.error || '应用提案失败' }
    }

    targetProposal.status = 'approved'
    targetProposal.changeId = applyRes.changeId
    targetProposal.appliedKnowledgeVersion = applyRes.knowledgeVersion
    targetProposal.decidedAt = new Date().toISOString()
    targetProposal.decidedByName = adminName
    proposals[idx] = targetProposal

    await db.collection('reflectionReports').doc(reflectionId).update({
      data: { proposals }
    })

    return {
      success: true,
      proposal: targetProposal,
      changeId: applyRes.changeId,
      knowledgeVersion: applyRes.knowledgeVersion
    }
  }

  // ============================================================
  // action === 'undo'：一键撤销已应用的知识库变更
  // ============================================================
  if (action === 'undo') {
    const changeId = event && event.changeId
    const caller = await getCaller(openid)
    const adminName = String((caller && (caller.nickName || caller.name)) || '管理员').trim()
    const res = await undoKnowledgeChange(changeId, { openid, adminName })
    if (!res.ok) {
      return { success: false, error: res.error }
    }
    return {
      success: true,
      knowledgeVersion: res.knowledgeVersion
    }
  }

  // ============================================================
  // action === 'changes'：查询知识库变更审计记录
  // ============================================================
  if (action === 'changes') {
    const limit = Math.min(50, Math.max(1, Number(event && event.limit) || 20))
    const res = await db.collection('knowledgeChanges')
      .orderBy('appliedAt', 'desc')
      .limit(limit)
      .get()
    return {
      success: true,
      list: res.data || []
    }
  }

  return { success: false, error: `未知 action: ${action}` }
}
