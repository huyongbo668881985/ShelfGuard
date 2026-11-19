'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfguard-'))
process.env.DATA_DIR = tmp
process.env.JWT_SECRET = 'test-jwt-secret-please-change'
process.env.ADMIN_SETUP_CODE = 'setup-code-8848'
process.env.SHELFGUARD_TEST_LOGIN = '1'
process.env.DISABLE_CRON = '1'
process.env.BASE_PATH = '/shelfguard'
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1'
process.env.WECHAT_APPID = ''
process.env.WECHAT_SECRET = ''
process.env.TIANDITU_KEY = ''
process.env.TENCENT_MAP_KEY = ''

const { createApp } = require('../src/app')
const db = require('../src/docdb')
const { decideJobs } = require('../src/scheduler')

let server
let base

before(async () => {
  const app = createApp()
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
    server.on('error', reject)
  })
  const port = server.address().port
  base = `http://127.0.0.1:${port}/shelfguard`
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`
})

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
})

async function login(testOpenid) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testOpenid })
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.ok(body.token)
  assert.equal(body.openid, testOpenid)
  return body
}

async function call(token, name, data) {
  const res = await fetch(`${base}/api/fn/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(data || {})
  })
  const body = await res.json()
  return { status: res.status, body }
}

test('文档库支持筛选、自增和聚合', async () => {
  const added = await db.collection('probe').add({
    data: {
      name: '特8烟酒',
      score: 80,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      location: null,
      nested: { flag: true }
    }
  })
  await db.collection('probe').add({
    data: {
      name: '其他店',
      score: 60,
      createdAt: new Date('2026-10-01T00:00:00.000Z')
    }
  })
  const _ = db.command
  const listed = await db.collection('probe').where(_.and(
    { createdAt: _.gte(new Date('2026-10-15T00:00:00.000Z')) },
    _.or([
      { name: db.RegExp({ regexp: '特8', options: 'i' }) },
      { name: '不存在' }
    ])
  )).get()
  assert.equal(listed.data.length, 1)
  assert.equal(listed.data[0]._id, added._id)

  const unlocated = await db.collection('probe').where(_.or([
    { location: null },
    { location: _.exists(false) }
  ])).get()
  assert.equal(unlocated.data.length, 2)

  await db.collection('probe').doc(added._id).update({ data: { score: _.inc(5) } })
  const again = await db.collection('probe').doc(added._id).get()
  assert.equal(again.data.score, 85)

  const agg = await db.collection('probe').aggregate()
    .match({ score: _.gte(70) })
    .group({ _id: null, avgScore: db.command.aggregate.avg('$score') })
    .end()
  assert.equal(agg.list[0].avgScore, 85)

  await db.collection('probe').doc(added._id).update({ data: { tags: ['a', 'b'] } })
  const tagged = await db.collection('probe').where({ tags: _.in(['b', 'z']) }).get()
  assert.equal(tagged.data.length, 1)
})

test('定时任务时刻判断', () => {
  const morning = { year: '2026', month: '11', day: '02', hour: 3, minute: 0, second: 0 }
  const jobs = decideJobs(morning, { lastBatch: '', lastJxc: '', lastStats: '' })
  assert.deepEqual(jobs.map(job => job.name), ['batchAnalyze', 'syncJxc', 'shelfStats'])
  const again = decideJobs(morning, {
    lastBatch: '2026-11-02T03:00',
    lastJxc: '2026-11-02T03:00',
    lastStats: '2026-11-02'
  })
  assert.equal(again.length, 0)
  const later = decideJobs(
    { year: '2026', month: '11', day: '02', hour: 21, minute: 2, second: 10 },
    { lastBatch: '', lastJxc: '', lastStats: '2026-11-02' }
  )
  assert.deepEqual(later.map(job => job.name), ['batchAnalyze'])
})

test('登录、审批、巡检、照片和看板主路径', async () => {
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  const healthBody = await health.json()
  assert.equal(healthBody.ok, true)

  const anonymous = await fetch(`${base}/api/fn/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get' })
  })
  assert.equal(anonymous.status, 401)

  const adminLogin = await login('admin001')
  assert.equal(adminLogin.userInfo.role, 'sales')
  assert.equal(adminLogin.userInfo.approved, false)

  const denied = await call(adminLogin.token, 'submitInspection', {
    taskName: '陈列检查',
    storeName: '无门店',
    userName: '张三',
    fileIDs: ['sg://inspections/admin001/a.jpg'],
    location: { latitude: 30.1, longitude: 120.1, address: '测试路' }
  })
  assert.equal(denied.body.success, false)
  assert.equal(denied.body.code, 'NOT_APPROVED')

  const beforeActivate = await call(adminLogin.token, 'settings', { action: 'get' })
  assert.equal(beforeActivate.body.hasAdmin, false)
  assert.equal(beforeActivate.body.canEdit, false)

  const badCode = await call(adminLogin.token, 'settings', { action: 'activateAdmin', code: 'wrong' })
  assert.equal(badCode.body.success, false)

  const activated = await call(adminLogin.token, 'settings', { action: 'activateAdmin', code: 'setup-code-8848' })
  assert.equal(activated.body.success, true)
  assert.equal(activated.body.role, 'admin')

  const again = await call(adminLogin.token, 'settings', { action: 'activateAdmin', code: 'setup-code-8848' })
  assert.equal(again.body.success, false)

  const settings = await call(adminLogin.token, 'settings', { action: 'get' })
  assert.equal(settings.body.canEdit, true)
  assert.equal(settings.body.hasAdmin, true)
  assert.equal(settings.body.settings.analyzeMode, 'batch')

  const saved = await call(adminLogin.token, 'settings', {
    action: 'save',
    settings: { analyzeMode: 'batch', analyzeTime: '21:00', imageMode: 'traffic', windowMinutes: 180, batchSize: 1 }
  })
  assert.equal(saved.body.success, true)

  const customer = await call(adminLogin.token, 'customers', {
    action: 'add',
    customer: { storeName: '特8烟酒店', address: '文三路 1 号', contactName: '李四' }
  })
  assert.equal(customer.body.success, true)
  const customerId = customer.body._id

  const unlocated = await call(adminLogin.token, 'customers', {
    action: 'list',
    keyword: '特8',
    filterTag: 'unlocated'
  })
  assert.equal(unlocated.body.success, true)
  assert.equal(unlocated.body.list.length, 1)
  assert.equal(unlocated.body.scope, 'all')

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const cloudPath = `inspections/admin001/${Date.now()}-0-abc123.jpg`
  const form = new FormData()
  form.append('cloudPath', cloudPath)
  form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'a.jpg')
  const uploaded = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminLogin.token}` },
    body: form
  })
  const uploadedBody = await uploaded.json()
  assert.equal(uploaded.status, 200, JSON.stringify(uploadedBody))
  assert.equal(uploadedBody.fileID, `sg://${cloudPath}`)

  const stolen = new FormData()
  stolen.append('cloudPath', 'inspections/someoneelse/x.jpg')
  stolen.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'a.jpg')
  const stolenRes = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminLogin.token}` },
    body: stolen
  })
  assert.equal(stolenRes.status, 403)

  const submitted = await call(adminLogin.token, 'submitInspection', {
    taskName: '11月陈列检查',
    storeName: '特8烟酒店',
    userName: '张三',
    customerId,
    fileIDs: [uploadedBody.fileID],
    location: { latitude: 30.25, longitude: 120.16, address: '文三路 1 号' }
  })
  assert.equal(submitted.body.success, true, JSON.stringify(submitted.body))
  const inspectionId = submitted.body.inspectionId

  const located = await call(adminLogin.token, 'customers', {
    action: 'get',
    customerId
  })
  assert.equal(located.body.customer.location.latitude, 30.25)

  const history = await call(adminLogin.token, 'getHistory', {
    action: 'list',
    page: 1,
    pageSize: 10,
    where: {}
  })
  assert.equal(history.body.success, true)
  assert.equal(history.body.list.length, 1)
  assert.ok(history.body.list[0].thumbnailURL)
  assert.ok(history.body.list[0].thumbnailURL.includes('v=thumb'))

  // 稳定时间桶签名：连续两次请求对同一文件返回完全一致的 URL，确保客户端强缓存命中
  const historyAgain = await call(adminLogin.token, 'getHistory', {
    action: 'list',
    page: 1,
    pageSize: 10,
    where: {}
  })
  assert.equal(historyAgain.body.list[0].thumbnailURL, history.body.list[0].thumbnailURL)

  const report = await call(adminLogin.token, 'getReport', { inspectionId })
  assert.equal(report.body.success, true)
  assert.equal(report.body.detail.photoURLs.length, 1)
  assert.equal(report.body.detail.photoThumbURLs.length, 1)
  assert.ok(report.body.detail.photoThumbURLs[0].includes('v=preview'))
  const photoUrl = new URL(report.body.detail.photoURLs[0])
  const photoRes = await fetch(`${base.replace(/\/shelfguard$/, '')}${photoUrl.pathname}${photoUrl.search}`)
  assert.equal(photoRes.status, 200)
  assert.match(photoRes.headers.get('cache-control') || '', /immutable/)
  const photoBuf = Buffer.from(await photoRes.arrayBuffer())
  assert.deepEqual(photoBuf, jpeg)

  // 变体鉴权校验：合法 v=thumb 放行，篡改 v 参数被拒
  const thumbUrl = new URL(history.body.list[0].thumbnailURL)
  const thumbRes = await fetch(`${base.replace(/\/shelfguard$/, '')}${thumbUrl.pathname}${thumbUrl.search}`)
  assert.equal(thumbRes.status, 200)
  const tamperedThumbRes = await fetch(`${base.replace(/\/shelfguard$/, '')}${photoUrl.pathname}${photoUrl.search}&v=thumb`)
  assert.equal(tamperedThumbRes.status, 401)
  const badVariantRes = await fetch(`${base.replace(/\/shelfguard$/, '')}${photoUrl.pathname}${photoUrl.search}&v=huge`)
  assert.equal(badVariantRes.status, 404)

  const naked = await fetch(`${base}/files/${cloudPath}`)
  assert.equal(naked.status, 401)

  const salesLogin = await login('sales002')
  const peek = await call(salesLogin.token, 'getReport', { inspectionId })
  assert.equal(peek.body.success, false)
  const foreignCustomers = await call(salesLogin.token, 'customers', { action: 'list', keyword: '特8' })
  assert.equal(foreignCustomers.body.list.length, 0)
  const foreignWrite = await call(salesLogin.token, 'customers', {
    action: 'update',
    customerId,
    customer: { storeName: '被篡改' }
  })
  assert.equal(foreignWrite.body.success, false)

  const users = await call(adminLogin.token, 'users', { action: 'listUsers' })
  assert.equal(users.body.success, true)
  const salesRow = users.body.list.find(item => item.openidMasked.includes('002') || item.name === '')
  const sales = users.body.list.find(item => item.role === 'sales')
  assert.ok(sales)
  assert.equal(sales.approved, false)
  assert.equal(sales.openidMasked.includes('sales002'), false)

  const approved = await call(adminLogin.token, 'users', {
    action: 'setApproved',
    targetId: sales._id,
    approved: true
  })
  assert.equal(approved.body.success, true)

  const own = await call(salesLogin.token, 'customers', {
    action: 'add',
    customer: { storeName: '沿街小店', address: '学校门口' }
  })
  assert.equal(own.body.success, true)
  const salesCustomerId = own.body._id

  // 管理员协访业务员名下门店：保留 customerId 关联并自动回填门店坐标
  const adminVisitSalesCust = await call(adminLogin.token, 'submitInspection', {
    taskName: '主管协访',
    storeName: '沿街小店',
    userName: '张三',
    customerId: salesCustomerId,
    fileIDs: [uploadedBody.fileID],
    location: { latitude: 30.28, longitude: 120.18, address: '学校门口 88 号' }
  })
  assert.equal(adminVisitSalesCust.body.success, true)
  const adminVisitRep = await call(adminLogin.token, 'getReport', {
    inspectionId: adminVisitSalesCust.body.inspectionId
  })
  assert.equal(adminVisitRep.body.detail.customerId, salesCustomerId)
  const salesCustAfter = await call(salesLogin.token, 'customers', {
    action: 'get',
    customerId: salesCustomerId
  })
  assert.equal(salesCustAfter.body.customer.location.latitude, 30.28)

  // 服务端按距离排序：离 (30.28, 120.18) 更近的「沿街小店」排在「特8烟酒店」(30.25, 120.16) 前面
  const nearSorted = await call(adminLogin.token, 'customers', {
    action: 'list',
    lat: 30.2801,
    lng: 120.1801
  })
  assert.equal(nearSorted.body.success, true)
  assert.equal(nearSorted.body.list[0]._id, salesCustomerId)
  assert.ok(nearSorted.body.list[0].distanceText)

  const product = await call(adminLogin.token, 'products', {
    action: 'add',
    product: { brandName: '特8', productLine: '经典', aliases: ['Te8'] }
  })
  assert.equal(product.body.success, true)
  const productList = await call(salesLogin.token, 'products', { action: 'list' })
  assert.equal(productList.body.list.length, 1)
  assert.equal(productList.body.list[0].brandName, '特8')
  const productDenied = await call(salesLogin.token, 'products', {
    action: 'add',
    product: { brandName: '不该成功' }
  })
  assert.equal(productDenied.body.success, false)

  // 验证广告物料库与门店物料覆盖统计
  const matAdded = await call(adminLogin.token, 'products', {
    action: 'addMaterial',
    material: {
      materialName: '永丰特8方形红灯箱',
      category: '灯箱',
      aliases: ['特8红灯箱'],
      visualFeatures: '红底金字方形亚克力发光灯箱'
    }
  })
  assert.equal(matAdded.body.success, true)
  const matList = await call(salesLogin.token, 'products', { action: 'listMaterials' })
  assert.equal(matList.body.success, true)
  assert.equal(matList.body.list.length, 1)
  assert.equal(matList.body.list[0].materialName, '永丰特8方形红灯箱')

  // 模拟门店巡检报告中识别到广告物料，校验 materialStats 覆盖统计
  await db.collection('inspections').doc(inspectionId).update({
    data: {
      aiReport: {
        score: 86,
        scoreLevel: '优秀',
        summary: '陈列良好',
        adMaterials: [{ name: '特8红灯箱', category: '灯箱', count: 1, condition: '完好' }]
      }
    }
  })
  const matStats = await call(adminLogin.token, 'shelfStats', { action: 'materialStats' })
  assert.equal(matStats.body.success, true)
  assert.equal(matStats.body.totalStores, 2)
  assert.equal(matStats.body.coveredStores, 1)
  assert.equal(matStats.body.materials[0].materialName, '永丰特8方形红灯箱')
  assert.equal(matStats.body.materials[0].storeCount, 1)
  assert.equal(matStats.body.materials[0].missingStoreCount, 1)

  const geo = await call(salesLogin.token, 'geocode', { lat: 30.25, lng: 120.16 })
  assert.equal(geo.body.success, false)
  assert.equal(geo.body.reason, 'NO_KEY')
  const badGeo = await call(salesLogin.token, 'geocode', { lat: 0, lng: 0 })
  assert.equal(badGeo.body.reason, 'PARAM_INVALID')

  const rebuilt = await call(adminLogin.token, 'shelfStats', { action: 'rebuild' })
  assert.equal(rebuilt.body.success, true, JSON.stringify(rebuilt.body))
  const dash = await call(adminLogin.token, 'shelfStats', { action: 'dashboard' })
  assert.equal(dash.body.success, true)
  assert.equal(dash.body.isManager, true)

  const analyzed = await call(adminLogin.token, 'analyzeImage', { inspectionId })
  assert.equal(analyzed.body.success, false)
  assert.match(analyzed.body.error, /API Key/)

  const retried = await call(adminLogin.token, 'settings', { action: 'retryFailed' })
  assert.equal(retried.body.success, true)
  assert.ok(retried.body.updated >= 1)

  const pending = await call(adminLogin.token, 'getReport', { inspectionId })
  assert.equal(pending.body.detail.status, 'pending')

  const orphans = await call(adminLogin.token, 'settings', {
    action: 'cleanupOrphans',
    dryRun: true,
    fileIDs: [uploadedBody.fileID, 'sg://inspections/admin001/not-really-there.jpg']
  })
  assert.equal(orphans.body.success, true)
  assert.equal(orphans.body.orphanCount, 1)

  const removed = await call(adminLogin.token, 'settings', {
    action: 'cleanupOrphans',
    fileIDs: ['sg://inspections/admin001/not-really-there.jpg']
  })
  assert.equal(removed.body.success, true)
  assert.equal(removed.body.deleted, 1)

  // 验证内部只读接口：未配置 INTERNAL_API_KEY 时 503，配置后错误密钥 401，正确密钥返回巡检汇总
  const noKeyRes = await fetch(`${base}/api/internal/overview`)
  assert.equal(noKeyRes.status, 503)

  process.env.INTERNAL_API_KEY = 'internal-test-secret-key-2026'
  const badKeyRes = await fetch(`${base}/api/internal/overview`, {
    headers: { Authorization: 'Bearer wrong-key' }
  })
  assert.equal(badKeyRes.status, 401)

  const ovRes = await fetch(`${base}/api/internal/overview?days=30`, {
    headers: { Authorization: 'Bearer internal-test-secret-key-2026' }
  })
  assert.equal(ovRes.status, 200)
  const ovBody = await ovRes.json()
  assert.equal(ovBody.success, true)
  assert.ok(ovBody.totals.inspectionCount >= 1)

  const csRes = await fetch(`${base}/api/internal/customer-summary?storeName=${encodeURIComponent('特8烟酒店')}&days=90`, {
    headers: { 'X-Internal-Key': 'internal-test-secret-key-2026' }
  })
  assert.equal(csRes.status, 200)
  const csBody = await csRes.json()
  assert.equal(csBody.success, true)
  assert.ok(csBody.summary.visitCount >= 1)
  assert.ok(csBody.recentInspections[0].thumbnailURL.includes('/files/'))

  // 验证网页拜访地图接口：未配置 WEB_MAP_PASSWORD 时拒绝访问(503)，仅接受 x-map-key 请求头
  delete process.env.WEB_MAP_PASSWORD
  const mapNoPassRes = await fetch(`${base}/api/web/map-route`)
  assert.equal(mapNoPassRes.status, 503)

  process.env.WEB_MAP_PASSWORD = 'map-secret-pass-2026'
  const mapQueryPassRes = await fetch(`${base}/api/web/map-route?key=map-secret-pass-2026`)
  assert.equal(mapQueryPassRes.status, 401)

  const mapOkRes = await fetch(`${base}/api/web/map-route`, {
    headers: { 'x-map-key': 'map-secret-pass-2026' }
  })
  assert.equal(mapOkRes.status, 200)
  const mapOkBody = await mapOkRes.json()
  assert.equal(mapOkBody.success, true)

  // 验证网页端导出 Excel/CSV 台账接口（当日明细 + 当月汇总）
  const exportUnauth = await fetch(`${base}/api/web/export-ledger?scope=day`)
  assert.equal(exportUnauth.status, 401)

  const exportDayRes = await fetch(`${base}/api/web/export-ledger?scope=day`, {
    headers: { 'x-map-key': 'map-secret-pass-2026' }
  })
  assert.equal(exportDayRes.status, 200)
  assert.match(exportDayRes.headers.get('content-type') || '', /text\/csv/)
  const exportDayBuf = Buffer.from(await exportDayRes.arrayBuffer())
  // UTF-8 BOM: EF BB BF (Fetch res.text() 会按规范剥离 BOM，因此用 arrayBuffer 校验原始字节)
  assert.equal(exportDayBuf[0], 0xef)
  assert.equal(exportDayBuf[1], 0xbb)
  assert.equal(exportDayBuf[2], 0xbf)
  const exportDayCsv = exportDayBuf.toString('utf8')
  assert.ok(exportDayCsv.includes('特8烟酒店'))

  const exportMonthRes = await fetch(`${base}/api/web/export-ledger?scope=month`, {
    headers: { 'x-map-key': 'map-secret-pass-2026' }
  })
  assert.equal(exportMonthRes.status, 200)
  const exportMonthCsv = await exportMonthRes.text()
  assert.ok(exportMonthCsv.includes('月度人员考勤与拜访汇总表'))
  assert.ok(exportMonthCsv.includes('每日考勤与拜访明细台账'))

  // 验证管理者 getHistory 返回 salesUsers 供胶囊选择器使用，以及排面看板 lowVisitCustomers 携带 userName
  const mgrStats = await call(adminLogin.token, 'getHistory', { action: 'stats' })
  assert.equal(mgrStats.body.success, true)
  assert.ok(Array.isArray(mgrStats.body.salesUsers))
  assert.ok(mgrStats.body.salesUsers.includes('张三'))
  assert.ok(dash.body.overall.lowVisitCustomers.some(c => c.userName === '张三'))

  // 验证 docdb _.nin 指令及 manager 角色打卡后调用 getHistory（屏蔽 admin 记录但不报错）
  assert.equal(db._internal.matchQuery({ _openid: 'u1', tags: ['a', 'b'] }, { _openid: db.command.nin(['admin1']) }), true)
  assert.equal(db._internal.matchQuery({ _openid: 'admin1' }, { _openid: db.command.nin(['admin1']) }), false)
  assert.equal(db._internal.matchQuery({ tags: ['a', 'b'] }, { tags: db.command.nin(['b']) }), false)
  assert.equal(db._internal.matchQuery({}, { _openid: db.command.nin(['admin1']) }), true)

  const mgrLogin = await login('manager001')
  const mgrUsers = await call(adminLogin.token, 'users', { action: 'listUsers' })
  const mgrRow = mgrUsers.body.list.find(item => item.openidMasked === 'man****001')
  assert.ok(mgrRow)
  assert.equal((await call(adminLogin.token, 'users', {
    action: 'setRole',
    targetId: mgrRow._id,
    role: 'manager'
  })).body.success, true)
  assert.equal((await call(mgrLogin.token, 'login', {
    action: 'update',
    userInfo: { name: '王经理' }
  })).body.success, true)

  const mgrCloudPath = `inspections/manager001/${Date.now()}-clock.jpg`
  const mgrForm = new FormData()
  mgrForm.append('cloudPath', mgrCloudPath)
  mgrForm.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'clock.jpg')
  const mgrUploaded = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrLogin.token}` },
    body: mgrForm
  })
  const mgrUploadedBody = await mgrUploaded.json()
  assert.equal(mgrUploaded.status, 200, JSON.stringify(mgrUploadedBody))

  const mgrClock = await call(mgrLogin.token, 'submitInspection', {
    recordType: 'clock_in',
    taskName: '考勤打卡：上班打卡',
    storeName: '上班打卡',
    userName: '王经理',
    customerId: '',
    fileIDs: [mgrUploadedBody.fileID],
    location: { latitude: 30.26, longitude: 120.17, address: '公司门口' }
  })
  assert.equal(mgrClock.body.success, true, JSON.stringify(mgrClock.body))

  const mgrHistList = await call(mgrLogin.token, 'getHistory', { action: 'list', page: 1, pageSize: 50 })
  assert.equal(mgrHistList.status, 200)
  assert.equal(mgrHistList.body.success, true, JSON.stringify(mgrHistList.body))
  assert.ok(mgrHistList.body.list.some(it => it._id === mgrClock.body.inspectionId && it.recordType === 'clock_in'))
  assert.equal(mgrHistList.body.list.some(it => it._id === inspectionId), false)

  const mgrHistStats = await call(mgrLogin.token, 'getHistory', { action: 'stats' })
  assert.equal(mgrHistStats.body.success, true)
  assert.equal(mgrHistStats.body.salesUsers.includes('张三'), false)

  const mgrMapRoute = await call(mgrLogin.token, 'getHistory', { action: 'mapRoute' })
  assert.equal(mgrMapRoute.body.success, true)
  assert.equal(mgrMapRoute.body.points.some(p => p._id === inspectionId), false)

  assert.ok(salesRow || sales)
})
