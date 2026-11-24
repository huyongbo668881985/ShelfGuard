'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('node:module')
const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfguard-review-refl-'))
process.env.DATA_DIR = tmpDataDir

const {
  computeReviewLevel,
  computeSpotCheck,
  selectProductRefs,
  validateAndNormalizeReport
} = require('../src/functions/analyzeImage/scoring')

const {
  PROMPT_VERSION,
  buildConfusableSection,
  buildLearnedRulesSection
} = require('../src/functions/analyzeImage/prompt')

const {
  extractFacts,
  validateFacts,
  buildCorrectedReport,
  diffFacts
} = require('../src/functions/reviewReport/facts')

const {
  computeReflectionStats,
  buildErrorClusters,
  computeProposalEffectTracking
} = require('../src/functions/reflection/stats')

const { backfillReviewLevels } = require('../scripts/backfill-review-level')

// ============================================================
// 轻量内存文档库（兼容本地 Node 20 与生产 Node 22+，完整支持 nin / in / and / or / inc / exists）
// ============================================================
function createInMemoryDb(dataDir) {
  const collections = new Map()
  const getCol = name => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }

  const isCmd = v => !!(v && typeof v === 'object' && !Array.isArray(v) && v.__cmd)
  const cmd = (op, arg) => ({ __cmd: op, args: [arg] })

  const toTime = v => {
    if (v instanceof Date) return v.getTime()
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const t = Date.parse(v)
      return Number.isNaN(t) ? null : t
    }
    return null
  }

  const equalVal = (a, b) => {
    if (a instanceof Date) a = a.toISOString()
    if (b instanceof Date) b = b.toISOString()
    const ta = toTime(a)
    const tb = toTime(b)
    if (ta != null && tb != null) return ta === tb
    return a === b
  }

  const compareVal = (a, b) => {
    if (a == null && b == null) return 0
    if (a == null) return -1
    if (b == null) return 1
    const ta = toTime(a)
    const tb = toTime(b)
    if (ta != null && tb != null) return ta - tb
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0)
  }

  const getPath = (doc, dotted) => {
    if (!doc) return undefined
    if (dotted === '_id') return doc._id
    return String(dotted).split('.').reduce((cur, p) => (
      cur != null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : undefined
    ), doc)
  }

  const matchValue = (actual, expected) => {
    if (isCmd(expected)) {
      const op = expected.__cmd
      const arg = expected.args[0]
      if (op === 'exists') return arg !== false ? actual !== undefined : actual === undefined
      if (op === 'in') {
        const list = Array.isArray(arg) ? arg : []
        if (Array.isArray(actual)) return actual.some(x => list.some(c => equalVal(x, c)))
        return list.some(c => equalVal(actual, c))
      }
      if (op === 'nin') {
        const list = Array.isArray(arg) ? arg : []
        if (actual === undefined) return true
        if (Array.isArray(actual)) return !actual.some(x => list.some(c => equalVal(x, c)))
        return !list.some(c => equalVal(actual, c))
      }
      if (op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') {
        if (actual === undefined || actual === null) return false
        const d = compareVal(actual, arg)
        if (op === 'lt') return d < 0
        if (op === 'lte') return d <= 0
        if (op === 'gt') return d > 0
        return d >= 0
      }
      if (op === 'neq') return actual === undefined ? true : !equalVal(actual, arg)
      return false
    }
    return equalVal(actual, expected)
  }

  const matchQuery = (doc, query) => {
    if (!query || typeof query !== 'object') return true
    if (isCmd(query)) {
      const parts = Array.isArray(query.args[0]) ? query.args[0] : query.args
      if (query.__cmd === 'and') return parts.every(p => matchQuery(doc, p))
      if (query.__cmd === 'or') return parts.some(p => matchQuery(doc, p))
      return false
    }
    return Object.keys(query).every(k => matchValue(getPath(doc, k), query[k]))
  }

  const cloneDoc = doc => JSON.parse(JSON.stringify(doc))

  const applyUpdateData = (existing, patch) => {
    const next = { ...cloneDoc(existing) }
    Object.keys(patch || {}).forEach(k => {
      const val = patch[k]
      if (isCmd(val) && val.__cmd === 'inc') {
        next[k] = (Number(next[k]) || 0) + (Number(val.args[0]) || 0)
      } else {
        next[k] = cloneDoc(val)
      }
    })
    return next
  }

  const makeQuery = (colName, initialQuery = {}) => {
    let q = initialQuery
    let order = null
    let lim = 100
    let sk = 0
    let fields = null
    const matched = () => Array.from(getCol(colName).values()).filter(d => matchQuery(d, q))
    const api = {
      where(next) { q = next || {}; return api },
      orderBy(field, dir) { order = { field, dir: dir === 'asc' ? 'asc' : 'desc' }; return api },
      skip(n) { sk = Number(n) || 0; return api },
      limit(n) { lim = n; return api },
      field(f) { fields = f; return api },
      async get() {
        let rows = matched().map(cloneDoc)
        if (order) {
          const mul = order.dir === 'asc' ? 1 : -1
          rows.sort((a, b) => compareVal(getPath(a, order.field), getPath(b, order.field)) * mul)
        }
        rows = rows.slice(sk, sk + lim)
        if (fields) {
          rows = rows.map(row => {
            const out = {}
            Object.keys(fields).forEach(k => {
              if (fields[k] && Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k]
            })
            return out
          })
        }
        return { data: rows }
      },
      async count() { return { total: matched().length } }
    }
    return api
  }

  const command = {
    and: (...parts) => cmd('and', parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts),
    or: list => cmd('or', list),
    gte: v => cmd('gte', v),
    lte: v => cmd('lte', v),
    gt: v => cmd('gt', v),
    lt: v => cmd('lt', v),
    neq: v => cmd('neq', v),
    in: list => cmd('in', list),
    nin: list => cmd('nin', list),
    exists: flag => cmd('exists', flag),
    inc: n => cmd('inc', n)
  }

  return {
    serverDate: () => new Date().toISOString(),
    command,
    RegExp: ({ regexp, options }) => new RegExp(regexp, options || ''),
    collection(name) {
      return {
        where(q) { return makeQuery(name, q) },
        orderBy(f, d) { return makeQuery(name, {}).orderBy(f, d) },
        limit(n) { return makeQuery(name, {}).limit(n) },
        async count() { return { total: getCol(name).size } },
        async add({ data } = {}) {
          const id = (data && data._id) || `doc_${Math.random().toString(36).slice(2, 10)}`
          const doc = { ...cloneDoc(data || {}), _id: id }
          getCol(name).set(id, doc)
          return { _id: id }
        },
        doc(id) {
          return {
            async get() {
              const found = getCol(name).get(id)
              if (!found) {
                const err = new Error(`document ${name}/${id} does not exist`)
                err.errCode = -1
                throw err
              }
              return { data: cloneDoc(found) }
            },
            async update({ data } = {}) {
              const found = getCol(name).get(id)
              if (!found) throw new Error(`document ${name}/${id} does not exist`)
              const next = applyUpdateData(found, data)
              next._id = id
              getCol(name).set(id, next)
              return { stats: { updated: 1 } }
            },
            async set({ data } = {}) {
              const next = { ...cloneDoc(data || {}), _id: id }
              getCol(name).set(id, next)
              return { _id: id }
            }
          }
        }
      }
    },
    _reset() { collections.clear() }
  }
}

// ============================================================
// 1. 复核等级计算（computeReviewLevel）与确定性抽检（computeSpotCheck）
// ============================================================
test('computeReviewLevel 与 computeSpotCheck：阈值分级准确、抽检哈希稳定且仅针对高置信', () => {
  // 1) 低置信：排面置信 < 0.6
  assert.equal(computeReviewLevel({
    hasShelfPhoto: true,
    facingMetrics: { countingConfidence: 0.55 },
    productIdentification: [{ brand: '永丰', productLine: '特8', isOwn: true, confidence: 0.9 }],
    metadata: { imageQuality: 'good', framingType: 'panorama' }
  }), 'low')

  // 2) 低置信：我方某单品 confidence < 0.6
  assert.equal(computeReviewLevel({
    hasShelfPhoto: true,
    facingMetrics: { countingConfidence: 0.9 },
    productIdentification: [{ brand: '永丰', productLine: '特8', isOwn: true, confidence: 0.52 }],
    metadata: { imageQuality: 'good', framingType: 'panorama' }
  }), 'low')

  // 3) 低置信：画质 poor
  assert.equal(computeReviewLevel({
    hasShelfPhoto: true,
    facingMetrics: { countingConfidence: 0.9 },
    metadata: { imageQuality: 'poor', framingType: 'panorama' }
  }), 'low')

  // 4) 中置信：排面置信 0.72 或单品置信 0.75 或 needsReview=true 或 closeup
  assert.equal(computeReviewLevel({
    hasShelfPhoto: true,
    facingMetrics: { countingConfidence: 0.72 },
    metadata: { imageQuality: 'good', framingType: 'panorama' }
  }), 'mid')

  assert.equal(computeReviewLevel({
    hasShelfPhoto: true,
    facingMetrics: { countingConfidence: 0.92 },
    metadata: { imageQuality: 'good', framingType: 'closeup' }
  }), 'mid')

  // 5) 高置信：排面置信 >= 0.8 且所有我方单品置信 >= 0.8 且全景清晰无复核标记
  assert.equal(computeReviewLevel({
    hasShelfPhoto: true,
    facingMetrics: { countingConfidence: 0.92 },
    productIdentification: [{ brand: '永丰', productLine: '特8', isOwn: true, confidence: 0.88 }],
    metadata: { imageQuality: 'good', framingType: 'panorama', needsReview: false }
  }), 'high')

  // 6) 确定性抽检：非 high 一律 false；high 按 10% 抽样分布约 10%
  assert.equal(computeSpotCheck('insp_001', 10, 'low'), false)
  assert.equal(computeSpotCheck('insp_001', 10, 'mid'), false)
  const firstRun = computeSpotCheck('insp_stable_check_99', 50, 'high')
  const secondRun = computeSpotCheck('insp_stable_check_99', 50, 'high')
  assert.equal(firstRun, secondRun)

  let hits = 0
  for (let i = 0; i < 1000; i++) {
    if (computeSpotCheck(`insp_sample_${i}`, 10, 'high')) hits++
  }
  assert.equal(hits >= 60 && hits <= 150, true, `10% 抽样应在合理区间，实际 ${hits}/1000`)
})

// ============================================================
// 2. 易混淆竞品硬拦截、参考图优先级排序与提示词区块上限
// ============================================================
test('validateAndNormalizeReport 易混淆竞品硬拦截、单品置信门槛及提示词区块构造', () => {
  const confusables = [
    {
      _id: 'c1',
      competitorBrand: '牛栏山',
      competitorName: '陈酿',
      lookalikeProductId: 'p1',
      lookalikeProductName: '永丰 特8',
      distinguishingFeatures: '蓝色颈标、竖排陈酿字样',
      hitCount: 5,
      isActive: true
    }
  ]

  // 模型错误地把「牛栏山 陈酿」标成了 isOwn: true（4面），同时识别了真正的「永丰 特8」（6面）
  const raw = {
    hasShelfPhoto: true,
    ownBrandPresent: true,
    productIdentification: [
      { brand: '永丰', productLine: '特8', isOwn: true, facingCount: 6, position: '黄金位', confidence: 0.92 },
      { brand: '牛栏山', productLine: '陈酿', isOwn: true, facingCount: 4, position: '中层', confidence: 0.85 }
    ],
    displayCompliance: {
      facingCount: { observedFacings: 10, score: 50 },
      goldenPosition: { goldenFacings: 6, totalOwnFacings: 6, score: 20 },
      labelOrientation: { frontLabelFacings: 6, totalOwnFacings: 6, score: 10 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 10 }
    }
  }

  const normalized = validateAndNormalizeReport(raw, '', {
    ownBrandNames: new Set(['永丰', '特8']),
    confusables
  })

  // 牛栏山陈酿必须被硬拦截改为 isOwn: false，我方排面数从 10 降为 6，排面分 30，且触发 needsReview
  assert.equal(normalized.productIdentification[1].isOwn, false)
  assert.equal(normalized.facingMetrics.ownFacingCount, 6)
  assert.equal(normalized.displayCompliance.facingCount.score, 30)
  assert.equal(normalized.metadata.needsReview, true)
  assert.equal(normalized.metadata.qualityFlags.includes('confusable_competitor_intercepted'), true)

  // 参考图按 refPriority 降序挑选
  const prods = [
    { _id: 'p1', brandName: '永丰', productLine: 'A', refPriority: 0, photos: { front: 'sg://a.jpg' }, isActive: true },
    { _id: 'p2', brandName: '永丰', productLine: 'B', refPriority: 20, photos: { front: 'sg://b.jpg' }, isActive: true }
  ]
  const refs = selectProductRefs(prods, 1)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].productLine, 'B')

  // 提示词区块构造
  const confSec = buildConfusableSection(confusables, prods)
  assert.match(confSec, /易混淆竞品警示/)
  assert.match(confSec, /牛栏山 陈酿/)

  const ruleSec = buildLearnedRulesSection([{ id: 'r1', rule: '纵深后排不计入排面', isActive: true }])
  assert.match(ruleSec, /近期复盘规则补丁/)
  assert.match(ruleSec, /纵深后排不计入排面/)
})

// ============================================================
// 3. 人工校正事实模型（extractFacts / validateFacts / buildCorrectedReport / diffFacts）
// ============================================================
test('facts.js：移除误认竞品、补充漏认我方、横签改无不回弹、全删变未上柜、未上柜补产品恢复计分及 diffFacts', () => {
  const activeProducts = [
    { _id: 'p_te8', brandName: '永丰', productLine: '特8', aliases: ['永丰特8'], isActive: true },
    { _id: 'p_jd', brandName: '永丰', productLine: '经典二锅头', aliases: ['永丰经典'], isActive: true }
  ]
  const ownBrandNames = new Set(['永丰', '特8', '永丰特8', '经典二锅头', '永丰经典'])

  // 初始 AI 报告：AI 误把 4 瓶红星当成经典二锅头（共算 10 面=50分），且给了横签 10 分并写了 adMaterials 横签
  const initialReport = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    productIdentification: [
      { brand: '永丰', productLine: '特8', isOwn: true, facingCount: 6, position: '黄金位', confidence: 0.92 },
      { brand: '永丰', productLine: '经典二锅头', isOwn: true, facingCount: 4, position: '中层', confidence: 0.55 }
    ],
    adMaterials: [
      { name: '永丰品牌横签', category: '横签', isOwn: true, count: 1, condition: '完好', position: '货架层板' }
    ],
    displayCompliance: {
      facingCount: { observedFacings: 10, score: 50 },
      goldenPosition: { goldenFacings: 6, totalOwnFacings: 10, score: 15 },
      labelOrientation: { frontLabelFacings: 10, totalOwnFacings: 10, score: 10 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 10 }
    }
  }, '', { ownBrandNames })

  assert.equal(initialReport.score, 94)

  const beforeFacts = extractFacts(initialReport, activeProducts)
  assert.equal(beforeFacts.ownProducts.length, 2)
  assert.equal(beforeFacts.bannerTier, 'good')

  // 管理员校正：移除第 2 个我方产品（实际是红星二锅头），并将横签改为 'none'
  const editedRaw = {
    ...beforeFacts,
    ownProducts: [beforeFacts.ownProducts[0]], // 只剩 6 面特8
    goldenFacings: 6,
    frontLabelFacings: 6,
    priceTagTier: 'good',
    bannerTier: 'none'
  }
  const vRes = validateFacts(editedRaw, activeProducts)
  assert.equal(vRes.ok, true)

  const corrected = buildCorrectedReport(initialReport, vRes.facts, {
    ownBrandNames,
    revision: 1,
    knowledgeVersion: 3
  })

  // 6 面 = 30 分；黄金位 6/6 = 20 分；正标 6/6 = 10 分；价签 = 10 分；横签 = 0 分（且不得因旧 adMaterials 回弹为 5 分）
  assert.equal(corrected.facingMetrics.ownFacingCount, 6)
  assert.equal(corrected.displayCompliance.facingCount.score, 30)
  assert.equal(corrected.displayCompliance.goldenPosition.score, 20)
  assert.equal(corrected.displayCompliance.labelOrientation.score, 10)
  assert.equal(corrected.displayCompliance.priceTag.score, 10)
  assert.equal(corrected.displayCompliance.horizontalBanner.score, 0)
  assert.equal(corrected.score, 70)
  assert.equal(corrected.metadata.corrected, true)
  assert.equal(corrected.metadata.needsReview, false)
  assert.equal(corrected.metadata.knowledgeVersion, 3)
  assert.equal(corrected.metadata.promptVersion, PROMPT_VERSION)

  // diffFacts 应准确记录 false_own 与 banner 变更
  const changes = diffFacts(beforeFacts, vRes.facts, [
    {
      type: 'false_own',
      slotKey: beforeFacts.ownProducts[1].slotKey,
      reason: 'look_alike',
      actualProduct: '红星二锅头',
      photoIndex: 2
    }
  ])
  assert.equal(changes.some(c => c.type === 'false_own' && c.actualProduct === '红星二锅头'), true)
  assert.equal(changes.some(c => c.type === 'banner' && c.aiValue === 'good' && c.humanValue === 'none'), true)

  // 删光所有我方产品 -> 自动变为未上柜（score=null, ownBrandPresent=false）
  const oosVal = validateFacts({
    ...beforeFacts,
    ownProducts: [],
    goldenFacings: 0,
    frontLabelFacings: 0
  }, activeProducts)
  assert.equal(oosVal.ok, true)
  const oosReport = buildCorrectedReport(initialReport, oosVal.facts, { ownBrandNames })
  assert.equal(oosReport.ownBrandPresent, false)
  assert.equal(oosReport.score, null)
  assert.equal(oosReport.scoreLevel, '未上柜')

  // 从未上柜补充 4 面经典二锅头 -> 自动恢复计分
  const recoverVal = validateFacts({
    hasShelfPhoto: true,
    ownProducts: [{ productId: 'p_jd', brand: '永丰', productLine: '经典二锅头', facingCount: 4, position: '黄金位' }],
    competitorProducts: [],
    goldenFacings: 4,
    frontLabelFacings: 4,
    priceTagTier: 'good',
    bannerTier: 'good'
  }, activeProducts)
  assert.equal(recoverVal.ok, true)
  const recoverReport = buildCorrectedReport(oosReport, recoverVal.facts, { ownBrandNames })
  assert.equal(recoverReport.ownBrandPresent, true)
  assert.equal(recoverReport.score, 20 + 20 + 10 + 10 + 10) // 70分
})

// ============================================================
// 4. 云函数集成测试：reviewReport / getHistory / analyzeImage 锁定 / reflection 完整闭环
// ============================================================
const mockDb = createInMemoryDb(tmpDataDir)
let currentOpenid = 'admin_1'
let currentSource = ''

const mockCloud = {
  DYNAMIC_CURRENT_ENV: 'local',
  init() {},
  database: () => mockDb,
  getWXContext: () => ({ OPENID: currentOpenid, SOURCE: currentSource }),
  getTempFileURL: async ({ fileList = [] } = {}) => ({
    fileList: fileList.map(fid => ({ fileID: fid, tempFileURL: `http://127.0.0.1/mock/${fid}` }))
  }),
  readFilesAsDataUrls: async ({ fileList = [] } = {}) => ({
    fileList: fileList.map(fid => ({ fileID: fid, tempFileURL: `data:image/jpeg;base64,9j/4AAQSkZJRg==` }))
  }),
  deleteFile: async () => ({ fileList: [] }),
  callFunction: async ({ name, data } = {}) => {
    const prevOpenid = currentOpenid
    const prevSource = currentSource
    currentOpenid = ''
    currentSource = 'internal'
    try {
      if (name === 'analyzeImage') {
        const res = await analyzeImageMain(data || {}, {})
        return { result: res }
      }
      if (name === 'shelfStats') {
        return { result: { success: true, storeDocs: 1, overallDocs: 1 } }
      }
      throw new Error(`unexpected callFunction: ${name}`)
    } finally {
      currentOpenid = prevOpenid
      currentSource = prevSource
    }
  }
}

let reviewReportMain
let reflectionMain
let getHistoryMain
let getReportMain
let productsMain
let analyzeImageMain
let applyMod
let schedulerMod
let batchAnalyzeMod

before(() => {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === '../../cloud-shim' || request === '../src/cloud-shim' || request === './cloud-shim') {
      return mockCloud
    }
    if (request === 'axios') {
      return {
        post: async () => {
          throw new Error('mock_no_network')
        }
      }
    }
    return origLoad.apply(this, arguments)
  }

  try {
    analyzeImageMain = require('../src/functions/analyzeImage/index').main
    reviewReportMain = require('../src/functions/reviewReport/index').main
    reflectionMain = require('../src/functions/reflection/index').main
    getHistoryMain = require('../src/functions/getHistory/index').main
    getReportMain = require('../src/functions/getReport/index').main
    productsMain = require('../src/functions/products/index').main
    applyMod = require('../src/functions/reflection/apply')
    schedulerMod = require('../src/scheduler')
    batchAnalyzeMod = require('../src/functions/batchAnalyze/index')
  } finally {
    Module._load = origLoad
  }
})

after(() => {
  try {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
  } catch (_) {}
})

test('端到端闭环：权限隔离 → 存量回填 → 复核筛选 → 人工校正与乐观锁 → 锁定防重跑 → AI 复盘统计/提案/采纳/一键撤销', async () => {
  mockDb._reset()

  // 1. 初始化用户（admin / manager / sales）与产品库
  await mockDb.collection('users').add({
    data: { _id: 'u_admin', _openid: 'admin_1', role: 'admin', approved: true, nickName: '王管理' }
  })
  await mockDb.collection('users').add({
    data: { _id: 'u_mgr', _openid: 'mgr_1', role: 'manager', approved: true, nickName: '李主管' }
  })
  await mockDb.collection('users').add({
    data: { _id: 'u_sales', _openid: 'sales_1', role: 'sales', approved: true, nickName: '张业务' }
  })

  currentOpenid = 'admin_1'
  const p1Res = await productsMain({
    action: 'add',
    product: {
      brandName: '永丰',
      productLine: '特8',
      aliases: ['永丰特8', '过宽别名'],
      visualFeatures: '红底金字正面大标'
    }
  })
  assert.equal(p1Res.success, true)
  const prodTe8Id = p1Res._id

  const p2Res = await productsMain({
    action: 'add',
    product: {
      brandName: '永丰',
      productLine: '经典二锅头',
      aliases: ['永丰经典'],
      visualFeatures: '透明玻瓶'
    }
  })
  assert.equal(p2Res.success, true)

  // 2. 插入 3 条已分析的巡检记录（1 条低置信误认、1 条中置信漏认、1 条高置信正确）
  const insp1 = await mockDb.collection('inspections').add({
    data: {
      _id: 'insp_low_1',
      _openid: 'sales_1',
      userName: '张业务',
      storeName: '兴旺烟酒店',
      status: 'analyzed',
      createdAt: new Date().toISOString(),
      analyzedAt: new Date().toISOString(),
      photoFileIDs: ['sg://p1.jpg'],
      aiReport: {
        scoringVersion: 'v2',
        hasShelfPhoto: true,
        ownBrandPresent: true,
        score: 85,
        scoreLevel: '优秀',
        summary: '初始总结',
        facingMetrics: { ownFacingCount: 8, ownSkuCount: 2, totalShelfFacingCount: 20, ownFacingShare: 40, countingConfidence: 0.52 },
        productIdentification: [
          { brand: '永丰', productLine: '特8', isOwn: true, facingCount: 5, position: '黄金位', confidence: 0.9 },
          { brand: '永丰', productLine: '经典二锅头', isOwn: true, facingCount: 3, position: '中层', confidence: 0.5 }
        ],
        displayCompliance: {
          facingCount: { score: 40, maxScore: 50, observedFacings: 8, status: 'good', detail: '' },
          goldenPosition: { score: 17, maxScore: 20, goldenFacings: 5, totalOwnFacings: 8, status: 'good', detail: '' },
          labelOrientation: { score: 8, maxScore: 10, frontLabelFacings: 7, totalOwnFacings: 8, status: 'good', detail: '' },
          priceTag: { score: 10, maxScore: 10, status: 'good', detail: '' },
          horizontalBanner: { score: 10, maxScore: 10, status: 'good', detail: '' }
        },
        metadata: { imageQuality: 'good', framingType: 'panorama', needsReview: true }
      }
    }
  })

  const insp2 = await mockDb.collection('inspections').add({
    data: {
      _id: 'insp_low_2',
      _openid: 'sales_1',
      userName: '张业务',
      storeName: '福满多超市',
      status: 'analyzed',
      createdAt: new Date().toISOString(),
      analyzedAt: new Date().toISOString(),
      photoFileIDs: ['sg://p2.jpg'],
      aiReport: {
        scoringVersion: 'v2',
        hasShelfPhoto: true,
        ownBrandPresent: true,
        score: 80,
        scoreLevel: '优秀',
        summary: '初始总结2',
        facingMetrics: { ownFacingCount: 7, ownSkuCount: 2, totalShelfFacingCount: 20, ownFacingShare: 35, countingConfidence: 0.55 },
        productIdentification: [
          { brand: '永丰', productLine: '特8', isOwn: true, facingCount: 4, position: '黄金位', confidence: 0.9 },
          { brand: '永丰', productLine: '经典二锅头', isOwn: true, facingCount: 3, position: '中层', confidence: 0.52 }
        ],
        displayCompliance: {
          facingCount: { score: 35, maxScore: 50, observedFacings: 7, status: 'medium', detail: '' },
          goldenPosition: { score: 17, maxScore: 20, goldenFacings: 4, totalOwnFacings: 7, status: 'good', detail: '' },
          labelOrientation: { score: 8, maxScore: 10, frontLabelFacings: 6, totalOwnFacings: 7, status: 'good', detail: '' },
          priceTag: { score: 10, maxScore: 10, status: 'good', detail: '' },
          horizontalBanner: { score: 10, maxScore: 10, status: 'good', detail: '' }
        },
        metadata: { imageQuality: 'good', framingType: 'panorama', needsReview: true }
      }
    }
  })

  // 3. 运行存量复核等级回填脚本
  const bfSummary = await backfillReviewLevels(mockDb, { apply: true, logger: { log() {} } })
  assert.equal(bfSummary.updated, 2)
  assert.equal(bfSummary.counts.low, 2)

  // 4. 权限校验：sales 和 manager 调用 reviewReport 与 reflection 必须被拒
  currentOpenid = 'sales_1'
  const salesTry = await reviewReportMain({ action: 'get', inspectionId: insp1._id })
  assert.equal(salesTry.success, false)
  assert.equal(salesTry.code, 'FORBIDDEN')

  currentOpenid = 'mgr_1'
  const mgrTry = await reviewReportMain({ action: 'get', inspectionId: insp1._id })
  assert.equal(mgrTry.success, false)
  assert.equal(mgrTry.code, 'FORBIDDEN')

  const mgrReflTry = await reflectionMain({ action: 'list' })
  assert.equal(mgrReflTry.success, false)
  assert.equal(mgrReflTry.code, 'FORBIDDEN')

  // 5. 管理员在 getHistory 中按 reviewLevel='low' + reviewStatus='unreviewed' 筛选，应拿到 2 条
  currentOpenid = 'admin_1'
  const histBefore = await getHistoryMain({
    action: 'list',
    where: { reviewLevel: 'low', reviewStatus: 'unreviewed' }
  })
  assert.equal(histBefore.success, true)
  assert.equal(histBefore.isAdmin, true)
  assert.equal(histBefore.total, 2)

  // 6. 管理员对 insp_low_1 进行人工校正：移除被误认的经典二锅头（实际是牛栏山陈酿）
  const ctx1 = await reviewReportMain({ action: 'get', inspectionId: insp1._id })
  assert.equal(ctx1.success, true)
  const editedFacts1 = {
    ...ctx1.facts,
    ownProducts: [ctx1.facts.ownProducts[0]], // 只保留 5 面特8
    goldenFacings: 5,
    frontLabelFacings: 5
  }
  const save1 = await reviewReportMain({
    action: 'save',
    inspectionId: insp1._id,
    expectedRevision: 0,
    facts: editedFacts1,
    annotations: [
      {
        type: 'false_own',
        slotKey: ctx1.facts.ownProducts[1].slotKey,
        sku: '永丰 经典二锅头',
        reason: 'look_alike',
        actualProduct: '牛栏山陈酿',
        photoIndex: 1
      }
    ],
    awaitNarrative: true
  })
  assert.equal(save1.success, true)
  assert.equal(save1.reviewStatus, 'corrected')
  assert.equal(save1.reviewRevision, 1)
  assert.equal(save1.report.facingMetrics.ownFacingCount, 5)
  assert.equal(save1.report.score, 25 + 20 + 10 + 10 + 10) // 75分

  // 乐观锁冲突测试：再传 expectedRevision: 0 应返回 REVISION_CONFLICT
  const conflictRes = await reviewReportMain({
    action: 'save',
    inspectionId: insp1._id,
    expectedRevision: 0,
    facts: editedFacts1
  })
  assert.equal(conflictRes.success, false)
  assert.equal(conflictRes.code, 'REVISION_CONFLICT')

  // 7. 已校正记录防覆盖：普通重新分析必须被拒（CORRECTED_LOCKED）
  const reAnalyzeLocked = await analyzeImageMain({ inspectionId: insp1._id })
  assert.equal(reAnalyzeLocked.success, false)
  assert.equal(reAnalyzeLocked.code, 'CORRECTED_LOCKED')

  // 8. 业务员查看报告详情时，看到的是校正后的 75 分，但看不到 reviewStatus / corrected 标记
  currentOpenid = 'sales_1'
  const salesView = await getReportMain({ inspectionId: insp1._id })
  assert.equal(salesView.success, true)
  assert.equal(salesView.detail.aiReport.score, 75)
  assert.equal(salesView.detail.reviewStatus, undefined)
  assert.equal(salesView.detail.aiReport.metadata.corrected, undefined)

  // 9. 管理员再次查未复核低置信队列，insp_low_1 已自动消失（剩 1 条），而在 reviewStatus='corrected' 中可查到且可再次修改
  currentOpenid = 'admin_1'
  const histAfter1 = await getHistoryMain({
    action: 'list',
    where: { reviewLevel: 'low', reviewStatus: 'unreviewed' }
  })
  assert.equal(histAfter1.total, 1)

  const histCorrected = await getHistoryMain({
    action: 'list',
    where: { reviewStatus: 'corrected' }
  })
  assert.equal(histCorrected.total, 1)
  assert.equal(histCorrected.list[0]._id, insp1._id)

  // 10. 管理员再校正 insp_low_2（同样是把牛栏山陈酿误认为经典二锅头），凑满 2 条同类错误触发聚类
  const ctx2 = await reviewReportMain({ action: 'get', inspectionId: insp2._id })
  const save2 = await reviewReportMain({
    action: 'save',
    inspectionId: insp2._id,
    expectedRevision: 0,
    facts: {
      ...ctx2.facts,
      ownProducts: [ctx2.facts.ownProducts[0]],
      goldenFacings: 4,
      frontLabelFacings: 4
    },
    annotations: [
      {
        type: 'false_own',
        slotKey: ctx2.facts.ownProducts[1].slotKey,
        sku: '永丰 经典二锅头',
        reason: 'look_alike',
        actualProduct: '牛栏山陈酿',
        photoIndex: 1
      }
    ],
    awaitNarrative: true
  })
  assert.equal(save2.success, true)

  // 11. 管理员触发定期 AI 复盘（reflection.run）
  const reflRun = await reflectionMain({ action: 'run', skipReplay: true })
  assert.equal(reflRun.success, true)
  assert.ok(reflRun.reflectionId)
  const report = reflRun.report
  assert.equal(report.stats.totalReviewed, 2)
  assert.equal(report.stats.correctedCount, 2)
  assert.equal(report.stats.topFalseOwn[0].actualProduct, '牛栏山陈酿')
  assert.equal(report.stats.topFalseOwn[0].count, 2)
  assert.equal(report.proposals.length >= 1, true)

  // 找到 confusable_add 提案并采纳
  const confProposal = report.proposals.find(p => p.fixType === 'confusable_add')
  assert.ok(confProposal, '应生成新增易混淆竞品提案')

  const decideRes = await reflectionMain({
    action: 'decide',
    reflectionId: reflRun.reflectionId,
    proposalId: confProposal.proposalId,
    decision: 'approve'
  })
  assert.equal(decideRes.success, true)
  assert.ok(decideRes.changeId)

  // 验证易混淆竞品库已新增「牛栏山陈酿」
  const confListRes = await productsMain({ action: 'listConfusables' })
  assert.equal(confListRes.success, true)
  assert.equal(confListRes.list.some(c => c.competitorName === '牛栏山陈酿' && c.isActive === true), true)

  // 12. 一键撤销该变更，验证易混淆竞品已下线
  const undoRes = await reflectionMain({
    action: 'undo',
    changeId: decideRes.changeId
  })
  assert.equal(undoRes.success, true)

  const confListAfterUndo = await productsMain({ action: 'listConfusables' })
  assert.equal(confListAfterUndo.list.length, 0)

  // 13. 测试其余修正落点（product_confusion_notes / product_visual_features / ref_priority / alias_remove / learned_rule_add / threshold_adjust）及撤销

  // a) product_confusion_notes
  const resNotes = await applyMod.applyProposal({
    proposalId: 'p_notes',
    fixType: 'product_confusion_notes',
    summary: '补充特8区分要点',
    target: { productId: prodTe8Id },
    payload: { confusionNotes: '认准特8红标，蓝色颈标为竞品' }
  }, { openid: 'admin_1', adminName: '王管理' })
  assert.equal(resNotes.ok, true)
  const pAfterNotes = (await mockDb.collection('products').doc(prodTe8Id).get()).data
  assert.equal(pAfterNotes.confusionNotes, '认准特8红标，蓝色颈标为竞品')

  await applyMod.undoKnowledgeChange(resNotes.changeId, { openid: 'admin_1' })
  const pUndoNotes = (await mockDb.collection('products').doc(prodTe8Id).get()).data
  assert.equal(pUndoNotes.confusionNotes, '')

  // b) alias_remove
  const resAlias = await applyMod.applyProposal({
    proposalId: 'p_alias',
    fixType: 'alias_remove',
    summary: '移除过宽别名',
    target: { productId: prodTe8Id },
    payload: { alias: '过宽别名' }
  }, { openid: 'admin_1' })
  assert.equal(resAlias.ok, true)
  const pAfterAlias = (await mockDb.collection('products').doc(prodTe8Id).get()).data
  assert.equal(pAfterAlias.aliases.includes('过宽别名'), false)

  await applyMod.undoKnowledgeChange(resAlias.changeId, { openid: 'admin_1' })
  const pUndoAlias = (await mockDb.collection('products').doc(prodTe8Id).get()).data
  assert.equal(pUndoAlias.aliases.includes('过宽别名'), true)

  // c) learned_rule_add 与撤销
  const resRule = await applyMod.applyProposal({
    proposalId: 'p_rule',
    fixType: 'learned_rule_add',
    summary: '新增排面口径补丁',
    target: {},
    payload: { category: 'facing_count', rule: '只数最前排正面可见瓶数' }
  }, { openid: 'admin_1' })
  assert.equal(resRule.ok, true)
  const sAfterRule = (await mockDb.collection('settings').doc('global').get()).data
  assert.equal(sAfterRule.learnedRules.length, 1)

  await applyMod.undoKnowledgeChange(resRule.changeId, { openid: 'admin_1' })
  const sUndoRule = (await mockDb.collection('settings').doc('global').get()).data
  assert.equal(sUndoRule.learnedRules.length, 0)

  // 14. 测试定时维护任务 reviewMaintenance（重算 stale 日报 + 防抖重建 shelfStats）
  await mockDb.collection('dailyReports').doc('dr_sales_1_2026-11-20').set({
    data: {
      date: '2026-11-20',
      _openid: 'sales_1',
      userName: '张业务',
      inspectionIds: [insp1._id, insp2._id],
      stale: true
    }
  })
  const maintRes = await reviewReportMain({
    action: 'maintenance',
    force: true
  })
  assert.equal(maintRes.success, true)
  assert.equal(maintRes.rebuiltShelfStats, true)

  // 15. 测试 scheduler.decideJobs 包含每 10 分钟 reviewMaintenance 与每周一 04:30 reflection
  const mon0430 = { year: '2026', month: '11', day: '23', weekday: 'Mon', hour: 4, minute: 30, second: 0 }
  const jobsMon = schedulerMod.decideJobs(mon0430, {
    lastBatch: '',
    lastReviewMaint: '',
    lastJxc: '',
    lastStats: '',
    lastPrune: '',
    lastReflection: ''
  })
  assert.equal(jobsMon.some(j => j.name === 'reviewMaintenance'), true)
  assert.equal(jobsMon.some(j => j.name === 'reflection'), true)
})

// ============================================================
// 5. 针对 11-23 全量人工校对总结的新增护栏与闭环优化回归测试
// ============================================================
test('v2.3 校对提准套件：combo比例参考图、横签在架矛盾拦截、挂牌价签保底、diffFacts去伪归因、按日批量确认与超时自动重排', async () => {
  // 1) selectProductRefs 支持第 4 槽位填充终端三品同框比例图(combo)，且 products.update 保留旧 combo
  const threeSkusWithCombo = [
    { _id: 'p_red', brandName: '永丰特8', productLine: '红标', photos: { front: 'sg://products/red.jpg' }, isActive: true },
    { _id: 'p_blue', brandName: '永丰特8', productLine: '蓝标', photos: { front: 'sg://products/blue.jpg' }, isActive: true },
    {
      _id: 'p_small',
      brandName: '永丰特8',
      productLine: '小酒',
      photos: { front: 'sg://products/small.jpg', combo: 'sg://products/combo.jpg' },
      isActive: true
    }
  ]
  const picked4 = selectProductRefs(threeSkusWithCombo, 4)
  assert.equal(picked4.length, 4)
  assert.deepEqual(picked4.map(r => r.slot), ['front', 'front', 'front', 'combo'])
  assert.equal(picked4[3].photo, 'sg://products/combo.jpg')

  // 2) 横签检出但误判未上柜（如阔阔超市挂卡挡圆印场景）-> 强制标记 banner_present_but_oos 且 reviewLevel='low'
  const kuokuoLike = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: false,
    adMaterials: [
      { name: '横签', category: '横签', isOwn: true, count: 1, condition: '完好', position: '货架层板' }
    ],
    facingMetrics: { ownFacingCount: 0, countingConfidence: 0.9 },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['门头照', '货架陈列照'] }
  }, '{}', {
    ownBrandNames: new Set(['永丰特8']),
    activeMaterials: [{ materialName: '横签', category: '横签', isActive: true }]
  })
  assert.equal(kuokuoLike.ownBrandPresent, false)
  assert.equal(kuokuoLike.metadata.needsReview, true)
  assert.equal(kuokuoLike.metadata.qualityFlags.includes('banner_present_but_oos'), true)
  assert.equal(computeReviewLevel(kuokuoLike), 'low')

  // 3) 贴有换购横签且有红标/蓝标 >=3 面但漏检小酒 -> computeReviewLevel 从 high 降为 mid 待核
  const missingMiniReport = {
    hasShelfPhoto: true,
    ownBrandPresent: true,
    facingMetrics: { ownFacingCount: 4, countingConfidence: 0.9 },
    productIdentification: [
      { brand: '永丰特8', productLine: '红标', isOwn: true, facingCount: 3, confidence: 0.88 },
      { brand: '永丰特8', productLine: '蓝标', isOwn: true, facingCount: 1, confidence: 0.86 }
    ],
    displayCompliance: {
      horizontalBanner: { score: 10 }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', needsReview: false }
  }
  assert.equal(computeReviewLevel(missingMiniReport), 'mid')

  // 4) 远景/fair 画质且无横签锚点、置信 <0.7 -> 降为 low
  const distantWeak = {
    hasShelfPhoto: true,
    ownBrandPresent: true,
    facingMetrics: { ownFacingCount: 2, countingConfidence: 0.65 },
    productIdentification: [{ brand: '永丰特8', productLine: '红标', isOwn: true, facingCount: 2, confidence: 0.65 }],
    displayCompliance: { horizontalBanner: { score: 0 } },
    metadata: { imageQuality: 'fair', framingType: 'panorama', needsReview: false }
  }
  assert.equal(computeReviewLevel(distantWeak), 'low')

  // 5) 制式颈挂价签保底：shelfObservations 已写明挂 35/40 价签牌，但 priceTag 误给 5 分且无破损 -> 自动校准为 10 分
  const ptCalibrated = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    shelfObservations: {
      photoFacings: [
        { photoIndex: 1, role: '货架陈列照', layerSummary: '第2层可见永丰特8红标2面(挂35黄圆牌)、蓝标1面(挂40价签)', ownFacingsInPhoto: 3, overlapWithPrevious: 0 }
      ]
    },
    productIdentification: [
      { brand: '永丰特8', productLine: '红标', isOwn: true, facingCount: 2, confidence: 0.85 },
      { brand: '永丰特8', productLine: '蓝标', isOwn: true, facingCount: 1, confidence: 0.85 }
    ],
    displayCompliance: {
      facingCount: { observedFacings: 3, score: 15 },
      goldenPosition: { goldenFacings: 3, totalOwnFacings: 3, score: 20 },
      labelOrientation: { frontLabelFacings: 3, totalOwnFacings: 3, score: 10 },
      priceTag: { score: 5, detail: '距离较远数字不够清晰' },
      horizontalBanner: { score: 10 }
    },
    metadata: { imageQuality: 'fair', framingType: 'panorama' }
  }, '{}', { ownBrandNames: new Set(['永丰特8']) })
  assert.equal(ptCalibrated.displayCompliance.priceTag.score, 10)

  // 6) diffFacts：红标 2->1 同时补增小酒 0->1 归因为 sku_misclassified，且黄金位/正标 100% 占比随分母同步变化时不产生假报错
  const bf = {
    hasShelfPhoto: true,
    ownBrandPresent: true,
    ownProducts: [
      { slotKey: 'own_0', productId: 'p_red', brand: '永丰特8', productLine: '红标', facingCount: 2, position: '黄金位', confidence: 0.82 },
      { slotKey: 'own_1', productId: 'p_blue', brand: '永丰特8', productLine: '蓝标', facingCount: 2, position: '黄金位', confidence: 0.85 }
    ],
    competitorProducts: [],
    goldenFacings: 4,
    frontLabelFacings: 4,
    priceTagTier: 'good',
    bannerTier: 'good',
    totalShelfFacingCount: 20
  }
  const afSameRatio = {
    ...bf,
    ownProducts: [
      { slotKey: 'own_0', productId: 'p_red', brand: '永丰特8', productLine: '红标', facingCount: 1, position: '黄金位', confidence: 0.82 },
      { slotKey: 'own_1', productId: 'p_blue', brand: '永丰特8', productLine: '蓝标', facingCount: 1, position: '黄金位', confidence: 0.85 },
      { slotKey: 'added_1', productId: 'p_small', brand: '永丰特8', productLine: '小酒', facingCount: 1, position: '黄金位', confidence: 1 }
    ],
    goldenFacings: 3,     // 3/3 仍为 100%
    frontLabelFacings: 3  // 3/3 仍为 100%
  }
  const cleanChanges = diffFacts(bf, afSameRatio, [])
  const redFacingChange = cleanChanges.find(c => c.type === 'facing_count' && c.sku === '永丰特8 红标')
  assert.ok(redFacingChange)
  assert.equal(redFacingChange.reason, 'sku_misclassified')
  assert.equal(cleanChanges.some(c => c.type === 'golden'), false, '同为100%黄金位不应误报 layer_misjudged')
  assert.equal(cleanChanges.some(c => c.type === 'label'), false, '同为100%正标不应误报 orientation_misjudged')

  // 7) reviewReport.batchConfirmDate：按日预览并批量确认未改记录，不触碰已校正与其他日期
  mockDb._reset()
  await mockDb.collection('users').add({
    data: { _id: 'u_admin', _openid: 'admin_1', role: 'admin', approved: true, nickName: '胡管理' }
  })
  await mockDb.collection('inspections').add({
    data: {
      _id: 'd23_corr',
      _openid: 's1',
      storeName: '已校正店',
      status: 'analyzed',
      reviewStatus: 'corrected',
      createdAt: '2026-11-23T02:00:00.000Z',
      aiReport: { hasShelfPhoto: true, ownBrandPresent: true, score: 75, facingMetrics: { ownFacingCount: 5 } }
    }
  })
  await mockDb.collection('inspections').add({
    data: {
      _id: 'd23_unrev_1',
      _openid: 's1',
      storeName: '未改店1',
      status: 'analyzed',
      reviewStatus: 'unreviewed',
      createdAt: '2026-11-23T06:00:00.000Z',
      aiReport: { hasShelfPhoto: true, ownBrandPresent: true, score: 80, facingMetrics: { ownFacingCount: 6 } }
    }
  })
  await mockDb.collection('inspections').add({
    data: {
      _id: 'd22_unrev_other',
      _openid: 's1',
      storeName: '前一日未改店',
      status: 'analyzed',
      reviewStatus: 'unreviewed',
      createdAt: '2026-11-22T06:00:00.000Z',
      aiReport: { hasShelfPhoto: true, ownBrandPresent: true, score: 70, facingMetrics: { ownFacingCount: 4 } }
    }
  })

  currentOpenid = 'admin_1'
  const dryBatch = await reviewReportMain({ action: 'batchConfirmDate', date: '2026-11-23', dryRun: true })
  assert.equal(dryBatch.success, true)
  assert.equal(dryBatch.totalAnalyzed, 2)
  assert.equal(dryBatch.correctedCount, 1)
  assert.equal(dryBatch.unreviewedCount, 1)

  const applyBatch = await reviewReportMain({ action: 'batchConfirmDate', date: '2026-11-23' })
  assert.equal(applyBatch.success, true)
  assert.equal(applyBatch.confirmedNowCount, 1)

  const afterUnrev1 = (await mockDb.collection('inspections').doc('d23_unrev_1').get()).data
  const afterOtherDay = (await mockDb.collection('inspections').doc('d22_unrev_other').get()).data
  assert.equal(afterUnrev1.reviewStatus, 'confirmed')
  assert.equal(afterUnrev1.keepOriginal, true)
  assert.equal(afterOtherDay.reviewStatus, 'unreviewed')

  // 8) batchAnalyze：首次 140s 超时写成的 analyze_failed 自动退回 pending 重试，满 3 次或缺 API Key 不重排
  await mockDb.collection('inspections').add({
    data: {
      _id: 'timeout_attempt_1',
      status: 'analyze_failed',
      analyzeAttempts: 1,
      analyzeError: 'AI 响应超过 140 秒未返回，已中止。建议减少单次照片数量或适当调小 DASHSCOPE_THINKING_BUDGET'
    }
  })
  await batchAnalyzeMod._internal.markFailedIfNeeded(
    { _id: 'timeout_attempt_1', analyzeAttempts: 1 },
    'AI 响应超过 140 秒未返回'
  )
  const retriedDoc = (await mockDb.collection('inspections').doc('timeout_attempt_1').get()).data
  assert.equal(retriedDoc.status, 'pending')

  await mockDb.collection('inspections').add({
    data: {
      _id: 'timeout_attempt_3',
      status: 'analyze_failed',
      analyzeAttempts: 3,
      analyzeError: 'AI 响应超过 140 秒未返回'
    }
  })
  await batchAnalyzeMod._internal.markFailedIfNeeded(
    { _id: 'timeout_attempt_3', analyzeAttempts: 3 },
    'AI 响应超过 140 秒未返回'
  )
  const exhaustedDoc = (await mockDb.collection('inspections').doc('timeout_attempt_3').get()).data
  assert.equal(exhaustedDoc.status, 'analyze_failed')

  await mockDb.collection('inspections').add({
    data: {
      _id: 'nokey_attempt_1',
      status: 'analyze_failed',
      analyzeAttempts: 1,
      analyzeError: '未配置 AI API Key，未生成真实分析报告'
    }
  })
  await batchAnalyzeMod._internal.markFailedIfNeeded(
    { _id: 'nokey_attempt_1', analyzeAttempts: 1 },
    '未配置 AI API Key'
  )
  const noKeyDoc = (await mockDb.collection('inspections').doc('nokey_attempt_1').get()).data
  assert.equal(noKeyDoc.status, 'analyze_failed')
})
