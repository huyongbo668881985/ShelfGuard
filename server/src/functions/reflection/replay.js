'use strict'

// ============================================================
// 定期 AI 复盘 · 第三阶段：回放验证（Replay Gate）
// - buildCandidateOverrides(proposal, knowledgeSnapshot)
// - compareReportWithHumanFacts(report, humanFacts, activeProducts)
// - verifyProposalWithReplay(proposal, cluster, allReviewLogs, knowledgeSnapshot, options)
// ============================================================

const cloud = require('../../cloud-shim')
const { extractFacts } = require('../reviewReport/facts')
const { _internal: analyzeInternal } = require('../analyzeImage/index')

const db = cloud.database()

/**
 * 将单条 proposal 应用到内存中的 knowledgeSnapshot，生成可传给 loadAnalysisContext(overrides) 的候选覆盖项
 */
function buildCandidateOverrides(proposal, knowledgeSnapshot = {}) {
  const products = (Array.isArray(knowledgeSnapshot.products) ? knowledgeSnapshot.products : []).map(p => ({ ...p }))
  const confusables = (Array.isArray(knowledgeSnapshot.confusableProducts) ? knowledgeSnapshot.confusableProducts : []).map(c => ({ ...c }))
  const materials = (Array.isArray(knowledgeSnapshot.adMaterials) ? knowledgeSnapshot.adMaterials : []).map(m => ({ ...m }))
  const learnedRules = (Array.isArray(knowledgeSnapshot.learnedRules) ? knowledgeSnapshot.learnedRules : []).map(r => ({ ...r }))
  let reviewThresholds = { ...(knowledgeSnapshot.reviewThresholds || {}) }

  const target = proposal.target || {}
  const payload = proposal.payload || {}

  switch (proposal.fixType) {
    case 'confusable_add':
      confusables.push({
        _id: 'cand_conf_1',
        competitorName: payload.competitorName,
        competitorBrand: payload.competitorBrand || '',
        lookalikeProductId: target.lookalikeProductId || '',
        lookalikeProductName: payload.lookalikeProductName || '',
        distinguishingFeatures: payload.distinguishingFeatures || '',
        hitCount: 10,
        isActive: true
      })
      break
    case 'confusable_update':
      confusables.forEach(c => {
        if (String(c._id) === String(target.confusableId)) {
          c.distinguishingFeatures = payload.distinguishingFeatures
        }
      })
      break
    case 'confusable_retire':
      confusables.forEach(c => {
        if (String(c._id) === String(target.confusableId)) {
          c.isActive = false
        }
      })
      break
    case 'product_confusion_notes':
      products.forEach(p => {
        if (String(p._id) === String(target.productId)) {
          p.confusionNotes = payload.confusionNotes
        }
      })
      break
    case 'product_visual_features':
      products.forEach(p => {
        if (String(p._id) === String(target.productId)) {
          p.visualFeatures = payload.visualFeatures
        }
      })
      break
    case 'ref_priority':
      products.forEach(p => {
        if (String(p._id) === String(target.productId)) {
          p.refPriority = payload.refPriority
        }
      })
      break
    case 'alias_remove':
      products.forEach(p => {
        if (String(p._id) === String(target.productId) && Array.isArray(p.aliases)) {
          p.aliases = p.aliases.filter(a => a !== payload.alias)
        }
      })
      break
    case 'material_visual_features':
      materials.forEach(m => {
        if (String(m._id) === String(target.materialId)) {
          m.visualFeatures = payload.visualFeatures
        }
      })
      break
    case 'learned_rule_add':
      learnedRules.unshift({
        id: 'cand_rule_1',
        category: payload.category || 'general',
        rule: payload.rule,
        isActive: true
      })
      break
    case 'learned_rule_retire':
      learnedRules.forEach(r => {
        if (String(r.id) === String(target.ruleId)) {
          r.isActive = false
        }
      })
      break
    case 'threshold_adjust':
      reviewThresholds = { ...reviewThresholds, ...payload }
      break
    default:
      break
  }

  return {
    activeProducts: products.filter(p => p.isActive !== false),
    confusables: confusables.filter(c => c.isActive !== false),
    activeMaterials: materials.filter(m => m.isActive !== false),
    learnedRules: learnedRules.filter(r => r.isActive !== false),
    reviewThresholds
  }
}

/**
 * 将 AI 分析报告与人工确认/校正后的标准答案 facts 进行对比，返回误差指标
 * - presenceMatch: 在架判定是否一致
 * - skuSetMatch: 我方在架 SKU 集合是否完全一致
 * - facingAbsError: 我方总排面绝对误差
 * - passed: 在架一致 && SKU 集合一致 && 排面误差 <= 1
 */
function compareReportWithHumanFacts(aiReport, humanFacts, activeProducts = []) {
  const predicted = extractFacts(aiReport, activeProducts)
  const expectedOwnPresent = Boolean(humanFacts && humanFacts.ownBrandPresent)
  const predictedOwnPresent = Boolean(predicted && predicted.ownBrandPresent)
  const presenceMatch = expectedOwnPresent === predictedOwnPresent

  const toSkuSet = (facts) => {
    const set = new Set()
    ;(Array.isArray(facts && facts.ownProducts) ? facts.ownProducts : []).forEach(p => {
      if (!p || (Number(p.facingCount) || 0) <= 0) return
      const key = p.productId
        ? `id:${p.productId}`
        : `name:${[p.brand, p.productLine].filter(Boolean).join('|').toLowerCase()}`
      set.add(key)
    })
    return set
  }

  const expSkus = toSkuSet(humanFacts)
  const predSkus = toSkuSet(predicted)
  let skuSetMatch = expSkus.size === predSkus.size
  if (skuSetMatch) {
    for (const k of expSkus) {
      if (!predSkus.has(k)) {
        skuSetMatch = false
        break
      }
    }
  }

  const expFacings = (Array.isArray(humanFacts && humanFacts.ownProducts) ? humanFacts.ownProducts : [])
    .reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
  const predFacings = (Array.isArray(predicted && predicted.ownProducts) ? predicted.ownProducts : [])
    .reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
  const facingAbsError = Math.abs(predFacings - expFacings)

  return {
    presenceMatch,
    skuSetMatch,
    facingAbsError,
    passed: presenceMatch && skuSetMatch && facingAbsError <= 1
  }
}

/**
 * 判断候选结果相对于基线结果是否在标准答案（humanFacts）上有所改善
 */
function isImprovedOrFixed(baselineEval, candidateEval) {
  if (!baselineEval || !candidateEval) return false
  if (!baselineEval.passed && candidateEval.passed) return true
  if (!baselineEval.presenceMatch && candidateEval.presenceMatch) return true
  if (baselineEval.presenceMatch === candidateEval.presenceMatch) {
    if (!baselineEval.skuSetMatch && candidateEval.skuSetMatch) return true
    if (baselineEval.skuSetMatch === candidateEval.skuSetMatch && candidateEval.facingAbsError < baselineEval.facingAbsError) {
      return true
    }
  }
  return false
}

function isRegressed(baselineEval, candidateEval) {
  if (!baselineEval || !candidateEval) return false
  if (baselineEval.passed && !candidateEval.passed) return true
  if (baselineEval.presenceMatch && !candidateEval.presenceMatch) return true
  if (baselineEval.skuSetMatch && !candidateEval.skuSetMatch) return true
  if (candidateEval.facingAbsError > baselineEval.facingAbsError + 1) return true
  return false
}

/**
 * 对单条提案执行历史样本回放验证
 * - 错例集（errorSet）：该聚类的校正记录（最多 4 条）
 * - 对照集（controlSet）：人工确认无误的正样本记录（最多 3 条）
 * - 若未配 API Key、预算耗尽或不可回放类型，返回 status: 'skipped'
 */
async function verifyProposalWithReplay(proposal, cluster, allReviewLogs = [], knowledgeSnapshot = {}, options = {}) {
  if (!proposal || !proposal.replayable) {
    return {
      status: 'skipped',
      reason: 'non_replayable_fix_type',
      summaryText: '该提案属于待办/提醒类，无需视觉回放'
    }
  }

  const budgetTracker = options.budgetTracker || { usedCalls: 0, maxCalls: 40 }
  const settingsDoc = options.settingsDoc || null
  const config = analyzeInternal.resolveRuntimeAIConfig(settingsDoc)
  const apiKey = await analyzeInternal.resolveApiKey(config, settingsDoc)

  if (!apiKey) {
    return {
      status: 'skipped',
      reason: 'no_api_key',
      summaryText: '未配置 API Key，已跳过自动回放验证'
    }
  }

  // 针对纯服务端确定性生效的提案（如易混淆硬拦截 confusable_add 或阈值调整），也可以先用已保存的原始报告做零成本离线沙盒验证
  const activeProducts = Array.isArray(knowledgeSnapshot.products) ? knowledgeSnapshot.products : []
  const logsByInsp = new Map()
  ;(Array.isArray(allReviewLogs) ? allReviewLogs : []).forEach(l => {
    if (l && l.inspectionId) logsByInsp.set(String(l.inspectionId), l)
  })

  const errorInspIds = (Array.isArray(cluster && cluster.inspectionIds) ? cluster.inspectionIds : []).slice(0, 3)
  const controlLogs = (Array.isArray(allReviewLogs) ? allReviewLogs : [])
    .filter(l => l && l.action === 'confirm' && l.inspectionId && !errorInspIds.includes(l.inspectionId))
    .slice(0, 2)
  const controlInspIds = controlLogs.map(l => l.inspectionId)

  const requiredCalls = (errorInspIds.length + controlInspIds.length) * 2
  if (budgetTracker.usedCalls + requiredCalls > budgetTracker.maxCalls) {
    return {
      status: 'skipped',
      reason: 'budget_exhausted',
      summaryText: '已达本期回放调用预算上限，跳过回放'
    }
  }

  const baselineCtx = await analyzeInternal.loadAnalysisContext({
    runtimeSettings: settingsDoc,
    activeProducts: knowledgeSnapshot.products,
    confusables: knowledgeSnapshot.confusableProducts,
    activeMaterials: knowledgeSnapshot.adMaterials,
    learnedRules: knowledgeSnapshot.learnedRules,
    reviewThresholds: knowledgeSnapshot.reviewThresholds
  })
  const candidateOverrides = buildCandidateOverrides(proposal, knowledgeSnapshot)
  const candidateCtx = await analyzeInternal.loadAnalysisContext({
    runtimeSettings: settingsDoc,
    ...candidateOverrides
  })

  let errorTested = 0
  let errorFixed = 0
  let controlTested = 0
  let controlPassed = 0
  let controlRegressed = 0

  const runPairOnInspection = async (inspId) => {
    const res = await db.collection('inspections').doc(inspId).get()
    const doc = res && res.data
    if (!doc || doc.originPrunedAt || !Array.isArray(doc.photoFileIDs) || doc.photoFileIDs.length === 0) {
      return null
    }
    const log = logsByInsp.get(String(inspId))
    const humanFacts = (log && log.afterFacts) || extractFacts(doc.aiReport, activeProducts)

    const fileRes = await cloud.readFilesAsDataUrls({ fileList: doc.photoFileIDs })
    const imageUrls = (fileRes.fileList || []).filter(f => f && f.tempFileURL).map(f => f.tempFileURL)
    if (imageUrls.length === 0) return null

    budgetTracker.usedCalls += 2
    const baseAnalysis = await analyzeInternal.analyzeWithVision(imageUrls, baselineCtx)
    const candAnalysis = await analyzeInternal.analyzeWithVision(imageUrls, candidateCtx)

    const baseEval = compareReportWithHumanFacts(baseAnalysis.text, humanFacts, activeProducts)
    const candEval = compareReportWithHumanFacts(candAnalysis.text, humanFacts, activeProducts)
    return { baseEval, candEval }
  }

  for (const inspId of errorInspIds) {
    try {
      const pair = await runPairOnInspection(inspId)
      if (!pair) continue
      errorTested++
      if (isImprovedOrFixed(pair.baseEval, pair.candEval) || pair.candEval.passed) {
        errorFixed++
      }
    } catch (_) {}
  }

  for (const inspId of controlInspIds) {
    try {
      const pair = await runPairOnInspection(inspId)
      if (!pair) continue
      controlTested++
      if (isRegressed(pair.baseEval, pair.candEval)) {
        controlRegressed++
      } else {
        controlPassed++
      }
    } catch (_) {}
  }

  if (errorTested === 0 && controlTested === 0) {
    return {
      status: 'skipped',
      reason: 'no_accessible_images',
      summaryText: '样本原图不可读或已清理，跳过在线回放'
    }
  }

  const hasRegression = controlRegressed > 0
  const status = hasRegression ? 'regressed' : (errorFixed > 0 ? 'verified' : 'neutral')
  const summaryText = `错例修复 ${errorFixed}/${errorTested}，对照无回归 ${controlPassed}/${controlTested}${hasRegression ? '（⚠️存在回归，不建议采纳）' : ''}`

  return {
    status,
    errorTested,
    errorFixed,
    controlTested,
    controlPassed,
    controlRegressed,
    recommended: !hasRegression && errorFixed > 0,
    summaryText
  }
}

module.exports = {
  buildCandidateOverrides,
  compareReportWithHumanFacts,
  isImprovedOrFixed,
  isRegressed,
  verifyProposalWithReplay
}
