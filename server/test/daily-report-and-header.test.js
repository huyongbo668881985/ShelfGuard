'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')
const { test } = require('node:test')

const {
  isHorizontalBannerMaterial,
  isOwnHorizontalBannerEntry,
  isCabinetHeaderMaterial,
  isOwnCabinetHeaderEntry,
  selectMaterialRefs
} = require('../src/functions/analyzeImage/scoring')
const {
  buildUserPrompt,
  buildMultimodalUserContent
} = require('../src/functions/analyzeImage/prompt')

function loadAnalyzeInternalWithStubs() {
  const analyzePath = require.resolve('../src/functions/analyzeImage/index.js')
  const prevAnalyze = require.cache[analyzePath]
  delete require.cache[analyzePath]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'axios') return { post: async () => ({}) }
    if (request === '../../cloud-shim') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database() {
          return {
            command: {},
            serverDate: () => new Date(),
            collection: () => ({ doc: () => ({ get: async () => ({ data: null }) }) })
          }
        }
      }
    }
    return origLoad.apply(this, arguments)
  }
  try {
    return require(analyzePath)._internal
  } finally {
    Module._load = origLoad
    if (prevAnalyze) require.cache[analyzePath] = prevAnalyze
    else delete require.cache[analyzePath]
  }
}

function withMockedDailyInternal(collections, fn) {
  const docdbPath = require.resolve('../src/docdb')
  const filesPath = require.resolve('../src/files')
  const internalPath = require.resolve('../src/internal')
  const origDocdb = require.cache[docdbPath]
  const origFiles = require.cache[filesPath]
  const origInternal = require.cache[internalPath]
  const origKey = process.env.INTERNAL_API_KEY

  const makeQuery = (rows) => {
    let skipN = 0
    let limitN = rows.length
    let currentRows = rows.slice()
    return {
      where(cond) {
        if (cond && cond._filterFn) {
          currentRows = currentRows.filter(cond._filterFn)
        }
        return this
      },
      orderBy() { return this },
      skip(n) { skipN = n; return this },
      limit(n) { limitN = n; return this },
      doc() { return { get: async () => ({ data: null }) } },
      get: async () => ({ data: currentRows.slice(skipN, skipN + limitN) })
    }
  }

  require.cache[docdbPath] = {
    id: docdbPath,
    filename: docdbPath,
    loaded: true,
    exports: {
      command: {
        gte: (d) => ({ _op: 'gte', val: d }),
        lt: (d) => ({ _op: 'lt', val: d }),
        lte: (d) => ({ _op: 'lte', val: d }),
        neq: (v) => ({ _op: 'neq', val: v }),
        in: (v) => ({ _op: 'in', val: v }),
        or: (arr) => ({ _op: 'or', val: arr }),
        and: (...conds) => ({
          _filterFn: (row) => conds.every(c => {
            if (!c || typeof c !== 'object') return true
            if (c.createdAt && c.createdAt._op === 'gte') {
              return new Date(row.createdAt).getTime() >= new Date(c.createdAt.val).getTime()
            }
            if (c.createdAt && c.createdAt._op === 'lt') {
              return new Date(row.createdAt).getTime() < new Date(c.createdAt.val).getTime()
            }
            if (c['aiReport.metadata.isMock'] && c['aiReport.metadata.isMock']._op === 'neq') {
              return !(row.aiReport && row.aiReport.metadata && row.aiReport.metadata.isMock === c['aiReport.metadata.isMock'].val)
            }
            return true
          })
        })
      },
      collection: (name) => makeQuery(collections[name] || [])
    }
  }
  require.cache[filesPath] = {
    id: filesPath,
    filename: filesPath,
    loaded: true,
    exports: { getTempFileURL: async () => ({ fileList: [] }) }
  }
  delete require.cache[internalPath]
  process.env.INTERNAL_API_KEY = 'internal-test-key-1234567890'
  const mod = require('../src/internal')

  return Promise.resolve()
    .then(() => fn(mod))
    .finally(() => {
      if (origDocdb) require.cache[docdbPath] = origDocdb
      else delete require.cache[docdbPath]
      if (origFiles) require.cache[filesPath] = origFiles
      else delete require.cache[filesPath]
      if (origInternal) require.cache[internalPath] = origInternal
      else delete require.cache[internalPath]
      if (origKey === undefined) delete process.env.INTERNAL_API_KEY
      else process.env.INTERNAL_API_KEY = origKey
    })
}

function mockRes() {
  const res = { statusCode: 200, payload: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (body) => { res.payload = body; return res }
  return res
}

test('柜眉参考图筛选、prompt拼装与横签严格隔离', () => {
  const materials = [
    { _id: 'm1', materialName: '标准换购横签', category: '横签', photo: 'sg://banner.jpg', isActive: true },
    { _id: 'm2', materialName: '店铺灯箱', category: '灯箱', photo: 'sg://lightbox.jpg', isActive: true },
    { _id: 'm3', materialName: '永丰特8换购柜眉', category: '柜眉', visualFeatures: '1.2m*0.2m红底黄框', photo: 'sg://header.jpg', isActive: true },
    { _id: 'm4', materialName: '停用柜眉', category: '柜眉', photo: 'sg://disabled.jpg', isActive: false }
  ]

  assert.equal(isHorizontalBannerMaterial(materials[0]), true)
  assert.equal(isHorizontalBannerMaterial(materials[2]), false)
  assert.equal(isCabinetHeaderMaterial(materials[2]), true)
  assert.equal(isCabinetHeaderMaterial(materials[0]), false)

  assert.equal(isOwnHorizontalBannerEntry({ name: '永丰特8换购柜眉', category: '柜眉', isOwn: true }), false)
  assert.equal(isOwnCabinetHeaderEntry({ name: '永丰特8换购柜眉', category: '柜眉', isOwn: true }), true)
  assert.equal(isOwnCabinetHeaderEntry({ name: '收银台柜眉', category: 'POP海报', isOwn: true }), true)
  assert.equal(isOwnCabinetHeaderEntry({ name: '竞品柜眉', category: '柜眉', isOwn: false }), false)

  const picked = selectMaterialRefs(materials, 2)
  assert.equal(picked.length, 2)
  assert.equal(picked[0].materialName, '永丰特8换购柜眉')
  assert.equal(picked[1].materialName, '店铺灯箱')

  const userPrompt = buildUserPrompt(
    2,
    '',
    [materials[0]],
    [{ brandName: '永丰特8', productLine: '红标', slot: 'front' }],
    [materials[2]]
  )
  assert.match(userPrompt, /重点广告物料对照参考图说明/)
  assert.match(userPrompt, /【物料参考图 1\/1】/)
  assert.match(userPrompt, /严禁计入货架横签得分/)

  const content = buildMultimodalUserContent({
    visitImageUrls: ['https://example.com/v1.jpg'],
    productRefs: [{ url: 'https://example.com/p1.jpg', brandName: '永丰特8', productLine: '红标', slot: 'front' }],
    bannerRefs: [{ url: 'https://example.com/b1.jpg', materialName: '标准换购横签' }],
    materialRefs: [{ url: 'https://example.com/h1.jpg', materialName: '永丰特8换购柜眉', category: '柜眉', visualFeatures: '1.2米' }],
    userPrompt
  })
  assert.ok(content.some(part => part.text && part.text.includes('【物料参考图 1/1】')))
  assert.ok(content.some(part => part.image === 'https://example.com/h1.jpg'))

  const analyzeInternal = loadAnalyzeInternalWithStubs()
  const alloc4 = analyzeInternal.allocateReferenceBudget(
    9,
    [{ photo: 'p1' }, { photo: 'p2' }, { photo: 'p3' }, { photo: 'p4' }],
    [{ photo: 'b1' }, { photo: 'b2' }, { photo: 'b3' }],
    12
  )
  assert.equal(alloc4.bannerRefs.length, 3)
  assert.equal(alloc4.productRefs.length, 0)
  assert.equal(alloc4.materialRefs.length, 0)

  const alloc5 = analyzeInternal.allocateReferenceBudget(
    2,
    [{ photo: 'p1' }, { photo: 'p2' }],
    [{ photo: 'b1' }],
    12,
    [{ photo: 'h1' }]
  )
  assert.equal(alloc5.bannerRefs.length, 1)
  assert.equal(alloc5.productRefs.length, 2)
  assert.equal(alloc5.materialRefs.length, 1)
})

test('dailyReportHandler 鉴权、北京时间窗口、同店去重与分人指标聚合正确', async () => {
  const users = [
    { _id: 'u1', _openid: 'op_zhang', name: '张三', role: 'sales', department: '一部', approved: true },
    { _id: 'u2', _openid: 'op_li', name: '李四', role: 'sales', department: '一部', approved: true },
    { _id: 'u3', _openid: 'op_admin', name: '管理员', role: 'admin', approved: true }
  ]

  const inspections = [
    // 张三上班打卡（08:30 与 08:45 取最早 08:30）
    { _id: 'r1', _openid: 'op_zhang', userName: '张三', recordType: 'clock_in', status: 'clocked', createdAt: new Date('2026-11-23T00:30:00.000Z') },
    { _id: 'r2', _openid: 'op_zhang', userName: '张三', recordType: 'clock_in', status: 'clocked', createdAt: new Date('2026-11-23T00:45:00.000Z') },
    // 张三拜访门店1 第1次（09:10）：货架照，有我司产品，80分，8面，有横签
    {
      _id: 'r3',
      _openid: 'op_zhang',
      userName: '张三',
      recordType: 'visit',
      customerId: 'cust_1',
      storeName: '兴隆烟酒',
      status: 'analyzed',
      createdAt: new Date('2026-11-23T01:10:00.000Z'),
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: true,
        score: 80,
        facingMetrics: { ownFacingCount: 8 },
        displayCompliance: { horizontalBanner: { score: 10 } },
        adMaterials: [{ name: '标准横签', category: '横签', isOwn: true, count: 1 }]
      }
    },
    // 张三拜访门店1 第2次（09:25）：补拍收银台纯柜眉照 -> 同店去重仍只算1家，且合并出柜眉！
    {
      _id: 'r4',
      _openid: 'op_zhang',
      userName: '张三',
      recordType: 'visit',
      customerId: 'cust_1',
      storeName: '兴隆烟酒',
      status: 'analyzed',
      createdAt: new Date('2026-11-23T01:25:00.000Z'),
      aiReport: {
        hasShelfPhoto: false,
        ownBrandPresent: null,
        score: null,
        adMaterials: [{ name: '永丰特8换购柜眉', category: '柜眉', isOwn: true, count: 1 }]
      }
    },
    // 张三拜访门店2（14:00）：70分，6面，无横签，有柜眉
    {
      _id: 'r5',
      _openid: 'op_zhang',
      userName: '张三',
      recordType: 'visit',
      customerId: 'cust_2',
      storeName: '宏达超市',
      status: 'analyzed',
      createdAt: new Date('2026-11-23T06:00:00.000Z'),
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: true,
        score: 70,
        facingMetrics: { ownFacingCount: 6 },
        displayCompliance: { horizontalBanner: { score: 0 } },
        adMaterials: [{ name: '永丰特8换购柜眉', category: '柜眉', isOwn: true, count: 1 }]
      }
    },
    // 张三拜访门店3（17:20）：未上柜（不计入有货均分与平均排面）
    {
      _id: 'r6',
      _openid: 'op_zhang',
      userName: '张三',
      recordType: 'visit',
      customerId: 'cust_3',
      storeName: '阳光便利店',
      status: 'analyzed',
      createdAt: new Date('2026-11-23T09:20:00.000Z'),
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: false,
        score: null,
        scoreLevel: '未上柜',
        facingMetrics: { ownFacingCount: 0 },
        displayCompliance: { horizontalBanner: { score: 0 } },
        adMaterials: []
      }
    },
    // 张三下班打卡：18:05 与 18:30（取最晚 18:30）
    { _id: 'r7', _openid: 'op_zhang', userName: '张三', recordType: 'clock_out', status: 'clocked', createdAt: new Date('2026-11-23T10:05:00.000Z') },
    { _id: 'r8', _openid: 'op_zhang', userName: '张三', recordType: 'clock_out', status: 'clocked', createdAt: new Date('2026-11-23T10:30:00.000Z') },
    // admin 测试记录（默认排除）
    {
      _id: 'r9',
      _openid: 'op_admin',
      userName: '管理员',
      recordType: 'visit',
      storeName: '测试门店',
      status: 'analyzed',
      createdAt: new Date('2026-11-23T02:00:00.000Z'),
      aiReport: { hasShelfPhoto: true, ownBrandPresent: true, score: 100, facingMetrics: { ownFacingCount: 10 } }
    },
    // isMock 记录（排除）
    {
      _id: 'r10',
      _openid: 'op_zhang',
      userName: '张三',
      recordType: 'visit',
      storeName: '模拟门店',
      status: 'analyzed',
      createdAt: new Date('2026-11-23T03:00:00.000Z'),
      aiReport: { hasShelfPhoto: true, ownBrandPresent: true, score: 100, metadata: { isMock: true } }
    },
    // 次日北京时间 00:05（不属于 2026-11-23）
    { _id: 'r11', _openid: 'op_li', userName: '李四', recordType: 'clock_in', status: 'clocked', createdAt: new Date('2026-11-23T16:05:00.000Z') }
  ]

  await withMockedDailyInternal({ users, inspections }, async (mod) => {
    // 鉴权拦截
    const rUnauth = mockRes()
    let nextCalled = false
    mod.requireInternalKey({ headers: {} }, rUnauth, () => { nextCalled = true })
    assert.equal(nextCalled, false)
    assert.equal(rUnauth.statusCode, 401)

    const rAuth = mockRes()
    mod.requireInternalKey({ headers: { authorization: 'Bearer internal-test-key-1234567890' } }, rAuth, () => { nextCalled = true })
    assert.equal(nextCalled, true)

    // 非法日期
    const badRes = mockRes()
    await mod.dailyReportHandler({ query: { date: '2026-02-30' } }, badRes)
    assert.equal(badRes.statusCode, 400)

    // 默认日期（北京时间 2026-11-24 07:10 运行 -> 统计昨日 2026-11-23）
    const defaultRange = mod._internal.parseShanghaiDayRange('', Date.parse('2026-11-23T23:10:00.000Z'))
    assert.equal(defaultRange.date, '2026-11-23')

    // 正常汇总
    const okRes = mockRes()
    await mod.dailyReportHandler({ query: { date: '2026-11-23' } }, okRes)
    assert.equal(okRes.statusCode, 200)
    const body = okRes.payload
    assert.equal(body.success, true)
    assert.equal(body.date, '2026-11-23')
    assert.equal(body.salespersons.length, 2)

    const zhang = body.salespersons.find(p => p.userName === '张三')
    assert.ok(zhang)
    assert.equal(zhang.clockInTime, '08:30')
    assert.equal(zhang.clockOutTime, '18:30')
    assert.equal(zhang.visitCount, 3)
    assert.equal(zhang.visitSubmissionCount, 4)
    assert.equal(zhang.firstVisitTime, '09:10')
    assert.equal(zhang.lastVisitTime, '17:20')
    assert.equal(zhang.visitTimeRange, '09:10~17:20')
    assert.equal(zhang.inStockStoreCount, 2)
    assert.equal(zhang.inStockAvgScore, 75)
    assert.equal(zhang.inStockAvgFacing, 7)
    assert.equal(zhang.horizontalBannerStoreCount, 1)
    assert.equal(zhang.cabinetHeaderStoreCount, 2)

    const li = body.salespersons.find(p => p.userName === '李四')
    assert.ok(li)
    assert.equal(li.clockInTime, null)
    assert.equal(li.clockOutTime, null)
    assert.equal(li.visitCount, 0)
    assert.equal(li.inStockAvgScore, null)
    assert.equal(li.inStockAvgFacing, null)

    assert.equal(body.totals.totalStaffCount, 2)
    assert.equal(body.totals.activeStaffCount, 1)
    assert.equal(body.totals.visitCount, 3)
    assert.equal(body.totals.inStockStoreCount, 2)
    assert.equal(body.totals.inStockAvgScore, 75)
    assert.equal(body.totals.inStockAvgFacing, 7)
    assert.equal(body.totals.horizontalBannerStoreCount, 1)
    assert.equal(body.totals.cabinetHeaderStoreCount, 2)
  })
})
