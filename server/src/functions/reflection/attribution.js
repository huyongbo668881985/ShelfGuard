'use strict'

// ============================================================
// 定期 AI 复盘 · 第二阶段：聚类归因与提案校验
// - attributeErrorCluster(cluster, knowledgeSnapshot, options)
// - validateAndNormalizeProposal(rawProposal, cluster, knowledgeSnapshot)
// - buildFallbackAttribution(cluster, knowledgeSnapshot)
// ============================================================

const cloud = require('../../cloud-shim')
const {
  ALLOWED_REFLECTION_FIX_TYPES,
  REFLECTION_ATTRIBUTION_SYSTEM_PROMPT,
  buildReflectionClusterUserPrompt
} = require('../analyzeImage/prompt')
const { normalizeReviewThresholds } = require('../analyzeImage/scoring')
const { _internal: analyzeInternal } = require('../analyzeImage/index')

const db = cloud.database()
const ALLOWED_FIX_SET = new Set(ALLOWED_REFLECTION_FIX_TYPES)

function parseAttributionJson(text) {
  let jsonStr = String(text || '').trim()
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) jsonStr = jsonMatch[1].trim()
  if (!jsonStr.startsWith('{') || !jsonStr.endsWith('}')) {
    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start !== -1 && end > start) {
      jsonStr = jsonStr.slice(start, end + 1)
    }
  }
  return JSON.parse(jsonStr)
}

/**
 * 校验单条提案的 fixType 白名单、target 实体真实存在性与 payload 长度边界
 * 返回规范化后的提案对象；不合法则返回 null
 */
function validateAndNormalizeProposal(raw, cluster, knowledgeSnapshot = {}, idx = 0) {
  if (!raw || typeof raw !== 'object') return null
  const fixType = String(raw.fixType || '').trim()
  if (!ALLOWED_FIX_SET.has(fixType)) return null

  const target = (raw.target && typeof raw.target === 'object') ? { ...raw.target } : {}
  const payload = (raw.payload && typeof raw.payload === 'object') ? { ...raw.payload } : {}
  const products = Array.isArray(knowledgeSnapshot.products) ? knowledgeSnapshot.products : []
  const confusables = Array.isArray(knowledgeSnapshot.confusableProducts) ? knowledgeSnapshot.confusableProducts : []
  const materials = Array.isArray(knowledgeSnapshot.adMaterials) ? knowledgeSnapshot.adMaterials : []
  const learnedRules = Array.isArray(knowledgeSnapshot.learnedRules) ? knowledgeSnapshot.learnedRules : []

  const findProduct = (id) => products.find(p => p && String(p._id) === String(id))
  const findConfusable = (id) => confusables.find(c => c && String(c._id) === String(id))
  const findMaterial = (id) => materials.find(m => m && String(m._id) === String(id))
  const findRule = (id) => learnedRules.find(r => r && String(r.id) === String(id))

  let summary = ''
  let replayable = true

  switch (fixType) {
    case 'confusable_add': {
      const competitorName = String(payload.competitorName || (cluster && cluster.actualProduct) || '').trim().slice(0, 60)
      if (!competitorName || competitorName === '未注明竞品' || competitorName === '其他酒水') return null
      const competitorBrand = String(payload.competitorBrand || '').trim().slice(0, 40)
      const distinguishingFeatures = String(payload.distinguishingFeatures || '').trim().slice(0, 160)
      if (!distinguishingFeatures) return null
      const lookId = String(target.lookalikeProductId || (cluster && cluster.productId) || '').trim()
      const lookProd = lookId ? findProduct(lookId) : null
      target.lookalikeProductId = lookProd ? String(lookProd._id) : ''
      payload.competitorName = competitorName
      payload.competitorBrand = competitorBrand
      payload.distinguishingFeatures = distinguishingFeatures
      payload.lookalikeProductName = lookProd
        ? [lookProd.brandName, lookProd.productLine].filter(Boolean).join(' ')
        : String((cluster && cluster.sku) || '')
      summary = `新增易混淆竞品「${[competitorBrand, competitorName].filter(Boolean).join(' ')}」及区分要点`
      break
    }

    case 'confusable_update': {
      const cid = String(target.confusableId || '').trim()
      const confDoc = cid ? findConfusable(cid) : null
      if (!confDoc) return null
      const distinguishingFeatures = String(payload.distinguishingFeatures || '').trim().slice(0, 160)
      if (!distinguishingFeatures) return null
      target.confusableId = String(confDoc._id)
      payload.distinguishingFeatures = distinguishingFeatures
      summary = `更新易混淆竞品「${confDoc.competitorName}」区分特征`
      break
    }

    case 'product_confusion_notes': {
      const pid = String(target.productId || (cluster && cluster.productId) || '').trim()
      const prod = pid ? findProduct(pid) : null
      if (!prod) return null
      const notes = String(payload.confusionNotes || '').trim().slice(0, 140)
      if (!notes) return null
      target.productId = String(prod._id)
      payload.confusionNotes = notes
      const label = [prod.brandName, prod.productLine].filter(Boolean).join(' ')
      summary = `补充我方「${label}」区分要点`
      break
    }

    case 'product_visual_features': {
      const pid = String(target.productId || (cluster && cluster.productId) || '').trim()
      const prod = pid ? findProduct(pid) : null
      if (!prod) return null
      const vf = String(payload.visualFeatures || '').trim().slice(0, 160)
      if (!vf) return null
      target.productId = String(prod._id)
      payload.visualFeatures = vf
      const label = [prod.brandName, prod.productLine].filter(Boolean).join(' ')
      summary = `补充我方「${label}」瓶身视觉特征`
      break
    }

    case 'ref_priority': {
      const pid = String(target.productId || (cluster && cluster.productId) || '').trim()
      const prod = pid ? findProduct(pid) : null
      if (!prod) return null
      const prio = Number.isFinite(Number(payload.refPriority))
        ? Math.max(1, Math.min(100, Math.round(Number(payload.refPriority))))
        : ((Number(prod.refPriority) || 0) + 10)
      target.productId = String(prod._id)
      payload.refPriority = prio
      const label = [prod.brandName, prod.productLine].filter(Boolean).join(' ')
      summary = `提升我方「${label}」参考图优先级至 ${prio}`
      break
    }

    case 'alias_remove': {
      const pid = String(target.productId || (cluster && cluster.productId) || '').trim()
      const prod = pid ? findProduct(pid) : null
      if (!prod) return null
      const alias = String(payload.alias || '').trim()
      const currentAliases = Array.isArray(prod.aliases) ? prod.aliases : []
      if (!alias || !currentAliases.includes(alias)) return null
      target.productId = String(prod._id)
      payload.alias = alias
      const label = [prod.brandName, prod.productLine].filter(Boolean).join(' ')
      summary = `移除「${label}」过宽别名「${alias}」`
      break
    }

    case 'material_visual_features': {
      const mid = String(target.materialId || '').trim()
      const mat = mid ? findMaterial(mid) : materials[0]
      if (!mat) return null
      const vf = String(payload.visualFeatures || '').trim().slice(0, 160)
      if (!vf) return null
      target.materialId = String(mat._id)
      payload.visualFeatures = vf
      summary = `补充物料「${mat.materialName}」视觉特征`
      break
    }

    case 'learned_rule_add': {
      const ruleText = String(payload.rule || '').trim().slice(0, 120)
      if (!ruleText) return null
      payload.rule = ruleText
      payload.category = String(payload.category || (cluster && cluster.errorType) || 'general').trim()
      summary = `新增复盘规则补丁：${ruleText.slice(0, 28)}${ruleText.length > 28 ? '…' : ''}`
      break
    }

    case 'learned_rule_retire': {
      const rid = String(target.ruleId || '').trim()
      const rDoc = rid ? findRule(rid) : null
      if (!rDoc) return null
      target.ruleId = String(rDoc.id)
      summary = `下线规则补丁「${String(rDoc.rule || '').slice(0, 24)}」`
      break
    }

    case 'confusable_retire': {
      const cid = String(target.confusableId || '').trim()
      const confDoc = cid ? findConfusable(cid) : null
      if (!confDoc) return null
      target.confusableId = String(confDoc._id)
      summary = `下线易混淆竞品「${confDoc.competitorName}」`
      break
    }

    case 'threshold_adjust': {
      const normalized = normalizeReviewThresholds(payload)
      Object.assign(payload, normalized)
      summary = `调整复核阈值（低置信<${normalized.lowCountingConfidence}，中置信<${normalized.midCountingConfidence}）`
      break
    }

    case 'product_ref_photo': {
      const pid = String(target.productId || (cluster && cluster.productId) || '').trim()
      const prod = pid ? findProduct(pid) : null
      if (!prod) return null
      target.productId = String(prod._id)
      payload.slot = ['front', 'side', 'back'].includes(payload.slot) ? payload.slot : 'side'
      payload.reason = String(payload.reason || '补拍侧面/背面参考照辅助侧摆识别').trim().slice(0, 120)
      const label = [prod.brandName, prod.productLine].filter(Boolean).join(' ')
      summary = `待办：为「${label}」补拍${payload.slot === 'side' ? '侧面' : (payload.slot === 'back' ? '背面' : '正面')}参考照`
      replayable = false
      break
    }

    case 'product_add_todo': {
      payload.suggestedBrand = String(payload.suggestedBrand || '').trim().slice(0, 40)
      payload.suggestedProductLine = String(payload.suggestedProductLine || (cluster && cluster.sku) || '').trim().slice(0, 60)
      payload.reason = String(payload.reason || '现场发现新品或新包装未入产品库').trim().slice(0, 120)
      summary = `待办：在产品库新增/更新「${[payload.suggestedBrand, payload.suggestedProductLine].filter(Boolean).join(' ') || '新包装品规'}」`
      replayable = false
      break
    }

    case 'sales_tip': {
      const tip = String(payload.tip || '').trim().slice(0, 140)
      if (!tip) return null
      payload.tip = tip
      summary = `业务员拍照规范提醒：${tip.slice(0, 28)}…`
      replayable = false
      break
    }

    case 'needs_dev': {
      const suggestion = String(payload.suggestion || '').trim().slice(0, 160)
      if (!suggestion) return null
      payload.suggestion = suggestion
      summary = `需开发介入：${suggestion.slice(0, 28)}…`
      replayable = false
      break
    }

    default:
      return null
  }

  return {
    proposalId: `prop_${(cluster && cluster.clusterKey ? cluster.clusterKey.replace(/[^a-zA-Z0-9_]/g, '_') : 'c')}_${idx + 1}`,
    clusterKey: (cluster && cluster.clusterKey) || '',
    clusterTitle: (cluster && cluster.title) || '',
    fixType,
    summary,
    target,
    payload,
    rationale: String(raw.rationale || '').trim().slice(0, 200),
    evidenceCount: (cluster && cluster.count) || 1,
    evidenceInspectionIds: (cluster && Array.isArray(cluster.inspectionIds)) ? cluster.inspectionIds.slice(0, 5) : [],
    replayable,
    replayResult: null,
    status: 'pending' // pending | approved | rejected
  }
}

/**
 * 确定性归因与提案兜底（当未配 API Key 或复盘模型调用失败时，按错误类型与知识库直接生成精准提案）
 */
function buildFallbackAttribution(cluster, knowledgeSnapshot = {}) {
  const products = Array.isArray(knowledgeSnapshot.products) ? knowledgeSnapshot.products : []
  const findTargetProd = () => {
    if (cluster.productId) {
      const p = products.find(x => x && String(x._id) === String(cluster.productId))
      if (p) return p
    }
    if (cluster.sku) {
      const lower = String(cluster.sku).toLowerCase()
      const p = products.find(x => x && lower.includes(String(x.productLine || x.brandName || '').toLowerCase()))
      if (p) return p
    }
    return products[0] || null
  }

  const targetProd = findTargetProd()
  const rawProposals = []
  let rootCause = 'other'
  let explanation = `该类错误在本周期共发生 ${cluster.count} 次，建议针对性补充区分特征或规则补丁。`

  if (cluster.errorType === 'false_own') {
    rootCause = 'look_alike'
    const actual = cluster.actualProduct && cluster.actualProduct !== '其他酒水' && cluster.actualProduct !== '未注明竞品'
      ? cluster.actualProduct
      : ''
    explanation = actual
      ? `竞品「${actual}」与我方「${cluster.sku || '产品'}」瓶身外观或字样接近，导致模型在${cluster.count}次巡检中误判为我方。`
      : `部分外观相似竞品被误判为我方「${cluster.sku || '产品'}」（共 ${cluster.count} 次）。`

    if (actual) {
      rawProposals.push({
        fixType: 'confusable_add',
        target: { lookalikeProductId: targetProd ? targetProd._id : '' },
        payload: {
          competitorName: actual,
          competitorBrand: '',
          distinguishingFeatures: `注意核对瓶身主商标文字，明确印有「${actual}」字样的为竞品，不得计入我方「${cluster.sku || '产品'}」`
        },
        rationale: '将高频误认竞品加入易混淆竞品库，同时触发提示词警示与服务端硬拦截'
      })
    }
    if (targetProd) {
      rawProposals.push({
        fixType: 'product_confusion_notes',
        target: { productId: targetProd._id },
        payload: {
          confusionNotes: `仅当瓶身清晰可见「${[targetProd.brandName, targetProd.productLine].filter(Boolean).join('')}」标准字样时才判为我方${actual ? `，严禁将「${actual}」混入` : ''}`
        },
        rationale: '在我方产品资料中强化正标防误认特征'
      })
    }
  } else if (cluster.errorType === 'missed_own' || cluster.errorType === 'own_as_competitor') {
    rootCause = cluster.reason || 'side_or_back_facing'
    explanation = `我方「${cluster.sku || '产品'}」在 ${cluster.count} 次巡检中被漏认（主要原因：${rootCause}）。`
    if (targetProd) {
      rawProposals.push({
        fixType: 'product_visual_features',
        target: { productId: targetProd._id },
        payload: {
          visualFeatures: `${targetProd.visualFeatures ? targetProd.visualFeatures + '；' : ''}注意侧摆或背标朝外时结合瓶盖颜色、瓶颈套与瓶型轮廓识别并计入我方排面`
        },
        rationale: '补充侧摆/背标视觉特征，减少因非正面摆放导致的漏认'
      })
      rawProposals.push({
        fixType: 'ref_priority',
        target: { productId: targetProd._id },
        payload: {
          refPriority: (Number(targetProd.refPriority) || 0) + 10
        },
        rationale: '提升该易漏认产品在多模态参考图中的入选优先级'
      })
    }
  } else if (cluster.errorType === 'wrong_sku') {
    rootCause = 'similar_name'
    explanation = `同品牌不同品规之间发生混淆（${cluster.title}，共 ${cluster.count} 次）。`
    if (targetProd) {
      rawProposals.push({
        fixType: 'product_confusion_notes',
        target: { productId: targetProd._id },
        payload: {
          confusionNotes: `注意与同品牌其他系列区分，认准「${targetProd.productLine || targetProd.brandName}」专属酒标字样与配色`
        },
        rationale: '明确同品牌品规间的酒标差异'
      })
    }
  } else if (cluster.errorType === 'facing_count') {
    const isSkuMerged = cluster.reason === 'sku_misclassified'
    rootCause = isSkuMerged ? 'similar_name' : 'depth_double_count'
    explanation = `${cluster.title}（共 ${cluster.count} 次）。`
    if (isSkuMerged && targetProd) {
      rawProposals.push({
        fixType: 'product_confusion_notes',
        target: { productId: targetProd._id },
        payload: {
          confusionNotes: `逐瓶核对瓶身高矮与颈牌数字，切勿将相邻半高矮扁瓶（挂15白底红圈牌）或不同色标品规合并计入「${[targetProd.brandName, targetProd.productLine].filter(Boolean).join(' ')}」`
        },
        rationale: '防止相邻同系矮瓶/其他品规被吞并多计'
      })
    } else {
      rawProposals.push({
        fixType: 'learned_rule_add',
        target: {},
        payload: {
          category: 'facing_count',
          rule: '排面计数只统计货架最前排正面可见瓶数，同品规向后纵深陈列的后排库存严禁重复计入排面数'
        },
        rationale: '强化最前排排面计数口径补丁'
      })
    }
  } else if (cluster.errorType === 'price_tag' || cluster.errorType === 'banner') {
    rootCause = 'banner_or_pricetag_confusion'
    explanation = `${cluster.title}（共 ${cluster.count} 次）。`
    const ruleText = cluster.errorType === 'price_tag'
      ? '我方陈列区只要有清晰可读的瓶颈挂牌价签或层板价签即得满分，勿将非价格促销贴当作价签'
      : '横签露出须对照我方横签参考图与品牌名，竞品横签或未贴横签一律记0分'
    rawProposals.push({
      fixType: 'learned_rule_add',
      target: {},
      payload: {
        category: cluster.errorType,
        rule: ruleText
      },
      rationale: '补充细项判别规则补丁'
    })
  }

  const proposals = rawProposals
    .map((p, i) => validateAndNormalizeProposal(p, cluster, knowledgeSnapshot, i))
    .filter(Boolean)

  return {
    clusterKey: cluster.clusterKey,
    title: cluster.title,
    errorType: cluster.errorType,
    count: cluster.count,
    rootCause,
    explanation,
    samples: cluster.samples || [],
    proposals,
    mode: 'fallback'
  }
}

/**
 * 加载聚类中前 2 个典型错误样本的现场照片 DataURL（供多模态复盘模型看图归因）
 */
async function loadClusterSampleImages(cluster, maxImages = 2) {
  const samples = Array.isArray(cluster && cluster.samples) ? cluster.samples.slice(0, maxImages) : []
  const out = []
  for (const s of samples) {
    if (!s || !s.inspectionId) continue
    try {
      const res = await db.collection('inspections').doc(s.inspectionId).get()
      const doc = res && res.data
      const fileIDs = (doc && Array.isArray(doc.photoFileIDs)) ? doc.photoFileIDs : []
      if (fileIDs.length === 0) continue
      const idx = Math.max(0, Math.min(fileIDs.length - 1, (Number(s.photoIndex) || 1) - 1))
      const fid = fileIDs[idx]
      const fileRes = await cloud.readFilesAsDataUrls({ fileList: [fid] })
      const url = fileRes && fileRes.fileList && fileRes.fileList[0] && fileRes.fileList[0].tempFileURL
      if (url) {
        out.push({
          storeName: s.storeName || (doc && doc.storeName) || '样本门店',
          photoIndex: idx + 1,
          url
        })
      }
    } catch (_) {}
  }
  return out
}

/**
 * 对单个错误聚类调用复盘模型进行深度归因，失败或无 API Key 时自动回退到确定性提案生成
 */
async function attributeErrorCluster(cluster, knowledgeSnapshot = {}, options = {}) {
  const settingsDoc = options.settingsDoc || null
  const baseConfig = analyzeInternal.resolveRuntimeAIConfig(settingsDoc)
  const reflectionModel = (settingsDoc && typeof settingsDoc.reflectionModel === 'string' && settingsDoc.reflectionModel.trim())
    ? settingsDoc.reflectionModel.trim()
    : (baseConfig.model || 'qwen3.8-flash')
  const config = {
    ...baseConfig,
    model: reflectionModel
  }
  const apiKey = await analyzeInternal.resolveApiKey(config, settingsDoc)

  if (!apiKey) {
    return buildFallbackAttribution(cluster, knowledgeSnapshot)
  }

  try {
    const sampleImages = await loadClusterSampleImages(cluster, 2)
    const userPrompt = buildReflectionClusterUserPrompt({ cluster, knowledgeSnapshot })
    const userContent = []
    sampleImages.forEach((img, i) => {
      userContent.push({ text: `【错误样本实拍图 ${i + 1}（门店：${img.storeName}，第 ${img.photoIndex} 张）】` })
      userContent.push({ image: img.url })
    })
    userContent.push({ text: userPrompt })

    const { text } = await analyzeInternal.withHardTimeout(
      analyzeInternal.callQwen(config, apiKey, userContent, REFLECTION_ATTRIBUTION_SYSTEM_PROMPT, {
        enableThinking: false,
        thinkingBudget: 0,
        maxTokens: 2048
      }),
      45 * 1000,
      'AI 复盘聚类归因超时'
    )

    const parsed = parseAttributionJson(text)
    const rawList = (parsed && Array.isArray(parsed.proposals)) ? parsed.proposals : []
    const validProposals = rawList
      .map((p, i) => validateAndNormalizeProposal(p, cluster, knowledgeSnapshot, i))
      .filter(Boolean)

    if (validProposals.length === 0) {
      const fb = buildFallbackAttribution(cluster, knowledgeSnapshot)
      return {
        ...fb,
        rootCause: (parsed && parsed.rootCause) || fb.rootCause,
        explanation: (parsed && parsed.explanation) || fb.explanation
      }
    }

    return {
      clusterKey: cluster.clusterKey,
      title: cluster.title,
      errorType: cluster.errorType,
      count: cluster.count,
      rootCause: String((parsed && parsed.rootCause) || 'other').trim(),
      explanation: String((parsed && parsed.explanation) || '').trim(),
      samples: cluster.samples || [],
      proposals: validProposals,
      mode: 'ai'
    }
  } catch (err) {
    console.warn(`[reflection/attribution] 聚类归因调用失败(${cluster.clusterKey})，降级为确定性提案:`, err.message || err)
    return buildFallbackAttribution(cluster, knowledgeSnapshot)
  }
}

module.exports = {
  parseAttributionJson,
  validateAndNormalizeProposal,
  buildFallbackAttribution,
  attributeErrorCluster
}
