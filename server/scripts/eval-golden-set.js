#!/usr/bin/env node
'use strict'

/**
 * 黄金标杆图集本地回归评测脚本
 *
 * 复用线上真实的 buildSystemPrompt / buildUserPrompt / validateAndNormalizeReport，
 * 对 15-20 张实拍图与人工基准分对照评估：
 * - 总分误差（MAE / RMSE / 最大误差）
 * - 排面计数误差（MAE / 精确命中率 / ±1面命中率）
 * - 无货架照 / 未上柜 分类准确率
 * - 同图多次运行波动（标准差 / 最大极差）
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx node server/scripts/eval-golden-set.js \
 *     --dataset server/scripts/golden-set.example.json --runs 3 --out eval-result.json
 *
 * 无 Key 本地演练（验证脚本与指标统计链路）：
 *   node server/scripts/eval-golden-set.js --dataset server/scripts/golden-set.example.json --runs 2 --dry-run
 */

const fs = require('fs')
const path = require('path')
const {
  buildSystemPrompt,
  buildUserPrompt,
  buildMultimodalUserContent
} = require('../src/functions/analyzeImage/prompt')
const {
  normalizeScoringRules,
  validateAndNormalizeReport
} = require('../src/functions/analyzeImage/scoring')

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

function parseBoolFlag(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const s = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return fallback
}

function parseBoundedInt(raw, fallback, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = parseInt(String(raw).trim(), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function parseArgs(argv) {
  const args = {
    dataset: '',
    runs: 1,
    model: process.env.EVAL_MODEL || process.env.DASHSCOPE_MODEL || 'qwen3.8-flash',
    enableThinking: parseBoolFlag(process.env.DASHSCOPE_ENABLE_THINKING, true),
    thinkingBudget: parseBoundedInt(process.env.DASHSCOPE_THINKING_BUDGET, 2560, 0, 8192),
    maxTokens: parseBoundedInt(process.env.DASHSCOPE_MAX_TOKENS, 8192, 1024, 16384),
    out: '',
    dryRun: false
  }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--dataset' && argv[i + 1]) args.dataset = argv[++i]
    else if (k === '--runs' && argv[i + 1]) args.runs = parseBoundedInt(argv[++i], 1, 1, 10)
    else if (k === '--model' && argv[i + 1]) args.model = argv[++i]
    else if (k === '--thinking-budget' && argv[i + 1]) {
      args.thinkingBudget = parseBoundedInt(argv[++i], 0, 0, 8192)
      args.enableThinking = args.thinkingBudget > 0
    }
    else if (k === '--no-thinking') { args.enableThinking = false; args.thinkingBudget = 0 }
    else if (k === '--max-tokens' && argv[i + 1]) args.maxTokens = parseBoundedInt(argv[++i], 8192, 1024, 16384)
    else if (k === '--out' && argv[i + 1]) args.out = argv[++i]
    else if (k === '--dry-run') args.dryRun = true
  }
  if (!args.enableThinking) args.thinkingBudget = 0
  return args
}

function fileToDataUrl(filePath, baseDir) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
  const buf = fs.readFileSync(abs)
  const ext = path.extname(abs).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg')
  return `data:${mime};base64,${buf.toString('base64')}`
}

function isHybridThinkingModel(model) {
  const m = String(model || '').trim()
  return /^qwen3(\.\d+)?[-.]/i.test(m) && !/^qwen-vl/i.test(m)
}

async function callDashScope({
  apiKey,
  model,
  userContent,
  systemPrompt,
  enableThinking = true,
  thinkingBudget = 2560,
  maxTokens = 8192
}) {
  const body = {
    model,
    input: {
      messages: [
        { role: 'system', content: [{ text: systemPrompt }] },
        {
          role: 'user',
          content: userContent
        }
      ]
    },
    parameters: {
      max_tokens: maxTokens,
      temperature: 0.1,
      top_p: 0.5,
      ...(String(model).toLowerCase().startsWith('qwen-vl') ? { vl_high_resolution_images: true } : {}),
      ...(isHybridThinkingModel(model)
        ? (enableThinking && thinkingBudget > 0
            ? { enable_thinking: true, thinking_budget: thinkingBudget }
            : { enable_thinking: false, thinking_budget: 0 })
        : {})
    }
  }

  const res = await fetch(DASHSCOPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(`DashScope HTTP ${res.status}: ${data.message || data.code || JSON.stringify(data)}`)
  }
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
  throw new Error('DashScope 返回结构异常：未提取到文本')
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

function makeDryRunResponse(item, runIdx) {
  const exp = item.expected || {}
  if (exp.hasShelfPhoto === false) {
    return JSON.stringify({
      hasShelfPhoto: false,
      ownBrandPresent: null,
      score: null,
      scoreLevel: '无货架照',
      summary: '[dry-run] 门头照，无货架',
      metadata: { imageQuality: 'good', framingType: 'non_shelf', photoRoles: ['门头照'] }
    })
  }
  if (exp.ownBrandPresent === false) {
    return JSON.stringify({
      hasShelfPhoto: true,
      ownBrandPresent: false,
      score: null,
      scoreLevel: '未上柜',
      summary: '[dry-run] 货架未见我方品牌',
      facingMetrics: { ownFacingCount: 0, ownSkuCount: 0, totalShelfFacingCount: 20, ownFacingShare: 0, countingConfidence: 0.9 },
      metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照'] }
    })
  }
  const jitter = runIdx % 2 === 0 ? 0 : 1
  const facing = Math.max(1, (exp.ownFacingCount || 8) + (runIdx % 2 === 0 ? 0 : 0))
  const dims = exp.dimensions || {}
  return JSON.stringify({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    summary: '[dry-run] 模拟评估输出',
    facingMetrics: {
      ownFacingCount: facing,
      ownSkuCount: 2,
      totalShelfFacingCount: Math.max(facing * 2, 20),
      ownFacingShare: 40,
      countingConfidence: 0.9
    },
    displayCompliance: {
      facingCount: { score: Math.min(50, facing * 5), observedFacings: facing, detail: 'dry-run' },
      goldenPosition: { score: (dims.goldenPosition != null ? dims.goldenPosition : 16) - jitter, detail: 'dry-run' },
      labelOrientation: { score: dims.labelOrientation != null ? dims.labelOrientation : 9, detail: 'dry-run' },
      priceTag: { score: dims.priceTag != null ? dims.priceTag : 10, detail: 'dry-run' },
      horizontalBanner: { score: dims.horizontalBanner != null ? dims.horizontalBanner : 10, detail: 'dry-run' }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照'] }
  })
}

function stdDev(nums) {
  if (!nums.length) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const variance = nums.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / nums.length
  return Math.sqrt(variance)
}

function round2(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100
}

function summarizeResults(caseReports) {
  const scoreAbsErrors = []
  const scoreSqErrors = []
  const facingAbsErrors = []
  let facingExactHits = 0
  let facingWithin1Hits = 0
  let statusTotal = 0
  let statusCorrect = 0
  const scoreStds = []
  const scoreRanges = []
  const facingRanges = []

  for (const cr of caseReports) {
    const exp = cr.expected || {}
    const validRuns = cr.runs.filter(r => !r.error)
    if (validRuns.length === 0) continue

    const runScores = []
    const runFacings = []

    for (const r of validRuns) {
      statusTotal += 1
      const expHasShelf = exp.hasShelfPhoto !== false
      const expPresent = expHasShelf ? (exp.ownBrandPresent !== false) : null
      if (r.hasShelfPhoto === expHasShelf && r.ownBrandPresent === expPresent) {
        statusCorrect += 1
      }

      if (typeof exp.score === 'number' && typeof r.score === 'number') {
        const diff = Math.abs(r.score - exp.score)
        scoreAbsErrors.push(diff)
        scoreSqErrors.push(diff * diff)
      }
      if (typeof r.score === 'number') runScores.push(r.score)

      if (typeof exp.ownFacingCount === 'number' && typeof r.ownFacingCount === 'number') {
        const fDiff = Math.abs(r.ownFacingCount - exp.ownFacingCount)
        facingAbsErrors.push(fDiff)
        if (fDiff === 0) facingExactHits += 1
        if (fDiff <= 1) facingWithin1Hits += 1
      }
      if (typeof r.ownFacingCount === 'number') runFacings.push(r.ownFacingCount)
    }

    if (runScores.length > 1) {
      scoreStds.push(stdDev(runScores))
      scoreRanges.push(Math.max(...runScores) - Math.min(...runScores))
    }
    if (runFacings.length > 1) {
      facingRanges.push(Math.max(...runFacings) - Math.min(...runFacings))
    }
  }

  return {
    totalCases: caseReports.length,
    statusAccuracyPercent: statusTotal > 0 ? round2((statusCorrect / statusTotal) * 100) : null,
    scoreSamples: scoreAbsErrors.length,
    scoreMAE: scoreAbsErrors.length > 0 ? round2(scoreAbsErrors.reduce((a, b) => a + b, 0) / scoreAbsErrors.length) : null,
    scoreRMSE: scoreSqErrors.length > 0 ? round2(Math.sqrt(scoreSqErrors.reduce((a, b) => a + b, 0) / scoreSqErrors.length)) : null,
    scoreMaxError: scoreAbsErrors.length > 0 ? Math.max(...scoreAbsErrors) : null,
    facingSamples: facingAbsErrors.length,
    facingMAE: facingAbsErrors.length > 0 ? round2(facingAbsErrors.reduce((a, b) => a + b, 0) / facingAbsErrors.length) : null,
    facingExactMatchPercent: facingAbsErrors.length > 0 ? round2((facingExactHits / facingAbsErrors.length) * 100) : null,
    facingWithin1Percent: facingAbsErrors.length > 0 ? round2((facingWithin1Hits / facingAbsErrors.length) * 100) : null,
    multiRunScoreMeanStd: scoreStds.length > 0 ? round2(scoreStds.reduce((a, b) => a + b, 0) / scoreStds.length) : null,
    multiRunScoreMaxRange: scoreRanges.length > 0 ? Math.max(...scoreRanges) : null,
    multiRunFacingMaxRange: facingRanges.length > 0 ? Math.max(...facingRanges) : null
  }
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.dataset) {
    console.error('用法: node eval-golden-set.js --dataset <json路径> [--runs 3] [--model qwen3.8-flash] [--out result.json] [--dry-run]')
    process.exit(1)
  }

  const datasetPath = path.resolve(process.cwd(), args.dataset)
  const datasetDir = path.dirname(datasetPath)
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'))
  const cases = Array.isArray(dataset.cases) ? dataset.cases : []
  if (cases.length === 0) {
    console.error('数据集 cases 为空')
    process.exit(1)
  }

  const apiKey = process.env.DASHSCOPE_API_KEY || ''
  if (!args.dryRun && !apiKey) {
    console.error('请设置环境变量 DASHSCOPE_API_KEY，或使用 --dry-run 进行本地演练')
    process.exit(1)
  }

  const rules = normalizeScoringRules(dataset.scoringRules)
  const systemPrompt = buildSystemPrompt(rules)
  const ownBrandNames = new Set((dataset.ownBrandNames || []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean))
  const brandReferenceText = dataset.brandReferenceText || ''

  const productRefMaterials = (Array.isArray(dataset.productRefMaterials) ? dataset.productRefMaterials : []).slice(0, 4)
  const productRefs = args.dryRun
    ? []
    : productRefMaterials
        .filter(p => p && p.imagePath)
        .map(p => ({ ...p, url: fileToDataUrl(p.imagePath, datasetDir) }))

  const bannerRefMaterials = (Array.isArray(dataset.bannerRefMaterials) ? dataset.bannerRefMaterials : []).slice(0, 3)
  const bannerRefs = args.dryRun
    ? []
    : bannerRefMaterials
        .filter(m => m && m.imagePath)
        .map(m => ({ ...m, url: fileToDataUrl(m.imagePath, datasetDir) }))

  const caseReports = []
  for (const item of cases) {
    const visitImages = args.dryRun
      ? []
      : (item.images || []).map(p => fileToDataUrl(p, datasetDir))
    const userPrompt = buildUserPrompt(
      (item.images || []).length || 1,
      brandReferenceText,
      bannerRefs,
      productRefs
    )
    const userContent = buildMultimodalUserContent({
      visitImageUrls: visitImages,
      productRefs,
      bannerRefs,
      userPrompt
    })

    const runs = []
    for (let r = 0; r < args.runs; r++) {
      try {
        const rawText = args.dryRun
          ? makeDryRunResponse(item, r)
          : await callDashScope({
              apiKey,
              model: args.model,
              userContent,
              systemPrompt,
              enableThinking: args.enableThinking,
              thinkingBudget: args.thinkingBudget,
              maxTokens: args.maxTokens
            })
        const parsedJson = parseRawJson(rawText)
        const normalized = validateAndNormalizeReport(parsedJson, rawText, {
          activeMaterials: Array.isArray(dataset.activeMaterials) ? dataset.activeMaterials : bannerRefMaterials,
          scoringRules: rules,
          ownBrandNames,
          visitImageCount: (item.images || []).length || 1
        })
        runs.push({
          run: r + 1,
          hasShelfPhoto: normalized.hasShelfPhoto,
          ownBrandPresent: normalized.ownBrandPresent,
          score: normalized.score,
          scoreLevel: normalized.scoreLevel,
          ownFacingCount: normalized.facingMetrics && normalized.facingMetrics.ownFacingCount,
          dimensions: normalized.displayCompliance
        })
      } catch (err) {
        runs.push({ run: r + 1, error: err.message || String(err) })
      }
    }

    caseReports.push({
      id: item.id,
      name: item.name,
      expected: item.expected || {},
      runs
    })
  }

  const summary = summarizeResults(caseReports)
  console.log('\n========== 黄金标杆图集评测汇总 ==========')
  console.log(JSON.stringify(summary, null, 2))

  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out)
    fs.writeFileSync(outPath, JSON.stringify({ model: args.model, runsPerCase: args.runs, dryRun: args.dryRun, summary, cases: caseReports }, null, 2))
    console.log(`\n详细结果已写入: ${outPath}`)
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('评测脚本执行失败:', err)
    process.exit(1)
  })
}

module.exports = { summarizeResults, parseArgs }
