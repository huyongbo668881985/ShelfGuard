#!/usr/bin/env node
'use strict'

/**
 * 本地实拍图集评测工具（复用线上真实 Prompt + 图文交错隔离 + 服务端强校验）
 *
 * 设计原则：
 * - 零第三方依赖、不依赖 node:sqlite，Node 20+ 直接运行。
 * - 默认读取被 .gitignore 忽略的 `server/data/local-eval/` 目录，真实门店/产品照片与评测报告不会上传 GitHub。
 * - 自动兼容 iPhone 导出的 HEIC 伪装 .jpg 与超大原图（在本地 .resized/ 缓存为标准 JPEG <=1600px，不修改原图）。
 * - 复刻线上 analyzeWithVision 的有界思考参数与单次自动降级重试（reasoning_only / truncated_json / json_parse_retry）。
 *
 * 常用命令（在仓库根目录或 server/ 目录执行均可）：
 *   npm --prefix server run eval:local -- --runs 2
 *   npm --prefix server run eval:local -- --model qwen3.7-plus --runs 2
 *   npm --prefix server run eval:local -- --store store-02 --runs 2
 *   npm --prefix server run eval:local -- --no-thinking --runs 1
 *   npm --prefix server run eval:local -- --dry-run
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const {
  buildSystemPrompt,
  buildUserPrompt,
  buildMultimodalUserContent
} = require('../src/functions/analyzeImage/prompt')
const {
  normalizeScoringRules,
  selectHorizontalBannerRefs,
  selectProductRefs,
  validateAndNormalizeReport
} = require('../src/functions/analyzeImage/scoring')
const { summarizeResults } = require('./eval-golden-set')

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const DEFAULT_EVAL_DIR = path.resolve(__dirname, '../data/local-eval')
const MAX_DIRECT_IMAGE_BYTES = 1.5 * 1024 * 1024
const MAX_RESIZED_EDGE = 1600

function parseBoolFlag(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const s = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return fallback
}

function parseIntFlag(raw, fallback, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = parseInt(String(raw).trim(), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function parseArgs(argv) {
  const args = {
    dir: DEFAULT_EVAL_DIR,
    model: process.env.EVAL_MODEL || process.env.DASHSCOPE_MODEL || 'qwen3.8-flash',
    runs: 2,
    enableThinking: parseBoolFlag(process.env.DASHSCOPE_ENABLE_THINKING, true),
    thinkingBudget: parseIntFlag(process.env.DASHSCOPE_THINKING_BUDGET, 1024, 0, 8192),
    maxTokens: parseIntFlag(process.env.DASHSCOPE_MAX_TOKENS, 4096, 1024, 16384),
    maxProductRefs: parseIntFlag(process.env.AI_MAX_PRODUCT_REFS, 4, 0, 8),
    maxBannerRefs: parseIntFlag(process.env.AI_MAX_BANNER_REFS, 3, 0, 5),
    store: '',
    out: '',
    dryRun: false
  }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--dir' && argv[i + 1]) args.dir = path.resolve(process.cwd(), argv[++i])
    else if (k === '--model' && argv[i + 1]) args.model = argv[++i]
    else if (k === '--runs' && argv[i + 1]) args.runs = parseIntFlag(argv[++i], 2, 1, 10)
    else if (k === '--thinking-budget' && argv[i + 1]) args.thinkingBudget = parseIntFlag(argv[++i], 1024, 0, 8192)
    else if (k === '--no-thinking') {
      args.enableThinking = false
      args.thinkingBudget = 0
    } else if (k === '--enable-thinking') args.enableThinking = true
    else if (k === '--max-tokens' && argv[i + 1]) args.maxTokens = parseIntFlag(argv[++i], 4096, 1024, 16384)
    else if (k === '--store' && argv[i + 1]) args.store = argv[++i].trim()
    else if (k === '--out' && argv[i + 1]) args.out = argv[++i]
    else if (k === '--dry-run') args.dryRun = true
  }
  return args
}

/**
 * 轻量读取 .env 文件中的 DASHSCOPE_API_KEY（不依赖 dotenv）
 */
function resolveApiKey() {
  if (process.env.DASHSCOPE_API_KEY && process.env.DASHSCOPE_API_KEY.trim()) {
    return process.env.DASHSCOPE_API_KEY.trim()
  }
  const candidates = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env')
  ]
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const m = /^\s*DASHSCOPE_API_KEY\s*=\s*(.+?)\s*$/.exec(line)
      if (m && m[1]) {
        return m[1].replace(/^['"]|['"]$/g, '').trim()
      }
    }
  }
  return ''
}

function isHybridThinkingModel(model) {
  const m = String(model || '').trim()
  return /^qwen3(\.\d+)?[-.]/i.test(m) && !/^qwen-vl/i.test(m)
}

function isHeicBuffer(buf) {
  if (!buf || buf.length < 12) return false
  const box = buf.slice(4, 12).toString('ascii')
  return /^ftyp(heic|heix|hevc|hevx|mif1|msf1)/i.test(box)
}

function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}

/**
 * 将本地照片转为 DataURL；若为 iPhone HEIC 或超过 1.5MB，自动转存标准 JPEG 缓存至 .resized/（不改动原图）
 */
function prepareImageDataUrl(absPath, baseDir) {
  const stat = fs.statSync(absPath)
  const head = Buffer.alloc(16)
  const fd = fs.openSync(absPath, 'r')
  try {
    fs.readSync(fd, head, 0, 16, 0)
  } finally {
    fs.closeSync(fd)
  }

  const needConvert = isHeicBuffer(head) || stat.size > MAX_DIRECT_IMAGE_BYTES
  if (!needConvert) {
    const buf = fs.readFileSync(absPath)
    return `data:${mimeFromExt(absPath)};base64,${buf.toString('base64')}`
  }

  const cacheDir = path.join(baseDir, '.resized')
  fs.mkdirSync(cacheDir, { recursive: true })
  const safeBase = path.relative(baseDir, absPath).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_')
  const cachedPath = path.join(cacheDir, `${safeBase}.jpg`)

  let reuseCache = false
  if (fs.existsSync(cachedPath)) {
    const cachedStat = fs.statSync(cachedPath)
    if (cachedStat.size > 0 && cachedStat.mtimeMs >= stat.mtimeMs) {
      reuseCache = true
    }
  }

  if (!reuseCache) {
    try {
      execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', String(MAX_RESIZED_EDGE), absPath, '--out', cachedPath], {
        stdio: 'ignore'
      })
    } catch (err) {
      if (isHeicBuffer(head)) {
        throw new Error(`图片 ${path.basename(absPath)} 实际为 HEIC 格式且本机无法自动转码，请先转为标准 JPG 后重试`)
      }
      const rawBuf = fs.readFileSync(absPath)
      return `data:${mimeFromExt(absPath)};base64,${rawBuf.toString('base64')}`
    }
  }

  const buf = fs.readFileSync(cachedPath)
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}

function listImagesInDir(dirPath) {
  if (!fs.existsSync(dirPath)) return []
  return fs.readdirSync(dirPath)
    .filter(name => !name.startsWith('.') && IMAGE_EXTS.has(path.extname(name).toLowerCase()))
    .sort()
    .map(name => path.join(dirPath, name))
}

/**
 * 加载本地评测目录（info.json + 自动扫描 products / materials / visits）
 */
function loadLocalEvalConfig(evalDir, options = {}) {
  const infoPath = path.join(evalDir, 'info.json')
  const info = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : {}
  const maxProductRefs = options.maxProductRefs != null ? options.maxProductRefs : 4
  const maxBannerRefs = options.maxBannerRefs != null ? options.maxBannerRefs : 3

  // 1. 产品库与我方品牌名集合
  const ownBrandNames = new Set()
  if (info.brandName) ownBrandNames.add(String(info.brandName).trim().toLowerCase())
  if (Array.isArray(info.ownBrandNames)) {
    info.ownBrandNames.forEach(s => {
      const k = String(s || '').trim().toLowerCase()
      if (k) ownBrandNames.add(k)
    })
  }

  const rawProducts = Array.isArray(info.products) ? info.products : []
  const normalizedProducts = rawProducts
    .filter(p => p && typeof p === 'object' && p.brandName && !String(p.productLine || '').includes('可继续往下加'))
    .map(p => {
      ownBrandNames.add(String(p.brandName).trim().toLowerCase())
      const aliases = Array.isArray(p.aliases) ? p.aliases.map(a => String(a || '').trim()).filter(Boolean) : []
      aliases.forEach(a => ownBrandNames.add(a.toLowerCase()))

      const photos = {}
      if (p.photos && typeof p.photos === 'object') {
        ;['front', 'side', 'back'].forEach(slot => {
          if (p.photos[slot]) {
            const abs = path.resolve(evalDir, p.photos[slot])
            if (fs.existsSync(abs)) photos[slot] = abs
          }
        })
      }
      if (p.photoFile) {
        const abs = path.resolve(evalDir, p.photoFile)
        const slot = ['front', 'side', 'back'].includes(p.slot) ? p.slot : 'front'
        if (fs.existsSync(abs) && !photos[slot]) photos[slot] = abs
      }
      return {
        brandName: String(p.brandName).trim(),
        productLine: String(p.productLine || '').trim(),
        aliases,
        visualFeatures: String(p.visualFeatures || '').trim(),
        photos,
        isActive: p.isActive !== false
      }
    })

  // 2. 广告物料库
  const rawMaterials = Array.isArray(info.materials) ? info.materials : []
  const activeMaterials = rawMaterials
    .filter(m => m && typeof m === 'object' && m.materialName)
    .map(m => {
      const photoAbs = m.photoFile ? path.resolve(evalDir, m.photoFile) : ''
      return {
        materialName: String(m.materialName).trim(),
        category: String(m.category || '其他').trim() || '其他',
        aliases: Array.isArray(m.aliases) ? m.aliases.map(a => String(a || '').trim()).filter(Boolean) : [],
        visualFeatures: String(m.visualFeatures || '').trim(),
        photo: photoAbs && fs.existsSync(photoAbs) ? photoAbs : '',
        isActive: m.isActive !== false
      }
    })

  // 3. 拼装与线上 loadAnalysisContext 一致的 brandReferenceText
  let brandReferenceText = ''
  if (normalizedProducts.length > 0) {
    const lines = normalizedProducts.map(p => {
      const parts = [`品牌：${p.brandName}`]
      if (p.productLine) parts.push(`产品线：${p.productLine}`)
      if (p.aliases.length > 0) parts.push(`别名/简称：${p.aliases.join('、')}`)
      if (p.visualFeatures) parts.push(`视觉特征：${p.visualFeatures}`)
      return `- ${parts.join('，')}`
    })
    brandReferenceText += `\n\n## 本品牌产品资料（识别时优先参考，遇到下列品牌/别名要统一按标准品牌名归类并标注 isOwn: true，其余品牌视为竞品 isOwn: false）\n${lines.join('\n')}`
  }
  if (activeMaterials.length > 0) {
    const mLines = activeMaterials.map(m => {
      const parts = [`标准名称：${m.materialName}`]
      if (m.category) parts.push(`分类：${m.category}`)
      if (m.aliases.length > 0) parts.push(`别名：${m.aliases.join('、')}`)
      if (m.visualFeatures) parts.push(`视觉特征：${m.visualFeatures}`)
      return `- ${parts.join('，')}`
    })
    brandReferenceText += `\n\n## 本品牌广告物料库（识别画面中的广告物料时必须优先比对下列物料，并在 adMaterials[].name 中严格输出对应的「标准名称」）\n${mLines.join('\n')}`
  }

  // 4. 筛选参考图（复用线上同款 selectProductRefs / selectHorizontalBannerRefs）
  const selectedProductRefs = selectProductRefs(normalizedProducts, maxProductRefs)
  const selectedBannerRefs = selectHorizontalBannerRefs(activeMaterials, maxBannerRefs)

  // 5. 发现门店拜访样本：合并 info.visits 配置与 visits/ 下全部非空子目录
  const visitMetaById = new Map()
  ;(Array.isArray(info.visits) ? info.visits : []).forEach(v => {
    if (!v || !v.folder) return
    const id = path.basename(v.folder)
    visitMetaById.set(id, v)
  })

  const visitsRoot = path.join(evalDir, 'visits')
  const discoveredIds = fs.existsSync(visitsRoot)
    ? fs.readdirSync(visitsRoot)
        .filter(name => !name.startsWith('.') && fs.statSync(path.join(visitsRoot, name)).isDirectory())
        .sort()
    : []

  const allStoreIds = Array.from(new Set([...visitMetaById.keys(), ...discoveredIds]))
  const stores = []
  for (const id of allStoreIds) {
    const meta = visitMetaById.get(id) || {}
    const folderAbs = meta.folder ? path.resolve(evalDir, meta.folder) : path.join(visitsRoot, id)
    const images = listImagesInDir(folderAbs)
    if (images.length === 0) continue
    stores.push({
      id,
      name: meta.name || id,
      images,
      expected: meta.expected || {}
    })
  }

  return {
    scoringRules: normalizeScoringRules(info.scoringRules),
    ownBrandNames,
    activeMaterials,
    brandReferenceText,
    selectedProductRefs,
    selectedBannerRefs,
    stores
  }
}

function parseRawJson(text) {
  let jsonStr = String(text || '').trim()
  const m = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m) jsonStr = m[1].trim()
  if (!jsonStr.startsWith('{') || !jsonStr.endsWith('}')) {
    const s = jsonStr.indexOf('{')
    const e = jsonStr.lastIndexOf('}')
    if (s !== -1 && e > s) jsonStr = jsonStr.slice(s, e + 1)
  }
  return JSON.parse(jsonStr)
}

function extractQwenText(data, enableThinking) {
  const output = data && data.output
  if (output && Array.isArray(output.choices) && output.choices[0]) {
    const content = output.choices[0].message && output.choices[0].message.content
    if (typeof content === 'string' && content.trim()) return content
    if (Array.isArray(content)) {
      const text = content.map(p => (typeof p === 'string' ? p : p.text)).filter(Boolean).join('')
      if (text) return text
    }
  }
  if (output && typeof output.text === 'string' && output.text) return output.text
  const msg = output && output.choices && output.choices[0] && output.choices[0].message
  if (msg && (msg.reasoning_content || msg.reasoning)) {
    const err = new Error(enableThinking ? '模型思考耗尽输出预算未能生成正文' : '模型只返回了思考过程无正文')
    err.code = 'REASONING_ONLY'
    throw err
  }
  throw new Error('DashScope 返回结构异常：未提取到文本')
}

async function callDashScopeOnce({ apiKey, model, userContent, systemPrompt, enableThinking, thinkingBudget, maxTokens, omitThinkingParams = false }) {
  const parameters = {
    max_tokens: maxTokens,
    temperature: 0.1,
    top_p: 0.5,
    ...(String(model).toLowerCase().startsWith('qwen-vl') ? { vl_high_resolution_images: true } : {}),
    ...(!omitThinkingParams && isHybridThinkingModel(model)
      ? (enableThinking && thinkingBudget > 0
          ? { enable_thinking: true, thinking_budget: thinkingBudget }
          : { enable_thinking: false, thinking_budget: 0 })
      : {})
  }

  const t0 = Date.now()
  const res = await fetch(DASHSCOPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: {
        messages: [
          { role: 'system', content: [{ text: systemPrompt }] },
          { role: 'user', content: userContent }
        ]
      },
      parameters
    })
  })
  const latencyMs = Date.now() - t0
  const data = await res.json()
  if (!res.ok) {
    const err = new Error(`DashScope HTTP ${res.status}: ${data.message || data.code || JSON.stringify(data)}`)
    err.dashscopeCode = data.code || String(res.status)
    throw err
  }
  const choice = data && data.output && Array.isArray(data.output.choices) && data.output.choices[0]
  const msg = choice && choice.message
  const reasoning = (msg && (msg.reasoning_content || msg.reasoning)) || ''
  const text = extractQwenText(data, Boolean(parameters.enable_thinking))
  return {
    text,
    latencyMs,
    finishReason: (choice && choice.finish_reason) || '',
    reasoningLength: reasoning.length,
    usage: data.usage || null,
    requestId: data.request_id || ''
  }
}

async function callWithProductionFallback(callParams) {
  const thinkingAttempted = isHybridThinkingModel(callParams.model) && callParams.enableThinking && callParams.thinkingBudget > 0
  let res
  let fallback = ''

  try {
    res = await callDashScopeOnce(callParams)
  } catch (err) {
    const isThinkingParamErr = thinkingAttempted &&
      /thinking/i.test(String(err.message || '')) &&
      /InvalidParameter|400|parameter/i.test(String(err.dashscopeCode || err.message || ''))
    const isReasoningOnly = thinkingAttempted && err.code === 'REASONING_ONLY'
    if (isReasoningOnly || isThinkingParamErr) {
      fallback = isReasoningOnly ? 'reasoning_only' : 'unsupported_param'
      res = await callDashScopeOnce({
        ...callParams,
        enableThinking: false,
        thinkingBudget: 0,
        omitThinkingParams: isThinkingParamErr
      })
    } else {
      throw err
    }
  }

  let parsed
  try {
    parsed = parseRawJson(res.text)
  } catch (parseErr) {
    if (!fallback) {
      fallback = (thinkingAttempted && res.finishReason === 'length') ? 'truncated_json' : 'json_parse_retry'
      const retryRes = await callDashScopeOnce({
        ...callParams,
        enableThinking: thinkingAttempted ? false : callParams.enableThinking,
        thinkingBudget: thinkingAttempted ? 0 : callParams.thinkingBudget
      })
      res = retryRes
      parsed = parseRawJson(res.text)
    } else {
      throw parseErr
    }
  }

  return { res, parsed, fallback }
}

function timestampSlug() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function main() {
  const args = parseArgs(process.argv)
  if (!fs.existsSync(args.dir)) {
    console.error(`本地评测目录不存在: ${args.dir}`)
    console.error('请先在 server/data/local-eval/ 下放入 products/、materials/、visits/ 和 info.json（详见 server/scripts/README.md）')
    process.exit(1)
  }

  const cfg = loadLocalEvalConfig(args.dir, {
    maxProductRefs: args.maxProductRefs,
    maxBannerRefs: args.maxBannerRefs
  })
  const stores = args.store
    ? cfg.stores.filter(s => s.id === args.store || s.name.includes(args.store))
    : cfg.stores

  if (stores.length === 0) {
    console.error(`未在 ${path.join(args.dir, 'visits')} 中找到可评测的门店照片`)
    process.exit(1)
  }

  const apiKey = resolveApiKey()
  if (!args.dryRun && !apiKey) {
    console.error('未找到 DASHSCOPE_API_KEY（请通过环境变量或 server/.env 配置，或加 --dry-run 演练）')
    process.exit(1)
  }

  console.log(`\n========== 本地实拍评测 ==========`)
  console.log(`目录: ${args.dir}`)
  console.log(`模型: ${args.model} | runs=${args.runs} | thinking=${args.enableThinking ? args.thinkingBudget : 'off'} | maxTokens=${args.maxTokens}${args.dryRun ? ' | DRY-RUN' : ''}`)
  console.log(`参考图: 产品 ${cfg.selectedProductRefs.length} 张 (${cfg.selectedProductRefs.map(p => `${p.productLine || p.brandName}[${p.slot}]`).join(', ') || '无'}) | 横签 ${cfg.selectedBannerRefs.length} 张`)
  console.log(`待测门店: ${stores.map(s => `${s.id}(${s.images.length}图)`).join(', ')}\n`)

  const productRefs = args.dryRun
    ? cfg.selectedProductRefs.map(p => ({ ...p, url: 'dry-run://product' }))
    : cfg.selectedProductRefs.map(p => ({ ...p, url: prepareImageDataUrl(p.photo, args.dir) }))
  const bannerRefs = args.dryRun
    ? cfg.selectedBannerRefs.map(b => ({ ...b, url: 'dry-run://banner' }))
    : cfg.selectedBannerRefs.map(b => ({ ...b, url: prepareImageDataUrl(b.photo, args.dir) }))

  const systemPrompt = buildSystemPrompt(cfg.scoringRules)
  const caseReports = []

  for (const store of stores) {
    const visitUrls = args.dryRun
      ? store.images.map((_, i) => `dry-run://visit-${i + 1}`)
      : store.images.map(imgPath => prepareImageDataUrl(imgPath, args.dir))

    const userPrompt = buildUserPrompt(visitUrls.length, cfg.brandReferenceText, bannerRefs, productRefs)
    const userContent = buildMultimodalUserContent({
      visitImageUrls: visitUrls,
      productRefs,
      bannerRefs,
      userPrompt
    })

    const storeRuns = []
    for (let r = 1; r <= args.runs; r++) {
      console.log(`[${args.model}] ${store.name} 第 ${r}/${args.runs} 轮...`)
      try {
        if (args.dryRun) {
          console.log(`  -> [dry-run] 已组装 ${userContent.length} 段图文交错内容（实拍 ${visitUrls.length} + 产品参考 ${productRefs.length} + 横签参考 ${bannerRefs.length}）`)
          storeRuns.push({ run: r, dryRun: true, contentParts: userContent.length })
          continue
        }

        const { res, parsed, fallback } = await callWithProductionFallback({
          apiKey,
          model: args.model,
          userContent,
          systemPrompt,
          enableThinking: args.enableThinking,
          thinkingBudget: args.thinkingBudget,
          maxTokens: args.maxTokens
        })
        const normalized = validateAndNormalizeReport(parsed, res.text, {
          activeMaterials: cfg.activeMaterials,
          scoringRules: cfg.scoringRules,
          ownBrandNames: cfg.ownBrandNames,
          visitImageCount: visitUrls.length
        })

        const dc = normalized.displayCompliance || {}
        const fm = normalized.facingMetrics || {}
        const meta = normalized.metadata || {}
        const runEntry = {
          run: r,
          latencyMs: res.latencyMs,
          finishReason: res.finishReason,
          reasoningLength: res.reasoningLength,
          fallback: fallback || '',
          usage: res.usage,
          hasShelfPhoto: normalized.hasShelfPhoto,
          ownBrandPresent: normalized.ownBrandPresent,
          score: normalized.score,
          scoreLevel: normalized.scoreLevel,
          ownFacingCount: fm.ownFacingCount,
          facingMetrics: fm,
          metadata: meta,
          shelfObservations: normalized.shelfObservations,
          productIdentification: normalized.productIdentification,
          adMaterials: normalized.adMaterials,
          displayCompliance: dc,
          summary: normalized.summary
        }
        storeRuns.push(runEntry)
        console.log(
          `  -> ${res.latencyMs}ms${fallback ? ` [fallback:${fallback}]` : ''} | score=${normalized.score} (${normalized.scoreLevel}) | ownFacing=${fm.ownFacingCount} | golden=${dc.goldenPosition ? dc.goldenPosition.score : '-'} | label=${dc.labelOrientation ? dc.labelOrientation.score : '-'} | price=${dc.priceTag ? dc.priceTag.score : '-'} | banner=${dc.horizontalBanner ? dc.horizontalBanner.score : '-'} | framing=${meta.framingType} | quality=${meta.imageQuality} | review=${meta.needsReview}`
        )
      } catch (err) {
        console.error(`  -> 失败: ${err.message}`)
        storeRuns.push({ run: r, error: err.message })
      }
    }

    caseReports.push({
      id: store.id,
      name: store.name,
      imageFiles: store.images.map(p => path.relative(args.dir, p)),
      expected: store.expected,
      runs: storeRuns
    })
  }

  if (!args.dryRun) {
    const summary = summarizeResults(caseReports)
    console.log('\n========== 评测指标汇总 ==========')
    console.log(JSON.stringify(summary, null, 2))

    const outDir = path.join(args.dir, 'results')
    fs.mkdirSync(outDir, { recursive: true })
    const safeModel = args.model.replace(/[^a-zA-Z0-9._-]/g, '_')
    const outPath = args.out
      ? path.resolve(process.cwd(), args.out)
      : path.join(outDir, `result-${safeModel}-${timestampSlug()}.json`)
    fs.writeFileSync(outPath, JSON.stringify({
      model: args.model,
      runs: args.runs,
      enableThinking: args.enableThinking,
      thinkingBudget: args.thinkingBudget,
      maxTokens: args.maxTokens,
      summary,
      cases: caseReports
    }, null, 2))
    console.log(`\n完整评测明细已保存（已 gitignore，不上传 GitHub）:\n  ${outPath}`)
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('本地评测执行失败:', err)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  loadLocalEvalConfig,
  parseRawJson,
  isHeicBuffer
}
