'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('node:module')
const assert = require('node:assert/strict')
const { test, after } = require('node:test')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfguard-geo-'))
process.env.DATA_DIR = tmpDir

function createMemoryDocDb(dataDir) {
  const cols = new Map()
  const getCol = name => {
    if (!cols.has(name)) cols.set(name, new Map())
    return cols.get(name)
  }
  const clone = v => JSON.parse(JSON.stringify(v))
  const match = (doc, q) => {
    if (!q || typeof q !== 'object') return true
    return Object.keys(q).every(k => doc[k] === q[k])
  }
  return {
    serverDate: () => new Date(),
    command: {},
    collection(name) {
      return {
        where(query) {
          let _skip = 0
          let _limit = 100
          return {
            orderBy() { return this },
            skip(n) { _skip = n || 0; return this },
            limit(n) { _limit = n || 100; return this },
            async get() {
              const all = Array.from(getCol(name).values()).filter(d => match(d, query))
              return { data: all.slice(_skip, _skip + _limit).map(clone) }
            }
          }
        },
        async add({ data } = {}) {
          const id = (data && data._id) || `doc_${Math.random().toString(36).slice(2, 10)}`
          const doc = { ...clone(data || {}), _id: id }
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
              return { data: clone(found) }
            },
            async update({ data } = {}) {
              const found = getCol(name).get(id)
              if (!found) throw new Error('document does not exist')
              const next = { ...clone(found), ...clone(data || {}), _id: id }
              getCol(name).set(id, next)
              return { stats: { updated: 1 } }
            }
          }
        }
      }
    },
    _internal: {
      dataDir: () => dataDir,
      closeSqlite: () => {}
    }
  }
}

let db
let hasRealSqlite = false
try {
  require('node:sqlite')
  hasRealSqlite = true
} catch (_) {
  hasRealSqlite = false
}

const docdbAbs = require.resolve('../src/docdb.js')
const origLoad = Module._load
if (hasRealSqlite) {
  db = require('../src/docdb')
} else {
  db = createMemoryDocDb(tmpDir)
  Module._load = function (request, parent, isMain) {
    if (request === './docdb' || request === '../docdb') return db
    if (parent && parent.filename) {
      const resolved = request.startsWith('.') ? path.resolve(path.dirname(parent.filename), request) : ''
      if (resolved === docdbAbs || `${resolved}.js` === docdbAbs) return db
    }
    return origLoad.apply(this, arguments)
  }
}

const cloud = require('../src/cloud-shim')
const geocodeFn = require('../src/functions/geocode')
const submitInspection = require('../src/functions/submitInspection')
const {
  isValidCoord,
  gcj02ToWgs84,
  isCoordinateAddress
} = require('../src/utils/coord')
const {
  formatTiandituAddress,
  reverseGeocodeCoords
} = require('../src/utils/geocode-service')
const { backfillCustomerAddresses } = require('../scripts/backfill-customer-addresses')

if (!hasRealSqlite) {
  Module._load = origLoad
}

after(() => {
  db._internal.closeSqlite()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('gcj02ToWgs84 国内坐标做逆偏，境外坐标保持不变', () => {
  const hz = gcj02ToWgs84(30.25, 120.16)
  // 国内 GCJ-02 与 WGS-84 差值约 0.001°~0.007°（百米级）
  assert.ok(Math.abs(hz.lat - 30.25) > 0.001 && Math.abs(hz.lat - 30.25) < 0.01)
  assert.ok(Math.abs(hz.lng - 120.16) > 0.001 && Math.abs(hz.lng - 120.16) < 0.01)

  const bj = gcj02ToWgs84(39.908823, 116.39747)
  assert.ok(Math.abs(bj.lat - 39.908823) > 0.0005 && Math.abs(bj.lat - 39.908823) < 0.01)
  assert.ok(Math.abs(bj.lng - 116.39747) > 0.0005 && Math.abs(bj.lng - 116.39747) < 0.01)

  const tokyo = gcj02ToWgs84(35.6895, 139.6917)
  assert.equal(tokyo.lat, 35.6895)
  assert.equal(tokyo.lng, 139.6917)

  assert.equal(isValidCoord(0, 0), false)
  assert.equal(isValidCoord(30.25, 120.16), true)
})

test('isCoordinateAddress 正确区分纯坐标/空值与中文路名', () => {
  assert.equal(isCoordinateAddress(''), true)
  assert.equal(isCoordinateAddress('   '), true)
  assert.equal(isCoordinateAddress(null), true)
  assert.equal(isCoordinateAddress('30.250000, 120.160000'), true)
  assert.equal(isCoordinateAddress('-30.25,120.16'), true)
  assert.equal(isCoordinateAddress('文三路199号'), false)
  assert.equal(isCoordinateAddress('杭州市西湖区文三路 1 号'), false)
})

test('formatTiandituAddress 简洁地标/路名优先级与前缀裁剪正确', () => {
  assert.equal(
    formatTiandituAddress({
      formatted_address: '浙江省杭州市西湖区文三路199号创业大厦',
      addressComponent: {
        province: '浙江省',
        city: '杭州市',
        county: '西湖区',
        road: '文三路',
        address: '文三路199号',
        poi: '创业大厦'
      }
    }),
    '西湖区文三路199号(创业大厦)'
  )

  // 实测天地图常把完整省市区街道写进 address 和 poi，应自动去重裁掉省市前缀
  assert.equal(
    formatTiandituAddress({
      formatted_address: '浙江省杭州市西湖区翠苑街道古荡湾社区万塘路262号',
      addressComponent: {
        province: '浙江省',
        city: '杭州市',
        county: '西湖区',
        town: '翠苑街道',
        road: '华星路',
        address: '浙江省杭州市西湖区翠苑街道古荡湾社区万塘路262号',
        poi: '浙江省杭州市西湖区翠苑街道古荡湾社区万塘路262号'
      }
    }),
    '西湖区古荡湾社区万塘路262号'
  )

  assert.equal(
    formatTiandituAddress({
      formatted_address: '北京市西城区大红罗厂街31号',
      addressComponent: {
        road: '大红罗厂街',
        address: '31号',
        poi: ''
      }
    }),
    '大红罗厂街31号'
  )

  // address/poi 仅重复省市名（含省+市拼接如 "浙江省杭州市"）时，自动忽略并回落到 county + road
  assert.equal(
    formatTiandituAddress({
      formatted_address: '北京市',
      addressComponent: {
        province: '北京市',
        county: '东城区',
        town: '东华门街道',
        road: '外桥',
        address: '北京市',
        poi: '北京'
      }
    }),
    '东城区外桥'
  )

  assert.equal(
    formatTiandituAddress({
      formatted_address: '浙江省杭州市',
      addressComponent: {
        province: '浙江省',
        city: '杭州市',
        county: '西湖区',
        road: '文三路',
        address: '浙江省杭州市',
        poi: ''
      }
    }),
    '西湖区文三路'
  )

  assert.equal(
    formatTiandituAddress({
      formatted_address: '浙江省余姚市某乡镇街口',
      addressComponent: {}
    }),
    '浙江省余姚市某乡镇街口'
  )
})

test('reverseGeocodeCoords 优先天地图并在异常时过渡兜底腾讯地图', async () => {
  const seenRequests = []
  const tdtOk = await reverseGeocodeCoords(30.25, 120.16, {
    tiandituKey: 'tdt-test-key',
    tencentKey: 'tx-test-key',
    httpGet: async (url, cfg) => {
      seenRequests.push({ url, cfg })
      return {
        data: {
          status: '0',
          msg: 'ok',
          result: {
            formatted_address: '浙江省杭州市西湖区文三路199号华星时代广场',
            addressComponent: {
              road: '文三路',
              address: '文三路199号',
              poi: '华星时代广场'
            }
          }
        }
      }
    }
  })

  assert.equal(tdtOk.success, true)
  assert.equal(tdtOk.provider, 'tianditu')
  assert.equal(tdtOk.address, '文三路199号(华星时代广场)')
  assert.equal(seenRequests.length, 1)
  assert.match(seenRequests[0].url, /api\.tianditu\.gov\.cn\/geocoder/)
  assert.equal(seenRequests[0].cfg.headers['User-Agent'], 'ShelfGuard-Server/1.0')
  const sentPostStr = JSON.parse(seenRequests[0].cfg.params.postStr)
  assert.ok(sentPostStr.lat !== 30.25 && sentPostStr.lon !== 120.16)
  assert.ok(Math.abs(sentPostStr.lat - 30.25) < 0.01 && Math.abs(sentPostStr.lon - 120.16) < 0.01)

  // 天地图报错时自动兜底腾讯地图
  const fallbackRes = await reverseGeocodeCoords(30.25, 120.16, {
    tiandituKey: 'tdt-test-key',
    tencentKey: 'tx-test-key',
    httpGet: async (url) => {
      if (url.includes('tianditu.gov.cn')) {
        return { data: { status: '404', msg: 'invalid key' } }
      }
      return {
        data: {
          status: 0,
          result: {
            formatted_addresses: { recommend: '文三路华星时代广场东门' }
          }
        }
      }
    }
  })
  assert.equal(fallbackRes.success, true)
  assert.equal(fallbackRes.provider, 'tencent')
  assert.equal(fallbackRes.fallbackFrom, 'tianditu')
  assert.equal(fallbackRes.address, '文三路华星时代广场东门')

  // 无腾讯兜底时优雅退回坐标串
  const tdtFailNoFallback = await reverseGeocodeCoords(30.25, 120.16, {
    tiandituKey: 'tdt-test-key',
    tencentKey: '',
    httpGet: async () => ({ data: { status: '1', msg: 'quota exceeded' } })
  })
  assert.equal(tdtFailNoFallback.success, false)
  assert.equal(tdtFailNoFallback.address, '30.250000, 120.160000')
  assert.match(tdtFailNoFallback.reason, /TIANDITU_API_ERROR/)

  // 天地图返回 status=0 但无任何可读地址时，标为失败并自动触发腾讯兜底
  const emptyFallback = await reverseGeocodeCoords(30.25, 120.16, {
    tiandituKey: 'tdt-test-key',
    tencentKey: 'tx-test-key',
    httpGet: async (url) => {
      if (url.includes('tianditu.gov.cn')) {
        return { data: { status: '0', msg: 'ok', result: {} } }
      }
      return {
        data: {
          status: 0,
          result: { formatted_addresses: { recommend: '腾讯兜底地址' } }
        }
      }
    }
  })
  assert.equal(emptyFallback.success, true)
  assert.equal(emptyFallback.provider, 'tencent')
  assert.equal(emptyFallback.address, '腾讯兜底地址')

  // HTTP 403/5xx 错误响应体中的 code/msg 应保留在 reason 中便于排障
  const http403Res = await reverseGeocodeCoords(30.25, 120.16, {
    tiandituKey: 'tdt-test-key',
    tencentKey: '',
    httpGet: async () => {
      const err = new Error('Request failed with status code 403')
      err.response = { status: 403, data: { code: 301013, msg: '权限类型错误' } }
      throw err
    }
  })
  assert.equal(http403Res.success, false)
  assert.match(http403Res.reason, /301013:权限类型错误/)

  // 未配置任何 Key 返回 NO_KEY
  const noKey = await reverseGeocodeCoords(30.25, 120.16, {
    tiandituKey: '',
    tencentKey: ''
  })
  assert.equal(noKey.success, false)
  assert.equal(noKey.reason, 'NO_KEY')
})

test('geocode 云函数入参校验、停用拦截与无 Key 降级正常', async () => {
  await db.collection('users').add({
    data: { _openid: 'geo_disabled', role: 'sales', disabled: true, approved: true }
  })
  await db.collection('users').add({
    data: { _openid: 'geo_active', role: 'sales', disabled: false, approved: true }
  })

  const noOpenid = await geocodeFn.main({ lat: 30.25, lng: 120.16 })
  assert.equal(noOpenid.reason, 'NO_OPENID')

  await cloud.runWithContext({ openid: 'geo_disabled' }, async () => {
    const dis = await geocodeFn.main({ lat: 30.25, lng: 120.16 })
    assert.equal(dis.reason, 'DISABLED')
  })

  const prevTdt = process.env.TIANDITU_KEY
  const prevTx = process.env.TENCENT_MAP_KEY
  delete process.env.TIANDITU_KEY
  delete process.env.TENCENT_MAP_KEY
  try {
    await cloud.runWithContext({ openid: 'geo_active' }, async () => {
      const bad = await geocodeFn.main({ lat: 0, lng: 0 })
      assert.equal(bad.reason, 'PARAM_INVALID')

      const noKey = await geocodeFn.main({ lat: 30.25, lng: 120.16 })
      assert.equal(noKey.success, false)
      assert.equal(noKey.reason, 'NO_KEY')
      assert.equal(noKey.address, '30.250000, 120.160000')
    })
  } finally {
    if (prevTdt !== undefined) process.env.TIANDITU_KEY = prevTdt
    if (prevTx !== undefined) process.env.TENCENT_MAP_KEY = prevTx
  }
})

test('submitInspection 对已有坐标但地址为纯坐标的老客户自动自愈补全，且绝不改动经纬度', async () => {
  await db.collection('users').add({
    data: {
      _openid: 'sales_geo_1',
      role: 'sales',
      approved: true,
      disabled: false,
      name: '小李'
    }
  })

  const custCoordOnly = await db.collection('customers').add({
    data: {
      _openid: 'sales_geo_1',
      storeName: '坐标老店',
      location: { latitude: 30.25, longitude: 120.16, address: '30.250000, 120.160000' },
      isActive: true,
      createdAt: db.serverDate()
    }
  })

  const custValidAddr = await db.collection('customers').add({
    data: {
      _openid: 'sales_geo_1',
      storeName: '中文老店',
      location: { latitude: 30.28, longitude: 120.18, address: '老腾讯地址' },
      isActive: true,
      createdAt: db.serverDate()
    }
  })

  await cloud.runWithContext({ openid: 'sales_geo_1' }, async () => {
    // 1) 异地补传（距离 > 500m，此处约 14km）绝不把异地地址写进老门店
    const resFar = await submitInspection.main({
      taskName: '日常巡检',
      storeName: '坐标老店',
      customerId: custCoordOnly._id,
      fileIDs: ['sg://inspections/sales_geo_1/far.jpg'],
      location: { latitude: 30.35, longitude: 120.26, address: '十公里外的异地地址' }
    })
    assert.equal(resFar.success, true)
  })
  const afterFar = (await db.collection('customers').doc(custCoordOnly._id).get()).data
  assert.equal(afterFar.location.address, '30.250000, 120.160000')

  await cloud.runWithContext({ openid: 'sales_geo_1' }, async () => {
    // 2) 门店现场（距离 <= 500m，此处约 180m）自动补全老门店地址，且不改原经纬度
    const res1 = await submitInspection.main({
      taskName: '日常巡检',
      storeName: '坐标老店',
      customerId: custCoordOnly._id,
      fileIDs: ['sg://inspections/sales_geo_1/a.jpg'],
      location: { latitude: 30.251234, longitude: 120.161234, address: '文三路199号(创业大厦)' }
    })
    assert.equal(res1.success, true)

    const res2 = await submitInspection.main({
      taskName: '日常巡检',
      storeName: '中文老店',
      customerId: custValidAddr._id,
      fileIDs: ['sg://inspections/sales_geo_1/b.jpg'],
      location: { latitude: 30.281234, longitude: 120.181234, address: '新天地图地址' }
    })
    assert.equal(res2.success, true)
  })

  const afterCoordOnly = (await db.collection('customers').doc(custCoordOnly._id).get()).data
  assert.equal(afterCoordOnly.location.latitude, 30.25)
  assert.equal(afterCoordOnly.location.longitude, 120.16)
  assert.equal(afterCoordOnly.location.address, '文三路199号(创业大厦)')

  const afterValidAddr = (await db.collection('customers').doc(custValidAddr._id).get()).data
  assert.equal(afterValidAddr.location.latitude, 30.28)
  assert.equal(afterValidAddr.location.longitude, 120.18)
  assert.equal(afterValidAddr.location.address, '老腾讯地址')
})

test('backfillCustomerAddresses 仅补全缺地址/纯坐标老客户并保持经纬度不变', async () => {
  const cEmpty = await db.collection('customers').add({
    data: {
      _openid: 'sales_geo_2',
      storeName: '无地址老店',
      location: { latitude: 30.3, longitude: 120.2, address: '' },
      isActive: true,
      createdAt: db.serverDate()
    }
  })
  const cUnlocated = await db.collection('customers').add({
    data: {
      _openid: 'sales_geo_2',
      storeName: '未定位店',
      location: null,
      isActive: true,
      createdAt: db.serverDate()
    }
  })

  const seenProviders = []
  const mockGeocode = async (lat, lng, opts) => {
    seenProviders.push(opts && opts.provider)
    return {
      success: true,
      address: `天地图路${lat.toFixed(2)}-${lng.toFixed(2)}`,
      provider: 'tianditu'
    }
  }

  const drySummary = await backfillCustomerAddresses(db, {
    apply: false,
    mode: 'missing',
    delayMs: 0,
    geocodeFn: mockGeocode,
    logger: { warn: () => {} }
  })
  assert.equal(drySummary.candidates, 1)
  assert.equal(drySummary.wouldUpdate, 1)
  assert.equal(drySummary.updated, 0)

  const beforeApply = (await db.collection('customers').doc(cEmpty._id).get()).data
  assert.equal(beforeApply.location.address, '')

  const applySummary = await backfillCustomerAddresses(db, {
    apply: true,
    mode: 'missing',
    delayMs: 0,
    geocodeFn: mockGeocode,
    logger: { warn: () => {} }
  })
  assert.equal(applySummary.candidates, 1)
  assert.equal(applySummary.updated, 1)

  const afterApply = (await db.collection('customers').doc(cEmpty._id).get()).data
  assert.equal(afterApply.location.latitude, 30.3)
  assert.equal(afterApply.location.longitude, 120.2)
  assert.equal(afterApply.location.address, '天地图路30.30-120.20')

  const afterUnlocated = (await db.collection('customers').doc(cUnlocated._id).get()).data
  assert.equal(afterUnlocated.location, null)
  assert.deepEqual(seenProviders, ['tianditu', 'tianditu'])
})
