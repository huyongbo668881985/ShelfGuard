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

  const expectedPerUnitExact = facingMaxScore / facingTarget
  const expectedPerUnit = Math.round(expectedPerUnitExact * 100) / 100
  const hasExplicitPerUnit = raw.facingPointsPerUnit !== undefined && raw.facingPointsPerUnit !== null && raw.facingPointsPerUnit !== ''
  const rawPerUnit = hasExplicitPerUnit ? Number(raw.facingPointsPerUnit) : expectedPerUnit

  if (facingMaxScore === 0) {
    if (!Number.isFinite(rawPerUnit) || rawPerUnit !== 0) {
      return { ok: false, error: '排面数量满分为 0 时，单排面分值必须为 0' }
    }
  } else {
    if (!Number.isFinite(rawPerUnit) || rawPerUnit <= 0 || rawPerUnit > 100) {
      return { ok: false, error: '单排面分值需大于 0' }
    }
    if (Math.abs(rawPerUnit - expectedPerUnitExact) > 0.01) {
      return {
        ok: false,
        error: `单排面分值与排面满分/目标数不匹配：应满足「排面满分 ÷ 排面目标数 = 单排面分值」（当前 ${facingMaxScore} ÷ ${facingTarget} = ${expectedPerUnit} 分/面，填写为 ${rawPerUnit} 分/面）`
      }
    }
  }

  const facingPointsPerUnit = Math.round(rawPerUnit * 100) / 100

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
 * medium 下限为 0.5，兼容价签/横签三档中档分（默认 5/10 = 0.5）正常落入 medium。
 */
function deriveDimensionStatus(score, maxScore) {
  if (!Number.isFinite(maxScore) || maxScore <= 0) return 'good'
  const ratio = Number(score) / maxScore
  if (ratio >= 0.8) return 'good'
  if (ratio >= 0.5) return 'medium'
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
 * 计算排面数量得分：严格按排面目标数线性计分，满目标得满分，避免提前满分或跳分
 */
function computeFacingScore(ownFacingCount, rules) {
  const r = normalizeScoringRules(rules)
  const count = Math.max(0, Math.floor(Number(ownFacingCount) || 0))
  if (r.facingMaxScore <= 0 || count <= 0) return 0
  if (count >= r.facingTarget) return r.facingMaxScore
  return Math.min(r.facingMaxScore, Math.round((count * r.facingMaxScore) / r.facingTarget))
}

/**
 * 基于结构化观测事实（黄金位排面数 / 我方总排面数）确定性锚定黄金位置得分，抑制连续分运行间漂移
 * 严格对齐 prompt.js Rubric 档位：
 * - >=80% -> [0.9, 1.0] * maxScore
 * - 50%-79% -> [0.65, 0.85] * maxScore
 * - 20%-49% -> [0.35, 0.60] * maxScore
 * - 1%-19% -> [1, 0.30 * maxScore]
 * - 0% -> 0
 */
function computeGoldenPositionScoreFromFacings(goldenFacings, totalOwnFacings, maxScore) {
  const max = Math.max(0, Math.round(Number(maxScore) || 0))
  const total = Math.max(0, Number(totalOwnFacings) || 0)
  const golden = Math.max(0, Math.min(total, Number(goldenFacings) || 0))
  if (max === 0 || total === 0 || golden === 0) return 0
  const ratio = golden / total

  let score
  if (ratio >= 0.8) {
    const low = Math.round(max * 0.9)
    score = low + ((ratio - 0.8) / 0.2) * (max - low)
  } else if (ratio >= 0.5) {
    const low = Math.round(max * 0.65)
    const high = Math.round(max * 0.85)
    score = low + ((ratio - 0.5) / 0.3) * (high - low)
  } else if (ratio >= 0.2) {
    const low = Math.round(max * 0.35)
    const high = Math.round(max * 0.6)
    score = low + ((ratio - 0.2) / 0.3) * (high - low)
  } else {
    const low = Math.min(max, 1)
    const high = Math.max(low, Math.round(max * 0.3))
    score = low + (ratio / 0.2) * (high - low)
  }
  return clampIntScore(Math.round(score), max)
}

/**
 * 基于结构化观测事实（正标朝外排面数 / 我方总排面数）确定性锚定正标朝向得分
 * 严格对齐 prompt.js Rubric 档位：
 * - >=95% -> [0.9, 1.0] * maxScore
 * - 80%-94% -> [0.7, 0.8] * maxScore
 * - 50%-79% -> [0.4, 0.6] * maxScore
 * - <50% -> [0, 0.3] * maxScore
 */
function computeLabelOrientationScoreFromFacings(frontLabelFacings, totalOwnFacings, maxScore) {
  const max = Math.max(0, Math.round(Number(maxScore) || 0))
  const total = Math.max(0, Number(totalOwnFacings) || 0)
  const front = Math.max(0, Math.min(total, Number(frontLabelFacings) || 0))
  if (max === 0 || total === 0 || front === 0) return 0
  const ratio = front / total

  let score
  if (ratio >= 0.95) {
    const low = Math.round(max * 0.9)
    score = low + ((ratio - 0.95) / 0.05) * (max - low)
  } else if (ratio >= 0.8) {
    const low = Math.round(max * 0.7)
    const high = Math.round(max * 0.8)
    score = low + ((ratio - 0.8) / 0.15) * (high - low)
  } else if (ratio >= 0.5) {
    const low = Math.round(max * 0.4)
    const high = Math.round(max * 0.6)
    score = low + ((ratio - 0.5) / 0.3) * (high - low)
  } else {
    const high = Math.round(max * 0.3)
    score = (ratio / 0.5) * high
  }
  return clampIntScore(Math.round(score), max)
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
 * 判断识别出的广告物料条目是否为我方横签（不要求带 photo 字段）
 */
function isOwnHorizontalBannerEntry(item) {
  if (!item || typeof item !== 'object') return false
  if (item.isOwn === false) return false
  if (String(item.category || '').trim() === '横签') return true
  if (/横签/.test(String(item.name || item.materialName || ''))) return true
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
 * 从启用的产品库中筛选最多 maxRefs 张带瓶身参考图的产品（全局优先 front 正面照，其次 side / back）
 */
function selectProductRefs(activeProducts = [], maxRefs = 4) {
  if (!Array.isArray(activeProducts)) return []
  const limit = Math.max(0, maxRefs)
  if (limit === 0) return []
  const seenFiles = new Set()
  const pickedProducts = new Set()
  const out = []

  const tryPick = (slotOrder) => {
    for (let i = 0; i < activeProducts.length; i++) {
      if (out.length >= limit) break
      if (pickedProducts.has(i)) continue
      const p = activeProducts[i]
      if (!p || typeof p !== 'object' || p.isActive === false) continue
      const photos = p.photos && typeof p.photos === 'object' ? p.photos : {}
      let pickedSlot = ''
      let pickedPhoto = ''
      for (const slot of slotOrder) {
        const val = typeof photos[slot] === 'string' ? photos[slot].trim() : ''
        if (val) {
          pickedSlot = slot
          pickedPhoto = val
          break
        }
      }
      if (!pickedPhoto || seenFiles.has(pickedPhoto)) continue
      seenFiles.add(pickedPhoto)
      pickedProducts.add(i)
      out.push({
        brandName: String(p.brandName || '').trim(),
        productLine: String(p.productLine || '').trim(),
        aliases: Array.isArray(p.aliases) ? p.aliases.filter(Boolean) : [],
        photo: pickedPhoto,
        slot: pickedSlot
      })
    }
  }

  // 第一轮优先挑选拥有正面照(front)的产品，避免靠前但仅有背面照的产品挤占名额
  tryPick(['front'])
  if (out.length < limit) {
    tryPick(['side', 'back'])
  }
  return out
}

/**
 * 规范化广告物料识别结果（按物料库别名归一化为标准名称，并拦截未命中物料库且无我方标识/低置信的误归属物料）
 */
function normalizeAdMaterials(rawList, activeMaterials = [], ownBrandNameSet = null) {
  if (!Array.isArray(rawList)) return []
  const hasMaterialLib = Array.isArray(activeMaterials) && activeMaterials.length > 0
  const ownNames = ownBrandNameSet instanceof Set
    ? Array.from(ownBrandNameSet).filter(Boolean)
    : (Array.isArray(ownBrandNameSet) ? ownBrandNameSet.map(s => String(s || '').trim().toLowerCase()).filter(Boolean) : [])

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

  const isNonShelfPos = (pos) => /门头|店外|室外|门口|收银|前台/.test(String(pos || ''))
  const merged = new Map()
  rawList.forEach(item => {
    if (!item || typeof item !== 'object') return
    if (item.present === false) return
    const rawName = String(item.name || item.materialName || '').trim()
    if (!rawName) return

    // 过滤模型误输出的“未发现 / count: 0”条目，避免污染物料台账和误抬横签分
    if (item.count !== undefined && item.count !== null && item.count !== '') {
      const parsedCount = Number(item.count)
      if (Number.isFinite(parsedCount) && parsedCount <= 0) return
    }
    const rawCondition = String(item.condition || '').trim()
    if (rawCondition && /^(无|未发现|缺失|不存在|未见)$/.test(rawCondition)) return

    const matched = byAlias.get(rawName.toLowerCase())
    const canonicalName = matched ? String(matched.materialName).trim() : rawName
    const category = (matched && matched.category) || String(item.category || '其他').trim() || '其他'
    const count = Math.max(1, parseInt(item.count, 10) || 1)
    const condition = rawCondition || '完好'
    const position = String(item.position || '').trim()
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? Math.round(Math.max(0, Math.min(1, item.confidence)) * 100) / 100
      : 0.9

    const explicitCompetitor = !matched && item.isOwn === undefined && /竞品|非我方|其他品牌/.test(rawName)
    let isOwn = matched ? true : (explicitCompetitor ? false : (item.isOwn !== false))

    // 未命中物料库的非库内物料保护：
    // 1) 若已配物料库且该条置信度 < 0.7，降为非我方避免把模糊/误认的竞品盒写入客户台账；
    // 2) 若已知我方品牌名集合，且非库内非横签物料名称完全不含我方品牌/别名，降为非我方避免无标识物料误归属。
    if (!matched && isOwn) {
      const lowerName = canonicalName.toLowerCase()
      const mentionsOwnBrand = ownNames.length > 0 && ownNames.some(k => k && lowerName.includes(k))
      const isBannerItem = category === '横签' || /横签/.test(canonicalName)
      if (hasMaterialLib && typeof item.confidence === 'number' && confidence < 0.7) {
        isOwn = false
      } else if (ownNames.length > 0 && !mentionsOwnBrand && !isBannerItem) {
        isOwn = false
      }
    }

    const existing = merged.get(canonicalName)
    if (existing) {
      existing.count = Math.max(existing.count, count)
      // 同物料跨图合并时，若新条目在货架区而旧条目在门头/非货架区，保留货架区位置信息
      if (position && (!existing.position || (isNonShelfPos(existing.position) && !isNonShelfPos(position)))) {
        existing.position = position
        existing.condition = condition
      }
    } else {
      merged.set(canonicalName, {
        name: canonicalName,
        category,
        isOwn,
        count,
        condition,
        position,
        confidence
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
    const hasShelfRole = roles.some(r => {
      const s = String(r || '')
      return !/(非|无)货架/.test(s) && /货架|陈列|堆头/.test(s)
    })
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
 * @param {number} [options.visitImageCount] 本次门店实拍图张数（用于拦截参考图混入 photoRoles）
 */
function validateAndNormalizeReport(rawResult, rawResponse, options = {}) {
  const result = rawResult && typeof rawResult === 'object' ? { ...rawResult } : {}
  const activeMaterials = options.activeMaterials || []
  const rules = normalizeScoringRules(options.scoringRules)
  const ownBrandNameSet = options.ownBrandNames instanceof Set
    ? options.ownBrandNames
    : new Set((options.ownBrandNames || []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean))
  const visitImageCount = Number.isFinite(Number(options.visitImageCount)) && Number(options.visitImageCount) > 0
    ? Math.floor(Number(options.visitImageCount))
    : null

  // 基础数组 / 对象兜底（浅拷贝嵌套对象避免污染调用方入参）
  result.productIdentification = Array.isArray(result.productIdentification) ? result.productIdentification : []
  result.adMaterials = normalizeAdMaterials(result.adMaterials, activeMaterials, ownBrandNameSet)
  result.issues = Array.isArray(result.issues) ? result.issues : []
  result.suggestions = Array.isArray(result.suggestions) ? result.suggestions : []
  result.competitiveAnalysis = (result.competitiveAnalysis && typeof result.competitiveAnalysis === 'object')
    ? { ...result.competitiveAnalysis }
    : {}
  if (!Array.isArray(result.competitiveAnalysis.brands)) {
    result.competitiveAnalysis.brands = []
  }
  result.metadata = (result.metadata && typeof result.metadata === 'object')
    ? { ...result.metadata }
    : {}
  if (!Array.isArray(result.metadata.photoRoles)) {
    result.metadata.photoRoles = []
  }

  // 质量控制与一致性校准记录
  const qualityFlags = []
  const reviewReasons = []
  const consistencyAdjustments = []
  let needsReview = false
  let scoreReliability = 'high'

  // 清洗 photoRoles：剔除模型误写入的参考图标签，并按实拍图张数裁剪
  const rawPhotoRoles = result.metadata.photoRoles.map(r => String(r || '').trim()).filter(Boolean)
  const cleanedPhotoRoles = rawPhotoRoles.filter(r => !/参考图|参考照/.test(r))
  if (cleanedPhotoRoles.length !== rawPhotoRoles.length) {
    consistencyAdjustments.push('已从 metadata.photoRoles 剔除误混入的参考图条目')
  }
  if (visitImageCount !== null && cleanedPhotoRoles.length > visitImageCount) {
    consistencyAdjustments.push(`metadata.photoRoles 长度(${cleanedPhotoRoles.length})超出实拍张数(${visitImageCount})，已按实拍张数裁剪`)
    result.metadata.photoRoles = cleanedPhotoRoles.slice(0, visitImageCount)
  } else {
    result.metadata.photoRoles = cleanedPhotoRoles
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

  if (imageQuality === 'poor') {
    qualityFlags.push('poor_image_quality')
    needsReview = true
    scoreReliability = 'low'
    const reasonSuffix = result.metadata.imageQualityReason ? `（${result.metadata.imageQualityReason}）` : ''
    reviewReasons.push(`照片画质较差${reasonSuffix}，排面计数与细项评分置信度偏低，建议重拍或人工复核`)
  } else if (imageQuality === 'fair') {
    scoreReliability = 'medium'
  }

  if (hasShelfPhoto && framingType === 'closeup') {
    qualityFlags.push('closeup_framing')
    needsReview = true
    if (scoreReliability === 'high') scoreReliability = 'medium'
  }

  const finalizeQualityMetadata = () => {
    result.metadata.needsReview = needsReview
    result.metadata.scoreReliability = scoreReliability
    result.metadata.qualityFlags = qualityFlags
    result.metadata.reviewReasons = reviewReasons
    result.metadata.consistencyAdjustments = consistencyAdjustments
  }

  // 规范化逐图观测与跨图去重记录（shelfObservations），供排面交叉核验
  let obsDedupFacings = null
  if (result.shelfObservations && typeof result.shelfObservations === 'object') {
    const rawObs = result.shelfObservations
    const rawPhotoFacings = Array.isArray(rawObs.photoFacings) ? rawObs.photoFacings : []
    let hasNumericObs = false
    let netSum = 0
    const normalizedPhotoFacings = rawPhotoFacings
      .filter(entry => entry && typeof entry === 'object')
      .map((entry, idx) => {
        const ownInPhotoRaw = Number(entry.ownFacingsInPhoto)
        const overlapRaw = Number(entry.overlapWithPrevious)
        const ownFacingsInPhoto = Number.isFinite(ownInPhotoRaw) && ownInPhotoRaw >= 0 ? Math.round(ownInPhotoRaw) : 0
        const overlapWithPrevious = Number.isFinite(overlapRaw) && overlapRaw >= 0
          ? Math.min(ownFacingsInPhoto, Math.round(overlapRaw))
          : 0
        if (entry.ownFacingsInPhoto !== undefined && entry.ownFacingsInPhoto !== null && entry.ownFacingsInPhoto !== '' && Number.isFinite(ownInPhotoRaw)) {
          hasNumericObs = true
        }
        const netFacings = Math.max(0, ownFacingsInPhoto - overlapWithPrevious)
        netSum += netFacings
        return {
          photoIndex: Number.isFinite(Number(entry.photoIndex)) ? Math.round(Number(entry.photoIndex)) : (idx + 1),
          role: String(entry.role || '').trim(),
          layerSummary: String(entry.layerSummary || '').trim(),
          ownFacingsInPhoto,
          overlapWithPrevious,
          netFacings
        }
      })
    if (hasNumericObs) {
      obsDedupFacings = netSum
    }
    result.shelfObservations = {
      photoFacings: normalizedPhotoFacings,
      dedupNote: String(rawObs.dedupNote || '').trim(),
      ...(obsDedupFacings !== null ? { dedupOwnFacings: obsDedupFacings } : {})
    }
  }

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
    finalizeQualityMetadata()
    result.rawResponse = rawResponse
    return result
  }

  // 提取排面指标：当 productIdentification 明确列出了我方 SKU 排面时，以逐品规累加值作为权威口径，避免顶层猜数与明细打架
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
  const skuKeysFromProducts = new Set(
    ownProducts
      .filter(p => (Number(p.facingCount) || 0) > 0)
      .map(p => `${String(p.brand || '').trim()}|${String(p.productLine || '').trim()}`)
  )

  let rawTopOwnFacing = null
  if (rawFm.ownFacingCount !== undefined && rawFm.ownFacingCount !== null && rawFm.ownFacingCount !== '') {
    const n = Number(rawFm.ownFacingCount)
    if (Number.isFinite(n) && n >= 0) rawTopOwnFacing = Math.round(n)
  }
  let rawObservedFacings = null
  if (rawDc.facingCount && rawDc.facingCount.observedFacings !== undefined && rawDc.facingCount.observedFacings !== null && rawDc.facingCount.observedFacings !== '') {
    const n = Number(rawDc.facingCount.observedFacings)
    if (Number.isFinite(n) && n >= 0) rawObservedFacings = Math.round(n)
  }

  let ownFacingCount = null
  let facingReconciledFromProducts = false
  let facingDiscrepancy = 0
  if (ownProducts.length > 0 && ownFacingFromProducts > 0) {
    ownFacingCount = ownFacingFromProducts
    if (rawTopOwnFacing !== null && rawTopOwnFacing !== ownFacingFromProducts) {
      facingReconciledFromProducts = true
      facingDiscrepancy = Math.max(facingDiscrepancy, Math.abs(rawTopOwnFacing - ownFacingFromProducts))
      consistencyAdjustments.push(
        `我方排面数已由顶层值 ${rawTopOwnFacing} 校准为 productIdentification 我方 SKU 累加值 ${ownFacingFromProducts}`
      )
    }
    if (rawObservedFacings !== null && rawObservedFacings !== ownFacingFromProducts) {
      facingReconciledFromProducts = true
      facingDiscrepancy = Math.max(facingDiscrepancy, Math.abs(rawObservedFacings - ownFacingFromProducts))
      consistencyAdjustments.push(
        `我方排面数已由 observedFacings(${rawObservedFacings}) 校准为 productIdentification 我方 SKU 累加值 ${ownFacingFromProducts}`
      )
    }
  } else {
    ownFacingCount = rawTopOwnFacing !== null
      ? rawTopOwnFacing
      : (rawObservedFacings !== null
          ? rawObservedFacings
          : (obsDedupFacings !== null ? obsDedupFacings : ownFacingFromProducts))
  }

  let ownSkuCount = null
  if (skuKeysFromProducts.size > 0) {
    ownSkuCount = skuKeysFromProducts.size
  } else if (rawFm.ownSkuCount !== undefined && rawFm.ownSkuCount !== null && rawFm.ownSkuCount !== '') {
    const n = Number(rawFm.ownSkuCount)
    if (Number.isFinite(n) && n >= 0) ownSkuCount = Math.round(n)
  }
  if (ownSkuCount === null) {
    ownSkuCount = skuKeysFromProducts.size
  }

  let totalShelfFacingCount = null
  if (rawFm.totalShelfFacingCount !== undefined && rawFm.totalShelfFacingCount !== null && rawFm.totalShelfFacingCount !== '') {
    const n = Number(rawFm.totalShelfFacingCount)
    // 当我方排面 > 0 时，模型填 totalShelfFacingCount=0 属于未数出总数，按未知处理避免虚构 100% 占比
    if (Number.isFinite(n) && (n > 0 || (n === 0 && ownFacingCount === 0))) {
      totalShelfFacingCount = Math.round(n)
    }
  }
  if (totalShelfFacingCount === null && totalFacingFromProducts > ownFacingCount) {
    totalShelfFacingCount = totalFacingFromProducts
  }
  const minTotalFacing = Math.max(ownFacingCount, totalFacingFromProducts)
  if (totalShelfFacingCount !== null && minTotalFacing > totalShelfFacingCount) {
    totalShelfFacingCount = minTotalFacing
  }

  let ownFacingShare = null
  if (totalShelfFacingCount > 0) {
    ownFacingShare = round1(Math.min(100, (ownFacingCount / totalShelfFacingCount) * 100))
  } else if (rawFm.ownFacingShare !== undefined && rawFm.ownFacingShare !== null && rawFm.ownFacingShare !== '') {
    const n = Number(rawFm.ownFacingShare)
    if (Number.isFinite(n) && n >= 0 && n <= 100) ownFacingShare = round1(n)
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

  // 局部特写防虚高：特写镜头看不到竞品全貌，不得将虚高排面占比写入统计指标
  if (framingType === 'closeup') {
    if (ownFacingShare !== null) {
      result.metadata.rawOwnFacingShare = ownFacingShare
    }
    ownFacingShare = null
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
  // 质量与取景对置信度的硬上限约束
  if (imageQuality === 'poor') {
    countingConfidence = Math.min(countingConfidence, 0.5)
  }
  if (framingType === 'closeup') {
    countingConfidence = Math.min(countingConfidence, 0.55)
  }
  if (facingReconciledFromProducts && facingDiscrepancy >= 2) {
    countingConfidence = Math.min(countingConfidence, 0.7)
    needsReview = true
    qualityFlags.push('facing_count_inconsistent')
    reviewReasons.push(`顶层排面数与识别 SKU 明细偏差 ${facingDiscrepancy} 面，已按明细校准并建议人工复核`)
  }
  // 逐图跨图去重观测值与最终排面数交叉核验（防多图漏去重或计数打架）
  if (obsDedupFacings !== null && ownFacingCount > 0 && Math.abs(obsDedupFacings - ownFacingCount) >= 2) {
    const obsDiff = Math.abs(obsDedupFacings - ownFacingCount)
    countingConfidence = Math.min(countingConfidence, 0.7)
    needsReview = true
    qualityFlags.push('observation_facing_inconsistent')
    const obsNote = `逐图去重观测排面(${obsDedupFacings}面)与最终统计排面(${ownFacingCount}面)偏差 ${obsDiff} 面，建议复核跨图去重计数`
    consistencyAdjustments.push(obsNote)
    reviewReasons.push(obsNote)
  }

  // 判断我方品牌是否在架（ownBrandPresent）
  let ownBrandPresent
  if (typeof result.ownBrandPresent === 'boolean') {
    ownBrandPresent = result.ownBrandPresent
  } else {
    ownBrandPresent = ownFacingCount > 0 || ownProducts.length > 0
  }
  // 如果模型声明未上柜但 productIdentification 已列出明确我方排面，按实证纠偏并标复核
  if (!ownBrandPresent && ownFacingFromProducts > 0) {
    ownBrandPresent = true
    needsReview = true
    consistencyAdjustments.push(`productIdentification 识别到我方排面 ${ownFacingFromProducts} 面，已将 ownBrandPresent 修正为 true`)
  }
  // 如果模型明确标了 ownFacingCount === 0 且没有识别出任何我方产品，则视为未上柜
  if (ownBrandPresent && ownFacingCount === 0 && ownProducts.length === 0) {
    ownBrandPresent = false
  }
  result.ownBrandPresent = ownBrandPresent

  if (framingType === 'closeup') {
    reviewReasons.push(
      ownBrandPresent
        ? '仅拍摄货架局部特写，无法核验整组货架层高与总排面，黄金位得分已封顶且排面占比不计入统计'
        : '仅拍摄货架局部特写，无法核验整组货架是否未上柜，建议补充货架全景照复核'
    )
  }

  // 情况 B：拍了货架照但全图无我方品牌 → 未上柜，score = null，不计入均分
  if (!ownBrandPresent) {
    result.score = null
    result.scoreLevel = '未上柜'
    result.displayCompliance = {}
    result.facingMetrics = {
      ownFacingCount: 0,
      ownSkuCount: 0,
      totalShelfFacingCount,
      ownFacingShare: framingType === 'closeup' ? null : 0,
      countingConfidence
    }
    if (!result.summary) {
      result.summary = '货架陈列照片中未发现我方品牌产品（未上柜），请及时跟进铺货上柜。'
    }
    finalizeQualityMetadata()
    result.rawResponse = rawResponse
    return result
  }

  // 情况 C：有货架照且有我方品牌 → 服务端严格按 5 维规则校验、观测锚定与交叉一致性校准
  const facingScore = computeFacingScore(ownFacingCount, rules)

  const parseOptionalPositiveInt = (v) => {
    if (v === undefined || v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  }

  // 黄金位置：若模型给出结构化 goldenFacings 观测值，则按 Rubric 比例曲线确定性锚定，抑制连续分漂移
  const rawGoldenObj = (rawDc.goldenPosition && typeof rawDc.goldenPosition === 'object') ? rawDc.goldenPosition : {}
  const goldenRaw = rawGoldenObj.score
  let goldenFacings = null
  let goldenRatio = null
  let goldenScore
  if (
    ownFacingCount > 0 &&
    rawGoldenObj.goldenFacings !== undefined &&
    rawGoldenObj.goldenFacings !== null &&
    rawGoldenObj.goldenFacings !== '' &&
    Number.isFinite(Number(rawGoldenObj.goldenFacings)) &&
    Number(rawGoldenObj.goldenFacings) >= 0
  ) {
    const rawGoldenCount = Math.max(0, Math.round(Number(rawGoldenObj.goldenFacings)))
    const rawGoldenDenom = parseOptionalPositiveInt(rawGoldenObj.totalOwnFacings)
    // 若模型显式给出了与校准后 ownFacingCount 不同的 totalOwnFacings，按其自洽分子分母保留真实观测占比，防止截断成 100% 虚高
    const effectiveDenom = rawGoldenDenom !== null ? rawGoldenDenom : ownFacingCount
    const effectiveGoldenCount = Math.min(effectiveDenom, rawGoldenCount)
    goldenRatio = round1((effectiveGoldenCount / effectiveDenom) * 100)
    goldenFacings = effectiveDenom === ownFacingCount
      ? effectiveGoldenCount
      : Math.min(ownFacingCount, Math.round((effectiveGoldenCount / effectiveDenom) * ownFacingCount))
    goldenScore = computeGoldenPositionScoreFromFacings(effectiveGoldenCount, effectiveDenom, rules.goldenPositionMaxScore)
    if (rawGoldenDenom !== null && rawGoldenDenom !== ownFacingCount) {
      consistencyAdjustments.push(
        `黄金位观测分母(${rawGoldenDenom})与校准排面数(${ownFacingCount})不一致，已按原观测占比 ${effectiveGoldenCount}/${effectiveDenom}(${goldenRatio}%) 锚定得分`
      )
    } else if (rawGoldenCount > ownFacingCount) {
      consistencyAdjustments.push(
        `goldenFacings(${rawGoldenCount}) 超出我方总排面(${ownFacingCount})，已裁剪为 ${effectiveGoldenCount}`
      )
    }
    if (goldenRaw !== undefined && goldenRaw !== null && goldenRaw !== '' && Number.isFinite(Number(goldenRaw))) {
      const clampedRawGolden = clampIntScore(goldenRaw, rules.goldenPositionMaxScore)
      if (Math.abs(clampedRawGolden - goldenScore) >= 3) {
        consistencyAdjustments.push(
          `黄金位得分已按观测占比 ${effectiveGoldenCount}/${effectiveDenom}(${goldenRatio}%) 由 ${clampedRawGolden} 校准为 ${goldenScore}/${rules.goldenPositionMaxScore}`
        )
      }
    }
  } else {
    goldenScore = clampIntScore(goldenRaw, rules.goldenPositionMaxScore)
  }

  let goldenDetail = String(rawGoldenObj.detail || '').trim()
  // 局部特写防虚高：特写无法判断整组货架层高，黄金位得分封顶为满分的 60%
  if (framingType === 'closeup' && rules.goldenPositionMaxScore > 0) {
    const closeupGoldenCap = Math.round(rules.goldenPositionMaxScore * 0.6)
    if (goldenScore > closeupGoldenCap) {
      const beforeCap = goldenScore
      goldenScore = closeupGoldenCap
      const capNote = `局部特写无法核验整组货架层高，黄金位得分由 ${beforeCap} 封顶为 ${closeupGoldenCap}/${rules.goldenPositionMaxScore} 分`
      consistencyAdjustments.push(capNote)
      goldenDetail = goldenDetail ? `${goldenDetail}（${capNote}）` : capNote
    }
  }

  // 正标朝向：若模型给出结构化 frontLabelFacings 观测值，则按 Rubric 比例曲线确定性锚定
  const rawLabelObj = (rawDc.labelOrientation && typeof rawDc.labelOrientation === 'object') ? rawDc.labelOrientation : {}
  const labelRaw = rawLabelObj.score
  let frontLabelFacings = null
  let frontLabelRatio = null
  let labelScore
  if (
    ownFacingCount > 0 &&
    rawLabelObj.frontLabelFacings !== undefined &&
    rawLabelObj.frontLabelFacings !== null &&
    rawLabelObj.frontLabelFacings !== '' &&
    Number.isFinite(Number(rawLabelObj.frontLabelFacings)) &&
    Number(rawLabelObj.frontLabelFacings) >= 0
  ) {
    const rawFrontCount = Math.max(0, Math.round(Number(rawLabelObj.frontLabelFacings)))
    const rawLabelDenom = parseOptionalPositiveInt(rawLabelObj.totalOwnFacings)
    const effectiveDenom = rawLabelDenom !== null ? rawLabelDenom : ownFacingCount
    const effectiveFrontCount = Math.min(effectiveDenom, rawFrontCount)
    frontLabelRatio = round1((effectiveFrontCount / effectiveDenom) * 100)
    frontLabelFacings = effectiveDenom === ownFacingCount
      ? effectiveFrontCount
      : Math.min(ownFacingCount, Math.round((effectiveFrontCount / effectiveDenom) * ownFacingCount))
    labelScore = computeLabelOrientationScoreFromFacings(effectiveFrontCount, effectiveDenom, rules.labelOrientationMaxScore)
    if (rawLabelDenom !== null && rawLabelDenom !== ownFacingCount) {
      consistencyAdjustments.push(
        `正标观测分母(${rawLabelDenom})与校准排面数(${ownFacingCount})不一致，已按原观测占比 ${effectiveFrontCount}/${effectiveDenom}(${frontLabelRatio}%) 锚定得分`
      )
    } else if (rawFrontCount > ownFacingCount) {
      consistencyAdjustments.push(
        `frontLabelFacings(${rawFrontCount}) 超出我方总排面(${ownFacingCount})，已裁剪为 ${effectiveFrontCount}`
      )
    }
    if (labelRaw !== undefined && labelRaw !== null && labelRaw !== '' && Number.isFinite(Number(labelRaw))) {
      const clampedRawLabel = clampIntScore(labelRaw, rules.labelOrientationMaxScore)
      if (Math.abs(clampedRawLabel - labelScore) >= 2) {
        consistencyAdjustments.push(
          `正标朝向得分已按观测占比 ${effectiveFrontCount}/${effectiveDenom}(${frontLabelRatio}%) 由 ${clampedRawLabel} 校准为 ${labelScore}/${rules.labelOrientationMaxScore}`
        )
      }
    }
  } else {
    labelScore = clampIntScore(labelRaw, rules.labelOrientationMaxScore)
  }

  // 兼容 priceTag / priceTagMatch 键名
  const rawPriceTag = rawDc.priceTag || rawDc.priceTagMatch || {}
  const priceTagScore = snapThreeTierScore(rawPriceTag.score, rules.priceTagMaxScore)

  // 横签露出 + 与 adMaterials 双向一致性交叉校验
  const rawBanner = rawDc.horizontalBanner || {}
  let bannerScore = snapThreeTierScore(rawBanner.score, rules.horizontalBannerMaxScore)
  let bannerDetail = String(rawBanner.detail || '').trim()

  if (rules.horizontalBannerMaxScore > 0) {
    const hbMid = Math.round(rules.horizontalBannerMaxScore / 2)
    const ownBannerEntries = result.adMaterials.filter(isOwnHorizontalBannerEntry)
    const isNonShelfPosition = (b) => /门头|店外|室外|门口|收银|前台/.test(String((b && b.position) || ''))
    const shelfOwnBanners = ownBannerEntries.filter(b => !isNonShelfPosition(b))
    const isDamagedOrOffBanner = (b) => /破损|卷曲|遮挡|残缺|褪色|脱落|脏污|偏离/.test(
      `${b.condition || ''} ${b.position || ''}`
    )

    if (bannerScore > 0 && ownBannerEntries.length === 0) {
      // 横签得分 > 0 但 adMaterials 漏记了我方横签 → 自动补录以保持物料台账与评分口径一致
      const libBanners = (activeMaterials || []).filter(m =>
        m && m.isActive !== false && (String(m.category || '').trim() === '横签' || /横签/.test(String(m.materialName || '')))
      )
      const canonicalBannerName = libBanners.length === 1 && libBanners[0].materialName
        ? String(libBanners[0].materialName).trim()
        : '我方品牌横签'
      result.adMaterials.push({
        name: canonicalBannerName,
        category: '横签',
        isOwn: true,
        count: 1,
        condition: bannerScore >= rules.horizontalBannerMaxScore ? '完好' : '破损/遮挡',
        position: '我方陈列区',
        confidence: 0.75
      })
      consistencyAdjustments.push(
        `horizontalBanner 得 ${bannerScore} 分但 adMaterials 未记录我方横签，已自动补录「${canonicalBannerName}」`
      )
    } else if (bannerScore === 0 && shelfOwnBanners.length > 0) {
      const hasExplicitBannerScore = rawBanner.score !== undefined && rawBanner.score !== null && rawBanner.score !== ''
      if (!hasExplicitBannerScore) {
        const hasIntactShelfBanner = shelfOwnBanners.some(b => !isDamagedOrOffBanner(b))
        bannerScore = hasIntactShelfBanner ? rules.horizontalBannerMaxScore : hbMid
        const syncNote = `adMaterials 识别到我方横签「${shelfOwnBanners[0].name}」，横签得分补全为 ${bannerScore}/${rules.horizontalBannerMaxScore} 分`
        consistencyAdjustments.push(syncNote)
        bannerDetail = bannerDetail ? `${bannerDetail}（${syncNote}）` : syncNote
      } else {
        // 模型一方面在 adMaterials 标了货架区我方横签、一方面给 horizontalBanner 打 0 分 → 保守校准至中档并标复核
        bannerScore = hbMid
        needsReview = true
        qualityFlags.push('banner_material_inconsistent')
        const conflictNote = `横签评分(0分)与 adMaterials 已识别我方横签「${shelfOwnBanners[0].name}」存在矛盾，已保守校准为中档 ${hbMid}/${rules.horizontalBannerMaxScore} 分并建议复核`
        consistencyAdjustments.push(conflictNote)
        reviewReasons.push(conflictNote)
        bannerDetail = bannerDetail ? `${bannerDetail}（${conflictNote}）` : conflictNote
      }
    } else if (
      bannerScore >= rules.horizontalBannerMaxScore &&
      shelfOwnBanners.length > 0 &&
      shelfOwnBanners.every(isDamagedOrOffBanner)
    ) {
      // adMaterials 明确记载全部货架我方横签破损/遮挡/偏离陈列区，但横签给了满分 → 下调为中档
      bannerScore = hbMid
      const condNote = `adMaterials 记载我方横签状态/位置异常（${shelfOwnBanners[0].condition || shelfOwnBanners[0].position}），横签得分由满分校准为中档 ${hbMid}/${rules.horizontalBannerMaxScore} 分`
      consistencyAdjustments.push(condNote)
      bannerDetail = bannerDetail ? `${bannerDetail}（${condNote}）` : condNote
    }
  }

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
      ...(goldenFacings !== null ? { goldenFacings, goldenRatio } : {}),
      status: deriveDimensionStatus(goldenScore, rules.goldenPositionMaxScore),
      detail: goldenDetail
    },
    labelOrientation: {
      score: labelScore,
      maxScore: rules.labelOrientationMaxScore,
      ...(frontLabelFacings !== null ? { frontLabelFacings, frontLabelRatio } : {}),
      status: deriveDimensionStatus(labelScore, rules.labelOrientationMaxScore),
      detail: String(rawLabelObj.detail || '').trim()
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
      detail: bannerDetail
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
  finalizeQualityMetadata()
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
  let needsReviewStores = 0
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
    const meta = ar && ar.metadata && typeof ar.metadata === 'object' ? ar.metadata : {}
    const needsReview = Boolean(meta.needsReview || meta.imageQuality === 'poor' || meta.framingType === 'closeup')
    const scoreReliability = meta.scoreReliability || (meta.imageQuality === 'poor' ? 'low' : (meta.framingType === 'closeup' ? 'medium' : 'high'))
    if (needsReview) needsReviewStores += 1

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
      needsReview,
      scoreReliability,
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
      noShelfPhotoStores,
      needsReviewStores
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
  const needsReviewStores = allRankings.filter(r => r.needsReview === true).length

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
      noShelfPhotoStores,
      needsReviewStores
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
  computeGoldenPositionScoreFromFacings,
  computeLabelOrientationScoreFromFacings,
  normalizeImageQuality,
  normalizeFramingType,
  isHorizontalBannerMaterial,
  isOwnHorizontalBannerEntry,
  selectHorizontalBannerRefs,
  selectProductRefs,
  normalizeAdMaterials,
  isOwnBrandProduct,
  validateAndNormalizeReport,
  extractFacingSummary,
  aggregateDailyMetrics,
  mergeDailyReports
}
