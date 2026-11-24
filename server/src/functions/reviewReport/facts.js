'use strict'

// ============================================================
// 人工校正事实模型（Facts Model）纯函数模块
// - extractFacts(aiReport, activeProducts)
// - validateFacts(facts, activeProducts)
// - buildCorrectedReport(baseReport, facts, ctx)
// - diffFacts(beforeFacts, afterFacts, reasons)
// ============================================================

const {
  normalizeScoringRules,
  validateAndNormalizeReport,
  isOwnHorizontalBannerEntry,
  snapThreeTierScore,
  round1
} = require('../analyzeImage/scoring')
const { PROMPT_VERSION } = require('../analyzeImage/prompt')

const ALLOWED_TIERS = new Set(['good', 'mid', 'none'])
const ALLOWED_POSITIONS = ['黄金位', '中层', '上层', '下层', '堆头', '其他']

function scoreToTier(score, maxScore) {
  const max = Math.max(0, Math.round(Number(maxScore) || 10))
  if (max === 0) return 'none'
  const snapped = snapThreeTierScore(score, max)
  if (snapped >= max) return 'good'
  if (snapped > 0) return 'mid'
  return 'none'
}

function tierToScore(tier, maxScore) {
  const max = Math.max(0, Math.round(Number(maxScore) || 10))
  if (tier === 'good') return max
  if (tier === 'mid') return Math.round(max / 2)
  return 0
}

function matchProductInLibrary(item, activeProducts = []) {
  if (!item || typeof item !== 'object') return null
  if (item.productId) {
    const byId = activeProducts.find(p => p && String(p._id) === String(item.productId))
    if (byId) return byId
  }
  const b = String(item.brand || '').trim().toLowerCase()
  const l = String(item.productLine || '').trim().toLowerCase()
  for (const p of activeProducts) {
    if (!p) continue
    const pb = String(p.brandName || '').trim().toLowerCase()
    const pl = String(p.productLine || '').trim().toLowerCase()
    if (pb && b === pb && pl === l) return p
  }
  for (const p of activeProducts) {
    if (!p) continue
    const pb = String(p.brandName || '').trim().toLowerCase()
    const pl = String(p.productLine || '').trim().toLowerCase()
    const aliases = Array.isArray(p.aliases) ? p.aliases.map(a => String(a || '').trim().toLowerCase()) : []
    const combined = `${b} ${l}`.trim()
    if (pl && (l === pl || combined.includes(pl))) return p
    if (aliases.some(a => a && (l === a || b === a || combined.includes(a)))) return p
  }
  return null
}

/**
 * 从现有 aiReport 提取可编辑的观测事实
 */
function extractFacts(aiReport, activeProducts = []) {
  const ar = (aiReport && typeof aiReport === 'object') ? aiReport : {}
  const rules = normalizeScoringRules(ar.scoringRulesUsed)
  const hasShelfPhoto = ar.hasShelfPhoto !== false && ar.scoreLevel !== '无货架照'
  const rawProducts = Array.isArray(ar.productIdentification) ? ar.productIdentification : []

  const ownProducts = []
  const competitorProducts = []

  rawProducts.forEach((p, idx) => {
    if (!p || typeof p !== 'object') return
    const fc = Math.max(0, Math.round(Number(p.facingCount) || 0))
    const conf = (typeof p.confidence === 'number' && Number.isFinite(p.confidence))
      ? Math.round(Math.max(0, Math.min(1, p.confidence)) * 100) / 100
      : null
    const pos = String(p.position || '中层').trim() || '中层'

    if (p.isOwn === true) {
      const matched = matchProductInLibrary(p, activeProducts)
      ownProducts.push({
        slotKey: `own_${idx}`,
        productId: matched ? String(matched._id) : (p.productId ? String(p.productId) : ''),
        brand: matched ? String(matched.brandName || p.brand || '').trim() : String(p.brand || '').trim(),
        productLine: matched ? String(matched.productLine || p.productLine || '').trim() : String(p.productLine || '').trim(),
        facingCount: fc,
        position: pos,
        confidence: conf,
        aromaType: String(p.aromaType || '').trim(),
        priceRange: String(p.priceRange || '').trim()
      })
    } else {
      competitorProducts.push({
        slotKey: `comp_${idx}`,
        brand: String(p.brand || '').trim(),
        productLine: String(p.productLine || '').trim(),
        facingCount: fc,
        position: pos,
        confidence: conf,
        aromaType: String(p.aromaType || '').trim(),
        priceRange: String(p.priceRange || '').trim()
      })
    }
  })

  const totalOwnFacings = ownProducts.reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
  const ownBrandPresent = hasShelfPhoto ? (totalOwnFacings > 0 || ar.ownBrandPresent === true) : null

  const dc = (ar.displayCompliance && typeof ar.displayCompliance === 'object') ? ar.displayCompliance : {}
  const gp = (dc.goldenPosition && typeof dc.goldenPosition === 'object') ? dc.goldenPosition : {}
  const lo = (dc.labelOrientation && typeof dc.labelOrientation === 'object') ? dc.labelOrientation : {}
  const pt = (dc.priceTag || dc.priceTagMatch || {})
  const hb = (dc.horizontalBanner || {})

  let goldenFacings = 0
  if (gp.goldenFacings !== undefined && gp.goldenFacings !== null && Number.isFinite(Number(gp.goldenFacings))) {
    goldenFacings = Math.max(0, Math.min(totalOwnFacings, Math.round(Number(gp.goldenFacings))))
  } else if (totalOwnFacings > 0) {
    const goldenFromPos = ownProducts
      .filter(p => /黄金/.test(String(p.position || '')))
      .reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
    goldenFacings = Math.min(totalOwnFacings, goldenFromPos)
  }

  let frontLabelFacings = 0
  if (lo.frontLabelFacings !== undefined && lo.frontLabelFacings !== null && Number.isFinite(Number(lo.frontLabelFacings))) {
    frontLabelFacings = Math.max(0, Math.min(totalOwnFacings, Math.round(Number(lo.frontLabelFacings))))
  } else if (totalOwnFacings > 0) {
    const ratio = (typeof lo.score === 'number' && rules.labelOrientationMaxScore > 0)
      ? Math.max(0, Math.min(1, lo.score / rules.labelOrientationMaxScore))
      : 1
    frontLabelFacings = Math.round(totalOwnFacings * ratio)
  }

  const priceTagTier = scoreToTier(pt.score, rules.priceTagMaxScore)
  const bannerTier = scoreToTier(hb.score, rules.horizontalBannerMaxScore)

  const fm = (ar.facingMetrics && typeof ar.facingMetrics === 'object') ? ar.facingMetrics : {}
  const totalCompFacings = competitorProducts.reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
  const totalShelfFacingCount = (typeof fm.totalShelfFacingCount === 'number' && fm.totalShelfFacingCount >= totalOwnFacings + totalCompFacings)
    ? Math.round(fm.totalShelfFacingCount)
    : (totalOwnFacings + totalCompFacings > 0 ? totalOwnFacings + totalCompFacings : null)

  return {
    hasShelfPhoto,
    ownBrandPresent: hasShelfPhoto ? (totalOwnFacings > 0) : null,
    ownProducts,
    competitorProducts,
    goldenFacings,
    frontLabelFacings,
    priceTagTier,
    bannerTier,
    totalShelfFacingCount
  }
}

/**
 * 校验并规范化前端提交的 facts
 * @returns {{ ok: boolean, facts?: object, error?: string }}
 */
function validateFacts(rawFacts, activeProducts = []) {
  if (!rawFacts || typeof rawFacts !== 'object' || Array.isArray(rawFacts)) {
    return { ok: false, error: '校正事实数据格式不正确' }
  }

  const hasShelfPhoto = rawFacts.hasShelfPhoto !== false
  const productById = new Map()
  ;(Array.isArray(activeProducts) ? activeProducts : []).forEach(p => {
    if (p && p._id) productById.set(String(p._id), p)
  })

  const rawOwn = Array.isArray(rawFacts.ownProducts) ? rawFacts.ownProducts : []
  const ownProducts = []
  for (let i = 0; i < rawOwn.length; i++) {
    const item = rawOwn[i]
    if (!item || typeof item !== 'object') continue
    const fc = Number(item.facingCount)
    if (!Number.isFinite(fc) || fc < 0 || fc > 500) {
      return { ok: false, error: `第 ${i + 1} 个我方产品的排面数需为 0-500 的整数` }
    }
    const facingCount = Math.round(fc)
    if (facingCount === 0) continue

    let brand = String(item.brand || '').trim()
    let productLine = String(item.productLine || '').trim()
    const productId = item.productId ? String(item.productId).trim() : ''

    if (productById.size > 0) {
      let libProd = productId ? productById.get(productId) : null
      if (!libProd) {
        libProd = matchProductInLibrary(item, activeProducts)
      }
      if (!libProd) {
        return { ok: false, error: `我方产品「${[brand, productLine].filter(Boolean).join(' ') || ('#' + (i + 1))}」不在启用中的产品库内，请从产品库选择标准品规` }
      }
      brand = String(libProd.brandName || brand).trim()
      productLine = String(libProd.productLine || productLine).trim()
      ownProducts.push({
        slotKey: String(item.slotKey || `own_${i}`),
        productId: String(libProd._id),
        brand,
        productLine,
        facingCount,
        position: String(item.position || '中层').trim() || '中层',
        confidence: (typeof item.confidence === 'number' && Number.isFinite(item.confidence)) ? item.confidence : 1,
        aromaType: String(item.aromaType || '').trim(),
        priceRange: String(item.priceRange || '').trim()
      })
    } else {
      if (!brand && !productLine) {
        return { ok: false, error: `第 ${i + 1} 个我方产品缺少品牌与品规名称` }
      }
      ownProducts.push({
        slotKey: String(item.slotKey || `own_${i}`),
        productId,
        brand: brand || '我方品牌',
        productLine,
        facingCount,
        position: String(item.position || '中层').trim() || '中层',
        confidence: (typeof item.confidence === 'number' && Number.isFinite(item.confidence)) ? item.confidence : 1,
        aromaType: String(item.aromaType || '').trim(),
        priceRange: String(item.priceRange || '').trim()
      })
    }
  }

  const rawComp = Array.isArray(rawFacts.competitorProducts) ? rawFacts.competitorProducts : []
  const competitorProducts = []
  for (let i = 0; i < rawComp.length; i++) {
    const item = rawComp[i]
    if (!item || typeof item !== 'object') continue
    const fc = Math.max(0, Math.min(500, Math.round(Number(item.facingCount) || 0)))
    if (fc === 0) continue
    const brand = String(item.brand || '竞品').trim()
    const productLine = String(item.productLine || '').trim()
    competitorProducts.push({
      slotKey: String(item.slotKey || `comp_${i}`),
      brand,
      productLine,
      facingCount: fc,
      position: String(item.position || '中层').trim() || '中层',
      confidence: (typeof item.confidence === 'number' && Number.isFinite(item.confidence)) ? item.confidence : 0.9,
      aromaType: String(item.aromaType || '').trim(),
      priceRange: String(item.priceRange || '').trim()
    })
  }

  const totalOwnFacings = ownProducts.reduce((s, p) => s + p.facingCount, 0)
  const ownBrandPresent = hasShelfPhoto ? (totalOwnFacings > 0) : null

  let goldenFacings = 0
  let frontLabelFacings = 0
  if (totalOwnFacings > 0) {
    const gRaw = Number(rawFacts.goldenFacings)
    if (!Number.isFinite(gRaw) || gRaw < 0 || Math.round(gRaw) > totalOwnFacings) {
      return { ok: false, error: `黄金位排面数需在 0 到我方总排面数（${totalOwnFacings}）之间` }
    }
    goldenFacings = Math.round(gRaw)

    const fRaw = Number(rawFacts.frontLabelFacings)
    if (!Number.isFinite(fRaw) || fRaw < 0 || Math.round(fRaw) > totalOwnFacings) {
      return { ok: false, error: `正标朝外排面数需在 0 到我方总排面数（${totalOwnFacings}）之间` }
    }
    frontLabelFacings = Math.round(fRaw)
  }

  const priceTagTier = ALLOWED_TIERS.has(rawFacts.priceTagTier) ? rawFacts.priceTagTier : 'none'
  const bannerTier = ALLOWED_TIERS.has(rawFacts.bannerTier) ? rawFacts.bannerTier : 'none'

  const totalCompFacings = competitorProducts.reduce((s, p) => s + p.facingCount, 0)
  let totalShelfFacingCount = null
  if (rawFacts.totalShelfFacingCount !== undefined && rawFacts.totalShelfFacingCount !== null && rawFacts.totalShelfFacingCount !== '') {
    const n = Number(rawFacts.totalShelfFacingCount)
    if (Number.isFinite(n) && n >= 0) {
      totalShelfFacingCount = Math.max(totalOwnFacings + totalCompFacings, Math.round(n))
    }
  } else if (totalOwnFacings + totalCompFacings > 0) {
    totalShelfFacingCount = totalOwnFacings + totalCompFacings
  }

  return {
    ok: true,
    facts: {
      hasShelfPhoto,
      ownBrandPresent,
      ownProducts,
      competitorProducts,
      goldenFacings,
      frontLabelFacings,
      priceTagTier,
      bannerTier,
      totalShelfFacingCount
    }
  }
}

/**
 * 构建确定性 5 维 detail 文案与默认 summary/issues/suggestions，确保即使 AI 文字重写尚未完成，页面上的数字和文案也 100% 自洽
 */
function buildDeterministicDetailsAndSummary(report, facts, rules) {
  const ownFacingCount = facts.ownProducts.reduce((s, p) => s + p.facingCount, 0)
  if (!facts.hasShelfPhoto) {
    report.summary = '人工复核确认：本次拜访未拍摄货架陈列照（仅门头或广告物料照），不计入陈列评分。'
    report.issues = []
    report.suggestions = []
    return
  }

  if (ownFacingCount === 0) {
    report.summary = '人工校正确认：货架未发现我方品牌产品（未上柜），请及时跟进铺货上柜。'
    report.issues = [
      {
        severity: 'high',
        category: '在架状态',
        description: '货架未发现我方品牌产品（未上柜）',
        impact: '终端无陈列露出，直接影响门店动销'
      }
    ]
    report.suggestions = [
      {
        priority: 'high',
        action: '立即与店主沟通推进我方核心品规铺货上柜，争取黄金视线位陈列',
        expectedEffect: '实现终端破零上柜',
        deadline: '本周内'
      }
    ]
    return
  }

  const dc = report.displayCompliance || {}
  const skuBreakdown = facts.ownProducts
    .map(p => `${[p.brand, p.productLine].filter(Boolean).join('') || '我方产品'}×${p.facingCount}面`)
    .join('、')

  if (dc.facingCount) {
    dc.facingCount.detail = `人工校正：正面可见我方产品共 ${ownFacingCount} 个排面（${skuBreakdown}），得 ${dc.facingCount.score}/${rules.facingMaxScore} 分。`
  }
  if (dc.goldenPosition) {
    const ratio = round1((facts.goldenFacings / ownFacingCount) * 100)
    const capSuffix = (report.metadata && report.metadata.framingType === 'closeup')
      ? '（局部特写按规则封顶）'
      : ''
    dc.goldenPosition.detail = `人工校正：${ownFacingCount} 个我方排面中有 ${facts.goldenFacings} 个位于黄金视线层（占比 ${ratio}%），得 ${dc.goldenPosition.score}/${rules.goldenPositionMaxScore} 分${capSuffix}。`
  }
  if (dc.labelOrientation) {
    const ratio = round1((facts.frontLabelFacings / ownFacingCount) * 100)
    dc.labelOrientation.detail = `人工校正：${ownFacingCount} 瓶我方产品中 ${facts.frontLabelFacings} 瓶正标完全朝外（占比 ${ratio}%），得 ${dc.labelOrientation.score}/${rules.labelOrientationMaxScore} 分。`
  }
  if (dc.priceTag) {
    const tierDesc = facts.priceTagTier === 'good'
      ? '我方陈列区有清晰完好、价格数字可读的价签'
      : (facts.priceTagTier === 'mid' ? '有价签但存在遮挡/模糊/偏离' : '未见有效价签')
    dc.priceTag.detail = `人工校正：${tierDesc}，得 ${dc.priceTag.score}/${rules.priceTagMaxScore} 分。`
  }
  if (dc.horizontalBanner) {
    const tierDesc = facts.bannerTier === 'good'
      ? '我方陈列上下沿有清晰完好的我方横签'
      : (facts.bannerTier === 'mid' ? '有我方横签但存在破损/遮挡/偏离' : '未发现我方横签')
    dc.horizontalBanner.detail = `人工校正：${tierDesc}，得 ${dc.horizontalBanner.score}/${rules.horizontalBannerMaxScore} 分。`
  }

  // 生成确定性 issues / suggestions / summary（后台 AI 重写成功后会更新更丰富的文案）
  const issues = []
  const suggestions = []
  if (ownFacingCount < rules.facingTarget) {
    const gap = rules.facingTarget - ownFacingCount
    issues.push({
      severity: ownFacingCount < Math.ceil(rules.facingTarget / 2) ? 'high' : 'medium',
      category: '排面数量',
      description: `我方正面可见排面 ${ownFacingCount} 面，距离满分目标（${rules.facingTarget} 面）尚差 ${gap} 面`,
      impact: '货架陈列体量与视觉冲击力有待提升'
    })
    suggestions.push({
      priority: 'high',
      action: `争取扩充 ${gap} 个我方正面排面至 ${rules.facingTarget} 面以上`,
      expectedEffect: `排面维度可提升至满分 ${rules.facingMaxScore} 分`,
      deadline: '下次拜访'
    })
  }
  if (facts.goldenFacings < Math.ceil(ownFacingCount * 0.8)) {
    issues.push({
      severity: 'medium',
      category: '黄金位置',
      description: `黄金视线层排面占比 ${round1((facts.goldenFacings / ownFacingCount) * 100)}%（${facts.goldenFacings}/${ownFacingCount}面），未达 80% 满分线`,
      impact: '消费者平视第一眼拦截率受限'
    })
    suggestions.push({
      priority: 'medium',
      action: '将偏高或偏低层的我方产品调换至货架中上黄金视线层',
      expectedEffect: '提升黄金位置得分与自然动销率',
      deadline: '当日'
    })
  }
  if (facts.frontLabelFacings < ownFacingCount) {
    const bad = ownFacingCount - facts.frontLabelFacings
    issues.push({
      severity: 'low',
      category: '正标朝向',
      description: `有 ${bad} 瓶我方产品存在侧摆或背标朝外`,
      impact: '品牌主视觉露出不完整'
    })
    suggestions.push({
      priority: 'medium',
      action: `随手理货，将 ${bad} 瓶偏转酒瓶转正使正标完全朝外`,
      expectedEffect: `正标朝向可得满分 ${rules.labelOrientationMaxScore} 分`,
      deadline: '当日'
    })
  }
  if (facts.priceTagTier !== 'good') {
    issues.push({
      severity: facts.priceTagTier === 'none' ? 'medium' : 'low',
      category: '价签规范',
      description: facts.priceTagTier === 'none' ? '我方产品陈列区缺少价签' : '我方价签存在遮挡或模糊',
      impact: '消费者选购缺少明确价格指引'
    })
    suggestions.push({
      priority: 'high',
      action: '在我方产品瓶颈或层板下沿补齐清晰完好的标准价签',
      expectedEffect: `价签规范项可得满分 ${rules.priceTagMaxScore} 分`,
      deadline: '当日'
    })
  }
  if (facts.bannerTier !== 'good') {
    issues.push({
      severity: facts.bannerTier === 'none' ? 'high' : 'medium',
      category: '横签露出',
      description: facts.bannerTier === 'none' ? '我方陈列上下沿未张贴我方横签' : '我方横签存在卷曲、遮挡或偏离',
      impact: '缺少品牌专属陈列边界与视觉聚焦'
    })
    suggestions.push({
      priority: 'high',
      action: '在我方陈列层下沿平整张贴我方标准横签',
      expectedEffect: `横签露出项可得满分 ${rules.horizontalBannerMaxScore} 分`,
      deadline: '当日'
    })
  }

  report.issues = issues
  report.suggestions = suggestions

  const shortDims = issues.map(i => i.category).slice(0, 2)
  const shortText = shortDims.length > 0 ? `主要短板在于${shortDims.join('与')}，请按建议逐项改进。` : '各项陈列规范表现优异，请继续保持。'
  report.summary = `我方品牌在架共 ${ownFacingCount} 个正面排面（${facts.ownProducts.length} 个品规：${skuBreakdown}），总分 ${report.score} 分（${report.scoreLevel}）；${shortText}`
}

/**
 * 基于人工校正后的 facts 与基础报告，通过服务端统一评分公式构建全新的权威 aiReport
 */
function buildCorrectedReport(baseReport, validatedFacts, ctx = {}) {
  const base = (baseReport && typeof baseReport === 'object') ? baseReport : {}
  const rules = normalizeScoringRules(ctx.scoringRules || base.scoringRulesUsed)
  const activeMaterials = Array.isArray(ctx.activeMaterials) ? ctx.activeMaterials : []
  const ownBrandNames = ctx.ownBrandNames || new Set()
  const revision = Number.isFinite(Number(ctx.revision)) ? Math.max(1, Math.round(Number(ctx.revision))) : 1
  const knowledgeVersion = Number.isFinite(Number(ctx.knowledgeVersion)) ? Math.round(Number(ctx.knowledgeVersion)) : 1

  const productIdentification = [
    ...validatedFacts.ownProducts.map(p => ({
      ...(p.productId ? { productId: p.productId } : {}),
      brand: p.brand,
      productLine: p.productLine,
      isOwn: true,
      aromaType: p.aromaType || '清香型',
      priceRange: p.priceRange || '大众',
      facingCount: p.facingCount,
      position: p.position || '中层',
      confidence: 1
    })),
    ...validatedFacts.competitorProducts.map(p => ({
      brand: p.brand,
      productLine: p.productLine,
      isOwn: false,
      aromaType: p.aromaType || '',
      priceRange: p.priceRange || '大众',
      facingCount: p.facingCount,
      position: p.position || '中层',
      confidence: p.confidence != null ? p.confidence : 0.95
    }))
  ]

  const ownFacingCount = validatedFacts.ownProducts.reduce((s, p) => s + p.facingCount, 0)
  const priceTagScore = tierToScore(validatedFacts.priceTagTier, rules.priceTagMaxScore)
  const bannerScore = tierToScore(validatedFacts.bannerTier, rules.horizontalBannerMaxScore)

  // 处理 adMaterials 与横签三档的一致性：
  // 若人工把横签改为 'none'，剔除原有货架区我方横签条目，避免 validateAndNormalizeReport 触发“横签0分但物料存在”的矛盾回弹
  let adMaterials = Array.isArray(base.adMaterials)
    ? base.adMaterials.map(m => (m && typeof m === 'object' ? { ...m } : m)).filter(Boolean)
    : []
  if (validatedFacts.bannerTier === 'none') {
    adMaterials = adMaterials.filter(m => !isOwnHorizontalBannerEntry(m))
  } else if (validatedFacts.bannerTier === 'mid') {
    adMaterials = adMaterials.map(m => {
      if (isOwnHorizontalBannerEntry(m)) {
        return { ...m, condition: '破损/遮挡' }
      }
      return m
    })
  } else if (validatedFacts.bannerTier === 'good') {
    adMaterials = adMaterials.map(m => {
      if (isOwnHorizontalBannerEntry(m)) {
        return { ...m, condition: '完好', position: '我方陈列区' }
      }
      return m
    })
  }

  // 重新汇总 competitiveAnalysis.brands 排面占比
  const totalFacings = validatedFacts.totalShelfFacingCount ||
    productIdentification.reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
  const brandFacingsMap = new Map()
  productIdentification.forEach(p => {
    const bName = String(p.brand || (p.isOwn ? '我方品牌' : '其他竞品')).trim()
    const key = `${p.isOwn ? 'own' : 'comp'}:${bName}`
    const prev = brandFacingsMap.get(key) || { brand: bName, isOwn: Boolean(p.isOwn), facings: 0, hasGolden: false }
    prev.facings += Number(p.facingCount) || 0
    if (/黄金/.test(String(p.position || ''))) prev.hasGolden = true
    brandFacingsMap.set(key, prev)
  })
  const brands = Array.from(brandFacingsMap.values()).map(b => ({
    brand: b.brand,
    isOwn: b.isOwn,
    sharePercent: totalFacings > 0 ? round1((b.facings / totalFacings) * 100) : null,
    positionAdvantage: b.hasGolden ? 'high' : 'medium'
  }))

  // 构造传给 validateAndNormalizeReport 的候选对象（去除旧 shelfObservations 防跨图去重旧值干扰）
  const baseMeta = (base.metadata && typeof base.metadata === 'object') ? { ...base.metadata } : {}
  const candidate = {
    ...base,
    hasShelfPhoto: validatedFacts.hasShelfPhoto,
    ownBrandPresent: validatedFacts.ownBrandPresent,
    shelfObservations: undefined,
    productIdentification,
    adMaterials,
    facingMetrics: {
      ownFacingCount,
      ownSkuCount: validatedFacts.ownProducts.length,
      totalShelfFacingCount: validatedFacts.totalShelfFacingCount,
      countingConfidence: 1
    },
    displayCompliance: {
      facingCount: {
        observedFacings: ownFacingCount
      },
      goldenPosition: {
        goldenFacings: validatedFacts.goldenFacings,
        totalOwnFacings: ownFacingCount
      },
      labelOrientation: {
        frontLabelFacings: validatedFacts.frontLabelFacings,
        totalOwnFacings: ownFacingCount
      },
      priceTag: {
        score: priceTagScore
      },
      horizontalBanner: {
        score: bannerScore
      }
    },
    competitiveAnalysis: {
      ...(base.competitiveAnalysis || {}),
      totalBrands: brands.length || 1,
      brands
    },
    metadata: {
      ...baseMeta,
      parseError: false
    }
  }

  // 校正后的报告不再执行易混淆硬拦截或启发式价签保底（因管理员已亲手确认了全部事实）
  const normalized = validateAndNormalizeReport(candidate, base.rawResponse || '', {
    activeMaterials,
    scoringRules: rules,
    ownBrandNames,
    confusables: [],
    isHumanCorrected: true
  })

  // 覆盖确定性 detail 文案与默认总结
  buildDeterministicDetailsAndSummary(normalized, validatedFacts, rules)

  // 覆盖校正后的权威元信息
  if (normalized.facingMetrics && validatedFacts.hasShelfPhoto) {
    normalized.facingMetrics.countingConfidence = 1
  }
  normalized.metadata = {
    ...(normalized.metadata || {}),
    needsReview: false,
    scoreReliability: 'high',
    reviewLevel: 'high',
    qualityFlags: [],
    reviewReasons: ['已人工校正'],
    consistencyAdjustments: [],
    corrected: true,
    correctedRevision: revision,
    knowledgeVersion,
    promptVersion: PROMPT_VERSION
  }

  return normalized
}

/**
 * 对比校正前后 facts，生成结构化变更明细（写入 reviewLogs.changes，供 AI 复盘统计与聚类）
 * @param {object} beforeFacts
 * @param {object} afterFacts
 * @param {Array}  userAnnotations 前端传入的逐项原因标注：
 *   [{ type, slotKey?, productId?, sku?, reason?, actualProduct?, photoIndex? }]
 */
function diffFacts(beforeFacts, afterFacts, userAnnotations = []) {
  const before = beforeFacts || extractFacts({})
  const after = afterFacts || extractFacts({})
  const annotations = Array.isArray(userAnnotations) ? userAnnotations : []
  const changes = []

  const findAnnotation = (predicate) => annotations.find(a => a && predicate(a)) || null

  const beforeOwnByKey = new Map()
  ;(before.ownProducts || []).forEach((p, idx) => {
    const key = p.slotKey || `own_${idx}`
    beforeOwnByKey.set(key, p)
  })
  const afterOwnByKey = new Map()
  ;(after.ownProducts || []).forEach((p, idx) => {
    const key = p.slotKey || `own_${idx}`
    afterOwnByKey.set(key, p)
  })

  // 1. 原被 AI 识别为我方，但管理员移除了（或转为竞品）：false_own
  for (const [key, bItem] of beforeOwnByKey.entries()) {
    if (!afterOwnByKey.has(key)) {
      const skuName = [bItem.brand, bItem.productLine].filter(Boolean).join(' ')
      const ann = findAnnotation(a =>
        (a.slotKey && a.slotKey === key) ||
        (a.type === 'false_own' && a.sku === skuName)
      )
      changes.push({
        type: 'false_own',
        slotKey: key,
        productId: bItem.productId || '',
        sku: skuName,
        aiValue: { brand: bItem.brand, productLine: bItem.productLine, facingCount: bItem.facingCount },
        humanValue: null,
        aiConfidence: bItem.confidence != null ? bItem.confidence : null,
        reason: (ann && ann.reason) || 'look_alike',
        actualProduct: (ann && ann.actualProduct) ? String(ann.actualProduct).trim() : '',
        photoIndex: (ann && Number.isFinite(Number(ann.photoIndex))) ? Number(ann.photoIndex) : 1
      })
    }
  }

  // 2. 新增的我方产品（slotKey 不在 beforeOwnByKey 中）：missed_own 或 own_as_competitor
  for (const [key, aItem] of afterOwnByKey.entries()) {
    if (!beforeOwnByKey.has(key)) {
      const skuName = [aItem.brand, aItem.productLine].filter(Boolean).join(' ')
      const isFromComp = /^comp_/.test(key)
      const ann = findAnnotation(a =>
        (a.slotKey && a.slotKey === key) ||
        ((a.type === 'missed_own' || a.type === 'own_as_competitor') &&
          (a.productId === aItem.productId || a.sku === skuName))
      )
      const changeType = (ann && ann.type === 'own_as_competitor') || isFromComp
        ? 'own_as_competitor'
        : 'missed_own'
      changes.push({
        type: changeType,
        slotKey: key,
        productId: aItem.productId || '',
        sku: skuName,
        aiValue: (ann && ann.aiValue) || null,
        humanValue: { brand: aItem.brand, productLine: aItem.productLine, facingCount: aItem.facingCount, position: aItem.position },
        aiConfidence: null,
        reason: (ann && ann.reason) || 'side_or_back_facing',
        actualProduct: (ann && ann.actualProduct) ? String(ann.actualProduct).trim() : '',
        photoIndex: (ann && Number.isFinite(Number(ann.photoIndex))) ? Number(ann.photoIndex) : 1
      })
    }
  }

  // 判断是否存在新增/补增的其他我方品规（用于区分「同系品规吞并混淆 sku_misclassified」与「纯纵深重计 depth_double_count」）
  const hasAddedOrIncreasedOtherOwnSku = changes.some(c => c.type === 'missed_own' || c.type === 'own_as_competitor') ||
    Array.from(afterOwnByKey.entries()).some(([k, aIt]) => {
      const bIt = beforeOwnByKey.get(k)
      return bIt && aIt.facingCount > bIt.facingCount
    })

  // 3. 同一 slotKey 保留但我方品规或排面数发生变化
  for (const [key, aItem] of afterOwnByKey.entries()) {
    const bItem = beforeOwnByKey.get(key)
    if (!bItem) continue
    const bSku = [bItem.brand, bItem.productLine].filter(Boolean).join(' ')
    const aSku = [aItem.brand, aItem.productLine].filter(Boolean).join(' ')
    if ((bItem.productId && aItem.productId && bItem.productId !== aItem.productId) || bSku !== aSku) {
      const ann = findAnnotation(a => a.slotKey === key && a.type === 'wrong_sku')
      changes.push({
        type: 'wrong_sku',
        slotKey: key,
        productId: aItem.productId || '',
        sku: aSku,
        aiValue: bSku,
        humanValue: aSku,
        aiConfidence: bItem.confidence != null ? bItem.confidence : null,
        reason: (ann && ann.reason) || 'series_look_alike',
        actualProduct: aSku,
        photoIndex: (ann && Number.isFinite(Number(ann.photoIndex))) ? Number(ann.photoIndex) : 1
      })
    }
    if (bItem.facingCount !== aItem.facingCount) {
      const ann = findAnnotation(a => (a.slotKey === key || a.type === 'facing_count'))
      const defaultFacingReason = aItem.facingCount < bItem.facingCount
        ? (hasAddedOrIncreasedOtherOwnSku ? 'sku_misclassified' : 'depth_double_count')
        : 'missed_facing'
      changes.push({
        type: 'facing_count',
        slotKey: key,
        productId: aItem.productId || bItem.productId || '',
        sku: aSku,
        aiValue: bItem.facingCount,
        humanValue: aItem.facingCount,
        delta: aItem.facingCount - bItem.facingCount,
        aiConfidence: bItem.confidence != null ? bItem.confidence : null,
        reason: (ann && ann.reason) || defaultFacingReason,
        actualProduct: '',
        photoIndex: (ann && Number.isFinite(Number(ann.photoIndex))) ? Number(ann.photoIndex) : 1
      })
    }
  }

  // 4. 在架状态翻转
  if (Boolean(before.ownBrandPresent) !== Boolean(after.ownBrandPresent)) {
    changes.push({
      type: 'presence',
      productId: '',
      sku: '',
      aiValue: Boolean(before.ownBrandPresent),
      humanValue: Boolean(after.ownBrandPresent),
      aiConfidence: null,
      reason: after.ownBrandPresent ? 'missed_all_own' : 'all_false_own',
      actualProduct: '',
      photoIndex: 1
    })
  }

  // 5. 细项变更：golden / label / price_tag / banner
  // 过滤纯因我方总排面分母变化而被动同步裁剪（如 4/4 -> 3/3 占比同为 100%）的假性细项报错，避免污染复盘聚类
  const beforeOwnTotal = (before.ownProducts || []).reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
  const afterOwnTotal = (after.ownProducts || []).reduce((s, p) => s + (Number(p.facingCount) || 0), 0)
  if (after.ownBrandPresent) {
    if (before.goldenFacings !== after.goldenFacings) {
      const ann = findAnnotation(a => a.type === 'golden')
      const sameGoldenRatio = !ann &&
        beforeOwnTotal > 0 &&
        afterOwnTotal > 0 &&
        Math.abs((before.goldenFacings / beforeOwnTotal) - (after.goldenFacings / afterOwnTotal)) < 1e-6
      if (!sameGoldenRatio) {
        changes.push({
          type: 'golden',
          productId: '',
          sku: '',
          aiValue: before.goldenFacings,
          humanValue: after.goldenFacings,
          aiConfidence: null,
          reason: (ann && ann.reason) || 'layer_misjudged',
          actualProduct: '',
          photoIndex: 1
        })
      }
    }
    if (before.frontLabelFacings !== after.frontLabelFacings) {
      const ann = findAnnotation(a => a.type === 'label')
      const sameLabelRatio = !ann &&
        beforeOwnTotal > 0 &&
        afterOwnTotal > 0 &&
        Math.abs((before.frontLabelFacings / beforeOwnTotal) - (after.frontLabelFacings / afterOwnTotal)) < 1e-6
      if (!sameLabelRatio) {
        changes.push({
          type: 'label',
          productId: '',
          sku: '',
          aiValue: before.frontLabelFacings,
          humanValue: after.frontLabelFacings,
          aiConfidence: null,
          reason: (ann && ann.reason) || 'orientation_misjudged',
          actualProduct: '',
          photoIndex: 1
        })
      }
    }
    if (before.priceTagTier !== after.priceTagTier) {
      const ann = findAnnotation(a => a.type === 'price_tag')
      changes.push({
        type: 'price_tag',
        productId: '',
        sku: '',
        aiValue: before.priceTagTier,
        humanValue: after.priceTagTier,
        aiConfidence: null,
        reason: (ann && ann.reason) || 'pricetag_misjudged',
        actualProduct: '',
        photoIndex: 1
      })
    }
    if (before.bannerTier !== after.bannerTier) {
      const ann = findAnnotation(a => a.type === 'banner')
      changes.push({
        type: 'banner',
        productId: '',
        sku: '',
        aiValue: before.bannerTier,
        humanValue: after.bannerTier,
        aiConfidence: null,
        reason: (ann && ann.reason) || 'banner_misjudged',
        actualProduct: '',
        photoIndex: 1
      })
    }
  }

  return changes
}

module.exports = {
  ALLOWED_TIERS,
  ALLOWED_POSITIONS,
  scoreToTier,
  tierToScore,
  matchProductInLibrary,
  extractFacts,
  validateFacts,
  buildCorrectedReport,
  diffFacts
}
