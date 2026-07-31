// 云函数：analyzeImage
// 功能：AI 视觉分析白酒陈列照片，生成结构化评估报告

const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// ============================================================
// AI 模型配置
// ============================================================
const AI_CONFIG = {
  openai: {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY || ''
  },
  qwen: {
    apiUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: 'qwen-vl-max',
    apiKey: process.env.DASHSCOPE_API_KEY || ''
  }
}

// 选择使用的模型
// TODO(后续切换)：计划改用通义千问 qwen3.7-plus（暂用 qwen-vl-max 占位），
// 到时候只需把下面的值改成 'qwen'，并在 AI_CONFIG.qwen.model 里填正确的模型名即可，
// 主流程（多图合并、JSON 解析、字段校验）不需要改动。
const CURRENT_MODEL = 'openai'

// ============================================================
// 核心 System Prompt — 白酒陈列评估专家
// ============================================================
const SYSTEM_PROMPT = `你是一位资深的白酒行业终端陈列评估专家，拥有超过15年的白酒品牌管理和终端巡检经验。你的任务是对货架陈列照片进行专业、客观、细致的分析。

## 你的专业背景

- 熟悉中国主流白酒品牌及其产品线（茅台、五粮液、泸州老窖、洋河、汾酒、郎酒、剑南春、古井贡酒、水井坊、舍得等）
- 了解白酒香型分类（酱香型、浓香型、清香型、兼香型、凤香型等）
- 精通终端陈列标准和最佳实践
- 了解白酒消费场景和购买决策因素

## 评估维度与标准

### 1. 产品识别（productIdentification）
- **品牌识别**：根据瓶身、包装、标签识别白酒品牌
- **产品系列**：识别具体产品线（如五粮液的普五、1618等）
- **香型判断**：根据品牌和产品推断香型
- **排面数量**：统计每个品牌/产品占据的货架面数（facing）
- **价格带判断**：根据产品定位判断价格区间（高端/次高端/中端/大众）

### 2. 陈列规范度（displayCompliance）
- **正标朝向**：产品正面标签是否统一朝外，消费者是否容易阅读
- **整齐度**：产品排列是否整齐，间距是否均匀，是否在同一水平线
- **黄金位置**：核心产品是否位于货架黄金位（视线高度，约1.2m-1.6m）
- **集中陈列**：同品牌产品是否集中摆放，形成品牌区块
- **价签对应**：价签是否与产品一一对应，是否清晰可见
- **饱满度**：货架是否饱满，有无空位或缺货

### 3. 竞品分析（competitiveAnalysis）
- 识别画面中出现的其他白酒品牌
- 评估各品牌的位置优势和排面占比
- 判断竞争态势

### 4. 问题诊断（issues）
- 陈列不规范的具体问题
- 可能影响销售的因素
- 与陈列标准的差距

### 5. 改进建议（suggestions）
- 具体、可执行的改进措施
- 优先级排序（高/中/低）
- 预期效果

## 评分标准（0-100分）

| 分数段 | 等级 | 说明 |
|--------|------|------|
| 90-100 | 卓越 | 陈列完美，可作为标杆 |
| 80-89  | 优秀 | 整体规范，细节可优化 |
| 70-79  | 良好 | 基本达标，有明显改进空间 |
| 60-69  | 一般 | 多处不规范，需要整改 |
| 40-59  | 较差 | 问题严重，需立即整改 |
| 0-39   | 不合格 | 陈列混乱，需重新整理 |

评分权重：
- 产品识别完整度：15%
- 正标朝向规范：20%
- 整齐度：20%
- 黄金位置利用：20%
- 集中陈列：10%
- 价签对应：10%
- 货架饱满度：5%

## 输出要求

你必须严格按照以下 JSON 格式输出，不要输出任何其他内容：

\`\`\`json
{
  "score": 85,
  "scoreLevel": "优秀",
  "summary": "整体陈列规范，产品正标朝向统一，排列整齐。黄金位置利用良好，但存在部分价签缺失问题。",
  
  "productIdentification": [
    {
      "brand": "五粮液",
      "productLine": "普五第八代",
      "aromaType": "浓香型",
      "priceRange": "高端",
      "facingCount": 4,
      "position": "黄金位",
      "confidence": 0.92
    }
  ],
  
  "displayCompliance": {
    "labelOrientation": {
      "score": 90,
      "status": "good",
      "detail": "95%以上产品正标朝外，朝向统一"
    },
    "neatness": {
      "score": 85,
      "status": "good", 
      "detail": "产品排列基本整齐，间距均匀"
    },
    "goldenPosition": {
      "score": 80,
      "status": "good",
      "detail": "核心产品位于视线高度，但部分高端产品位置偏低"
    },
    "brandConcentration": {
      "score": 75,
      "status": "medium",
      "detail": "同品牌产品基本集中，但有分散情况"
    },
    "priceTagMatch": {
      "score": 60,
      "status": "poor",
      "detail": "部分产品缺少价签，约3个位置价签不对应"
    },
    "shelfFullness": {
      "score": 85,
      "status": "good",
      "detail": "货架饱满度良好，无明显空位"
    }
  },
  
  "competitiveAnalysis": {
    "totalBrands": 5,
    "brands": [
      {"brand": "五粮液", "sharePercent": 35, "positionAdvantage": "high"},
      {"brand": "泸州老窖", "sharePercent": 25, "positionAdvantage": "medium"},
      {"brand": "洋河", "sharePercent": 20, "positionAdvantage": "low"}
    ],
    "insight": "当前货架以浓香型白酒为主，五粮液占据优势位置"
  },
  
  "issues": [
    {
      "severity": "high",
      "category": "价签管理",
      "description": "第3排第2个位置缺少价签",
      "impact": "影响消费者价格判断，降低购买转化率"
    },
    {
      "severity": "medium",
      "category": "陈列规范",
      "description": "底层产品正标未完全朝外",
      "impact": "影响品牌形象和消费者识别"
    }
  ],
  
  "suggestions": [
    {
      "priority": "high",
      "action": "立即补充缺失的3个价签，确保每个产品都有对应价签",
      "expectedEffect": "提升购买转化率约15%",
      "deadline": "当日"
    },
    {
      "priority": "medium",
      "action": "调整底层产品摆放角度，确保正标完全朝外",
      "expectedEffect": "提升品牌展示效果",
      "deadline": "当日"
    },
    {
      "priority": "low",
      "action": "建议将高端产品移至黄金位置，增加视觉吸引力",
      "expectedEffect": "提升高端产品销售占比",
      "deadline": "下次补货时"
    }
  ],
  
  "metadata": {
    "imageQuality": "good",
    "shelfCount": 4,
    "totalProducts": 28,
    "analysisTime": "2026-07-28T14:30:00+08:00"
  }
}
\`\`\`

## 重要规则

1. **只输出 JSON**，不要输出任何解释文字、markdown 标记或其他内容
2. **所有字段必须存在**，如果无法识别某项信息，使用合理的默认值
3. **confidence 字段**表示识别置信度（0-1），低于 0.5 表示不确定
4. **score 必须是整数**，0-100 之间
5. **issues 和 suggestions 必须具体**，指出具体位置和具体操作
6. **如果照片不是货架陈列**，返回 score: 0 并在 summary 中说明
7. **如果照片模糊或质量差**，在 metadata.imageQuality 中标注，并适当降低 confidence`

// ============================================================
// 云函数入口
// ============================================================
exports.main = async (event, context) => {
  // 兼容两种入参：
  // - fileIDs: string[]  推荐，一次巡检的多张照片一起分析，得到一份合并报告
  // - fileID:  string    旧版单图入参，仍然支持
  const { fileID, fileIDs, inspectionId } = event
  const idsToAnalyze = Array.isArray(fileIDs) && fileIDs.length > 0
    ? fileIDs
    : (fileID ? [fileID] : [])

  if (idsToAnalyze.length === 0 || !inspectionId) {
    return { success: false, error: '缺少必要参数 fileID(s) 或 inspectionId' }
  }

  // 归属校验：云函数以管理员权限运行，会绕过数据库安全规则，如果不在这里显式校验，
  // 任何登录用户理论上都能传一个别人的 inspectionId，把自己的分析结果写进别人的巡检
  // 记录里（越权写入）。这里只允许"记录本人"或"管理者角色"触发分析。
  const wxContext = cloud.getWXContext()
  const callerOpenid = wxContext.OPENID
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
  if (inspectionDoc._openid !== callerOpenid) {
    const callerRes = await db.collection('users').where({ _openid: callerOpenid }).get()
    const callerRole = callerRes.data.length > 0 ? callerRes.data[0].role : 'sales'
    if (callerRole !== 'admin' && callerRole !== 'manager') {
      console.warn(`拒绝越权分析请求: caller=${callerOpenid} 试图分析 inspection=${inspectionId}（属于 ${inspectionDoc._openid}）`)
      return { success: false, error: '无权操作该巡检记录' }
    }
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
    console.log('[3/5] 调用 AI 视觉分析...')
    const aiReport = await analyzeWithVision(imageUrls, brandReferenceText)
    console.log('[3/5] AI 分析完成')

    // 4. 更新巡检记录
    console.log('[4/5] 更新数据库记录...')
    await db.collection('inspections').doc(inspectionId).update({
      data: {
        aiReport: aiReport,
        status: 'analyzed',
        analyzedAt: db.serverDate(),
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

  if (!config.apiKey) {
    console.warn('未配置 AI API Key，返回模拟结果')
    return generateMockReport()
  }

  const basePrompt = imageUrls.length > 1
    ? `以下 ${imageUrls.length} 张照片是同一次巡检、同一个货架从不同角度或不同排面拍摄的。请综合所有图片作为一个整体给出一份评估结果，注意跨图片去重（同一产品出现在多张照片中不要重复计数），不要为每张图分别输出。请严格按照 System Prompt 中定义的 JSON 格式输出评估结果。注意：只输出 JSON，不要输出任何其他内容。`
    : `请分析这张白酒货架陈列照片。请严格按照 System Prompt 中定义的 JSON 格式输出评估结果。注意：只输出 JSON，不要输出任何其他内容。`

  const userPrompt = basePrompt + (brandReferenceText || '')

  let response
  if (CURRENT_MODEL === 'openai') {
    response = await callOpenAI(config, imageUrls, userPrompt)
  } else if (CURRENT_MODEL === 'qwen') {
    response = await callQwen(config, imageUrls, userPrompt)
  } else {
    throw new Error(`不支持的模型: ${CURRENT_MODEL}`)
  }

  return parseAIResponse(response)
}

/**
 * 调用 OpenAI GPT-4o（支持一次传入多张图片）
 */
async function callOpenAI(config, imageUrls, userPrompt) {
  const imageContent = imageUrls.map(url => ({
    type: 'image_url',
    image_url: { url, detail: 'high' }
  }))

  const response = await axios.post(config.apiUrl, {
    model: config.model,
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          ...imageContent
        ]
      }
    ],
    max_tokens: 4000,
    temperature: 0.2,
    response_format: { type: 'json_object' }
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    timeout: 150000
  })

  return response.data.choices[0].message.content
}

/**
 * 调用通义千问 VL（支持一次传入多张图片）
 * 注：qwen-vl-max 为占位模型，切换到 qwen3.7-plus 时按其多模态接口要求调整
 * message.content 的图片字段即可，本函数的多图拼装方式一般无需改动。
 */
async function callQwen(config, imageUrls, userPrompt) {
  const imageContent = imageUrls.map(url => ({ image: url }))

  const response = await axios.post(config.apiUrl, {
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
      max_tokens: 4000,
      temperature: 0.2
    }
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    timeout: 150000
  })

  return response.data.output.text
}

// ============================================================
// 响应解析
// ============================================================
function parseAIResponse(responseText) {
  try {
    let jsonStr = responseText.trim()

    // 提取 markdown 代码块中的 JSON
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
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
  if (!result.metadata || typeof result.metadata !== 'object') {
    result.metadata = {}
  }

  // 保留原始响应
  result.rawResponse = rawResponse

  return result
}

// ============================================================
// 模拟报告（测试用）
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
