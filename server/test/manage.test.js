'use strict'

// 「管理」改版相关：首次填姓名 / 姓名锁定、管理员改姓名与绑定进销存、
// 进销存同步按绑定匹配并标记未分配客户、拍照上传策略全员统一。

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfguard-manage-'))
process.env.DATA_DIR = tmp
process.env.JWT_SECRET = 'test-jwt-secret-please-change'
process.env.ADMIN_SETUP_CODE = 'setup-code-8848'
process.env.SHELFGUARD_TEST_LOGIN = '1'
process.env.DISABLE_CRON = '1'
process.env.BASE_PATH = '/shelfguard'
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1'
process.env.WECHAT_APPID = ''
process.env.WECHAT_SECRET = ''
delete process.env.JXC_BASE_URL
delete process.env.JXC_API_KEY

const { createApp } = require('../src/app')

let server
let base
let jxcServer
let jxcBase
let jxcItems = []

before(async () => {
  const app = createApp()
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
    server.on('error', reject)
  })
  base = `http://127.0.0.1:${server.address().port}/shelfguard`

  jxcServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ items: jxcItems, total_pages: 1 }))
  })
  await new Promise(resolve => jxcServer.listen(0, '127.0.0.1', resolve))
  jxcBase = `http://127.0.0.1:${jxcServer.address().port}`
})

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  if (jxcServer) await new Promise(resolve => jxcServer.close(resolve))
})

async function login(testOpenid) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testOpenid })
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  return body
}

async function call(token, name, data) {
  const res = await fetch(`${base}/api/fn/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data || {})
  })
  return { status: res.status, body: await res.json() }
}

test('姓名、绑定、未分配客户与拍照上传策略', async () => {
  const admin = await login('admin_m01')
  assert.equal((await call(admin.token, 'settings', { action: 'activateAdmin', code: 'setup-code-8848' })).body.success, true)

  // 管理员自己可以填 / 改姓名
  const adminName = await call(admin.token, 'login', { action: 'update', userInfo: { name: '  老板  ' } })
  assert.equal(adminName.body.success, true)
  assert.equal(adminName.body.userInfo.name, '老板')
  assert.equal((await call(admin.token, 'login', { action: 'update', userInfo: { name: '胡总' } })).body.success, true)

  // 业务员首次填姓名：空的 / 太长的被拒
  const s1 = await login('sales_m01')
  assert.equal((await call(s1.token, 'login', {})).body.userInfo.name, '')
  assert.equal((await call(s1.token, 'login', { action: 'update', userInfo: { name: '   ' } })).body.success, false)
  assert.equal((await call(s1.token, 'login', { action: 'update', userInfo: { name: '一'.repeat(21) } })).body.success, false)
  const first = await call(s1.token, 'login', { action: 'update', userInfo: { name: '张 三' } })
  assert.equal(first.body.success, true)

  // 填过以后业务员不能自己改（旧版前端的设置面板也走这里）
  const locked = await call(s1.token, 'login', { action: 'update', userInfo: { name: '李四' } })
  assert.equal(locked.body.success, false)
  assert.equal(locked.body.nameLocked, true)
  assert.equal((await call(s1.token, 'login', {})).body.userInfo.name, '张 三')
  // 同名重复提交不算改名
  assert.equal((await call(s1.token, 'login', { action: 'update', userInfo: { name: '张 三' } })).body.success, true)

  const s2 = await login('sales_m02')
  await call(s2.token, 'login', { action: 'update', userInfo: { name: '王五' } })
  const s3 = await login('sales_m03')
  await call(s3.token, 'login', { action: 'update', userInfo: { name: '王五' } }) // 和 s2 重名

  // 业务员不能调用管理动作
  const users = await call(admin.token, 'users', { action: 'listUsers' })
  assert.equal(users.body.success, true)
  const row = name => users.body.list.filter(u => u.name === name)
  assert.equal(row('胡总')[0].isMe, true)
  const s1Row = row('张 三')[0]
  const s2Row = row('王五').find(u => u.openidMasked.endsWith('m02'))
  const s3Row = row('王五').find(u => u.openidMasked.endsWith('m03'))
  assert.ok(s1Row && s2Row && s3Row)
  assert.equal((await call(s1.token, 'users', { action: 'setName', targetId: s1Row._id, name: '李四' })).body.success, false)
  assert.equal((await call(s1.token, 'users', { action: 'setJxcBinding', targetId: s1Row._id, jxcOperatorName: 'x' })).body.success, false)
  assert.equal((await call(s1.token, 'customers', { action: 'listUnassigned' })).body.success, false)

  // 管理员改姓名（含校验）
  assert.equal((await call(admin.token, 'users', { action: 'setName', targetId: s1Row._id, name: '' })).body.success, false)
  const renamed = await call(admin.token, 'users', { action: 'setName', targetId: s1Row._id, name: '张三' })
  assert.equal(renamed.body.success, true)
  assert.equal(renamed.body.updated, true)
  assert.equal((await call(s1.token, 'login', {})).body.userInfo.name, '张三')

  // 进销存同步：张三按姓名、王五重名 → 未分配、赵六没人 → 未分配
  await call(admin.token, 'settings', { action: 'save', settings: { jxcBaseUrl: jxcBase, jxcApiKey: 'test-key-123456' } })
  jxcItems = [
    { id: 1, name: '一号店', operator_name: '张三', operator_username: '' },
    { id: 2, name: '二号店', operator_name: '王五', operator_username: '' },
    { id: 3, name: '三号店', operator_name: '赵六', operator_username: '' }
  ]
  const sync1 = await call(admin.token, 'syncJxcCustomers', { manual: true })
  assert.equal(sync1.body.success, true, JSON.stringify(sync1.body))
  assert.equal(sync1.body.summary.added, 3)

  const s1Customers = await call(s1.token, 'customers', { action: 'list' })
  assert.deepEqual(s1Customers.body.list.map(c => c.storeName), ['一号店'])
  assert.equal(s1Customers.body.list[0].jxcOperatorName, '张三')

  let un = await call(admin.token, 'customers', { action: 'listUnassigned' })
  assert.equal(un.body.success, true)
  assert.deepEqual(un.body.list.map(c => c.storeName).sort(), ['三号店', '二号店'])
  assert.equal(un.body.pendingSync, 0)
  const mgrView = un.body.list.find(c => c.storeName === '三号店')
  assert.equal(mgrView.jxcOperatorName, '赵六')

  // 手动绑定：s2 绑定「王五」、s3 绑定「赵六」，下次同步就分过去
  assert.equal((await call(admin.token, 'users', { action: 'setJxcBinding', targetId: s2Row._id, jxcOperatorName: '王五' })).body.success, true)
  assert.equal((await call(admin.token, 'users', { action: 'setJxcBinding', targetId: s3Row._id, jxcOperatorName: '赵六' })).body.success, true)
  const sync2 = await call(admin.token, 'syncJxcCustomers', { manual: true })
  assert.equal(sync2.body.success, true)
  assert.deepEqual((await call(s2.token, 'customers', { action: 'list' })).body.list.map(c => c.storeName), ['二号店'])
  assert.deepEqual((await call(s3.token, 'customers', { action: 'list' })).body.list.map(c => c.storeName), ['三号店'])
  un = await call(admin.token, 'customers', { action: 'listUnassigned' })
  assert.equal(un.body.total, 0)

  // 两个人绑了同一个名字：忽略绑定并警告，按姓名也重名 → 归管理员
  await call(admin.token, 'users', { action: 'setJxcBinding', targetId: s3Row._id, jxcOperatorName: '王五' })
  const sync3 = await call(admin.token, 'syncJxcCustomers', { manual: true })
  assert.ok(sync3.body.summary.warnings.some(w => w.includes('手动绑定')))
  un = await call(admin.token, 'customers', { action: 'listUnassigned' })
  assert.deepEqual(un.body.list.map(c => c.storeName).sort(), ['三号店', '二号店'])
  // 解除绑定
  assert.equal((await call(admin.token, 'users', { action: 'setJxcBinding', targetId: s3Row._id, jxcOperatorName: '' })).body.success, true)

  // 未分配客户分页：35 家没人对应 → 每页 30，共 2 页
  jxcItems = Array.from({ length: 35 }, (_, i) => ({ id: 100 + i, name: `无主店${i}`, operator_name: '查无此人', operator_username: '' }))
  assert.equal((await call(admin.token, 'syncJxcCustomers', { manual: true })).body.success, true)
  const p1 = await call(admin.token, 'customers', { action: 'listUnassigned', page: 1, limit: 30 })
  const p2 = await call(admin.token, 'customers', { action: 'listUnassigned', page: 2, limit: 30 })
  assert.ok(p1.body.total >= 35)
  assert.equal(p1.body.list.length, 30)
  assert.equal(p1.body.hasMore, true)
  assert.equal(p2.body.list.length, p1.body.total - 30)
  assert.equal(new Set([...p1.body.list, ...p2.body.list].map(c => c._id)).size, p1.body.total)

  // 拍照上传策略：只有管理员能改，所有人读到同一个值
  assert.equal((await call(s1.token, 'settings', { action: 'save', settings: { imageMode: 'quality' } })).body.success, false)
  assert.equal((await call(admin.token, 'settings', { action: 'save', settings: { imageMode: 'quality' } })).body.success, true)
  const s1Settings = await call(s1.token, 'settings', { action: 'get' })
  assert.equal(s1Settings.body.settings.imageMode, 'quality')
  assert.equal(s1Settings.body.canEdit, false)
  assert.equal(s1Settings.body.role, 'sales')
})
