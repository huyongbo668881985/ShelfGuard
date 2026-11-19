// 云函数：analyzeImage
// 功能：AI 视觉分析白酒陈列照片，生成结构化评估报告
//
// 【调用方】
// 1. 小程序端直接调用（即时分析模式，或用户手动重试）——带 OPENID，走完整归属校验
// 2. batchAnalyze 云函数调用（每日集中分析模式）——云函数互调时 OPENID 为空，
//    走内部调用分支跳过归属校验（客户端伪造不了这个身份，见 isInternalCall 注释）
//
// 【Prompt 在哪】
// 全部在同目录 prompt.js，改 Prompt 不用动这个文件。优化建议见 PROMPT_GUIDE.md。

const cloud = require('../../cloud-shim')
const axios = require('axios')
const {
  SYSTEM_PROMPT,
  buildSystemPrompt,
  buildUserPrompt,
  buildMultimodalUserContent,
  DAILY_SUMMARY_SYSTEM_PROMPT,
  buildDailySummaryUserPrompt
} = require('./prompt')
const {
  normalizeScoringRules,
  selectHorizontalBannerRefs,
  selectProductRefs,
  normalizeAdMaterials,
  validateAndNormalizeReport,
  aggregateDailyMetrics,
  mergeDailyReports
} = require('./scoring')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// ============================================================
// AI 模型配置（支持通过环境变量 / settings.global 动态覆盖）
// ============================================================
function parseBoundedIntEnv(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = parseInt(String(raw).trim(), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function parseBoolEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const s = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return fallback
}

const DEFAULT_DASHSCOPE_MODEL = 'qwen3.8-flash'
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_ENABLE_THINKING = true
const DEFAULT_THINKING_BUDGET = 1024
const MAX_PRODUCT_REFS = parseBoundedIntEnv('AI_MAX_PRODUCT_REFS', 4, 0, 8)
const MAX_BANNER_REFS = parseBoundedIntEnv('AI_MAX_BANNER_REFS', 3, 0, 5)
const MAX_TOTAL_IMAGES = parseBoundedIntEnv('AI_MAX_TOTAL_IMAGES', 12, 4, 20)

const AI_CONFIG = {
  qwen: {
    // DashScope 多模态生成接口（qwen-vl 系列与 Qwen3.x 多模态系列通用，不是纯文本接口）。
    // 要识图必须选多模态模型：qwen3.8-flash / qwen3.7-plus / qwen3-vl-plus / qwen-vl-plus 等。
    apiUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: (process.env.DASHSCOPE_MODEL || '').trim() || DEFAULT_DASHSCOPE_MODEL,
    apiKey: process.env.DASHSCOPE_API_KEY || ''
  }
}

const CURRENT_MODEL = 'qwen'

// 采样参数：陈列评分追求稳定可复现，温度压低；输出上限提升至 4096 防大货架 SKU 多时截断 JSON。
const TEMPERATURE = 0.1
const MAX_TOKENS = parseBoundedIntEnv('DASHSCOPE_MAX_TOKENS', DEFAULT_MAX_TOKENS, 1024, 16384)
const ENABLE_THINKING = parseBoolEnv('DASHSCOPE_ENABLE_THINKING', DEFAULT_ENABLE_THINKING)
const THINKING_BUDGET = parseBoundedIntEnv('DASHSCOPE_THINKING_BUDGET', DEFAULT_THINKING_BUDGET, 0, 8192)

// 自建后端已无微信云函数 60 秒硬上限，开启有界思考后留 120s 硬超时 / 110s HTTP 超时。
const AI_HARD_TIMEOUT_MS = parseBoundedIntEnv('DASHSCOPE_HARD_TIMEOUT_MS', 120 * 1000, 30 * 1000, 300 * 1000)
const AI_HTTP_TIMEOUT_MS = Math.min(
  AI_HARD_TIMEOUT_MS - 5000,
  parseBoundedIntEnv('DASHSCOPE_HTTP_TIMEOUT_MS', 110 * 1000, 25 * 1000, 290 * 1000)
)


// ============================================================
// 准入批准 + 按日配额
// ============================================================
const DEFAULT_ANALYZE_DAILY_LIMIT = 50
const _ = db.command

// approved===true 放行；无字段时仅 admin/manager 视为已批准；否则拒绝
function isUserApproved(user) {
  if (!user) return false
  if (user.approved === true) return true
  if (user.approved === undefined || user.approved === null) {
    return user.role === 'admin' || user.role === 'manager'
  }
  return false
}

function beijingDateStr() {
  const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const y = beijing.getUTCFullYear()
  const m = String(beijing.getUTCMonth() + 1).padStart(2, '0')
  const d = String(beijing.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

async function getAnalyzeDailyLimit() {
  try {
    const res = await db.collection('settings').doc('global').get()
    const n = res.data && res.data.analyzeDailyLimit
    if (typeof n === 'number' && n > 0 && n < 10000) return Math.floor(n)
  } catch (e) { /* settings 可能不存在 */ }
  return DEFAULT_ANALYZE_DAILY_LIMIT
}

/** 按 openid + 北京自然日计数；确定性 _id 防并发双文档；超限返回 ok:false */
async function checkAndIncAnalyzeQuota(openid) {
  const limit = await getAnalyzeDailyLimit()
  const date = beijingDateStr()
  // 微信云库 doc id 允许字母数字下划线；openid 本身为安全字符
  const docId = `${openid}_${date}`
  const col = db.collection('analyzeQuota')
  try {
    let count = 0
    try {
      const existing = await col.doc(docId).get()
      count = (existing.data && existing.data.count) || 0
    } catch (e) {
      // 文档不存在：首次写入
      count = 0
    }
    if (count >= limit) {
      return { ok: false, count, limit, date }
    }
    try {
      await col.doc(docId).update({
        data: { count: _.inc(1), updatedAt: db.serverDate() }
      })
      return { ok: true, count: count + 1, limit, date }
    } catch (updErr) {
      // 不存在则 set；若并发双 set，后写覆盖但 count 从 1 起，可接受；再失败则 softFail
      try {
        await col.doc(docId).set({
          data: {
            _openid: openid,
            date,
            count: 1,
            updatedAt: db.serverDate()
          }
        })
        return { ok: true, count: 1, limit, date }
      } catch (setErr) {
        console.warn('[analyzeQuota] 配额写入失败，本次放行:', setErr.message)
        return { ok: true, count: -1, limit, date, softFail: true }
      }
    }
  } catch (err) {
    console.warn('[analyzeQuota] 配额计数失败，本次放行:', err.message)
    return { ok: true, count: -1, limit, date, softFail: true }
  }
}

// ============================================================
// 云函数入口
// ============================================================
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()

  // 全天巡检汇总结论分析（每日综合分析模式）
  if (event.action === 'dailySummary') {
    return await handleDailySummary(event, wxContext)
  }

  // 兼容两种入参：
  // - fileIDs: string[]  推荐，一次巡检的多张照片一起分析，得到一份合并报告
  // - fileID:  string    旧版单图入参，仍然支持
  const { fileID, fileIDs, inspectionId } = event

  if (!inspectionId) {
    return { success: false, error: '缺少必要参数 inspectionId' }
  }

  // 归属校验：云函数以管理员权限运行，会绕过数据库安全规则，如果不在这里显式校验，
  // 任何登录用户理论上都能传一个别人的 inspectionId，把自己的分析结果写进别人的巡检
  // 记录里（越权写入）。这里只允许"记录本人"或"管理者角色"触发分析。
  //
  // isInternalCall：云函数之间互相调用（batchAnalyze → analyzeImage）以及定时触发时，
  // wxContext.OPENID 为空字符串。而小程序端调用时 OPENID 一定有值——这是微信云开发在
  // 服务端注入的，客户端无法伪造、也无法清空。所以"OPENID 为空"可以安全地作为
  // "调用来自云端内部"的判据，不需要额外的密钥。
  const callerOpenid = wxContext.OPENID || ''
  const isInternalCall = !callerOpenid

  // 停用账号拦截：业务员账号被管理员停用后，由本人发起的分析一律拒绝。
  // 云端内部调用（batchAnalyze 定时跑）不受此限——否则停用的号留下的待分析
  // 记录永远跑不完，反而越积越多。callerUser 顺带给下面的归属校验复用。
  let callerUser = null
  if (!isInternalCall) {
    const callerRes = await db.collection('users').where({ _openid: callerOpenid }).get()
    callerUser = callerRes.data[0] || null
    if (callerUser && callerUser.disabled) {
      return { success: false, error: '账号已停用，无法进行分析' }
    }
    if (!isUserApproved(callerUser)) {
      return { success: false, error: '等待管理员审批', code: 'NOT_APPROVED' }
    }
  }

  let inspectionDoc
  try {
    const inspectionRes = await db.collection('inspections').doc(inspectionId).get()
    inspectionDoc = inspectionRes.data
  } catch (err) {
    return { success: false, error: '拜访记录不存在' }
  }
  if (!inspectionDoc) {
    return { success: false, error: '拜访记录不存在' }
  }

  if (!isInternalCall && inspectionDoc._openid !== callerOpenid) {
    const callerRole = callerUser ? callerUser.role : 'sales'
    if (callerRole !== 'admin' && callerRole !== 'manager') {
      console.warn(`拒绝越权分析请求: caller=${callerOpenid} 试图分析 inspection=${inspectionId}（属于 ${inspectionDoc._openid}）`)
      return { success: false, error: '无权操作该拜访记录' }
    }
  }

  // 待分析的图片：调用方没传就用巡检记录里存的全部照片（batchAnalyze 走的就是这条路）
  const idsToAnalyze = Array.isArray(fileIDs) && fileIDs.length > 0
    ? fileIDs
    : (fileID ? [fileID] : (inspectionDoc.photoFileIDs || []))

  if (idsToAnalyze.length === 0) {
    return { success: false, error: '该拜访记录没有可分析的照片' }
  }

  // fileIDs 也做一层归属校验：只允许分析这条巡检记录自己名下的照片，
  // 避免调用方夹带其他来源的 fileID 混进同一份报告
  const allowedFileIDs = new Set(inspectionDoc.photoFileIDs || [])
  const invalidIds = idsToAnalyze.filter(id => !allowedFileIDs.has(id))
  if (invalidIds.length > 0) {
    console.warn(`拒绝分析请求: fileID 不属于该巡检记录 inspection=${inspectionId}`, invalidIds)
    return { success: false, error: '提交的图片不属于该拜访记录' }
  }

  // 原图已归档清理的记录无法重新分析：在扣配额前拦截，且不覆写已有状态与报告
  if (inspectionDoc.originPrunedAt) {
    return {
      success: false,
      error: '该记录原图已归档清理，仅保留缩略图，无法重新进行 AI 分析',
      code: 'ORIGIN_PRUNED'
    }
  }

  // 配额：归属/照片校验通过后再扣，避免无效请求烧额度
  if (!isInternalCall) {
    const quota = await checkAndIncAnalyzeQuota(callerOpenid)
    if (!quota.ok) {
      return {
        success: false,
        error: `今日 AI 分析次数已达上限（${quota.limit} 次/人/日），请明日再试或联系管理员`,
        code: 'QUOTA_EXCEEDED',
        quota
      }
    }
  }

  return await analyzeSingleInspection(inspectionDoc, idsToAnalyze)
}

/**
 * 标准单次拜访分析主链路（单条触发与 batchAnalyze / dailySummary 均复用此函数）
 */
async function analyzeSingleInspection(inspectionDoc, idsToAnalyze, preloadedContext = null) {
  const inspectionId = inspectionDoc._id
  if (inspectionDoc.originPrunedAt) {
    return {
      success: false,
      error: '该记录原图已归档清理，仅保留缩略图，无法重新进行 AI 分析',
      code: 'ORIGIN_PRUNED'
    }
  }
  try {
    // 1. 获取实拍图片数据
    console.log(`[1/5] 获取 ${idsToAnalyze.length} 张实拍图片...`)
    const fileRes = await cloud.readFilesAsDataUrls({ fileList: idsToAnalyze })
    const failedFiles = fileRes.fileList.filter(f => !f.tempFileURL)
    if (fileRes.fileList.length === 0 || failedFiles.length === fileRes.fileList.length) {
      throw new Error('获取图片链接失败')
    }
    const imageUrls = fileRes.fileList
      .filter(f => f.tempFileURL)
      .map(f => f.tempFileURL)
    console.log('[1/5] 图片获取成功')

    // 2. 加载产品库（含瓶身参考图）、广告物料库、横签对照参考图与评分规则配置
    console.log('[2/5] 查询产品库、物料库与评分配置...')
    const ctx = preloadedContext || await loadAnalysisContext()
    const {
      activeMaterials,
      brandReferenceText,
      ownBrandNames,
      scoringRules,
      productRefs = [],
      bannerRefs = [],
      bannerRefMaterials = [],
      bannerRefUrls = [],
      runtimeSettings = null
    } = ctx
    console.log(`[2/5] 上下文加载完成（产品参考图 ${productRefs.length} 张，横签参考图 ${bannerRefs.length} 张）`)

    // 3. 调用 AI 视觉模型分析（图文交错：实拍图 + 产品参考图 + 横签参考图）
    const runtimeConfig = resolveRuntimeAIConfig(runtimeSettings)
    console.log(`[3/5] 调用 ${CURRENT_MODEL}/${runtimeConfig.model} 视觉分析（thinking=${runtimeConfig.enableThinking}, budget=${runtimeConfig.thinkingBudget}, maxTokens=${runtimeConfig.maxTokens}）...`)
    const analysis = await withHardTimeout(
      analyzeWithVision(imageUrls, {
        brandReferenceText,
        activeMaterials,
        ownBrandNames,
        scoringRules,
        productRefs,
        bannerRefs,
        bannerRefMaterials,
        bannerRefUrls,
        runtimeSettings
      }),
      AI_HARD_TIMEOUT_MS,
      `AI 分析超过 ${AI_HARD_TIMEOUT_MS / 1000} 秒未完成，已主动中止。常见原因：单次照片过多、图片分辨率过高`
    )

    if (analysis.mock) {
      const noKeyError = '未配置 AI API Key，未生成真实分析报告。请管理员在服务器环境变量 DASHSCOPE_API_KEY 或「分析设置」中配置。'
      console.warn('[3/5]', noKeyError)
      await db.collection('inspections').doc(inspectionId).update({
        data: {
          status: 'analyze_failed',
          analyzeError: noKeyError,
          analyzedAt: db.serverDate(),
          aiDebug: analysis.debug
        }
      })
      return { success: false, error: noKeyError, mock: true, report: analysis.text }
    }

    const aiReport = analysis.text
    console.log('[3/5] AI 分析完成')

    // 4. 更新巡检记录
    console.log('[4/5] 更新数据库记录...')
    await db.collection('inspections').doc(inspectionId).update({
      data: {
        aiReport: aiReport,
        status: 'analyzed',
        analyzedAt: db.serverDate(),
        analyzeError: '',
        analyzedModel: (analysis.debug && analysis.debug.model) || runtimeConfig.model,
        analyzedFileID: idsToAnalyze[0],
        analyzedFileIDs: idsToAnalyze,
        aiDebug: analysis.debug
      }
    })
    if (inspectionDoc.customerId && Array.isArray(aiReport.adMaterials) && aiReport.adMaterials.length > 0) {
      await syncCustomerMaterials(inspectionDoc.customerId, aiReport.adMaterials, inspectionId)
    }
    console.log('[4/5] 数据库更新成功')

    console.log('[5/5] 分析完成')
    return { success: true, report: aiReport, fileIDs: idsToAnalyze }

  } catch (err) {
    console.error('AI 分析失败:', err)
    const debug = (err && err.debug) || {}
    try {
      await db.collection('inspections').doc(inspectionId).update({
        data: {
          status: 'analyze_failed',
          analyzeError: err.message,
          analyzedAt: db.serverDate(),
          aiDebug: debug
        }
      })
    } catch (updateErr) {
      console.error('更新失败状态出错:', updateErr)
    }
    return { success: false, error: err.message }
  }
}

// ============================================================
// 工具：给一个 Promise 套倒计时
// ============================================================
/**
 * 到点就抛错，把控制权交回调用方的 catch。
 * 注意：这不会真的取消底层请求（axios 那边还在跑），但云函数马上就会结束，
 * 目的只是抢在被硬杀之前把失败状态写进数据库。
 */
function withHardTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ============================================================
// 运行时 AI 配置与 API Key 解析：环境变量优先，其次读 settings 集合
// ============================================================
function resolveRuntimeAIConfig(settingsDoc = null) {
  const base = AI_CONFIG[CURRENT_MODEL]
  const envModel = (process.env.DASHSCOPE_MODEL || '').trim()
  const settingsModel = settingsDoc && typeof settingsDoc.aiModel === 'string' ? settingsDoc.aiModel.trim() : ''
  const model = envModel || settingsModel || base.model || DEFAULT_DASHSCOPE_MODEL

  const settingsMaxTokens = settingsDoc && Number.isFinite(Number(settingsDoc.aiMaxTokens))
    ? Math.max(1024, Math.min(16384, Math.round(Number(settingsDoc.aiMaxTokens))))
    : null
  const settingsEnableThinking = settingsDoc && typeof settingsDoc.aiEnableThinking === 'boolean'
    ? settingsDoc.aiEnableThinking
    : null
  const settingsThinkingBudget = settingsDoc && Number.isFinite(Number(settingsDoc.aiThinkingBudget))
    ? Math.max(0, Math.min(8192, Math.round(Number(settingsDoc.aiThinkingBudget))))
    : null

  const maxTokens = parseBoundedIntEnv(
    'DASHSCOPE_MAX_TOKENS',
    settingsMaxTokens !== null ? settingsMaxTokens : MAX_TOKENS,
    1024,
    16384
  )
  const enableThinking = parseBoolEnv(
    'DASHSCOPE_ENABLE_THINKING',
    settingsEnableThinking !== null ? settingsEnableThinking : ENABLE_THINKING
  )
  const thinkingBudget = parseBoundedIntEnv(
    'DASHSCOPE_THINKING_BUDGET',
    settingsThinkingBudget !== null ? settingsThinkingBudget : THINKING_BUDGET,
    0,
    8192
  )

  return {
    apiUrl: base.apiUrl,
    model,
    apiKey: process.env.DASHSCOPE_API_KEY || base.apiKey || '',
    maxTokens,
    enableThinking,
    thinkingBudget
  }
}

function buildQwenRequestParameters(config, callOptions = {}) {
  const model = (config && config.model) || DEFAULT_DASHSCOPE_MODEL
  const maxTokens = Number.isFinite(Number(callOptions.maxTokens))
    ? Math.max(256, Math.round(Number(callOptions.maxTokens)))
    : (Number.isFinite(Number(config && config.maxTokens)) ? Math.round(Number(config.maxTokens)) : MAX_TOKENS)
  const enableThinking = callOptions.enableThinking !== undefined
    ? Boolean(callOptions.enableThinking)
    : Boolean(config && config.enableThinking !== undefined ? config.enableThinking : ENABLE_THINKING)
  const rawBudget = callOptions.thinkingBudget !== undefined
    ? Number(callOptions.thinkingBudget)
    : Number(config && config.thinkingBudget !== undefined ? config.thinkingBudget : THINKING_BUDGET)
  const thinkingBudget = Number.isFinite(rawBudget) ? Math.max(0, Math.min(8192, Math.round(rawBudget))) : THINKING_BUDGET

  const params = {
    max_tokens: maxTokens,
    temperature: TEMPERATURE,
    top_p: 0.5
  }

  // 高分辨率模式：vl_high_resolution_images 仅对老 qwen-vl 系列有效，Qwen3.x 原生支持高分辨率
  if (String(model).toLowerCase().startsWith('qwen-vl')) {
    params.vl_high_resolution_images = true
  }

  // Qwen3.x 混合思考模型：支持有界思考（enable_thinking: true + thinking_budget），
  // 视觉计数/多图去重默认开启有界思考；纯文本汇总或降级重试可显式关闭或省略思考参数。
  if (!callOptions.omitThinkingParams && isHybridThinkingModel(model)) {
    if (enableThinking && thinkingBudget > 0) {
      params.enable_thinking = true
      params.thinking_budget = thinkingBudget
    } else {
      params.enable_thinking = false
      params.thinking_budget = 0
    }
  }

  return params
}

function allocateReferenceBudget(visitCount, productRefs = [], bannerRefs = [], maxTotalImages = MAX_TOTAL_IMAGES) {
  const remainingAfterVisits = Math.max(0, maxTotalImages - Math.max(0, visitCount))
  const banners = Array.isArray(bannerRefs) ? bannerRefs.slice(0, Math.min(MAX_BANNER_REFS, remainingAfterVisits)) : []
  const remainingForProducts = Math.max(0, remainingAfterVisits - banners.length)
  const products = Array.isArray(productRefs) ? productRefs.slice(0, Math.min(MAX_PRODUCT_REFS, remainingForProducts)) : []
  return { productRefs: products, bannerRefs: banners }
}

async function resolveApiKey(config, settingsDoc = null) {
  if (config.apiKey) return config.apiKey
  if (settingsDoc && settingsDoc.dashscopeApiKey) {
    console.log('使用 settings 集合中配置的 API Key')
    return settingsDoc.dashscopeApiKey
  }

  // 环境变量没配时，退回读小程序设置页写入的 Key
  try {
    const res = await db.collection('settings').doc('global').get()
    const key = res.data && res.data.dashscopeApiKey
    if (key) {
      console.log('使用 settings 集合中配置的 API Key')
      return key
    }
  } catch (err) {
    // settings 集合可能还没建，属于正常情况，不打错误日志
  }
  return ''
}

// ============================================================
// 评分规则 & 产品库（含瓶身参考图）& 广告物料库 & 横签参考图加载
// ============================================================
async function loadGlobalSettingsDoc() {
  try {
    const res = await db.collection('settings').doc('global').get()
    return (res && res.data) || null
  } catch (err) {
    return null
  }
}

async function loadActiveMaterials() {
  try {
    const res = await db.collection('adMaterials').where({ isActive: true }).get()
    return res.data || []
  } catch (err) {
    console.warn('查询广告物料库失败:', err.message || err)
    return []
  }
}

async function loadAnalysisContext() {
  const runtimeSettings = await loadGlobalSettingsDoc()
  const scoringRules = normalizeScoringRules(runtimeSettings && runtimeSettings.scoringRules)
  const activeMaterials = await loadActiveMaterials()
  const ownBrandNames = new Set()
  let brandReferenceText = ''
  let activeProducts = []

  try {
    const res = await db.collection('products').where({ isActive: true }).get()
    activeProducts = res.data || []
    if (activeProducts.length > 0) {
      const lines = activeProducts.map(p => {
        if (p.brandName) ownBrandNames.add(String(p.brandName).trim().toLowerCase())
        const parts = [`品牌：${p.brandName}`]
        if (p.productLine) parts.push(`产品线：${p.productLine}`)
        if (Array.isArray(p.aliases) && p.aliases.length > 0) {
          p.aliases.forEach(a => {
            const k = String(a || '').trim().toLowerCase()
            if (k) ownBrandNames.add(k)
          })
          parts.push(`别名/简称：${p.aliases.join('、')}`)
        }
        if (p.visualFeatures) parts.push(`视觉特征：${String(p.visualFeatures).trim()}`)
        return `- ${parts.join('，')}`
      })
      brandReferenceText += `\n\n## 本品牌产品资料（识别时优先参考，遇到下列品牌/别名要统一按标准品牌名归类并标注 isOwn: true，其余品牌视为竞品 isOwn: false）\n${lines.join('\n')}`
    }
  } catch (err) {
    console.error('查询产品库失败，本次分析不带品牌参考:', err)
  }

  if (activeMaterials.length > 0) {
    const mLines = activeMaterials.map(m => {
      const parts = [`标准名称：${m.materialName}`]
      if (m.category) parts.push(`分类：${m.category}`)
      if (Array.isArray(m.aliases) && m.aliases.length > 0) {
        parts.push(`别名：${m.aliases.join('、')}`)
      }
      if (m.visualFeatures) parts.push(`视觉特征：${m.visualFeatures}`)
      return `- ${parts.join('，')}`
    })
    brandReferenceText += `\n\n## 本品牌广告物料库（识别画面中的广告物料时必须优先比对下列物料，并在 adMaterials[].name 中严格输出对应的「标准名称」）\n${mLines.join('\n')}`
  }

  // 筛选启用且带瓶身参考图的产品（优先正面照 front），最多 MAX_PRODUCT_REFS 张
  const candidateProductRefs = selectProductRefs(activeProducts, MAX_PRODUCT_REFS)
  const productRefs = []
  if (candidateProductRefs.length > 0) {
    try {
      const prodFileRes = await cloud.readFilesAsDataUrls({
        fileList: candidateProductRefs.map(p => p.photo)
      })
      const byFileId = new Map()
      ;(prodFileRes.fileList || []).forEach(f => {
        if (f && f.fileID && f.tempFileURL) byFileId.set(f.fileID, f.tempFileURL)
      })
      candidateProductRefs.forEach(p => {
        const url = byFileId.get(p.photo)
        if (url) {
          productRefs.push({ ...p, url })
        }
      })
    } catch (err) {
      console.warn('读取产品瓶身参考图失败，降级为纯文本产品资料:', err.message || err)
    }
  }

  // 筛选启用且带参考图 photo 的横签，最多取 MAX_BANNER_REFS 张作为对照图传给视觉模型
  const candidateBannerRefs = selectHorizontalBannerRefs(activeMaterials, MAX_BANNER_REFS)
  const bannerRefs = []
  const bannerRefMaterials = []
  const bannerRefUrls = []
  if (candidateBannerRefs.length > 0) {
    try {
      const refFileRes = await cloud.readFilesAsDataUrls({
        fileList: candidateBannerRefs.map(m => m.photo)
      })
      const byFileId = new Map()
      ;(refFileRes.fileList || []).forEach(f => {
        if (f && f.fileID && f.tempFileURL) byFileId.set(f.fileID, f.tempFileURL)
      })
      candidateBannerRefs.forEach(m => {
        const url = byFileId.get(m.photo)
        if (url) {
          bannerRefs.push({ ...m, url })
          bannerRefMaterials.push(m)
          bannerRefUrls.push(url)
        }
      })
    } catch (err) {
      console.warn('读取横签参考图失败，降级为纯文本特征识别:', err.message || err)
    }
  }

  return {
    runtimeSettings,
    scoringRules,
    activeMaterials,
    ownBrandNames,
    brandReferenceText,
    productRefs,
    bannerRefs,
    bannerRefMaterials,
    bannerRefUrls
  }
}

async function syncCustomerMaterials(customerId, adMaterials, inspectionId) {
  const cid = String(customerId || '').trim()
  if (!cid || !Array.isArray(adMaterials) || adMaterials.length === 0) return
  try {
    const custRes = await db.collection('customers').doc(cid).get()
    const cust = custRes && custRes.data
    if (!cust) return
    const prevList = Array.isArray(cust.adMaterials) ? cust.adMaterials : []
    const matMap = new Map()
    prevList.forEach(m => {
      if (m && m.name) matMap.set(m.name, m)
    })
    const nowIso = new Date().toISOString()
    adMaterials.forEach(m => {
      if (!m || !m.name || m.isOwn === false) return
      matMap.set(m.name, {
        name: m.name,
        category: m.category || '其他',
        count: m.count || 1,
        condition: m.condition || '完好',
        lastSeenAt: nowIso,
        lastInspectionId: inspectionId || ''
      })
    })
    await db.collection('customers').doc(cid).update({
      data: {
        adMaterials: Array.from(matMap.values()),
        updatedAt: db.serverDate()
      }
    })
  } catch (err) {
    console.warn('同步客户广告物料台账失败:', err.message || err)
  }
}

// ============================================================
// AI 调用逻辑
// ============================================================
async function analyzeWithVision(imageUrls, options = {}) {
  const config = resolveRuntimeAIConfig(options.runtimeSettings || null)
  const apiKey = await resolveApiKey(config, options.runtimeSettings || null)

  if (!apiKey) {
    console.warn('未配置 AI API Key，拒绝将模拟报告写入数据库（防止假数据污染统计）。配置方法见本文件顶部注释。')
    return {
      text: generateMockReport(options.scoringRules),
      debug: { mode: 'mock', reason: '未配置 API Key' },
      mock: true
    }
  }

  const {
    brandReferenceText = '',
    activeMaterials = [],
    ownBrandNames = new Set(),
    scoringRules = null,
    productRefs = [],
    bannerRefs = [],
    bannerRefMaterials = [],
    bannerRefUrls = []
  } = options

  // 兼容旧调用方仅传 bannerRefMaterials + bannerRefUrls 的形式
  const rawBannerRefs = bannerRefs.length > 0
    ? bannerRefs
    : bannerRefMaterials.map((m, idx) => ({ ...m, url: bannerRefUrls[idx] })).filter(r => r && r.url)

  const allocated = allocateReferenceBudget(imageUrls.length, productRefs, rawBannerRefs, MAX_TOTAL_IMAGES)
  const systemPrompt = buildSystemPrompt(scoringRules)
  const userPrompt = buildUserPrompt(
    imageUrls.length,
    brandReferenceText,
    allocated.bannerRefs,
    allocated.productRefs
  )
  const userContent = buildMultimodalUserContent({
    visitImageUrls: imageUrls,
    productRefs: allocated.productRefs,
    bannerRefs: allocated.bannerRefs,
    userPrompt
  })

  const primaryCallOpts = {
    enableThinking: config.enableThinking,
    thinkingBudget: config.thinkingBudget,
    maxTokens: config.maxTokens
  }
  const parseOpts = {
    activeMaterials,
    scoringRules,
    ownBrandNames,
    visitImageCount: imageUrls.length
  }

  let text
  let debug
  let thinkingFallback = ''
  const thinkingAttempted = isHybridThinkingModel(config.model) && config.enableThinking && config.thinkingBudget > 0

  try {
    const primaryRes = await callQwen(config, apiKey, userContent, systemPrompt, primaryCallOpts)
    text = primaryRes.text
    debug = primaryRes.debug
  } catch (primaryErr) {
    const isThinkingParamErr = thinkingAttempted &&
      /thinking/i.test(String(primaryErr && primaryErr.message || '')) &&
      (/InvalidParameter|400|parameter/i.test(String((primaryErr && primaryErr.dashscopeCode) || (primaryErr && primaryErr.message) || '')))
    const isReasoningOnlyErr = thinkingAttempted && primaryErr && primaryErr.code === 'REASONING_ONLY'

    if (isReasoningOnlyErr || isThinkingParamErr) {
      thinkingFallback = isReasoningOnlyErr ? 'reasoning_only' : 'unsupported_param'
      console.warn(`[analyzeWithVision] 有界思考调用异常(${thinkingFallback})，自动降级为关闭思考重试一次:`, primaryErr.message)
      const retryOpts = isThinkingParamErr
        ? { omitThinkingParams: true, maxTokens: config.maxTokens }
        : { enableThinking: false, thinkingBudget: 0, maxTokens: config.maxTokens }
      const retryRes = await callQwen(config, apiKey, userContent, systemPrompt, retryOpts)
      text = retryRes.text
      debug = retryRes.debug
    } else {
      throw primaryErr
    }
  }

  let parsed = parseAIResponse(text, parseOpts)
  // 若首次响应解析失败（输出被 max_tokens 截断，或偶发未转义引号等 JSON 语法错），自动重试一次提升稳定性
  if (!thinkingFallback && parsed.metadata && parsed.metadata.parseError) {
    const isTruncated = Boolean(debug && debug.finishReason === 'length')
    thinkingFallback = (thinkingAttempted && isTruncated) ? 'truncated_json' : 'json_parse_retry'
    console.warn(
      `[analyzeWithVision] 首次响应 JSON 解析失败(${thinkingFallback}, finishReason=${(debug && debug.finishReason) || 'unknown'})，自动重试一次`
    )
    const retryOpts = thinkingAttempted
      ? { enableThinking: false, thinkingBudget: 0, maxTokens: config.maxTokens }
      : { ...primaryCallOpts }
    const retryRes = await callQwen(config, apiKey, userContent, systemPrompt, retryOpts)
    text = retryRes.text
    debug = retryRes.debug
    parsed = parseAIResponse(text, parseOpts)
  }

  debug.parsedOk = !(parsed.metadata && parsed.metadata.parseError)
  debug.visitImageCount = imageUrls.length
  debug.productRefCount = allocated.productRefs.length
  debug.bannerRefCount = allocated.bannerRefs.length
  if (thinkingFallback) {
    debug.thinkingFallback = thinkingFallback
  }
  return { text: parsed, debug }
}

/**
 * 调用通义千问 DashScope 原生多模态接口（支持图文交错 content 数组，以及旧版 (imageUrls, userPrompt) 入参）
 */
async function callQwen(config, apiKey, contentOrImageUrls, userPromptOrSystemPrompt, maybeSystemPrompt, maybeCallOptions) {
  let userContent
  let systemPrompt = SYSTEM_PROMPT
  let callOptions = {}

  const isInterleavedContent = Array.isArray(contentOrImageUrls) &&
    contentOrImageUrls.length > 0 &&
    typeof contentOrImageUrls[0] === 'object' &&
    contentOrImageUrls[0] !== null

  if (isInterleavedContent) {
    userContent = contentOrImageUrls
    systemPrompt = userPromptOrSystemPrompt || SYSTEM_PROMPT
    callOptions = maybeSystemPrompt && typeof maybeSystemPrompt === 'object' ? maybeSystemPrompt : {}
  } else {
    const imageUrls = Array.isArray(contentOrImageUrls) ? contentOrImageUrls : []
    const userPrompt = userPromptOrSystemPrompt || ''
    systemPrompt = maybeSystemPrompt || SYSTEM_PROMPT
    callOptions = maybeCallOptions && typeof maybeCallOptions === 'object' ? maybeCallOptions : {}
    userContent = [
      ...imageUrls.map(url => ({ image: url })),
      { text: userPrompt }
    ]
  }

  const parameters = buildQwenRequestParameters(config, callOptions)

  let response
  try {
    response = await axios.post(config.apiUrl, {
      model: config.model,
      input: {
        messages: [
          {
            role: 'system',
            content: [{ text: systemPrompt }]
          },
          {
            role: 'user',
            content: userContent
          }
        ]
      },
      parameters
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: AI_HTTP_TIMEOUT_MS
    })
  } catch (err) {
    const data = err.response && err.response.data
    if (data && (data.message || data.code)) {
      const apiErr = new Error(`DashScope 调用失败[${data.code || err.response.status}]: ${data.message || '未知错误'}`)
      apiErr.dashscopeCode = data.code || String(err.response.status || '')
      throw apiErr
    }
    if (err.code === 'ECONNABORTED') {
      throw new Error(`AI 响应超过 ${AI_HTTP_TIMEOUT_MS / 1000} 秒未返回，已中止。建议减少单次照片数量或适当调小 DASHSCOPE_THINKING_BUDGET`)
    }
    throw err
  }

  // 构造一份诊断快照，无论解析成功与否都透传给调用方写进数据库
  const output = response.data && response.data.output
  const choice = output && Array.isArray(output.choices) && output.choices[0]
  const msg = choice && choice.message
  const contentType = msg ? (Array.isArray(msg.content) ? 'array' : typeof msg.content) : 'none'
  const reasoningText = msg && (msg.reasoning_content || msg.reasoning || '')
  const hasReasoning = Boolean(reasoningText)
  const reasoningOnly = hasReasoning && (
    contentType === 'none' ||
    (typeof msg.content === 'string' && !msg.content.trim()) ||
    (Array.isArray(msg.content) && msg.content.every(p => !p || !p.text))
  )
  const debug = {
    model: config.model,
    enableThinking: Boolean(parameters.enable_thinking),
    thinkingBudget: parameters.thinking_budget != null ? parameters.thinking_budget : 0,
    maxTokens: parameters.max_tokens,
    finishReason: (choice && choice.finish_reason) || (output && output.finish_reason) || '',
    hasOutput: !!output,
    hasChoices: !!(output && Array.isArray(output.choices) && output.choices.length > 0),
    contentType,
    hasReasoning,
    reasoningLength: typeof reasoningText === 'string' ? reasoningText.length : 0,
    reasoningOnly,
    dashscopeCode: response.data && response.data.code,
    dashscopeMessage: response.data && response.data.message,
    requestId: response.data && response.data.request_id
  }

  try {
    const text = extractQwenText(response.data, { enableThinking: Boolean(parameters.enable_thinking) })
    return { text, debug }
  } catch (extractErr) {
    extractErr.debug = debug
    throw extractErr
  }
}

/**
 * 判断是否为 Qwen3.x 混合思考模型
 *
 * 命中的模型：qwen3.5-* / qwen3.6-* / qwen3.7-* / qwen3.8-* 全系（plus / max / flash）
 * 不命中的：qwen-vl-plus 等老 VL 系列（不认识 enable_thinking 参数，传了会报参数错误）
 */
function isHybridThinkingModel(model) {
  const m = String(model || '').trim()
  return /^qwen3(\.\d+)?[-.]/i.test(m) && !/^qwen-vl/i.test(m)
}

/**
 * 从 DashScope 响应里取出文本
 */
function extractQwenText(data, options = {}) {
  if (!data || !data.output) {
    throw new Error('DashScope 返回结构异常：缺少 output 字段')
  }

  const output = data.output

  // 结构一（qwen-vl / qwen3 多模态接口）：output.choices[0].message.content 是数组或字符串
  if (Array.isArray(output.choices) && output.choices.length > 0) {
    const content = output.choices[0].message && output.choices[0].message.content
    if (typeof content === 'string' && content.trim()) return content
    if (Array.isArray(content)) {
      const text = content
        .map(part => (typeof part === 'string' ? part : part.text))
        .filter(Boolean)
        .join('')
      if (text) return text
    }
  }

  // 结构二（部分文本模型）：output.text
  if (typeof output.text === 'string' && output.text) {
    return output.text
  }

  const msg = output.choices && output.choices[0] && output.choices[0].message
  if (msg && (msg.reasoning_content || msg.reasoning)) {
    const err = options.enableThinking
      ? new Error('模型思考耗尽输出预算未能生成正文，请适当调小 DASHSCOPE_THINKING_BUDGET 或调大 DASHSCOPE_MAX_TOKENS')
      : new Error('模型只返回了思考过程、没有正文，请确认 enable_thinking 参数已生效')
    err.code = 'REASONING_ONLY'
    throw err
  }

  throw new Error('DashScope 返回结构异常：未能提取到文本内容')
}

// ============================================================
// 响应解析
// ============================================================
function parseAIResponse(responseText, options = {}) {
  try {
    let jsonStr = (responseText || '').trim()

    // 提取 markdown 代码块中的 JSON
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
    }

    // 兜底：截取第一个 { 到最后一个 } 之间的内容再解析（兼容前后带解释文字的情况）
    if (!jsonStr.startsWith('{') || !jsonStr.endsWith('}')) {
      const start = jsonStr.indexOf('{')
      const end = jsonStr.lastIndexOf('}')
      if (start !== -1 && end > start) {
        jsonStr = jsonStr.slice(start, end + 1)
      }
    }

    const result = JSON.parse(jsonStr)
    const opts = Array.isArray(options) ? { activeMaterials: options } : (options || {})
    return validateAndNormalizeReport(result, responseText, opts)
  } catch (err) {
    console.error('解析 AI 返回结果失败:', err)
    return {
      scoringVersion: 'v2',
      hasShelfPhoto: true,
      ownBrandPresent: null,
      score: null,
      scoreLevel: '解析失败',
      summary: 'AI 返回结果解析失败，请重试',
      facingMetrics: {
        ownFacingCount: null,
        ownSkuCount: null,
        totalShelfFacingCount: null,
        ownFacingShare: null,
        countingConfidence: null
      },
      productIdentification: [],
      adMaterials: [],
      displayCompliance: {},
      competitiveAnalysis: { brands: [] },
      issues: [],
      suggestions: [],
      metadata: { parseError: true },
      rawResponse: responseText
    }
  }
}

// ============================================================
// 模拟报告（未配置 API Key 时的占位结果，不落库）
// ============================================================
function generateMockReport(scoringRules) {
  const rules = normalizeScoringRules(scoringRules)
  return validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    summary: '【模拟报告】我方品牌共占据 8 个正面排面（2 个品规），核心产品位于黄金视线层，正标朝向统一，价签清晰，但缺少我方横签。',
    facingMetrics: {
      ownFacingCount: 8,
      ownSkuCount: 2,
      totalShelfFacingCount: 24,
      ownFacingShare: 33.3,
      countingConfidence: 0.9
    },
    productIdentification: [
      {
        brand: '永丰',
        productLine: '特8',
        isOwn: true,
        aromaType: '清香型',
        priceRange: '大众',
        facingCount: 5,
        position: '黄金位',
        confidence: 0.92
      },
      {
        brand: '永丰',
        productLine: '经典二锅头',
        isOwn: true,
        aromaType: '清香型',
        priceRange: '大众',
        facingCount: 3,
        position: '中层',
        confidence: 0.88
      }
    ],
    displayCompliance: {
      facingCount: { score: 40, observedFacings: 8, detail: '观测事实：正面最前排共见我方 8 个排面。' },
      goldenPosition: { score: 16, detail: '观测事实：核心产品 6 个排面位于中上黄金视线层。' },
      labelOrientation: { score: 9, detail: '观测事实：8 瓶中 7 瓶正标朝外，1 瓶略偏。' },
      priceTag: { score: 10, detail: '观测事实：我方陈列层下沿价签清晰完好。' },
      horizontalBanner: { score: 0, detail: '观测事实：陈列上下沿未见我方横签。' }
    },
    competitiveAnalysis: {
      totalBrands: 4,
      brands: [
        { brand: '永丰', isOwn: true, sharePercent: 33.3, positionAdvantage: 'high' },
        { brand: '竞品A', isOwn: false, sharePercent: 25.0, positionAdvantage: 'medium' }
      ],
      insight: '我方在黄金位占优，补齐横签并扩充 2 个排面即可冲刺满分。'
    },
    issues: [
      { severity: 'high', category: '横签露出', description: '我方陈列上下沿缺少我方横签', impact: '品牌视觉识别度偏弱' }
    ],
    suggestions: [
      { priority: 'high', action: '在我方陈列层下沿补齐我方横签', expectedEffect: '横签项直接+10分', deadline: '当日' }
    ],
    metadata: {
      imageQuality: 'good',
      imageQualityReason: '',
      framingType: 'panorama',
      shelfCount: 4,
      totalProducts: 24,
      photoRoles: ['货架陈列照'],
      isMock: true
    }
  }, '', { scoringRules: rules })
}

// ============================================================
// 全天巡检汇总结论分析（基于单条结构化报告统一汇总，不再重复喂图、绝不造 80 假分）
// ============================================================
function buildDeterministicDailyFallback(aggregated, inspections) {
  const st = aggregated.storeStats
  const ov = aggregated.ownBrandOverview
  const scorePart = aggregated.overallScore !== null
    ? `在架门店平均陈列分 ${aggregated.overallScore} 分（${aggregated.overallLevel}）`
    : `暂无可计分在架陈列（${aggregated.overallLevel}）`
  const facingPart = ov.avgFacingCount !== null ? `，平均我方排面 ${ov.avgFacingCount} 面` : ''
  const stockPart = ov.inStockRate !== null ? `，在架率 ${ov.inStockRate}%` : ''
  const oosPart = st.outOfStockStores > 0 ? `，其中 ${st.outOfStockStores} 家未上柜需重点跟进铺货` : ''

  // 从单条报告汇总高频问题
  const issueMap = new Map()
  for (const item of inspections) {
    const issues = (item.aiReport && Array.isArray(item.aiReport.issues)) ? item.aiReport.issues : []
    for (const iss of issues) {
      if (!iss || !iss.category) continue
      const key = String(iss.category).trim()
      if (!issueMap.has(key)) {
        issueMap.set(key, {
          category: key,
          severity: iss.severity || 'medium',
          count: 0,
          description: iss.description || key
        })
      }
      issueMap.get(key).count += 1
    }
  }
  const commonIssues = Array.from(issueMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((x, idx) => ({
      rank: idx + 1,
      category: x.category,
      severity: x.severity,
      affectStores: `${x.count}家门店`,
      description: x.description
    }))

  return {
    summaryTitle: '今日终端拜访综合分析日报',
    summaryConclusion: `今日共拜访 ${st.totalStores} 家门店，${scorePart}${facingPart}${stockPart}${oosPart}。`,
    competitiveSituation: ov.facingSharePercent !== null
      ? `今日在架门店我方平均排面占比 ${ov.facingSharePercent}%。`
      : '请结合各店单条报告查看竞品格局。',
    commonIssues,
    actionPlanTomorrow: st.outOfStockStores > 0
      ? [{ priority: 'P0', action: '优先回访未上柜门店推动我方产品上柜陈列', target: '提升终端在架率' }]
      : [{ priority: 'P0', action: '针对排面不足 10 面及缺少横签/价签的门店逐项整改', target: '提升整体陈列分' }],
    storeComments: []
  }
}

function parseDailySummaryNarrative(responseText) {
  let jsonStr = (responseText || '').trim()
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) jsonStr = jsonMatch[1].trim()
  if (!jsonStr.startsWith('{') || !jsonStr.endsWith('}')) {
    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start !== -1 && end > start) jsonStr = jsonStr.slice(start, end + 1)
  }
  return JSON.parse(jsonStr)
}

async function handleDailySummary(event, wxContext) {
  const callerOpenid = wxContext.OPENID || ''
  const source = String(wxContext.SOURCE || '')
  const isTimerSource = /trigger|timer|cron/i.test(source)
  const isInternalCall = !callerOpenid || isTimerSource

  let isManager = false
  if (!isInternalCall) {
    const callerRes = await db.collection('users').where({ _openid: callerOpenid }).get()
    const callerUser = callerRes.data[0] || null
    if (callerUser && callerUser.disabled) {
      return { success: false, error: '账号已停用，无法进行分析' }
    }
    isManager = !!(callerUser && (callerUser.role === 'admin' || callerUser.role === 'manager'))
    if (!isManager) {
      return { success: false, error: '仅管理员或管理者可触发日报汇总', code: 'DAILY_SUMMARY_FORBIDDEN' }
    }
    if (!isUserApproved(callerUser)) {
      return { success: false, error: '等待管理员审批', code: 'NOT_APPROVED' }
    }
  }

  // 1. 查找目标巡检记录
  let inspections = []
  if (Array.isArray(event.inspectionIds) && event.inspectionIds.length > 0) {
    const query = { _id: db.command.in(event.inspectionIds) }
    if (!isInternalCall && !isManager) {
      query._openid = callerOpenid
    }
    const listRes = await db.collection('inspections')
      .where(query)
      .limit(50)
      .get()
    inspections = listRes.data || []
  } else {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const query = { createdAt: db.command.gte(dayAgo) }
    if (!isInternalCall && !isManager) {
      query._openid = callerOpenid
    }
    const listRes = await db.collection('inspections')
      .where(query)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()
    inspections = listRes.data || []
  }

  // 排除上下班打卡记录
  inspections = inspections.filter(i => i && i.recordType !== 'clock_in' && i.recordType !== 'clock_out' && i.status !== 'clocked')
  if (inspections.length === 0) {
    return { success: false, error: '今日暂无拜访记录可供汇总' }
  }

  const sharedCtx = await loadAnalysisContext()
  const config = resolveRuntimeAIConfig(sharedCtx.runtimeSettings)
  const apiKey = await resolveApiKey(config, sharedCtx.runtimeSettings)
  if (!apiKey) {
    const noKeyError = '未配置 AI API Key，未生成真实汇总报告。请管理员在服务器环境变量 DASHSCOPE_API_KEY 或「分析设置」中配置。'
    console.warn('[dailySummary]', noKeyError)
    return {
      success: false,
      error: noKeyError,
      mock: true
    }
  }

  if (!isInternalCall) {
    const quota = await checkAndIncAnalyzeQuota(callerOpenid)
    if (!quota.ok) {
      return {
        success: false,
        error: `今日 AI 分析次数已达上限（${quota.limit} 次/人/日），请明日再试或联系管理员`,
        code: 'QUOTA_EXCEEDED',
        quota
      }
    }
  }

  // 2. 逐条补齐尚未执行标准单条分析的记录（确保单条与批量口径完全一致）
  const readyInspections = []
  let singleFailedCount = 0

  for (const item of inspections) {
    const hasRealReport = !!(
      item.aiReport &&
      !(item.aiReport.metadata && item.aiReport.metadata.isDailySummary) &&
      !(item.aiReport.metadata && item.aiReport.metadata.parseError)
    )
    if (hasRealReport && item.status === 'analyzed') {
      readyInspections.push(item)
      continue
    }

    const fileIDs = Array.isArray(item.photoFileIDs) ? item.photoFileIDs : []
    if (fileIDs.length === 0 || item.originPrunedAt) {
      singleFailedCount += 1
      continue
    }

    const singleRes = await analyzeSingleInspection(item, fileIDs, sharedCtx)
    if (singleRes && singleRes.success && singleRes.report) {
      readyInspections.push({
        ...item,
        status: 'analyzed',
        aiReport: singleRes.report
      })
    } else {
      singleFailedCount += 1
    }
  }

  if (readyInspections.length === 0) {
    return { success: false, error: '所选拜访记录均未完成单条分析，无法生成今日综合日报' }
  }

  // 3. 基于真实单条结构化结果精确汇总大盘指标（纯文本汇总无需开启视觉思考）
  const aggregated = aggregateDailyMetrics(readyInspections)
  let narrative
  try {
    const userPrompt = buildDailySummaryUserPrompt(readyInspections, aggregated, sharedCtx.brandReferenceText)
    const { text } = await withHardTimeout(
      callQwen(config, apiKey, [], userPrompt, DAILY_SUMMARY_SYSTEM_PROMPT, {
        enableThinking: false,
        thinkingBudget: 0
      }),
      AI_HARD_TIMEOUT_MS,
      '今日拜访综合日报汇总超时'
    )
    narrative = parseDailySummaryNarrative(text)
  } catch (narrErr) {
    console.warn('[dailySummary] AI 文本综合提炼失败，降级使用真实单条数据确定性汇总:', narrErr.message || narrErr)
    narrative = buildDeterministicDailyFallback(aggregated, readyInspections)
  }

  // 把 AI 提炼的门店简评挂到确定性 storeRankings 上（绝不篡改分数与排面数）
  const commentMap = new Map()
  if (narrative && Array.isArray(narrative.storeComments)) {
    narrative.storeComments.forEach(c => {
      if (c && c.storeName && c.comment) commentMap.set(String(c.storeName).trim(), String(c.comment).trim())
    })
  }
  const storeRankings = aggregated.storeRankings.map(r => ({
    ...r,
    comment: commentMap.get(r.storeName) || r.comment
  }))

  const summaryReport = {
    scoringVersion: 'v2',
    summaryTitle: (narrative && narrative.summaryTitle) || '今日终端拜访综合分析日报',
    overallScore: aggregated.overallScore,
    overallLevel: aggregated.overallLevel,
    summaryConclusion: (narrative && narrative.summaryConclusion) || buildDeterministicDailyFallback(aggregated, readyInspections).summaryConclusion,
    storeStats: aggregated.storeStats,
    ownBrandOverview: {
      ...aggregated.ownBrandOverview,
      competitiveSituation: (narrative && narrative.competitiveSituation) || ''
    },
    commonIssues: (narrative && Array.isArray(narrative.commonIssues)) ? narrative.commonIssues : [],
    actionPlanTomorrow: (narrative && Array.isArray(narrative.actionPlanTomorrow)) ? narrative.actionPlanTomorrow : [],
    storeRankings
  }

  // 4. 落库存储到 dailyReports（北京时间 YYYY-MM-DD，同日同业务员支持多轮合并重算）
  const todayStr = beijingDateStr()
  const ownerOpenids = Array.from(new Set(readyInspections.map(i => i._openid).filter(Boolean)))
  const userNames = Array.from(new Set(readyInspections.map(i => i.userName).filter(Boolean)))
  const ownerKey = ownerOpenids.length === 1 ? ownerOpenids[0] : (callerOpenid || 'multi')
  const safeOwner = String(ownerKey).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown'
  const reportDocId = `dr_${safeOwner}_${todayStr}`

  const newInspectionIds = readyInspections.map(i => i._id)
  const newStoreNames = Array.from(new Set(readyInspections.map(i => i.storeName || '未命名门店')))

  let mergedInspectionIds = newInspectionIds
  let mergedStoreNames = newStoreNames
  let mergedOwnerOpenids = ownerOpenids
  let mergedUserName = userNames.join('、')
  let mergedReport = summaryReport

  try {
    const prev = await db.collection('dailyReports').doc(reportDocId).get()
    if (prev.data) {
      const p = prev.data
      mergedInspectionIds = Array.from(new Set([...(p.inspectionIds || []), ...newInspectionIds]))
      mergedStoreNames = Array.from(new Set([...(p.storeNames || []), ...newStoreNames]))
      mergedOwnerOpenids = Array.from(new Set([...(p.ownerOpenids || []), ...ownerOpenids]))
      const prevNames = (p.userName || '').split('、').filter(Boolean)
      mergedUserName = Array.from(new Set([...prevNames, ...userNames])).join('、')

      mergedReport = mergeDailyReports(p.report, summaryReport)
    }
  } catch (prevErr) {
    // 首次生成，无历史文档
  }

  const docPayload = {
    date: todayStr,
    _openid: ownerOpenids.length === 1 ? ownerOpenids[0] : (callerOpenid || ''),
    ownerOpenids: mergedOwnerOpenids,
    userName: mergedUserName,
    generatedAt: db.serverDate(),
    inspectionCount: mergedInspectionIds.length,
    inspectionIds: mergedInspectionIds,
    storeNames: mergedStoreNames,
    report: mergedReport
  }

  let savedId = reportDocId
  try {
    await db.collection('dailyReports').doc(reportDocId).set({ data: docPayload })
  } catch (dbErr) {
    try {
      const addRes = await db.collection('dailyReports').add({ data: docPayload })
      savedId = addRes._id
    } catch (addErr) {
      try {
        await db.collection('settings').doc('global').update({
          data: { latestDailyReport: docPayload }
        })
      } catch (updateErr) {
        console.warn('存储每日汇总失败:', updateErr)
      }
      savedId = ''
    }
  }

  // 5. 仅在巡检记录上关联 dailyReportId，绝不覆盖单条完整 aiReport
  if (savedId) {
    for (const item of readyInspections) {
      await db.collection('inspections').doc(item._id).update({
        data: { dailyReportId: savedId }
      }).catch(err => console.warn(`关联巡检 ${item._id} 日报 ID 失败:`, err))
    }
  }

  return {
    success: true,
    dailyReport: mergedReport,
    date: todayStr,
    savedId,
    analyzedCount: readyInspections.length,
    failedCount: singleFailedCount
  }
}

exports._internal = {
  resolveRuntimeAIConfig,
  buildQwenRequestParameters,
  allocateReferenceBudget,
  isHybridThinkingModel,
  extractQwenText,
  parseAIResponse,
  DEFAULT_MAX_TOKENS,
  DEFAULT_ENABLE_THINKING,
  DEFAULT_THINKING_BUDGET
}
