'use strict'

// ============================================================
// 定期 AI 复盘 · 第一阶段：确定性统计与聚类（纯函数模块，不调 AI）
// - computeReflectionStats(reviewLogs)
// - buildErrorClusters(reviewLogs, options)
// - computeProposalEffectTracking(allReviewLogs, appliedChanges)
// ============================================================

const { round1 } = require('../analyzeImage/scoring')

/**
 * 对同一 inspectionId 的多次修订只取最新一条（revision 最大）参与统计，防止同一条记录反复编辑导致样本重复放大
 */
function deduplicateLatestLogs(reviewLogs = []) {
  const byInsp = new Map()
  ;(Array.isArray(reviewLogs) ? reviewLogs : []).forEach(log => {
    if (!log || !log.inspectionId) return
    const key = String(log.inspectionId)
    const prev = byInsp.get(key)
    const curRev = Number(log.revision) || 0
    const prevRev = prev ? (Number(prev.revision) || 0) : -1
    if (!prev || curRev >= prevRev) {
      byInsp.set(key, log)
    }
  })
  return Array.from(byInsp.values())
}

/**
 * 基于周期内的 reviewLogs 计算确定性指标：
 * - 复核总量、确认无误数、人工校正数、校正率
 * - 误认 Top（实际是 X 却被认成我方 Y）
 * - 漏认 Top（我方各 SKU 被漏次数 + 原因分布）
 * - 排面数平均绝对误差（MAE）与高估/低估倾向
 * - 细项（黄金位/正标/价签/横签）修改率
 * - 置信度校准表（高/中/低置信及高置信抽检的实际错误率）
 * - 按照片画质、取景类型切分的错误率
 */
function computeReflectionStats(rawLogs = []) {
  const logs = deduplicateLatestLogs(rawLogs)
  let confirmedCount = 0
  let correctedCount = 0

  const falseOwnMap = new Map() // key: `${actualProduct||未知竞品} -> ${sku}`
  const missedOwnMap = new Map() // key: sku
  const wrongSkuMap = new Map() // key: `${aiValue} -> ${humanValue}`
  const changeTypeCounts = {
    false_own: 0,
    missed_own: 0,
    own_as_competitor: 0,
    wrong_sku: 0,
    facing_count: 0,
    golden: 0,
    label: 0,
    price_tag: 0,
    banner: 0,
    presence: 0
  }

  let facingAbsDiffSum = 0
  let facingSignedDiffSum = 0
  let facingSampleCount = 0

  const byConfidenceLevel = {
    low: { total: 0, corrected: 0, errorRate: null },
    mid: { total: 0, corrected: 0, errorRate: null },
    high: { total: 0, corrected: 0, errorRate: null },
    spotCheckHigh: { total: 0, corrected: 0, errorRate: null }
  }

  const byImageQuality = {
    good: { total: 0, corrected: 0, errorRate: null },
    fair: { total: 0, corrected: 0, errorRate: null },
    poor: { total: 0, corrected: 0, errorRate: null }
  }

  const byFramingType = {
    panorama: { total: 0, corrected: 0, errorRate: null },
    closeup: { total: 0, corrected: 0, errorRate: null }
  }

  for (const log of logs) {
    const isCorrected = log.action === 'correct' && Array.isArray(log.changes) && log.changes.length > 0
    if (isCorrected) correctedCount++
    else confirmedCount++

    const meta = (log.aiMeta && typeof log.aiMeta === 'object') ? log.aiMeta : {}
    const level = ['low', 'mid', 'high'].includes(meta.reviewLevel) ? meta.reviewLevel : 'mid'
    byConfidenceLevel[level].total++
    if (isCorrected) byConfidenceLevel[level].corrected++

    if (level === 'high' && meta.spotCheck === true) {
      byConfidenceLevel.spotCheckHigh.total++
      if (isCorrected) byConfidenceLevel.spotCheckHigh.corrected++
    }

    const iq = ['good', 'fair', 'poor'].includes(meta.imageQuality) ? meta.imageQuality : 'good'
    byImageQuality[iq].total++
    if (isCorrected) byImageQuality[iq].corrected++

    const ft = meta.framingType === 'closeup' ? 'closeup' : 'panorama'
    byFramingType[ft].total++
    if (isCorrected) byFramingType[ft].corrected++

    // 排面总误差（按整单我方总排面对比）
    const beforeOwnTotal = Array.isArray(log.beforeFacts && log.beforeFacts.ownProducts)
      ? log.beforeFacts.ownProducts.reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
      : null
    const afterOwnTotal = Array.isArray(log.afterFacts && log.afterFacts.ownProducts)
      ? log.afterFacts.ownProducts.reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
      : null
    if (beforeOwnTotal !== null && afterOwnTotal !== null) {
      facingAbsDiffSum += Math.abs(afterOwnTotal - beforeOwnTotal)
      facingSignedDiffSum += (beforeOwnTotal - afterOwnTotal) // 正数表示 AI 高估
      facingSampleCount++
    }

    const changes = Array.isArray(log.changes) ? log.changes : []
    for (const ch of changes) {
      if (!ch || !ch.type) continue
      if (Object.prototype.hasOwnProperty.call(changeTypeCounts, ch.type)) {
        changeTypeCounts[ch.type]++
      }

      if (ch.type === 'false_own') {
        const actual = String(ch.actualProduct || '未注明竞品').trim()
        const sku = String(ch.sku || '我方产品').trim()
        const key = `${actual}|||${sku}`
        const prev = falseOwnMap.get(key) || {
          actualProduct: actual,
          recognizedAsSku: sku,
          productId: ch.productId || '',
          count: 0,
          reasons: {}
        }
        prev.count++
        const r = String(ch.reason || 'look_alike')
        prev.reasons[r] = (prev.reasons[r] || 0) + 1
        falseOwnMap.set(key, prev)
      } else if (ch.type === 'missed_own' || ch.type === 'own_as_competitor') {
        const sku = String(ch.sku || '我方产品').trim()
        const prev = missedOwnMap.get(sku) || {
          sku,
          productId: ch.productId || '',
          count: 0,
          reasons: {}
        }
        prev.count++
        const r = String(ch.reason || 'side_or_back_facing')
        prev.reasons[r] = (prev.reasons[r] || 0) + 1
        missedOwnMap.set(sku, prev)
      } else if (ch.type === 'wrong_sku') {
        const fromSku = String(ch.aiValue || '原品规').trim()
        const toSku = String(ch.humanValue || ch.sku || '正确品规').trim()
        const key = `${fromSku}|||${toSku}`
        const prev = wrongSkuMap.get(key) || {
          fromSku,
          toSku,
          productId: ch.productId || '',
          count: 0
        }
        prev.count++
        wrongSkuMap.set(key, prev)
      }
    }
  }

  const finalizeBucket = (b) => {
    b.errorRate = b.total > 0 ? round1((b.corrected / b.total) * 100) : null
  }
  Object.values(byConfidenceLevel).forEach(finalizeBucket)
  Object.values(byImageQuality).forEach(finalizeBucket)
  Object.values(byFramingType).forEach(finalizeBucket)

  const totalReviewed = logs.length
  const correctionRate = totalReviewed > 0 ? round1((correctedCount / totalReviewed) * 100) : null
  const facingMae = facingSampleCount > 0 ? round1(facingAbsDiffSum / facingSampleCount) : null
  const facingBias = facingSampleCount > 0 ? round1(facingSignedDiffSum / facingSampleCount) : null

  return {
    totalReviewed,
    confirmedCount,
    correctedCount,
    correctionRate,
    facingMae,
    facingBias,
    changeTypeCounts,
    topFalseOwn: Array.from(falseOwnMap.values()).sort((a, b) => b.count - a.count).slice(0, 10),
    topMissedOwn: Array.from(missedOwnMap.values()).sort((a, b) => b.count - a.count).slice(0, 10),
    topWrongSku: Array.from(wrongSkuMap.values()).sort((a, b) => b.count - a.count).slice(0, 10),
    byConfidenceLevel,
    byImageQuality,
    byFramingType
  }
}

/**
 * 将本期校正记录按 `(错误类型, 目标我方产品, 实际竞品/主要原因)` 聚类，供 AI 逐类深度归因
 * @param {Array} rawLogs
 * @param {object} options
 * @param {number} [options.minClusterSize=2] 最小成簇样本数（当总校正样本较少但管理员强制手动复盘时可降为 1）
 * @param {number} [options.maxClusters=6] 最多归因前 N 个高频簇
 */
function buildErrorClusters(rawLogs = [], options = {}) {
  const logs = deduplicateLatestLogs(rawLogs)
  const minClusterSize = Number.isFinite(Number(options.minClusterSize))
    ? Math.max(1, Math.round(Number(options.minClusterSize)))
    : 2
  const maxClusters = Number.isFinite(Number(options.maxClusters))
    ? Math.max(1, Math.min(12, Math.round(Number(options.maxClusters))))
    : 6

  const clusterMap = new Map()

  for (const log of logs) {
    if (!log || log.action !== 'correct' || !Array.isArray(log.changes)) continue
    for (const ch of log.changes) {
      if (!ch || !ch.type || ch.type === 'presence') continue
      let clusterKey = ''
      let title = ''

      if (ch.type === 'false_own') {
        const actual = String(ch.actualProduct || '其他酒水').trim()
        const sku = String(ch.sku || '我方产品').trim()
        clusterKey = `false_own:${sku}:${actual}`
        title = `「${actual}」被误认为我方「${sku}」`
      } else if (ch.type === 'missed_own' || ch.type === 'own_as_competitor') {
        const sku = String(ch.sku || '我方产品').trim()
        const reason = String(ch.reason || 'side_or_back_facing').trim()
        clusterKey = `missed_own:${sku}:${reason}`
        title = `我方「${sku}」漏识别（原因：${reason}）`
      } else if (ch.type === 'wrong_sku') {
        const fromSku = String(ch.aiValue || '原品规').trim()
        const toSku = String(ch.humanValue || ch.sku || '正确品规').trim()
        clusterKey = `wrong_sku:${fromSku}:${toSku}`
        title = `我方「${toSku}」被误判为同品牌「${fromSku}」`
      } else if (ch.type === 'facing_count') {
        const dir = (Number(ch.delta) || 0) < 0 ? 'overcount' : 'undercount'
        const reason = String(ch.reason || dir).trim()
        clusterKey = `facing_count:${dir}:${reason}`
        title = dir === 'overcount'
          ? `我方排面数高估（${reason}）`
          : `我方排面数漏数（${reason}）`
      } else if (ch.type === 'price_tag' || ch.type === 'banner') {
        clusterKey = `${ch.type}:${ch.aiValue}->${ch.humanValue}`
        const label = ch.type === 'price_tag' ? '价签规范' : '横签露出'
        title = `${label}档位误判（AI:${ch.aiValue} → 实际:${ch.humanValue}）`
      } else {
        continue
      }

      const existing = clusterMap.get(clusterKey) || {
        clusterKey,
        errorType: ch.type,
        title,
        productId: ch.productId || '',
        sku: ch.sku || '',
        actualProduct: ch.actualProduct || '',
        reason: ch.reason || '',
        count: 0,
        inspectionIds: [],
        logIds: [],
        samples: []
      }

      existing.count++
      if (log.inspectionId && !existing.inspectionIds.includes(log.inspectionId)) {
        existing.inspectionIds.push(log.inspectionId)
      }
      if (log._id && !existing.logIds.includes(log._id)) {
        existing.logIds.push(log._id)
      }
      if (existing.samples.length < 5) {
        existing.samples.push({
          logId: log._id || '',
          inspectionId: log.inspectionId,
          storeName: log.storeName || '',
          photoIndex: ch.photoIndex || 1,
          aiValue: ch.aiValue,
          humanValue: ch.humanValue,
          aiConfidence: ch.aiConfidence,
          reason: ch.reason || '',
          actualProduct: ch.actualProduct || '',
          imageQuality: (log.aiMeta && log.aiMeta.imageQuality) || 'good',
          framingType: (log.aiMeta && log.aiMeta.framingType) || 'panorama',
          note: log.note || ''
        })
      }

      clusterMap.set(clusterKey, existing)
    }
  }

  return Array.from(clusterMap.values())
    .filter(c => c.count >= minClusterSize)
    .sort((a, b) => b.count - a.count)
    .slice(0, maxClusters)
}

/**
 * 效果追踪：对比已采纳的知识库变更（knowledgeChanges）在采纳前后的目标错误发生率
 */
function computeProposalEffectTracking(allRawLogs = [], appliedChanges = []) {
  const logs = deduplicateLatestLogs(allRawLogs)
  const changes = (Array.isArray(appliedChanges) ? appliedChanges : []).filter(
    c => c && !c.undone && c.appliedAt
  )
  if (changes.length === 0 || logs.length === 0) return []

  const results = []
  for (const kc of changes) {
    const appliedMs = new Date(kc.appliedAt).getTime()
    if (!Number.isFinite(appliedMs)) continue

    const beforeLogs = []
    const afterLogs = []
    for (const log of logs) {
      const logMs = new Date(log.createdAt).getTime()
      if (!Number.isFinite(logMs)) continue
      if (logMs < appliedMs) beforeLogs.push(log)
      else afterLogs.push(log)
    }

    const matchTargetError = (log) => {
      if (!log || log.action !== 'correct' || !Array.isArray(log.changes)) return false
      return log.changes.some(ch => {
        if (!ch) return false
        if (kc.fixType === 'confusable_add' || kc.fixType === 'confusable_update') {
          const compName = String((kc.payload && kc.payload.competitorName) || '').trim().toLowerCase()
          return ch.type === 'false_own' && compName && String(ch.actualProduct || '').toLowerCase().includes(compName)
        }
        if (kc.fixType === 'product_confusion_notes' || kc.fixType === 'product_visual_features' || kc.fixType === 'ref_priority') {
          const pid = String((kc.target && kc.target.productId) || '')
          return pid && String(ch.productId || '') === pid
        }
        if (kc.fixType === 'learned_rule_add') {
          return ch.type === 'facing_count' || ch.type === 'price_tag' || ch.type === 'banner'
        }
        return false
      })
    }

    const beforeHits = beforeLogs.filter(matchTargetError).length
    const afterHits = afterLogs.filter(matchTargetError).length
    const beforeRate = beforeLogs.length > 0 ? round1((beforeHits / beforeLogs.length) * 100) : null
    const afterRate = afterLogs.length > 0 ? round1((afterHits / afterLogs.length) * 100) : null

    results.push({
      changeId: kc._id || '',
      fixType: kc.fixType,
      summary: kc.summary || kc.fixType,
      appliedAt: kc.appliedAt,
      beforeSampleCount: beforeLogs.length,
      beforeErrorHits: beforeHits,
      beforeErrorRate: beforeRate,
      afterSampleCount: afterLogs.length,
      afterErrorHits: afterHits,
      afterErrorRate: afterRate,
      improved: (beforeRate !== null && afterRate !== null) ? (afterRate < beforeRate) : null
    })
  }

  return results
}

module.exports = {
  deduplicateLatestLogs,
  computeReflectionStats,
  buildErrorClusters,
  computeProposalEffectTracking
}
