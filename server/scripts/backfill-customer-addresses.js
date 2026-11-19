#!/usr/bin/env node
'use strict'

/**
 * 存量已定位客户地址过渡补刷脚本
 *
 * 设计原则：
 * - 绝不修改已有客户的 location.latitude / location.longitude（保持 GCJ-02 零偏移）。
 * - 默认仅预览 (--dry-run) 且只处理缺地址或纯坐标文本的老客户 (--mode missing)。
 * - 若想统一全库地址文本风格，可显式传 --mode all --apply。
 *
 * 用法：
 *   node server/scripts/backfill-customer-addresses.js --dry-run
 *   node server/scripts/backfill-customer-addresses.js --apply
 *   node server/scripts/backfill-customer-addresses.js --mode all --apply --delay 300
 */

const fs = require('fs')
const path = require('path')
const { isValidCoord, isCoordinateAddress } = require('../src/utils/coord')
const { reverseGeocodeCoords } = require('../src/utils/geocode-service')

function loadEnvFile() {
  const file = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value
  })
}

function parseArgs(argv) {
  const args = {
    apply: false,
    mode: 'missing', // 'missing' | 'all'
    delayMs: 250,
    limit: 0,
    allowFallback: false
  }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--apply') args.apply = true
    else if (token === '--dry-run') args.apply = false
    else if (token === '--allow-fallback') args.allowFallback = true
    else if (token === '--mode' && argv[i + 1]) {
      const m = argv[++i]
      if (m === 'missing' || m === 'all') args.mode = m
    } else if (token === '--delay' && argv[i + 1]) {
      const d = parseInt(argv[++i], 10)
      if (Number.isFinite(d) && d >= 0) args.delayMs = d
    } else if (token === '--limit' && argv[i + 1]) {
      const l = parseInt(argv[++i], 10)
      if (Number.isFinite(l) && l > 0) args.limit = l
    }
  }
  return args
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function listLocatedCustomers(db) {
  const pageSize = 200
  let skip = 0
  const all = []
  while (true) {
    const res = await db.collection('customers')
      .where({ isActive: true })
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(pageSize)
      .get()
    const rows = res.data || []
    all.push(...rows)
    if (rows.length < pageSize) break
    skip += rows.length
  }
  return all
}

async function backfillCustomerAddresses(db, options = {}) {
  const apply = !!options.apply
  const mode = options.mode === 'all' ? 'all' : 'missing'
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 250
  const limit = Number.isFinite(options.limit) ? options.limit : 0
  const geocodeFn = options.geocodeFn || reverseGeocodeCoords
  const logger = options.logger || console

  const customers = await listLocatedCustomers(db)
  const summary = {
    totalActive: customers.length,
    located: 0,
    candidates: 0,
    skippedValid: 0,
    updated: 0,
    wouldUpdate: 0,
    failed: 0,
    samples: []
  }

  const targets = []
  for (const cust of customers) {
    const loc = cust && cust.location
    const lat = loc ? Number(loc.latitude) : NaN
    const lng = loc ? Number(loc.longitude) : NaN
    if (!isValidCoord(lat, lng)) continue

    summary.located += 1
    const oldAddr = loc && typeof loc.address === 'string' ? loc.address : ''
    const needsFix = mode === 'all' || isCoordinateAddress(oldAddr)
    if (!needsFix) {
      summary.skippedValid += 1
      continue
    }
    targets.push({ cust, lat, lng, oldAddr })
  }

  const slice = limit > 0 ? targets.slice(0, limit) : targets
  summary.candidates = slice.length

  for (let i = 0; i < slice.length; i++) {
    const { cust, lat, lng, oldAddr } = slice[i]
    if (i > 0 && delayMs > 0) await sleep(delayMs)

    const geoOpts = {
      provider: options.allowFallback ? 'auto' : 'tianditu',
      ...(options.geocodeOptions || {})
    }
    const geo = await geocodeFn(lat, lng, geoOpts)
    if (!geo || !geo.success || !geo.address || isCoordinateAddress(geo.address)) {
      summary.failed += 1
      logger.warn(`[backfill] 跳过 ${cust.storeName || cust._id}: ${(geo && geo.reason) || 'GEOCODE_FAILED'}`)
      continue
    }

    if (summary.samples.length < 10) {
      summary.samples.push({
        id: cust._id,
        storeName: cust.storeName || '',
        oldAddress: oldAddr,
        newAddress: geo.address,
        provider: geo.provider || ''
      })
    }

    if (apply) {
      await db.collection('customers').doc(cust._id).update({
        data: {
          location: {
            ...cust.location,
            latitude: cust.location.latitude,
            longitude: cust.location.longitude,
            address: geo.address
          },
          updatedAt: db.serverDate()
        }
      })
      summary.updated += 1
    } else {
      summary.wouldUpdate += 1
    }
  }

  return summary
}

async function main() {
  loadEnvFile()
  const args = parseArgs(process.argv.slice(2))
  if (!args.allowFallback && !(process.env.TIANDITU_KEY || '').trim()) {
    console.error('[backfill] 未检测到 TIANDITU_KEY 环境变量。请先在 server/.env 配置 TIANDITU_KEY（或传 --allow-fallback 允许使用腾讯地图兜底）。')
    process.exit(1)
  }
  const db = require('../src/docdb')

  try {
    console.log(
      `[backfill] 启动模式=${args.apply ? 'APPLY(写库)' : 'DRY-RUN(仅预览)'} ` +
      `range=${args.mode} delay=${args.delayMs}ms`
    )
    const summary = await backfillCustomerAddresses(db, args)
    console.log('[backfill] 完成统计:', JSON.stringify({
      totalActive: summary.totalActive,
      located: summary.located,
      candidates: summary.candidates,
      skippedValid: summary.skippedValid,
      updated: summary.updated,
      wouldUpdate: summary.wouldUpdate,
      failed: summary.failed
    }))
    if (summary.samples.length > 0) {
      console.log('[backfill] 样例预览:')
      summary.samples.forEach(s => {
        console.log(`  - ${s.storeName} (${s.id}): "${s.oldAddress || '(空)'}" -> "${s.newAddress}" [${s.provider}]`)
      })
    }
  } finally {
    db._internal.closeSqlite()
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[backfill] 执行失败:', err)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  backfillCustomerAddresses
}
