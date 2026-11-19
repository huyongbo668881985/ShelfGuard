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
  DAILY_SUMMARY_SYSTEM_PROMPT,
  buildDailySummaryUserPrompt
} = require('./prompt')
const {
  normalizeScoringRules,
  selectHorizontalBannerRefs,
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
// AI 模型配置
// ============================================================
//
// 【API Key 填在哪里】（三选一，优先级从高到低）
// 1. 【推荐】云函数环境变量：微信开发者工具 → 云开发控制台 → 云函数 →
//    找到 analyzeImage → 版本与配置 → 环境变量 → 新增 DASHSCOPE_API_KEY = sk-xxxxxx
//    Key 不进代码库、不经过前端，最安全。
// 2. 小程序内「设置」页填写：会存进 settings 集合的 dashscopeApiKey 字段。
//    方便，但 Key 会经过前端网络请求，建议只在没有云开发控制台权限时用。
// 3. 直接写死在下面的 apiKey 里：仅限本地调试，千万别提交到 git。
//
// Key 从哪申请：阿里云百炼控制台 https://bailian.console.aliyun.com/
// → 右上角头像 → API-KEY → 创建我的 API-KEY，形如 sk-xxxxxxxxxxxx
//
const AI_CONFIG = {
  qwen: {
    // DashScope 多模态生成接口（qwen-vl 系列 与 Qwen3.7 系列通用，不是通用文本接口）。
    // 注意：纯文本的 qwen-plus / qwen3.6-plus 不能放这里——它们不接收图片，
    // 会导致整条分析链路失败。要识图必须选多模态模型：qwen-vl-plus、qwen3-vl-plus、qwen3.7-plus 等。
    apiUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: 'qwen3.8-flash',
    apiKey: process.env.DASHSCOPE_API_KEY || ''
  }
}

// 当前只走 qwen3.8-flash 这一个多模态通道，不再保留 OpenAI 备用通道。
const CURRENT_MODEL = 'qwen'

// 采样参数：陈列评分要的是稳定复现，不是创意，所以温度压到很低。
// 如果发现同一张图多次分析分差还是很大，先看 PROMPT_GUIDE.md 建议 2。
const TEMPERATURE = 0.1
const MAX_TOKENS = 2500

// ============================================================
// ⚠️ 超时控制（改之前务必看懂，这里踩过坑）
// ============================================================
// 微信云函数单次执行**硬上限 60 秒**，到点进程直接被杀，
// try/catch 和 finally 都不会执行 —— 也就是说记录的 status 会永远停在
// analyzing，前端一直显示"分析中"，而 DashScope 那边其实已经跑完并计了费。
//
// 所以这里做两层防护：
// 1. AI_HARD_TIMEOUT_MS：自己先掐表，到点主动抛错，把控制权交回 catch，
//    保证能写入 analyze_failed，让用户看到失败而不是无限转圈。
// 2. axios timeout 设得比它再小一点，让网络层先超时、错误信息更具体。
//
// 40 秒的余量怎么来的：本函数前后还有取图片临时链接、查产品库、写数据库这些开销
// （合计约 3-5 秒），40 + 5 = 45 秒，距离 60 秒硬上限还剩 15 秒安全垫。
// 另外 batchAnalyze 是同步等本函数返回的，它自己也要在 60 秒内收尾，所以不能贴太满。
//
// 关掉思考模式后，一次三图分析正常在 15-25 秒完成，40 秒是够用的。
// 如果日志里频繁出现"主动中止"，说明图片太大或太多，优先压缩图片而不是调大这里
// —— 上限是 60 秒，调不动的。
// 自建后端没有云函数 60 秒硬上限。这里留 90 秒，避免正常偏慢的多图分析被误判失败。
const AI_HARD_TIMEOUT_MS = 90 * 1000
const AI_HTTP_TIMEOUT_MS = 85 * 1000


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

    // 2. 加载产品库、广告物料库、横签对照参考图与评分规则配置
    console.log('[2/5] 查询产品库、物料库与评分配置...')
    const ctx = preloadedContext || await loadAnalysisContext()
    const {
      activeMaterials,
      brandReferenceText,
      ownBrandNames,
      scoringRules,
      bannerRefMaterials,
      bannerRefUrls
    } = ctx
    console.log(`[2/5] 上下文加载完成（横签参考图 ${bannerRefUrls.length} 张）`)

    // 3. 调用 AI 视觉模型分析（实拍图 + 最多 3 张横签参考图）
    console.log(`[3/5] 调用 ${CURRENT_MODEL}/${AI_CONFIG[CURRENT_MODEL].model} 视觉分析...`)
    const analysis = await withHardTimeout(
      analyzeWithVision(imageUrls, {
        brandReferenceText,
        activeMaterials,
        ownBrandNames,
        scoringRules,
        bannerRefMaterials,
        bannerRefUrls
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
        analyzedModel: AI_CONFIG[CURRENT_MODEL].model,
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
// API Key 解析：环境变量优先，其次读 settings 集合
// ============================================================
async function resolveApiKey(config) {
  if (config.apiKey) return config.apiKey

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
// 评分规则 & 产品库 & 广告物料库 & 横签参考图加载
// ============================================================
async function loadScoringRules() {
  try {
    const res = await db.collection('settings').doc('global').get()
    return normalizeScoringRules(res.data && res.data.scoringRules)
  } catch (err) {
    return normalizeScoringRules(null)
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
  const scoringRules = await loadScoringRules()
  const activeMaterials = await loadActiveMaterials()
  const ownBrandNames = new Set()
  let brandReferenceText = ''

  try {
    const res = await db.collection('products').where({ isActive: true }).get()
    const products = res.data || []
    if (products.length > 0) {
      const lines = products.map(p => {
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

  // 筛选启用且带参考图 photo 的横签，最多取 3 张作为对照图传给视觉模型
  const candidateBannerRefs = selectHorizontalBannerRefs(activeMaterials, 3)
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
          bannerRefMaterials.push(m)
          bannerRefUrls.push(url)
        }
      })
    } catch (err) {
      console.warn('读取横签参考图失败，降级为纯文本特征识别:', err.message || err)
    }
  }

  return {
    scoringRules,
    activeMaterials,
    ownBrandNames,
    brandReferenceText,
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
  const config = AI_CONFIG[CURRENT_MODEL]
  const apiKey = await resolveApiKey(config)

  if (!apiKey) {
    console.warn('未配置 AI API Key，拒绝将模拟报告写入数据库（防止假数据污染统计）。配置方法见本文件顶部 AI_CONFIG 注释。')
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
    bannerRefMaterials = [],
    bannerRefUrls = []
  } = options

  const systemPrompt = buildSystemPrompt(scoringRules)
  const userPrompt = buildUserPrompt(imageUrls.length, brandReferenceText, bannerRefMaterials)
  const allImages = [...imageUrls, ...bannerRefUrls]

  const { text, debug } = await callQwen(config, apiKey, allImages, userPrompt, systemPrompt)
  const parsed = parseAIResponse(text, { activeMaterials, scoringRules, ownBrandNames })
  debug.parsedOk = !(parsed.metadata && parsed.metadata.parseError)
  debug.visitImageCount = imageUrls.length
  debug.bannerRefCount = bannerRefUrls.length
  return { text: parsed, debug }
}

/**
 * 调用通义千问 Qwen3.7-Plus（DashScope 原生多模态接口，支持一次传入多张图片）
 * Qwen3.7-Plus 是视觉-语言一体化多模态模型，能直接接收图片做视觉理解。
 *
 * 请求体结构（图片与文本都放进同一个 content 数组）：
 * - 图片放 input.messages[].content 数组里，格式是 { image: 'https://...' }
 * - 文本放同一个数组里，格式是 { text: '...' }
 * - 采样参数在顶层 parameters 里，不是平铺在 body 上
 *
 * 图片链接用的是云存储 getTempFileURL 返回的公网临时地址（有效期 2 小时），
 * DashScope 会自己去拉取，所以云存储不能设成完全私有。
 */
async function callQwen(config, apiKey, imageUrls, userPrompt, systemPrompt = SYSTEM_PROMPT) {
  const imageContent = imageUrls.map(url => ({ image: url }))

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
            content: [
              ...imageContent,
              { text: userPrompt }
            ]
          }
        ]
      },
      parameters: {
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        top_p: 0.5,
        // 高分辨率模式：把单图 token 上限从 1280 提到 16384，
        // 货架上的价签、瓶标小字要靠它才看得清。代价是 token 消耗上升。
        // 注意：vl_high_resolution_images 是 qwen-vl 老系列的专用参数，
        // Qwen3.7 系列原生就支持高分辨率，不需要也不会接受这个参数，
        // 传了反而可能报「参数错误」，所以只对 qwen-vl 前缀的模型开启。
        ...(config.model.startsWith('qwen-vl') ? { vl_high_resolution_images: true } : {}),
        // ⚠️⚠️ 千万不要删掉下面这两行 ⚠️⚠️
        // Qwen3.x 是"混合思考"模型，**默认开启思考模式**：回答正文之前会先生成
        // 一大段推理过程（reasoning_content）。对陈列打分这种结构化提取任务，
        // 思考过程没有价值，却带来两个致命后果：
        //   1. 耗时翻 2-4 倍 —— 直接把云函数顶穿 60 秒硬上限，记录卡死在"分析中"
        //   2. 思考 token 照常计费 —— 一次简单分析能烧掉近 2 万 token
        // 关闭后必须两个参数一起传：只设 thinking_budget=0 而不设 enable_thinking，
        // 模型仍会输出 reasoning_content 并计费（官方文档明确说明）。
        ...(isHybridThinkingModel(config.model)
          ? { enable_thinking: false, thinking_budget: 0 }
          : {})
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: AI_HTTP_TIMEOUT_MS
    })
  } catch (err) {
    // DashScope 的报错信息藏在 response.data 里，直接抛 axios 原始错误会丢掉
    // "Invalid API-key" / "模型不存在" 这类关键提示，排查时非常痛苦
    const data = err.response && err.response.data
    if (data && (data.message || data.code)) {
      throw new Error(`DashScope 调用失败[${data.code || err.response.status}]: ${data.message || '未知错误'}`)
    }
    // 网络层超时：说明模型生成太慢（图片太大／太多，或思考模式没关掉）
    if (err.code === 'ECONNABORTED') {
      throw new Error(`AI 响应超过 ${AI_HTTP_TIMEOUT_MS / 1000} 秒未返回，已中止。建议减少单次照片数量或压缩图片`)
    }
    throw err
  }

  // 构造一份诊断快照，无论解析成功与否都透传给调用方写进数据库，
  // 方便在云开发控制台直接看"模型到底回了什么、思考模式到底关没关"，而不用再靠猜。
  const output = response.data && response.data.output
  const msg = output && output.choices && output.choices[0] && output.choices[0].message
  const contentType = msg ? (Array.isArray(msg.content) ? 'array' : typeof msg.content) : 'none'
  const hasReasoning = !!(msg && (msg.reasoning_content || msg.reasoning))
  const reasoningOnly = hasReasoning && (
    contentType === 'none' ||
    (Array.isArray(msg.content) && msg.content.every(p => !p.text))
  )
  const debug = {
    model: config.model,
    enableThinkingSent: isHybridThinkingModel(config.model),
    hasOutput: !!output,
    hasChoices: !!(output && Array.isArray(output.choices) && output.choices.length > 0),
    contentType,
    hasReasoning,
    reasoningOnly,        // true = 模型只吐了思考过程、没吐正文，说明 enable_thinking 没关成功
    dashscopeCode: response.data && response.data.code,
    dashscopeMessage: response.data && response.data.message,
    requestId: response.data && response.data.request_id
  }

  try {
    const text = extractQwenText(response.data)
    return { text, debug }
  } catch (extractErr) {
    // 把诊断一并带上去，让 catch 上游能把 reasoningOnly 这类关键信号落库
    extractErr.debug = debug
    throw extractErr
  }
}

/**
 * 判断是否为 Qwen3.x 混合思考模型（需要显式关闭思考模式）
 *
 * 命中的模型：qwen3.5-* / qwen3.6-* / qwen3.7-* / qwen3.8-* 全系（plus / max / flash）
 * 不命中的：qwen-vl-plus 等老 VL 系列（不认识 enable_thinking 参数，传了会报参数错误）
 */
function isHybridThinkingModel(model) {
  return /^qwen3(\.\d+)?[-.]/.test(model || '') && !model.startsWith('qwen-vl')
}

/**
 * 从 DashScope 响应里取出文本
 * 官方对不同模型/不同时期返回过两种结构，这里都兼容一下，
 * 免得哪天换个模型名就整条链路静默返回 undefined。
 */
function extractQwenText(data) {
  if (!data || !data.output) {
    throw new Error('DashScope 返回结构异常：缺少 output 字段')
  }

  const output = data.output

  // 结构一（qwen-vl 系列多模态接口）：output.choices[0].message.content 是数组
  if (Array.isArray(output.choices) && output.choices.length > 0) {
    const content = output.choices[0].message && output.choices[0].message.content
    if (typeof content === 'string') return content
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

  // 走到这里通常意味着：模型只输出了思考过程（reasoning_content）没输出正文，
  // 说明 enable_thinking 没关成功。把这个判断单独拎出来，免得又被
  // "返回结构异常"这种万金油报错掩盖掉真正原因。
  const msg = output.choices && output.choices[0] && output.choices[0].message
  if (msg && (msg.reasoning_content || msg.reasoning)) {
    throw new Error('模型只返回了思考过程、没有正文，请确认 enable_thinking 参数已生效')
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

    // 兜底：截取第一个 { 到最后一个 } 之间的内容再解析
    if (!jsonStr.startsWith('{')) {
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
  if (!jsonStr.startsWith('{')) {
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

  const config = AI_CONFIG[CURRENT_MODEL]
  const apiKey = await resolveApiKey(config)
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
  const sharedCtx = await loadAnalysisContext()
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
    if (fileIDs.length === 0) {
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

  // 3. 基于真实单条结构化结果精确汇总大盘指标
  const aggregated = aggregateDailyMetrics(readyInspections)
  let narrative
  try {
    const userPrompt = buildDailySummaryUserPrompt(readyInspections, aggregated, sharedCtx.brandReferenceText)
    const { text } = await withHardTimeout(
      callQwen(config, apiKey, [], userPrompt, DAILY_SUMMARY_SYSTEM_PROMPT),
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
