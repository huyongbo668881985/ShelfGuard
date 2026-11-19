'use strict'

// ============================================================
// 新版 5 维陈列质量评分引擎（v2）
// - 纯函数模块：不依赖数据库或网络，供 analyzeImage / settings /
//   batchAnalyze / 黄金标杆评测脚本 / 单元测试共同复用。
// ============================================================

const DEFAULT_SCORING_RULES = Object.freeze({
  facingMaxScore: 50,
  facingTarget: 10,
  facingPointsPerUnit: 5,
  goldenPositionMaxScore: 20,
  labelOrientationMaxScore: 10,
  priceTagMaxScore: 10,
  horizontalBannerMaxScore: 10
})

/**
 * 校验并规范化评分规则配置（供 settings 保存时校验）
 * @param {object} raw
 * @returns {{ ok: boolean, rules?: object, error?: string }}
 */
function validateScoringRules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '评分规则配置格式不正确' }
  }

  const pickInt = (key, fallback) => {
    const val = raw[key] !== undefined ? Number(raw[key]) : fallback
    return Number.isFinite(val) ? Math.round(val) : NaN
  }

  const facingMaxScore = pickInt('facingMaxScore', DEFAULT_SCORING_RULES.facingMaxScore)
  const facingTarget = pickInt('facingTarget', DEFAULT_SCORING_RULES.facingTarget)
  const facingPointsPerUnit = raw.facingPointsPerUnit !== undefined
    ? Number(raw.facingPointsPerUnit)
    : (facingTarget > 0 ? Math.round((facingMaxScore / facingTarget) * 100) / 100 : DEFAULT_SCORING_RULES.facingPointsPerUnit)
  const goldenPositionMaxScore = pickInt('goldenPositionMaxScore', DEFAULT_SCORING_RULES.goldenPositionMaxScore)
  const labelOrientationMaxScore = pickInt('labelOrientationMaxScore', DEFAULT_SCORING_RULES.labelOrientationMaxScore)
  const priceTagMaxScore = pickInt('priceTagMaxScore', DEFAULT_SCORING_RULES.priceTagMaxScore)
  const horizontalBannerMaxScore = pickInt('horizontalBannerMaxScore', DEFAULT_SCORING_RULES.horizontalBannerMaxScore)

  const dims = [
    ['排面数量满分', facingMaxScore],
    ['黄金位置满分', goldenPositionMaxScore],
    ['正标朝向满分', labelOrientationMaxScore],
    ['价签规范满分', priceTagMaxScore],
    ['横签露出满分', horizontalBannerMaxScore]
  ]
  for (const [label, v] of dims) {
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      return { ok: false, error: `${label}需为 0-100 的整数` }
    }
  }
  const sum = facingMaxScore + goldenPositionMaxScore + labelOrientationMaxScore + priceTagMaxScore + horizontalBannerMaxScore
  if (sum !== 100) {
    return { ok: false, error: `5 个维度满分合计必须等于 100 分（当前为 ${sum} 分）` }
  }
  if (!Number.isFinite(facingTarget) || facingTarget < 1 || facingTarget > 100) {
    return { ok: false, error: '排面满分目标数需在 1-100 之间' }
  }
  if (!Number.isFinite(facingPointsPerUnit) || facingPointsPerUnit <= 0 || facingPointsPerUnit > 100) {
    return { ok: false, error: '单排面分值需大于 0' }
  }

  return {
    ok: true,
    rules: {
      facingMaxScore,
      facingTarget,
      facingPointsPerUnit,
      goldenPositionMaxScore,
      labelOrientationMaxScore,
      priceTagMaxScore,
      horizontalBannerMaxScore
    }
  }
}

/**
 * 读取配置时使用：合法则采用，非法或缺省则回退默认值
 */
function normalizeScoringRules(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SCORING_RULES }
  const res = validateScoringRules(raw)
  return res.ok ? res.rules : { ...DEFAULT_SCORING_RULES }
}

/**
 * 根据得分率统一派生维度状态：good / medium / poor
 */
function deriveDimensionStatus(score, maxScore) {
  if (!Number.isFinite(maxScore) || maxScore <= 0) return 'good'
  const ratio = Number(score) / maxScore
  if (ratio >= 0.8) return 'good'
  if (ratio >= 0.6) return 'medium'
  return 'poor'
}

/**
 * 根据总分（0-100）统一派生等级
 */
function deriveScoreLevel(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return ''
  const s = Number(score)
  if (s >= 90) return '卓越'
  if (s >= 80) return '优秀'
  if (s >= 70) return '良好'
  if (s >= 60) return '一般'
  if (s >= 40) return '较差'
  return '不合格'
}

/**
 * 裁剪连续分数到 [0, maxScore] 的整数
 */
function clampIntScore(rawVal, maxScore) {
  const n = Number(rawVal)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= maxScore) return Math.round(maxScore)
  return Math.round(n)
}

/**
 * 三档分值规范化（价签 / 横签）：0 / 中档(maxScore/2) / 满分(maxScore)
 * 默认 0 / 5 / 10
 */
function snapThreeTierScore(rawVal, maxScore) {
  const max = Math.max(0, Math.round(Number(maxScore) || 0))
  if (max === 0) return 0
  const mid = Math.round(max / 2)
  const n = Number(rawVal)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= max * 0.75) return max
  if (n >= max * 0.25) return mid
  return 0
}

/**
 * 计算排面数量得分：min(facingMaxScore, ownFacingCount * facingPointsPerUnit)
 */
function computeFacingScore(ownFacingCount, rules) {
  const r = normalizeScoringRules(rules)
  const count = Math.max(0, Math.floor(Number(ownFacingCount) || 0))
  if (count >= r.facingTarget) return r.facingMaxScore
  return Math.min(r.facingMaxScore, Math.round(count * r.facingPointsPerUnit))
}

function round1(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null
  return Math.round(Number(n) * 10) / 10
}

/**
 * 规范化照片质量枚举：good | fair | poor
 */
function normalizeImageQuality(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return 'good'
  if (s === 'poor' || s === 'bad' || s === 'low' || /差|模糊|过暗|反光|不清/.test(s)) return 'poor'
  if (s === 'fair' || s === 'medium' || s === 'normal' || /一般|中等|尚可/.test(s)) return 'fair'
  return 'good'
}

/**
 * 规范化取景类型枚举：panorama | closeup | non_shelf
 */
function normalizeFramingType(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return 'panorama'
  if (s === 'non_shelf' || s === 'nonshelf' || s === 'none' || /非货架|门头|纯物料/.test(s)) return 'non_shelf'
  if (s === 'closeup' || s === 'close_up' || s === 'partial' || s === 'local' || /局部|特写|近景/.test(s)) return 'closeup'
  return 'panorama'
}

/**
 * 判断物料是否为需要作为参考图喂给 AI 的「横签」
 */
function isHorizontalBannerMaterial(m) {
  if (!m || typeof m !== 'object') return false
  if (m.isActive === false) return false
  if (!m.photo || typeof m.photo !== 'string' || !m.photo.trim()) return false
  if (String(m.category || '').trim() === '横签') return true
  if (/横签/.test(String(m.materialName || ''))) return true
  if (Array.isArray(m.aliases) && m.aliases.some(a => /横签/.test(String(a || '')))) return true
  return false
}

/**
 * 从启用的物料库中筛选最多 maxRefs 张带参考图的横签物料
 */
function selectHorizontalBannerRefs(activeMaterials = [], maxRefs = 3) {
  if (!Array.isArray(activeMaterials)) return []
  return activeMaterials.filter(isHorizontalBannerMaterial).slice(0, Math.max(0, maxRefs))
}

/**
 * 规范化广告物料识别结果（按物料库别名归一化为标准名称）
 */
function normalizeAdMaterials(rawList, activeMaterials = []) {
  if (!Array.isArray(rawList)) return []
  const byAlias = new Map()
  ;(activeMaterials || []).forEach(m => {
    if (!m || !m.materialName) return
    const std = String(m.materialName).trim()
    if (!std) return
    byAlias.set(std.toLowerCase(), m)
    if (Array.isArray(m.aliases)) {
      m.aliases.forEach(a => {
        const k = String(a || '').trim().toLowerCase()
        if (k) byAlias.set(k, m)
      })
    }
  })

  const merged = new Map()
  rawList.forEach(item => {
    if (!item) return
    const rawName = String(item.name || item.materialName || '').trim()
    if (!rawName) return
    const matched = byAlias.get(rawName.toLowerCase())
    const canonicalName = matched ? String(matched.materialName).trim() : rawName
    const category = (matched && matched.category) || String(item.category || '其他').trim() || '其他'
    const count = Math.max(1, parseInt(item.count, 10) || 1)
    const condition = String(item.condition || '完好').trim() || '完好'
    const isOwn = matched ? true : (item.isOwn !== false)

    const existing = merged.get(canonicalName)
    if (existing) {
      existing.count = Math.max(existing.count, count)
    } else {
      merged.set(canonicalName, {
        name: canonicalName,
        category,
        isOwn,
        count,
        condition,
        position: String(item.position || '').trim(),
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.9
      })
    }
  })

  return Array.from(merged.values())
}

/**
 * 判断产品项是否属于我方品牌
 */
function isOwnBrandProduct(productItem, ownBrandNameSet) {
  if (!productItem || typeof productItem !== 'object') return false
  if (productItem.isOwn === true) return true
  if (productItem.isOwn === false) return false
  if (ownBrandNameSet && ownBrandNameSet.size > 0) {
    const brand = String(productItem.brand || '').trim().toLowerCase()
    if (brand && ownBrandNameSet.has(brand)) return true
  }
  return false
}

/**
 * 推断整次拜访是否包含货架/堆头陈列照
 */
function inferHasShelfPhoto(result, framingType) {
  if (typeof result.hasShelfPhoto === 'boolean') return result.hasShelfPhoto
  if (result.metadata && typeof result.metadata.hasShelfPhoto === 'boolean') {
    return result.metadata.hasShelfPhoto
  }
  if (framingType === 'non_shelf') return false
  const roles = result.metadata && Array.isArray(result.metadata.photoRoles)
    ? result.metadata.photoRoles
    : []
  if (roles.length > 0) {
    const hasShelfRole = roles.some(r => /货架|陈列|堆头/.test(String(r || '')))
    if (!hasShelfRole) return false
  }
  return true
}

/**
 * 服务端强校验与派生：规范化新版 5 维 AI 分析报告
 * @param {object} rawResult       AI JSON.parse 后的对象
 * @param {string} rawResponse     AI 原始响应文本
 * @param {object} options
 * @param {Array}  options.activeMaterials  启用中的广告物料库
 * @param {object} options.scoringRules     评分规则配置（缺省用默认）
 * @param {Set<string>} options.ownBrandNames 我方品牌名/别名集合（小写）
 */
function validateAndNormalizeReport(rawResult, rawResponse, options = {}) {
  const result = rawResult && typeof rawResult === 'object' ? { ...rawResult } : {}
  const activeMaterials = options.activeMaterials || []
  const rules = normalizeScoringRules(options.scoringRules)
  const ownBrandNameSet = options.ownBrandNames instanceof Set
    ? options.ownBrandNames
    : new Set((options.ownBrandNames || []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean))

  // 基础数组 / 对象兜底
  result.productIdentification = Array.isArray(result.productIdentification) ? result.productIdentification : []
  result.adMaterials = normalizeAdMaterials(result.adMaterials, activeMaterials)
  result.issues = Array.isArray(result.issues) ? result.issues : []
  result.suggestions = Array.isArray(result.suggestions) ? result.suggestions : []
  if (!result.competitiveAnalysis || typeof result.competitiveAnalysis !== 'object') {
    result.competitiveAnalysis = {}
  }
  if (!Array.isArray(result.competitiveAnalysis.brands)) {
    result.competitiveAnalysis.brands = []
  }
  if (!result.metadata || typeof result.metadata !== 'object') {
    result.metadata = {}
  }
  if (!Array.isArray(result.metadata.photoRoles)) {
    result.metadata.photoRoles = []
  }

  // 照片质量与取景类型规范化
  const imageQuality = normalizeImageQuality(result.metadata.imageQuality)
  const framingType = normalizeFramingType(result.metadata.framingType)
  result.metadata.imageQuality = imageQuality
  result.metadata.framingType = framingType
  if (result.metadata.imageQualityReason != null) {
    result.metadata.imageQualityReason = String(result.metadata.imageQualityReason).trim()
  }

  const hasShelfPhoto = inferHasShelfPhoto(result, framingType)
  result.hasShelfPhoto = hasShelfPhoto
  result.scoringVersion = 'v2'
  result.scoringRulesUsed = { ...rules }

  // 标注产品识别中的 isOwn
  const hasBrandLib = ownBrandNameSet.size > 0
  result.productIdentification = result.productIdentification.map(p => {
    if (!p || typeof p !== 'object') return p
    const fc = Number(p.facingCount)
    const normalizedFc = Number.isFinite(fc) && fc >= 0 ? Math.round(fc) : 0
    const isOwn = isOwnBrandProduct(p, ownBrandNameSet)
    return {
      ...p,
      facingCount: normalizedFc,
      isOwn: p.isOwn !== undefined ? Boolean(p.isOwn) : (hasBrandLib ? isOwn : undefined)
    }
  })

  // 情况 A：整次拜访无货架照（仅门头照/纯物料照）
  if (!hasShelfPhoto) {
    result.ownBrandPresent = null
    result.score = null
    result.scoreLevel = '无货架照'
    result.displayCompliance = {}
    result.facingMetrics = {
      ownFacingCount: null,
      ownSkuCount: null,
      totalShelfFacingCount: null,
      ownFacingShare: null,
      countingConfidence: null
    }
    if (!result.summary) {
      result.summary = '本次拜访未拍摄货架陈列照（仅门头或广告物料照），不计入陈列评分。'
    }
    result.rawResponse = rawResponse
    return result
  }

  // 提取排面指标（优先模型 facingMetrics，缺失则从 productIdentification / competitiveAnalysis 推导）
  const rawFm = (result.facingMetrics && typeof result.facingMetrics === 'object') ? result.facingMetrics : {}
  const rawDc = (result.displayCompliance && typeof result.displayCompliance === 'object') ? result.displayCompliance : {}

  const ownProducts = result.productIdentification.filter(p => {
    if (!p) return false
    if (p.isOwn === true) return true
    if (hasBrandLib) return isOwnBrandProduct(p, ownBrandNameSet)
    return false
  })
  const ownFacingFromProducts = ownProducts.reduce((sum, p) => sum + (Number(p.facingCount) || 0), 0)
  const totalFacingFromProducts = result.productIdentification.reduce((sum, p) => sum + (Number(p.facingCount) || 0), 0)

  let ownFacingCount = null
  if (rawFm.ownFacingCount !== undefined && rawFm.ownFacingCount !== null && rawFm.ownFacingCount !== '') {
    const n = Number(rawFm.ownFacingCount)
    if (Number.isFinite(n) && n >= 0) ownFacingCount = Math.round(n)
  }
  if (ownFacingCount === null && rawDc.facingCount && rawDc.facingCount.observedFacings != null) {
    const n = Number(rawDc.facingCount.observedFacings)
    if (Number.isFinite(n) && n >= 0) ownFacingCount = Math.round(n)
  }
  if (ownFacingCount === null) {
    ownFacingCount = ownFacingFromProducts
  }

  let ownSkuCount = null
  if (rawFm.ownSkuCount !== undefined && rawFm.ownSkuCount !== null && rawFm.ownSkuCount !== '') {
    const n = Number(rawFm.ownSkuCount)
    if (Number.isFinite(n) && n >= 0) ownSkuCount = Math.round(n)
  }
  if (ownSkuCount === null) {
    const skuKeys = new Set(
      ownProducts
        .filter(p => (Number(p.facingCount) || 0) > 0)
        .map(p => `${String(p.brand || '').trim()}|${String(p.productLine || '').trim()}`)
    )
    ownSkuCount = skuKeys.size
  }

  let totalShelfFacingCount = null
  if (rawFm.totalShelfFacingCount !== undefined && rawFm.totalShelfFacingCount !== null && rawFm.totalShelfFacingCount !== '') {
    const n = Number(rawFm.totalShelfFacingCount)
    if (Number.isFinite(n) && n >= 0) totalShelfFacingCount = Math.round(n)
  }
  if (totalShelfFacingCount === null && totalFacingFromProducts > 0) {
    totalShelfFacingCount = totalFacingFromProducts
  }
  if (totalShelfFacingCount !== null && ownFacingCount > totalShelfFacingCount) {
    totalShelfFacingCount = ownFacingCount
  }

  let ownFacingShare = null
  if (rawFm.ownFacingShare !== undefined && rawFm.ownFacingShare !== null && rawFm.ownFacingShare !== '') {
    const n = Number(rawFm.ownFacingShare)
    if (Number.isFinite(n) && n >= 0 && n <= 100) ownFacingShare = round1(n)
  }
  if (ownFacingShare === null && totalShelfFacingCount > 0) {
    ownFacingShare = round1(Math.min(100, (ownFacingCount / totalShelfFacingCount) * 100))
  }
  if (ownFacingShare === null && result.competitiveAnalysis.brands.length > 0) {
    const ownBrandEntry = result.competitiveAnalysis.brands.find(b =>
      b && (b.isOwn === true || b.brand === '我方品牌' || (hasBrandLib && ownBrandNameSet.has(String(b.brand || '').trim().toLowerCase())))
    )
    if (ownBrandEntry && ownBrandEntry.sharePercent != null) {
      const n = Number(ownBrandEntry.sharePercent)
      if (Number.isFinite(n) && n >= 0 && n <= 100) ownFacingShare = round1(n)
    }
  }

  let countingConfidence = null
  if (rawFm.countingConfidence !== undefined && rawFm.countingConfidence !== null && rawFm.countingConfidence !== '') {
    const n = Number(rawFm.countingConfidence)
    if (Number.isFinite(n)) {
      countingConfidence = Math.round(Math.max(0, Math.min(1, n)) * 100) / 100
    }
  }
  if (countingConfidence === null) {
    countingConfidence = imageQuality === 'poor' ? 0.5 : (imageQuality === 'fair' ? 0.75 : 0.85)
  }

  // 判断我方品牌是否在架（ownBrandPresent）
  let ownBrandPresent
  if (typeof result.ownBrandPresent === 'boolean') {
    ownBrandPresent = result.ownBrandPresent
  } else {
    ownBrandPresent = ownFacingCount > 0 || ownProducts.length > 0
  }
  // 如果模型明确标了 ownFacingCount === 0 且没有识别出任何我方产品，则视为未上柜
  if (ownBrandPresent && ownFacingCount === 0 && ownProducts.length === 0) {
    ownBrandPresent = false
  }
  result.ownBrandPresent = ownBrandPresent

  // 情况 B：拍了货架照但全图无我方品牌 → 未上柜，score = null，不计入均分
  if (!ownBrandPresent) {
    result.score = null
    result.scoreLevel = '未上柜'
    result.displayCompliance = {}
    result.facingMetrics = {
      ownFacingCount: 0,
      ownSkuCount: 0,
      totalShelfFacingCount,
      ownFacingShare: 0,
      countingConfidence
    }
    if (!result.summary) {
      result.summary = '货架陈列照片中未发现我方品牌产品（未上柜），请及时跟进铺货上柜。'
    }
    result.rawResponse = rawResponse
    return result
  }

  // 情况 C：有货架照且有我方品牌 → 服务端严格按 5 维规则校验与重算
  const facingScore = computeFacingScore(ownFacingCount, rules)
  const goldenRaw = rawDc.goldenPosition && rawDc.goldenPosition.score
  const goldenScore = clampIntScore(goldenRaw, rules.goldenPositionMaxScore)

  const labelRaw = rawDc.labelOrientation && rawDc.labelOrientation.score
  const labelScore = clampIntScore(labelRaw, rules.labelOrientationMaxScore)

  // 兼容 priceTag / priceTagMatch 键名
  const rawPriceTag = rawDc.priceTag || rawDc.priceTagMatch || {}
  const priceTagScore = snapThreeTierScore(rawPriceTag.score, rules.priceTagMaxScore)

  const rawBanner = rawDc.horizontalBanner || {}
  const bannerScore = snapThreeTierScore(rawBanner.score, rules.horizontalBannerMaxScore)

  const normalizedDc = {
    facingCount: {
      score: facingScore,
      maxScore: rules.facingMaxScore,
      observedFacings: ownFacingCount,
      status: deriveDimensionStatus(facingScore, rules.facingMaxScore),
      detail: String((rawDc.facingCount && rawDc.facingCount.detail) || `识别到我方正面可见排面 ${ownFacingCount} 个，按标准折算 ${facingScore}/${rules.facingMaxScore} 分`).trim()
    },
    goldenPosition: {
      score: goldenScore,
      maxScore: rules.goldenPositionMaxScore,
      status: deriveDimensionStatus(goldenScore, rules.goldenPositionMaxScore),
      detail: String((rawDc.goldenPosition && rawDc.goldenPosition.detail) || '').trim()
    },
    labelOrientation: {
      score: labelScore,
      maxScore: rules.labelOrientationMaxScore,
      status: deriveDimensionStatus(labelScore, rules.labelOrientationMaxScore),
      detail: String((rawDc.labelOrientation && rawDc.labelOrientation.detail) || '').trim()
    },
    priceTag: {
      score: priceTagScore,
      maxScore: rules.priceTagMaxScore,
      status: deriveDimensionStatus(priceTagScore, rules.priceTagMaxScore),
      detail: String(rawPriceTag.detail || '').trim()
    },
    horizontalBanner: {
      score: bannerScore,
      maxScore: rules.horizontalBannerMaxScore,
      status: deriveDimensionStatus(bannerScore, rules.horizontalBannerMaxScore),
      detail: String(rawBanner.detail || '').trim()
    }
  }

  const totalScore = Math.max(
    0,
    Math.min(
      100,
      facingScore + goldenScore + labelScore + priceTagScore + bannerScore
    )
  )

  result.displayCompliance = normalizedDc
  result.score = totalScore
  result.scoreLevel = deriveScoreLevel(totalScore)
  result.facingMetrics = {
    ownFacingCount,
    ownSkuCount: Math.max(ownSkuCount, ownFacingCount > 0 ? 1 : 0),
    totalShelfFacingCount,
    ownFacingShare,
    countingConfidence
  }
  result.rawResponse = rawResponse

  return result
}

/**
 * 从单条 aiReport（兼容新旧版本）提取排面数量、品规数、排面占比与在架状态
 */
function extractFacingSummary(aiReport, ownBrandNameSet) {
  if (!aiReport || typeof aiReport !== 'object' || (aiReport.metadata && aiReport.metadata.parseError)) {
    return {
      ownFacingCount: null,
      ownSkuCount: null,
      ownFacingShare: null,
      countingConfidence: null,
      ownBrandPresent: null,
      hasShelfPhoto: null
    }
  }
  const hasShelfPhoto = typeof aiReport.hasShelfPhoto === 'boolean'
    ? aiReport.hasShelfPhoto
    : (aiReport.scoreLevel === '无货架照' ? false : true)

  if (!hasShelfPhoto) {
    return {
      ownFacingCount: null,
      ownSkuCount: null,
      ownFacingShare: null,
      countingConfidence: null,
      ownBrandPresent: null,
      hasShelfPhoto: false
    }
  }

  const ownBrandPresent = typeof aiReport.ownBrandPresent === 'boolean'
    ? aiReport.ownBrandPresent
    : (aiReport.scoreLevel === '未上柜' ? false : true)

  const fm = aiReport.facingMetrics && typeof aiReport.facingMetrics === 'object' ? aiReport.facingMetrics : null
  const parseStrictNum = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v.trim())
      return Number.isFinite(n) ? n : null
    }
    return null
  }
  const rawOwnFacing = fm ? parseStrictNum(fm.ownFacingCount) : null
  let ownFacingCount = rawOwnFacing !== null && rawOwnFacing >= 0 ? Math.round(rawOwnFacing) : null
  const rawOwnSku = fm ? parseStrictNum(fm.ownSkuCount) : null
  let ownSkuCount = rawOwnSku !== null && rawOwnSku >= 0 ? Math.round(rawOwnSku) : null
  const rawOwnShare = fm ? parseStrictNum(fm.ownFacingShare) : null
  let ownFacingShare = rawOwnShare !== null && rawOwnShare >= 0 && rawOwnShare <= 100 ? round1(rawOwnShare) : null
  const rawConf = fm ? parseStrictNum(fm.countingConfidence) : null
  const countingConfidence = rawConf !== null ? rawConf : null

  // 兼容旧版：尝试从 productIdentification 推导
  if (ownFacingCount === null && Array.isArray(aiReport.productIdentification) && ownBrandNameSet && ownBrandNameSet.size > 0) {
    let own = 0
    let total = 0
    const skus = new Set()
    aiReport.productIdentification.forEach(p => {
      const fc = Number(p && p.facingCount)
      if (!Number.isFinite(fc) || fc <= 0) return
      total += fc
      if (isOwnBrandProduct(p, ownBrandNameSet)) {
        own += fc
        skus.add(`${String(p.brand || '').trim()}|${String(p.productLine || '').trim()}`)
      }
    })
    if (own > 0) {
      ownFacingCount = Math.round(own)
      if (ownSkuCount === null) ownSkuCount = skus.size
      if (ownFacingShare === null && total > 0) ownFacingShare = round1((own / total) * 100)
    }
  }

  return {
    ownFacingCount,
    ownSkuCount,
    ownFacingShare,
    countingConfidence,
    ownBrandPresent,
    hasShelfPhoto: true
  }
}

/**
 * 基于已完成的单条结构化分析结果，确定性汇总当日大盘指标（供日报生成与合并使用）
 * 绝不造 80 假分；未上柜（score=null）与无货架照（score=null）均不参与陈列均分计算。
 */
function aggregateDailyMetrics(inspections = []) {
  let totalPhotos = 0
  let scoreSum = 0
  let scoredStoresCount = 0
  let goodStoresCount = 0
  let needImprovementCount = 0
  let shelfPhotoStores = 0
  let ownBrandPresentStores = 0
  let outOfStockStores = 0
  let noShelfPhotoStores = 0
  let facingSum = 0
  let facingSampleCount = 0
  let shareSum = 0
  let shareSampleCount = 0
  let goldenGoodCount = 0
  let goldenTotalCount = 0

  const storeRankings = []

  for (const item of inspections) {
    if (!item) continue
    const itemPhotoCount = item.photoCount || (Array.isArray(item.photoFileIDs) ? item.photoFileIDs.length : 1)
    totalPhotos += itemPhotoCount
    const ar = item.aiReport && typeof item.aiReport === 'object' ? item.aiReport : null
    const fs = extractFacingSummary(ar)

    const hasScore = !!(ar && typeof ar.score === 'number' && Number.isFinite(ar.score))
    if (hasScore) {
      scoreSum += ar.score
      scoredStoresCount += 1
      if (ar.score >= 80) goodStoresCount += 1
      else needImprovementCount += 1
    }

    if (fs.hasShelfPhoto === false) {
      noShelfPhotoStores += 1
    } else if (fs.hasShelfPhoto === true) {
      shelfPhotoStores += 1
      if (fs.ownBrandPresent === false) {
        outOfStockStores += 1
      } else if (fs.ownBrandPresent === true) {
        ownBrandPresentStores += 1
      }
    }

    if (fs.ownFacingCount !== null) {
      facingSum += fs.ownFacingCount
      facingSampleCount += 1
    }
    if (fs.ownFacingShare !== null) {
      shareSum += fs.ownFacingShare
      shareSampleCount += 1
    }

    const gp = ar && ar.displayCompliance && ar.displayCompliance.goldenPosition
    if (gp && typeof gp.score === 'number') {
      goldenTotalCount += 1
      const maxGp = Number(gp.maxScore) || 100
      if (gp.score / maxGp >= 0.7) goldenGoodCount += 1
    }

    const status = hasScore
      ? (ar.scoreLevel || deriveScoreLevel(ar.score))
      : ((ar && ar.scoreLevel) || (fs.hasShelfPhoto === false ? '无货架照' : (fs.ownBrandPresent === false ? '未上柜' : '待评估')))

    storeRankings.push({
      inspectionId: item._id || '',
      storeName: item.storeName || '未命名门店',
      photoCount: itemPhotoCount,
      score: hasScore ? ar.score : null,
      scoreLevel: status,
      status,
      ownFacingCount: fs.ownFacingCount,
      ownSkuCount: fs.ownSkuCount,
      ownFacingShare: fs.ownFacingShare,
      ownBrandPresent: fs.ownBrandPresent,
      hasShelfPhoto: fs.hasShelfPhoto,
      comment: (ar && ar.summary) ? String(ar.summary).slice(0, 80) : '',
      adMaterials: (ar && Array.isArray(ar.adMaterials)) ? ar.adMaterials : []
    })
  }

  const overallScore = scoredStoresCount > 0 ? Math.round(scoreSum / scoredStoresCount) : null
  const overallLevel = overallScore !== null
    ? deriveScoreLevel(overallScore)
    : (outOfStockStores > 0 ? '未上柜' : (noShelfPhotoStores > 0 ? '无货架照' : '暂无评分'))
  const avgFacingCount = facingSampleCount > 0 ? round1(facingSum / facingSampleCount) : null
  const facingSharePercent = shareSampleCount > 0 ? round1(shareSum / shareSampleCount) : null
  const inStockRate = shelfPhotoStores > 0 ? round1((ownBrandPresentStores / shelfPhotoStores) * 100) : null
  const goldenPositionRatio = goldenTotalCount > 0
    ? `${Math.round((goldenGoodCount / goldenTotalCount) * 100)}%`
    : '--'

  return {
    overallScore,
    overallLevel,
    storeStats: {
      totalStores: inspections.length,
      totalPhotos,
      scoredStoresCount,
      goodStoresCount,
      needImprovementCount,
      shelfPhotoStores,
      ownBrandPresentStores,
      outOfStockStores,
      noShelfPhotoStores
    },
    ownBrandOverview: {
      avgFacingCount,
      totalFacingCount: facingSampleCount > 0 ? facingSum : null,
      facingSharePercent,
      inStockRate,
      goldenPositionRatio
    },
    storeRankings
  }
}

/**
 * 同日多轮批次合并《今日综合日报》，确保全部大盘指标由合并后的 storeRankings 一致重算
 */
function mergeDailyReports(prevReport, newReport) {
  if (!prevReport || typeof prevReport !== 'object') return newReport
  if (!newReport || typeof newReport !== 'object') return prevReport

  const rankMap = new Map()
  const prevRankings = Array.isArray(prevReport.storeRankings) ? prevReport.storeRankings : []
  const newRankings = Array.isArray(newReport.storeRankings) ? newReport.storeRankings : []
  prevRankings.forEach(r => { if (r) rankMap.set(r.inspectionId || r.storeName, r) })
  newRankings.forEach(r => { if (r) rankMap.set(r.inspectionId || r.storeName, r) })
  const allRankings = Array.from(rankMap.values())

  const scored = allRankings.filter(r => typeof r.score === 'number' && Number.isFinite(r.score))
  const mergedOverallScore = scored.length > 0
    ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length)
    : null

  const shelfStores = allRankings.filter(r => r.hasShelfPhoto === true || (r.hasShelfPhoto !== false && r.status !== '无货架照'))
  const outOfStockStores = shelfStores.filter(r => r.ownBrandPresent === false).length
  const ownBrandPresentStores = shelfStores.filter(r => r.ownBrandPresent !== false).length
  const noShelfPhotoStores = allRankings.filter(r => r.hasShelfPhoto === false || r.status === '无货架照').length

  const mergedOverallLevel = mergedOverallScore !== null
    ? deriveScoreLevel(mergedOverallScore)
    : (outOfStockStores > 0 ? '未上柜' : (noShelfPhotoStores > 0 ? '无货架照' : '暂无评分'))

  const facings = allRankings.filter(r => typeof r.ownFacingCount === 'number' && Number.isFinite(r.ownFacingCount))
  const totalFacingCount = facings.length > 0
    ? facings.reduce((s, r) => s + r.ownFacingCount, 0)
    : null
  const avgFacingCount = facings.length > 0 ? round1(totalFacingCount / facings.length) : null

  const shares = allRankings.filter(r => typeof r.ownFacingShare === 'number' && Number.isFinite(r.ownFacingShare))
  const facingSharePercent = shares.length > 0
    ? round1(shares.reduce((s, r) => s + r.ownFacingShare, 0) / shares.length)
    : null

  const inStockRate = shelfStores.length > 0
    ? round1((ownBrandPresentStores / shelfStores.length) * 100)
    : null

  const totalPhotos = allRankings.reduce((s, r) => s + (Number(r.photoCount) || 1), 0)

  // 共性问题按 category 去重并重排 rank
  const issueMap = new Map()
  const allIssues = [
    ...(Array.isArray(newReport.commonIssues) ? newReport.commonIssues : []),
    ...(Array.isArray(prevReport.commonIssues) ? prevReport.commonIssues : [])
  ]
  for (const iss of allIssues) {
    if (!iss || !iss.category) continue
    const key = String(iss.category).trim()
    if (!issueMap.has(key)) issueMap.set(key, iss)
  }
  const commonIssues = Array.from(issueMap.values())
    .slice(0, 10)
    .map((iss, idx) => ({ ...iss, rank: idx + 1 }))

  return {
    ...newReport,
    overallScore: mergedOverallScore,
    overallLevel: mergedOverallLevel,
    storeRankings: allRankings,
    commonIssues,
    storeStats: {
      totalStores: allRankings.length,
      totalPhotos,
      scoredStoresCount: scored.length,
      goodStoresCount: scored.filter(r => r.score >= 80).length,
      needImprovementCount: scored.filter(r => r.score < 80).length,
      shelfPhotoStores: shelfStores.length,
      ownBrandPresentStores,
      outOfStockStores,
      noShelfPhotoStores
    },
    ownBrandOverview: {
      ...(newReport.ownBrandOverview || {}),
      avgFacingCount,
      totalFacingCount,
      facingSharePercent,
      inStockRate
    }
  }
}

module.exports = {
  DEFAULT_SCORING_RULES,
  validateScoringRules,
  normalizeScoringRules,
  deriveDimensionStatus,
  deriveScoreLevel,
  clampIntScore,
  snapThreeTierScore,
  computeFacingScore,
  normalizeImageQuality,
  normalizeFramingType,
  isHorizontalBannerMaterial,
  selectHorizontalBannerRefs,
  normalizeAdMaterials,
  isOwnBrandProduct,
  validateAndNormalizeReport,
  extractFacingSummary,
  aggregateDailyMetrics,
  mergeDailyReports
}
