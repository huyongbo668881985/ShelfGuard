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

const cloud = require('wx-server-sdk')
const axios = require('axios')
const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompt')

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
    // DashScope 多模态生成接口（qwen-vl 系列专用，不是通用文本接口）
    apiUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: 'qwen-vl-plus',
    apiKey: process.env.DASHSCOPE_API_KEY || ''
  },
  openai: {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY || ''
  }
}

// 当前启用的模型。改成 'openai' 即可切回 GPT-4o，
// 主流程（多图合并、JSON 解析、字段校验）两边共用，不需要改动。
const CURRENT_MODEL = 'qwen'

// 采样参数：陈列评分要的是稳定复现，不是创意，所以温度压到很低。
// 如果发现同一张图多次分析分差还是很大，先看 PROMPT_GUIDE.md 建议 2。
const TEMPERATURE = 0.1
const MAX_TOKENS = 4000

// ============================================================
// 云函数入口
// ============================================================
exports.main = async (event, context) => {
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
  const wxContext = cloud.getWXContext()
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
  }

  let inspectionDoc
  try {
    const inspectionRes = await db.collection('inspections').doc(inspectionId).get()
    inspectionDoc = inspectionRes.data
  } catch (err) {
    return { success: false, error: '巡检记录不存在' }
  }
  if (!inspectionDoc) {
    return { success: false, error: '巡检记录不存在' }
  }

  if (!isInternalCall && inspectionDoc._openid !== callerOpenid) {
    const callerRole = callerUser ? callerUser.role : 'sales'
    if (callerRole !== 'admin' && callerRole !== 'manager') {
      console.warn(`拒绝越权分析请求: caller=${callerOpenid} 试图分析 inspection=${inspectionId}（属于 ${inspectionDoc._openid}）`)
      return { success: false, error: '无权操作该巡检记录' }
    }
  }

  // 待分析的图片：调用方没传就用巡检记录里存的全部照片（batchAnalyze 走的就是这条路）
  const idsToAnalyze = Array.isArray(fileIDs) && fileIDs.length > 0
    ? fileIDs
    : (fileID ? [fileID] : (inspectionDoc.photoFileIDs || []))

  if (idsToAnalyze.length === 0) {
    return { success: false, error: '该巡检记录没有可分析的照片' }
  }

  // fileIDs 也做一层归属校验：只允许分析这条巡检记录自己名下的照片，
  // 避免调用方夹带其他来源的 fileID 混进同一份报告
  const allowedFileIDs = new Set(inspectionDoc.photoFileIDs || [])
  const invalidIds = idsToAnalyze.filter(id => !allowedFileIDs.has(id))
  if (invalidIds.length > 0) {
    console.warn(`拒绝分析请求: fileID 不属于该巡检记录 inspection=${inspectionId}`, invalidIds)
    return { success: false, error: '提交的图片不属于该巡检记录' }
  }

  try {
    // 1. 获取图片临时链接（一次性批量获取，避免同一门店多角度照片被拆成多次分析、互相覆盖结果）
    console.log(`[1/5] 获取 ${idsToAnalyze.length} 张图片临时链接...`)
    const fileRes = await cloud.getTempFileURL({ fileList: idsToAnalyze })
    const failedFiles = fileRes.fileList.filter(f => !f.tempFileURL)
    if (fileRes.fileList.length === 0 || failedFiles.length === fileRes.fileList.length) {
      throw new Error('获取图片链接失败')
    }
    const imageUrls = fileRes.fileList
      .filter(f => f.tempFileURL)
      .map(f => f.tempFileURL)
    console.log('[1/5] 图片链接获取成功')

    // 2. 查询产品库（本品牌/别名/系列），拼成一段文字提示给 AI 做识别参考，
    //    这样品牌一多、一换，不用改 Prompt 代码，直接在"产品库管理"页里维护就行。
    console.log('[2/5] 查询产品库...')
    const brandReferenceText = await getBrandReferenceText()
    console.log('[2/5] 产品库查询完成')

    // 3. 调用 AI 视觉模型分析（同一次巡检的多张照片合并为一次调用，输出一份综合报告）
    console.log(`[3/5] 调用 ${CURRENT_MODEL}/${AI_CONFIG[CURRENT_MODEL].model} 视觉分析...`)
    const aiReport = await analyzeWithVision(imageUrls, brandReferenceText)
    console.log('[3/5] AI 分析完成')

    // 4. 更新巡检记录
    console.log('[4/5] 更新数据库记录...')
    await db.collection('inspections').doc(inspectionId).update({
      data: {
        aiReport: aiReport,
        status: 'analyzed',
        analyzedAt: db.serverDate(),
        analyzeError: '',                  // 重试成功时清掉上一次的错误信息
        analyzedModel: AI_CONFIG[CURRENT_MODEL].model,
        analyzedFileID: idsToAnalyze[0],   // 兼容旧字段：保留第一张图的 fileID
        analyzedFileIDs: idsToAnalyze      // 新字段：本次参与分析的全部 fileID
      }
    })
    console.log('[4/5] 数据库更新成功')

    console.log('[5/5] 分析完成')
    return { success: true, report: aiReport, fileIDs: idsToAnalyze }

  } catch (err) {
    console.error('AI 分析失败:', err)
    try {
      await db.collection('inspections').doc(inspectionId).update({
        data: {
          status: 'analyze_failed',
          analyzeError: err.message,
          analyzedAt: db.serverDate()
        }
      })
    } catch (updateErr) {
      console.error('更新失败状态出错:', updateErr)
    }
    return { success: false, error: err.message }
  }
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
// 产品库：查询本品牌资料，拼装成 AI 识别时的参考文本
// ============================================================
async function getBrandReferenceText() {
  try {
    const res = await db.collection('products').where({ isActive: true }).get()
    const products = res.data || []
    if (products.length === 0) return ''

    const lines = products.map(p => {
      const parts = [`品牌：${p.brandName}`]
      if (p.productLine) parts.push(`产品线：${p.productLine}`)
      if (Array.isArray(p.aliases) && p.aliases.length > 0) {
        parts.push(`别名/简称：${p.aliases.join('、')}`)
      }
      return `- ${parts.join('，')}`
    })

    return `\n\n## 本品牌产品资料（识别时优先参考，遇到下列品牌/别名要统一按标准品牌名归类，不要因为叫法不同而拆成两个品牌）\n${lines.join('\n')}`
  } catch (err) {
    // 产品库查询失败不应该阻断整个分析流程，退化为"不带品牌参考"继续跑
    console.error('查询产品库失败，本次分析不带品牌参考:', err)
    return ''
  }
}

// ============================================================
// AI 调用逻辑
// ============================================================
async function analyzeWithVision(imageUrls, brandReferenceText) {
  const config = AI_CONFIG[CURRENT_MODEL]
  const apiKey = await resolveApiKey(config)

  if (!apiKey) {
    console.warn('未配置 AI API Key，返回模拟结果。配置方法见本文件顶部 AI_CONFIG 注释。')
    return generateMockReport()
  }

  const userPrompt = buildUserPrompt(imageUrls.length, brandReferenceText)

  let response
  if (CURRENT_MODEL === 'qwen') {
    response = await callQwen(config, apiKey, imageUrls, userPrompt)
  } else if (CURRENT_MODEL === 'openai') {
    response = await callOpenAI(config, apiKey, imageUrls, userPrompt)
  } else {
    throw new Error(`不支持的模型: ${CURRENT_MODEL}`)
  }

  return parseAIResponse(response)
}

/**
 * 调用通义千问 Qwen-VL-Plus（DashScope 原生多模态接口，支持一次传入多张图片）
 *
 * 请求体结构和 OpenAI 完全不同，注意别照着 OpenAI 的写：
 * - 图片放 input.messages[].content 数组里，格式是 { image: 'https://...' }
 * - 文本放同一个数组里，格式是 { text: '...' }
 * - 采样参数在顶层 parameters 里，不是平铺在 body 上
 *
 * 图片链接用的是云存储 getTempFileURL 返回的公网临时地址（有效期 2 小时），
 * DashScope 会自己去拉取，所以云存储不能设成完全私有。
 */
async function callQwen(config, apiKey, imageUrls, userPrompt) {
  const imageContent = imageUrls.map(url => ({ image: url }))

  let response
  try {
    response = await axios.post(config.apiUrl, {
      model: config.model,
      input: {
        messages: [
          {
            role: 'system',
            content: [{ text: SYSTEM_PROMPT }]
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
        // 货架上的价签、瓶标小字要靠它才看得清。代价是 token 消耗上升，
        // 如果账单吃紧或接口报参数错误，删掉这一行即可。
        vl_high_resolution_images: true
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 150000
    })
  } catch (err) {
    // DashScope 的报错信息藏在 response.data 里，直接抛 axios 原始错误会丢掉
    // "Invalid API-key" / "模型不存在" 这类关键提示，排查时非常痛苦
    const data = err.response && err.response.data
    if (data && (data.message || data.code)) {
      throw new Error(`DashScope 调用失败[${data.code || err.response.status}]: ${data.message || '未知错误'}`)
    }
    throw err
  }

  return extractQwenText(response.data)
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

  throw new Error('DashScope 返回结构异常：未能提取到文本内容')
}

/**
 * 调用 OpenAI GPT-4o（支持一次传入多张图片）—— 备用通道
 */
async function callOpenAI(config, apiKey, imageUrls, userPrompt) {
  const imageContent = imageUrls.map(url => ({
    type: 'image_url',
    image_url: { url, detail: 'high' }
  }))

  const response = await axios.post(config.apiUrl, {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          ...imageContent
        ]
      }
    ],
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    response_format: { type: 'json_object' }
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    timeout: 150000
  })

  return response.data.choices[0].message.content
}

// ============================================================
// 响应解析
// ============================================================
function parseAIResponse(responseText) {
  try {
    let jsonStr = (responseText || '').trim()

    // 提取 markdown 代码块中的 JSON
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
    }

    // 兜底：Qwen 不支持 OpenAI 的 response_format:json_object 强制 JSON 输出，
    // 偶尔会在 JSON 前后带一句"好的，以下是分析结果："。
    // 截取第一个 { 到最后一个 } 之间的内容再解析。
    if (!jsonStr.startsWith('{')) {
      const start = jsonStr.indexOf('{')
      const end = jsonStr.lastIndexOf('}')
      if (start !== -1 && end > start) {
        jsonStr = jsonStr.slice(start, end + 1)
      }
    }

    const result = JSON.parse(jsonStr)

    // 验证并补全必要字段
    return validateAndNormalize(result, responseText)
  } catch (err) {
    console.error('解析 AI 返回结果失败:', err)
    return {
      score: 0,
      scoreLevel: '解析失败',
      summary: 'AI 返回结果解析失败，请重试',
      productIdentification: [],
      displayCompliance: {},
      competitiveAnalysis: {},
      issues: [],
      suggestions: [],
      metadata: { parseError: true },
      rawResponse: responseText
    }
  }
}

/**
 * 验证并规范化 AI 返回结果
 */
function validateAndNormalize(result, rawResponse) {
  // 确保 score 是有效整数
  let score = parseInt(result.score)
  if (isNaN(score) || score < 0 || score > 100) {
    score = 0
  }
  result.score = score

  // 确保 scoreLevel 存在
  if (!result.scoreLevel) {
    if (score >= 90) result.scoreLevel = '卓越'
    else if (score >= 80) result.scoreLevel = '优秀'
    else if (score >= 70) result.scoreLevel = '良好'
    else if (score >= 60) result.scoreLevel = '一般'
    else if (score >= 40) result.scoreLevel = '较差'
    else result.scoreLevel = '不合格'
  }

  // 确保数组字段存在
  if (!Array.isArray(result.productIdentification)) result.productIdentification = []
  if (!Array.isArray(result.issues)) result.issues = []
  if (!Array.isArray(result.suggestions)) result.suggestions = []

  // 确保对象字段存在
  if (!result.displayCompliance || typeof result.displayCompliance !== 'object') {
    result.displayCompliance = {}
  }
  if (!result.competitiveAnalysis || typeof result.competitiveAnalysis !== 'object') {
    result.competitiveAnalysis = {}
  }
  // report.wxml 里直接访问了 competitiveAnalysis.brands.length，
  // 缺这个数组会整页渲染报错，这里补一个空数组兜底
  if (!Array.isArray(result.competitiveAnalysis.brands)) {
    result.competitiveAnalysis.brands = []
  }
  if (!result.metadata || typeof result.metadata !== 'object') {
    result.metadata = {}
  }

  // 保留原始响应
  result.rawResponse = rawResponse

  return result
}

// ============================================================
// 模拟报告（未配置 API Key 时的占位结果，方便先把流程跑通）
// ============================================================
function generateMockReport() {
  return {
    score: 78,
    scoreLevel: '良好',
    summary: '【模拟报告】整体陈列基本规范，产品正标朝向较为统一。货架饱满度良好，但存在部分价签缺失和产品排列不够整齐的问题。建议优先补充价签，调整产品摆放角度。',
    productIdentification: [
      {
        brand: '五粮液',
        productLine: '普五第八代',
        aromaType: '浓香型',
        priceRange: '高端',
        facingCount: 4,
        position: '黄金位',
        confidence: 0.92
      },
      {
        brand: '泸州老窖',
        productLine: '特曲',
        aromaType: '浓香型',
        priceRange: '中端',
        facingCount: 3,
        position: '中层',
        confidence: 0.85
      },
      {
        brand: '洋河',
        productLine: '海之蓝',
        aromaType: '浓香型',
        priceRange: '中端',
        facingCount: 2,
        position: '底层',
        confidence: 0.78
      }
    ],
    displayCompliance: {
      labelOrientation: { score: 85, status: 'good', detail: '90%以上产品正标朝外' },
      neatness: { score: 72, status: 'medium', detail: '部分产品排列不够整齐' },
      goldenPosition: { score: 80, status: 'good', detail: '核心产品位于黄金位置' },
      brandConcentration: { score: 75, status: 'medium', detail: '同品牌基本集中' },
      priceTagMatch: { score: 55, status: 'poor', detail: '约4个位置缺少价签' },
      shelfFullness: { score: 88, status: 'good', detail: '货架饱满度良好' }
    },
    competitiveAnalysis: {
      totalBrands: 4,
      brands: [
        { brand: '五粮液', sharePercent: 35, positionAdvantage: 'high' },
        { brand: '泸州老窖', sharePercent: 28, positionAdvantage: 'medium' },
        { brand: '洋河', sharePercent: 22, positionAdvantage: 'low' }
      ],
      insight: '当前货架以浓香型白酒为主，五粮液占据优势位置'
    },
    issues: [
      { severity: 'high', category: '价签管理', description: '中层第2排约4个位置缺少价签', impact: '影响消费者价格判断' },
      { severity: 'medium', category: '陈列整齐度', description: '底层产品排列不够整齐，间距不均匀', impact: '影响整体视觉效果' },
      { severity: 'low', category: '品牌集中', description: '泸州老窖产品分散在两个区域', impact: '品牌展示效果减弱' }
    ],
    suggestions: [
      { priority: 'high', action: '立即补充缺失的4个价签', expectedEffect: '提升购买转化率', deadline: '当日' },
      { priority: 'medium', action: '调整底层产品摆放，保持间距均匀', expectedEffect: '提升陈列整齐度', deadline: '当日' },
      { priority: 'low', action: '将泸州老窖产品集中到一个区域', expectedEffect: '增强品牌区块效果', deadline: '下次补货时' }
    ],
    metadata: {
      imageQuality: 'good',
      shelfCount: 4,
      totalProducts: 24,
      isMock: true
    }
  }
}
