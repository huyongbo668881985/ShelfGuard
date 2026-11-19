'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('node:module')
const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfguard-prune-'))
process.env.DATA_DIR = tmpDataDir
process.env.JWT_SECRET = 'test-jwt-secret-prune-originals'
process.env.FILE_URL_SECRET = 'test-file-url-secret-prune-originals'
process.env.BASE_PATH = '/shelfguard'
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3999'

/**
 * 轻量内存文档库（复刻 docdb.js 的查询/命令/排序/更新语义），
 * 使本测试同时兼容本地 Node 20 与生产 Node 22+（无需依赖 node:sqlite 或 express）。
 */
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

  const makeQuery = (colName, initialQuery = {}) => {
    let q = initialQuery
    let order = null
    let lim = 100
    let fields = null
    const matched = () => Array.from(getCol(colName).values()).filter(d => matchQuery(d, q))
    const api = {
      where(next) { q = next || {}; return api },
      orderBy(field, dir) { order = { field, dir: dir === 'asc' ? 'asc' : 'desc' }; return api },
      limit(n) { lim = n; return api },
      field(f) { fields = f; return api },
      async get() {
        let rows = matched().map(cloneDoc)
        if (order) {
          const mul = order.dir === 'asc' ? 1 : -1
          rows.sort((a, b) => compareVal(getPath(a, order.field), getPath(b, order.field)) * mul)
        }
        rows = rows.slice(0, lim)
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
      async count() { return { total: matched().length } },
      async update({ data } = {}) {
        const rows = matched()
        rows.forEach(row => {
          const next = { ...cloneDoc(row), ...cloneDoc(data || {}), _id: row._id }
          getCol(colName).set(row._id, next)
        })
        return { stats: { updated: rows.length } }
      }
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
    exists: flag => cmd('exists', flag),
    inc: n => cmd('inc', n)
  }

  return {
    command,
    serverDate: () => new Date(),
    collection(name) {
      return {
        where: q => makeQuery(name, q),
        orderBy: (f, d) => makeQuery(name, {}).orderBy(f, d),
        limit: n => makeQuery(name, {}).limit(n),
        count: () => makeQuery(name, {}).count(),
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
                const err = new Error('document does not exist')
                err.errCode = -1
                throw err
              }
              return { data: cloneDoc(found) }
            },
            async update({ data } = {}) {
              const found = getCol(name).get(id)
              if (!found) throw new Error('document does not exist')
              const next = { ...cloneDoc(found), ...cloneDoc(data || {}), _id: id }
              getCol(name).set(id, next)
              return { stats: { updated: 1 } }
            },
            async set({ data } = {}) {
              const next = { ...cloneDoc(data || {}), _id: id }
              getCol(name).set(id, next)
              return { _id: id, stats: { updated: 1 } }
            }
          }
        }
      }
    },
    _reset() { collections.clear() },
    _internal: { dataDir: () => dataDir }
  }
}

const mockDb = createInMemoryDb(tmpDataDir)

// 可控的 mock sharp：正常模式把原图按变体标识写入有效 JPEG 字节；失败模式可按回调抛错或生成 0 字节
let sharpBehavior = 'ok' // 'ok' | 'throw' | 'zero'
function mockSharpFactory(inputPath) {
  let targetMaxDim = 0
  const chain = {
    rotate() { return chain },
    resize(opts) { targetMaxDim = (opts && opts.width) || 0; return chain },
    jpeg() { return chain },
    async toFile(dest) {
      if (sharpBehavior === 'throw') {
        throw new Error('mock sharp decode error')
      }
      if (sharpBehavior === 'zero') {
        fs.writeFileSync(dest, Buffer.alloc(0))
        return
      }
      const tag = targetMaxDim <= 360 ? 'THUMB-360' : 'PREVIEW-720'
      const srcName = path.basename(inputPath)
      const payload = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.from(`${tag}:${srcName}`),
        Buffer.from([0xff, 0xd9])
      ])
      fs.writeFileSync(dest, payload)
    }
  }
  return chain
}

let filesMod
let pruneMod
let schedulerMod

function loadModulesWithMocks() {
  const origLoad = Module._load
  const docdbAbs = require.resolve('../src/docdb.js')
  const filesAbs = require.resolve('../src/files.js')
  const pruneAbs = require.resolve('../src/prune-originals.js')
  const schedAbs = require.resolve('../src/scheduler.js')
  const shimAbs = require.resolve('../src/cloud-shim.js')

  ;[filesAbs, pruneAbs, schedAbs, shimAbs].forEach(p => { delete require.cache[p] })

  Module._load = function (request, parent, isMain) {
    if (request === 'sharp') return mockSharpFactory
    if (request === './docdb' || request === '../docdb') return mockDb
    if (parent && parent.filename) {
      const resolved = request.startsWith('.') ? path.resolve(path.dirname(parent.filename), request) : ''
      if (resolved === docdbAbs || `${resolved}.js` === docdbAbs) return mockDb
    }
    return origLoad.apply(this, arguments)
  }

  try {
    filesMod = require(filesAbs)
    // 在 mock 生效期间初始化 sharp 缓存（files.js 为惰性加载 sharp）
    filesMod.isSharpAvailable()
    pruneMod = require(pruneAbs)
    schedulerMod = require(schedAbs)
  } finally {
    Module._load = origLoad
  }
}

function writeOrigFile(rel, content = 'ORIG-FULL-RES-BINARY-CONTENT') {
  const abs = filesMod.absPath(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const buf = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(content),
    Buffer.from([0xff, 0xd9])
  ])
  fs.writeFileSync(abs, buf)
  return abs
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    jsonBody: null,
    sentFile: null,
    status(code) { res.statusCode = code; return res },
    setHeader(k, v) { res.headers[String(k).toLowerCase()] = v },
    json(body) { res.jsonBody = body; return res },
    sendFile(filePath) { res.sentFile = filePath; return res }
  }
  return res
}

async function invokeDownloadBySignedUrl(signedUrlStr) {
  const u = new URL(signedUrlStr)
  const prefix = '/shelfguard/files/'
  const relRaw = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname
  const query = {}
  u.searchParams.forEach((v, k) => { query[k] = v })
  const req = { query, user: null }
  const res = createMockRes()
  await filesMod.handleDownload(req, res, relRaw)
  return res
}

before(() => {
  loadModulesWithMocks()
})

after(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true })
})

test('analyzed 超过 72 小时清理原图并保留 thumb/preview，且 handleDownload 静默降级返回 preview/thumb', async () => {
  mockDb._reset()
  sharpBehavior = 'ok'

  // 当前时间：2026-11-20 03:30:00 +08:00
  const now = new Date('2026-11-20T03:30:00+08:00')
  const hoursAgo = h => new Date(now.getTime() - h * 60 * 60 * 1000)

  const relOver72 = 'inspections/u1/over72.png'
  const relLegacyNoAnalyzedAt = 'inspections/u1/legacy-old.jpg'
  const origOver72 = writeOrigFile(relOver72, 'BIG-PNG-ORIGINAL')
  const origLegacy = writeOrigFile(relLegacyNoAnalyzedAt, 'LEGACY-ORIGINAL')

  const doc1 = await mockDb.collection('inspections').add({
    data: {
      _openid: 'u1',
      recordType: 'visit',
      status: 'analyzed',
      photoFileIDs: [`sg://${relOver72}`],
      createdAt: hoursAgo(80),
      analyzedAt: hoursAgo(73),
      aiReport: { score: 88, scoreLevel: '优秀' }
    }
  })

  // 历史老数据缺少 analyzedAt，按规则回退取 createdAt（超过 72 小时）
  const docLegacy = await mockDb.collection('inspections').add({
    data: {
      _openid: 'u1',
      status: 'analyzed',
      photoFileIDs: [`sg://${relLegacyNoAnalyzedAt}`],
      createdAt: hoursAgo(96),
      aiReport: { score: 82, scoreLevel: '良好' }
    }
  })

  const summary = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now })
  assert.equal(summary.prunedRecords, 2)
  assert.equal(summary.prunedFiles, 2)
  assert.equal(summary.byCategory.analyzed, 2)

  // 原图已删，但 thumb 和 preview 均存在且非空
  assert.equal(fs.existsSync(origOver72), false)
  assert.equal(fs.existsSync(origLegacy), false)
  const thumbOver72 = filesMod.variantPath(relOver72, 'thumb')
  const previewOver72 = filesMod.variantPath(relOver72, 'preview')
  assert.equal(filesMod.isNonEmptyFile(thumbOver72), true)
  assert.equal(filesMod.isNonEmptyFile(previewOver72), true)
  assert.equal(filesMod.isNonEmptyFile(filesMod.variantPath(relLegacyNoAnalyzedAt, 'thumb')), true)
  assert.equal(filesMod.isNonEmptyFile(filesMod.variantPath(relLegacyNoAnalyzedAt, 'preview')), true)

  // 数据库记录完整保留，并写入 originPrunedAt
  const saved1 = (await mockDb.collection('inspections').doc(doc1._id).get()).data
  assert.ok(saved1.originPrunedAt)
  assert.equal(saved1.originPrunedCount, 1)
  assert.equal(saved1.aiReport.score, 88)
  const savedLegacy = (await mockDb.collection('inspections').doc(docLegacy._id).get()).data
  assert.ok(savedLegacy.originPrunedAt)

  // getTempFileURL 在原图删除后仍为原图/preview/thumb 签出有效链接
  const origUrlRes = await filesMod.getTempFileURL({ fileList: [`sg://${relOver72}`] })
  const previewUrlRes = await filesMod.getTempFileURL({ fileList: [`sg://${relOver72}`], variant: 'preview' })
  const thumbUrlRes = await filesMod.getTempFileURL({ fileList: [`sg://${relOver72}`], variant: 'thumb' })
  assert.equal(origUrlRes.fileList[0].status, 0)
  assert.equal(previewUrlRes.fileList[0].status, 0)
  assert.equal(thumbUrlRes.fileList[0].status, 0)

  // handleDownload：v=thumb / v=preview 直接返回对应缓存（不要求原图存在）
  const dlThumb = await invokeDownloadBySignedUrl(thumbUrlRes.fileList[0].tempFileURL)
  assert.equal(dlThumb.statusCode, 200)
  assert.equal(dlThumb.sentFile, thumbOver72)
  assert.equal(dlThumb.headers['content-type'], 'image/jpeg')

  const dlPreview = await invokeDownloadBySignedUrl(previewUrlRes.fileList[0].tempFileURL)
  assert.equal(dlPreview.statusCode, 200)
  assert.equal(dlPreview.sentFile, previewOver72)
  assert.equal(dlPreview.headers['content-type'], 'image/jpeg')

  // handleDownload：请求原图（无 v 参数）静默降级返回 preview，且 Content-Type 为 image/jpeg（即使原文件后缀是 .png）
  const dlOrigFallback = await invokeDownloadBySignedUrl(origUrlRes.fileList[0].tempFileURL)
  assert.equal(dlOrigFallback.statusCode, 200)
  assert.equal(dlOrigFallback.sentFile, previewOver72)
  assert.equal(dlOrigFallback.headers['content-type'], 'image/jpeg')

  // 无签名直接访问仍应拒绝 401
  const unauthRes = createMockRes()
  await filesMod.handleDownload({ query: {}, user: null }, unauthRes, relOver72)
  assert.equal(unauthRes.statusCode, 401)

  // 当 preview 也被删除仅剩 thumb 时，原图请求继续降级返回 thumb
  fs.unlinkSync(previewOver72)
  const dlThumbFallback = await invokeDownloadBySignedUrl(origUrlRes.fileList[0].tempFileURL)
  assert.equal(dlThumbFallback.statusCode, 200)
  assert.equal(dlThumbFallback.sentFile, thumbOver72)
  assert.equal(dlThumbFallback.headers['content-type'], 'image/jpeg')

  // 原图与缓存全部不存在时返回 404，且 getTempFileURL 返回 status=-1
  fs.unlinkSync(thumbOver72)
  const missingUrlRes = await filesMod.getTempFileURL({ fileList: [`sg://${relOver72}`] })
  assert.equal(missingUrlRes.fileList[0].status, -1)
  assert.equal(missingUrlRes.fileList[0].tempFileURL, '')
  const dlMissing = await invokeDownloadBySignedUrl(origUrlRes.fileList[0].tempFileURL)
  assert.equal(dlMissing.statusCode, 404)

  // 二次运行定时清理不会重复扫描已标记 originPrunedAt 的记录
  const secondRun = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now })
  assert.equal(secondRun.scanned, 0)
  assert.equal(secondRun.prunedRecords, 0)
})

test('analyzed 未满 72 小时、pending、analyzing、uploaded 的原图绝不被清理', async () => {
  mockDb._reset()
  sharpBehavior = 'ok'

  const now = new Date('2026-11-20T03:30:00+08:00')
  const hoursAgo = h => new Date(now.getTime() - h * 60 * 60 * 1000)

  const relFreshAnalyzed = 'inspections/u2/fresh-analyzed.jpg'
  const relPending = 'inspections/u2/pending-old.jpg'
  const relAnalyzing = 'inspections/u2/analyzing-old.jpg'
  const relUploaded = 'inspections/u2/uploaded-old.jpg'

  const absFresh = writeOrigFile(relFreshAnalyzed)
  const absPending = writeOrigFile(relPending)
  const absAnalyzing = writeOrigFile(relAnalyzing)
  const absUploaded = writeOrigFile(relUploaded)

  const dFresh = await mockDb.collection('inspections').add({
    data: { _openid: 'u2', status: 'analyzed', photoFileIDs: [`sg://${relFreshAnalyzed}`], createdAt: hoursAgo(90), analyzedAt: hoursAgo(48) }
  })
  const dPending = await mockDb.collection('inspections').add({
    data: { _openid: 'u2', status: 'pending', photoFileIDs: [`sg://${relPending}`], createdAt: hoursAgo(200) }
  })
  const dAnalyzing = await mockDb.collection('inspections').add({
    data: { _openid: 'u2', status: 'analyzing', photoFileIDs: [`sg://${relAnalyzing}`], createdAt: hoursAgo(200) }
  })
  const dUploaded = await mockDb.collection('inspections').add({
    data: { _openid: 'u2', status: 'uploaded', photoFileIDs: [`sg://${relUploaded}`], createdAt: hoursAgo(200) }
  })

  const summary = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now })
  assert.equal(summary.prunedRecords, 0)
  assert.equal(summary.prunedFiles, 0)

  assert.equal(fs.existsSync(absFresh), true)
  assert.equal(fs.existsSync(absPending), true)
  assert.equal(fs.existsSync(absAnalyzing), true)
  assert.equal(fs.existsSync(absUploaded), true)

  for (const d of [dFresh, dPending, dAnalyzing, dUploaded]) {
    const saved = (await mockDb.collection('inspections').doc(d._id).get()).data
    assert.equal(saved.originPrunedAt, undefined)
  }
})

test('上下班打卡照片：当天保留原图，次日凌晨（早于今日北京时间 00:00）定时清理原图并兼容历史老打卡', async () => {
  mockDb._reset()
  sharpBehavior = 'ok'

  // 2026-11-20 03:30:00 +08:00 定时任务触发
  const now = new Date('2026-11-20T03:30:00+08:00')

  const relTodayClock = 'inspections/u3/clock-today.jpg'
  const relYesterdayClockIn = 'inspections/u3/clock-yesterday-in.jpg'
  const relYesterdayClockOut = 'inspections/u3/clock-yesterday-out.jpg'
  const relLegacyClocked = 'inspections/u3/clock-legacy-status.jpg'

  const absToday = writeOrigFile(relTodayClock)
  const absYesterdayIn = writeOrigFile(relYesterdayClockIn)
  const absYesterdayOut = writeOrigFile(relYesterdayClockOut)
  const absLegacy = writeOrigFile(relLegacyClocked)

  // 今天凌晨 00:15 打卡：同日不清理
  const dToday = await mockDb.collection('inspections').add({
    data: {
      _openid: 'u3',
      recordType: 'clock_in',
      status: 'clocked',
      photoFileIDs: [`sg://${relTodayClock}`],
      createdAt: new Date('2026-11-20T00:15:00+08:00')
    }
  })

  // 昨天 08:30 上班打卡：次日凌晨清理
  const dYesterdayIn = await mockDb.collection('inspections').add({
    data: {
      _openid: 'u3',
      recordType: 'clock_in',
      status: 'clocked',
      photoFileIDs: [`sg://${relYesterdayClockIn}`],
      createdAt: new Date('2026-11-19T08:30:00+08:00')
    }
  })

  // 昨天 23:55 下班打卡（虽然距 03:30 不足 4 小时，但已跨自然日）：次日凌晨清理
  const dYesterdayOut = await mockDb.collection('inspections').add({
    data: {
      _openid: 'u3',
      recordType: 'clock_out',
      status: 'clocked',
      photoFileIDs: [`sg://${relYesterdayClockOut}`],
      createdAt: new Date('2026-11-19T23:55:00+08:00')
    }
  })

  // 历史老打卡（无 recordType 字段，仅 status === 'clocked'）
  const dLegacy = await mockDb.collection('inspections').add({
    data: {
      _openid: 'u3',
      status: 'clocked',
      photoFileIDs: [`sg://${relLegacyClocked}`],
      createdAt: new Date('2026-10-01T09:00:00+08:00')
    }
  })

  const summary = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now })
  assert.equal(summary.prunedRecords, 3)
  assert.equal(summary.byCategory.clock, 3)

  // 当天打卡保留原图
  assert.equal(fs.existsSync(absToday), true)
  assert.equal((await mockDb.collection('inspections').doc(dToday._id).get()).data.originPrunedAt, undefined)

  // 昨日与历史老打卡原图均已删，thumb/preview 保留，数据库记录保留
  assert.equal(fs.existsSync(absYesterdayIn), false)
  assert.equal(fs.existsSync(absYesterdayOut), false)
  assert.equal(fs.existsSync(absLegacy), false)
  for (const rel of [relYesterdayClockIn, relYesterdayClockOut, relLegacyClocked]) {
    assert.equal(filesMod.isNonEmptyFile(filesMod.variantPath(rel, 'thumb')), true)
    assert.equal(filesMod.isNonEmptyFile(filesMod.variantPath(rel, 'preview')), true)
  }
  for (const d of [dYesterdayIn, dYesterdayOut, dLegacy]) {
    const saved = (await mockDb.collection('inspections').doc(d._id).get()).data
    assert.ok(saved.originPrunedAt)
    assert.equal(saved.status, 'clocked')
  }
})

test('analyze_failed 超过 30 天只删原图保留缩略图与库记录，未满 30 天保留；且 retryFailed 与 queue.failed 跳过已清理记录', async () => {
  mockDb._reset()
  sharpBehavior = 'ok'

  const now = new Date('2026-11-20T03:30:00+08:00')
  const daysAgo = d => new Date(now.getTime() - d * 24 * 60 * 60 * 1000)

  const relFailedOld = 'inspections/u4/failed-35d.jpg'
  const relFailedRecent = 'inspections/u4/failed-10d.jpg'
  const absFailedOld = writeOrigFile(relFailedOld)
  const absFailedRecent = writeOrigFile(relFailedRecent)

  const dOld = await mockDb.collection('inspections').add({
    data: {
      _openid: 'u4',
      status: 'analyze_failed',
      storeName: '老失败门店',
      photoFileIDs: [`sg://${relFailedOld}`],
      createdAt: daysAgo(40),
      analyzeStartedAt: daysAgo(35),
      analyzedAt: daysAgo(35),
      analyzeAttempts: 3
    }
  })

  const dRecent = await mockDb.collection('inspections').add({
    data: {
      _openid: 'u4',
      status: 'analyze_failed',
      storeName: '近失败门店',
      photoFileIDs: [`sg://${relFailedRecent}`],
      createdAt: daysAgo(40),
      analyzeStartedAt: daysAgo(10), // 曾被重排过，距今不足 30 天
      analyzedAt: daysAgo(10),
      analyzeAttempts: 3
    }
  })

  const summary = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now })
  assert.equal(summary.prunedRecords, 1)
  assert.equal(summary.byCategory.analyze_failed, 1)

  // 超过 30 天：原图删除，缩略图与数据库记录保留
  assert.equal(fs.existsSync(absFailedOld), false)
  assert.equal(filesMod.isNonEmptyFile(filesMod.variantPath(relFailedOld, 'thumb')), true)
  assert.equal(filesMod.isNonEmptyFile(filesMod.variantPath(relFailedOld, 'preview')), true)
  const savedOld = (await mockDb.collection('inspections').doc(dOld._id).get()).data
  assert.equal(savedOld.storeName, '老失败门店')
  assert.equal(savedOld.status, 'analyze_failed')
  assert.ok(savedOld.originPrunedAt)

  // 未满 30 天：原图保留
  assert.equal(fs.existsSync(absFailedRecent), true)
  assert.equal((await mockDb.collection('inspections').doc(dRecent._id).get()).data.originPrunedAt, undefined)

  // 验证 settings.get（queue.failed）与 settings.retryFailed 均正确排除已清理原图的失败记录
  await mockDb.collection('users').add({
    data: { _openid: 'admin_u', role: 'admin', disabled: false, approved: true }
  })

  const origLoad = Module._load
  const settingsPath = require.resolve('../src/functions/settings/index.js')
  const prevSettings = require.cache[settingsPath]
  delete require.cache[settingsPath]

  const mockCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext: () => ({ OPENID: 'admin_u' }),
    database: () => mockDb
  }
  Module._load = function (request) {
    if (request === '../../cloud-shim') return mockCloud
    return origLoad.apply(this, arguments)
  }

  let settingsMain
  try {
    settingsMain = require(settingsPath).main
  } finally {
    Module._load = origLoad
    if (prevSettings) require.cache[settingsPath] = prevSettings
    else delete require.cache[settingsPath]
  }

  const getRes = await settingsMain({ action: 'get' }, {})
  assert.equal(getRes.success, true)
  assert.equal(getRes.queue.failed, 1) // 仅统计未清理原图的近失败记录

  const retryRes = await settingsMain({ action: 'retryFailed' }, {})
  assert.equal(retryRes.success, true)
  assert.equal(retryRes.failed, 1)
  assert.equal(retryRes.skippedPruned, 1)

  // 老失败记录仍保持 analyze_failed（不进入无原图死循环），近失败记录重排为 pending
  assert.equal((await mockDb.collection('inspections').doc(dOld._id).get()).data.status, 'analyze_failed')
  assert.equal((await mockDb.collection('inspections').doc(dRecent._id).get()).data.status, 'pending')
})

test('ensureVariant 失败、生成 0 字节文件、sharp 不可用或非 inspections/ 路径时，均安全保留原图不删除', async () => {
  mockDb._reset()

  const now = new Date('2026-11-20T03:30:00+08:00')
  const oldDate = new Date(now.getTime() - 100 * 60 * 60 * 1000)

  // 1. ensureVariant 抛错（sharp decode 失败）
  const relErr = 'inspections/u5/corrupt.jpg'
  const absErr = writeOrigFile(relErr)
  const dErr = await mockDb.collection('inspections').add({
    data: { _openid: 'u5', status: 'analyzed', photoFileIDs: [`sg://${relErr}`], createdAt: oldDate, analyzedAt: oldDate }
  })
  sharpBehavior = 'throw'
  const resThrow = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now })
  assert.equal(resThrow.prunedRecords, 0)
  assert.equal(resThrow.skippedFailed, 1)
  assert.equal(fs.existsSync(absErr), true)
  assert.equal((await mockDb.collection('inspections').doc(dErr._id).get()).data.originPrunedAt, undefined)

  // 2. ensureVariant 生成 0 字节文件
  sharpBehavior = 'zero'
  const resZero = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now })
  assert.equal(resZero.prunedRecords, 0)
  assert.equal(resZero.skippedFailed, 1)
  assert.equal(fs.existsSync(absErr), true)
  assert.equal((await mockDb.collection('inspections').doc(dErr._id).get()).data.originPrunedAt, undefined)

  // 3. sharp 不可用
  sharpBehavior = 'ok'
  const resNoSharp = await pruneMod.pruneOriginals({
    db: mockDb,
    files: filesMod,
    now,
    pruneFileDeps: { isSharpAvailable: () => false }
  })
  assert.equal(resNoSharp.sharpAvailable, false)
  assert.equal(resNoSharp.prunedRecords, 0)
  assert.equal(resNoSharp.skippedFailed, 1)
  assert.equal(fs.existsSync(absErr), true)
  assert.equal((await mockDb.collection('inspections').doc(dErr._id).get()).data.originPrunedAt, undefined)

  // 4. 白名单保护：products/ 产品/物料参考照绝不被删除
  const relProd = 'products/front-ref-001.jpg'
  const absProd = writeOrigFile(relProd, 'PRODUCT-REF-PHOTO')
  const prodRes = await filesMod.pruneInspectionOriginal(`sg://${relProd}`)
  assert.equal(prodRes.status, 'skipped_non_inspection')
  assert.equal(fs.existsSync(absProd), true)

  // 5. 批次上限 batchLimit 控制生效
  mockDb._reset()
  for (let i = 0; i < 5; i++) {
    const rel = `inspections/u6/batch-${i}.jpg`
    writeOrigFile(rel)
    await mockDb.collection('inspections').add({
      data: {
        _openid: 'u6',
        status: 'analyzed',
        photoFileIDs: [`sg://${rel}`],
        createdAt: new Date(oldDate.getTime() + i * 1000),
        analyzedAt: new Date(oldDate.getTime() + i * 1000)
      }
    })
  }
  const batch1 = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now, batchLimit: 2, concurrency: 2 })
  assert.equal(batch1.prunedRecords, 2)
  const batch2 = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now, batchLimit: 2, concurrency: 2 })
  assert.equal(batch2.prunedRecords, 2)
  const batch3 = await pruneMod.pruneOriginals({ db: mockDb, files: filesMod, now, batchLimit: 2, concurrency: 2 })
  assert.equal(batch3.prunedRecords, 1)
})

test('已清理原图的记录触发 analyzeImage 时直接拒绝，不扣配额且不覆盖原有 analyzed 状态', async () => {
  mockDb._reset()

  await mockDb.collection('users').add({
    data: { _openid: 'sales_p1', role: 'sales', disabled: false, approved: true }
  })
  const dPruned = await mockDb.collection('inspections').add({
    data: {
      _openid: 'sales_p1',
      status: 'analyzed',
      photoFileIDs: ['sg://inspections/sales_p1/archived.jpg'],
      originPrunedAt: new Date(),
      aiReport: { score: 91, scoreLevel: '优秀' }
    }
  })

  const origLoad = Module._load
  const analyzePath = require.resolve('../src/functions/analyzeImage/index.js')
  const prevAnalyze = require.cache[analyzePath]
  delete require.cache[analyzePath]

  const mockCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext: () => ({ OPENID: 'sales_p1' }),
    database: () => mockDb,
    readFilesAsDataUrls: async () => { throw new Error('不应执行读图') }
  }
  Module._load = function (request) {
    if (request === 'axios') return { post: async () => { throw new Error('不应调用 AI') } }
    if (request === '../../cloud-shim') return mockCloud
    return origLoad.apply(this, arguments)
  }

  let analyzeMain
  try {
    analyzeMain = require(analyzePath).main
  } finally {
    Module._load = origLoad
    if (prevAnalyze) require.cache[analyzePath] = prevAnalyze
    else delete require.cache[analyzePath]
  }

  const res = await analyzeMain({ inspectionId: dPruned._id }, {})
  assert.equal(res.success, false)
  assert.equal(res.code, 'ORIGIN_PRUNED')

  // 原有报告与状态完整保留，且未扣减 analyzeQuota
  const afterDoc = (await mockDb.collection('inspections').doc(dPruned._id).get()).data
  assert.equal(afterDoc.status, 'analyzed')
  assert.equal(afterDoc.aiReport.score, 91)
  const quotaCount = await mockDb.collection('analyzeQuota').count()
  assert.equal(quotaCount.total, 0)
})

test('scheduler.decideJobs：每天 03:30 触发 pruneOriginals，避开 03:00 shelfStats 且每日仅触发一次', () => {
  const at0300 = { year: '2026', month: '11', day: '20', hour: 3, minute: 0, second: 0 }
  const jobs0300 = schedulerMod.decideJobs(at0300, { lastBatch: '', lastJxc: '', lastStats: '', lastPrune: '' })
  assert.equal(jobs0300.some(j => j.name === 'shelfStats'), true)
  assert.equal(jobs0300.some(j => j.name === 'pruneOriginals'), false)

  const at0330 = { year: '2026', month: '11', day: '20', hour: 3, minute: 30, second: 5 }
  const jobs0330 = schedulerMod.decideJobs(at0330, { lastBatch: '', lastJxc: '', lastStats: '2026-11-20', lastPrune: '' })
  assert.equal(jobs0330.some(j => j.name === 'pruneOriginals'), true)

  // 同日已触发后不再重复触发
  const at0332 = { year: '2026', month: '11', day: '20', hour: 3, minute: 32, second: 0 }
  const jobsAgain = schedulerMod.decideJobs(at0332, {
    lastBatch: '2026-11-20T03:32',
    lastJxc: '2026-11-20T03:30',
    lastStats: '2026-11-20',
    lastPrune: '2026-11-20'
  })
  assert.equal(jobsAgain.some(j => j.name === 'pruneOriginals'), false)

  // 若 03:30 恰好被其他任务阻塞错过，03:31 仍可补触发
  const at0331 = { year: '2026', month: '11', day: '20', hour: 3, minute: 31, second: 0 }
  const jobsCatchup = schedulerMod.decideJobs(at0331, {
    lastBatch: '',
    lastJxc: '',
    lastStats: '2026-11-20',
    lastPrune: '2026-11-19'
  })
  assert.deepEqual(jobsCatchup.map(j => j.name), ['pruneOriginals'])
})
