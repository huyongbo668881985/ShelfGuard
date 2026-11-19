#!/usr/bin/env node
'use strict'

/**
 * 存量已分析巡检记录复核等级（reviewLevel / spotCheck / reviewStatus）一次性回填脚本
 *
 * 用法：
 *   node server/scripts/backfill-review-level.js --dry-run
 *   node server/scripts/backfill-review-level.js --apply
 *   node server/scripts/backfill-review-level.js --mode all --apply
 */

const fs = require('fs')
const path = require('path')
const {
  normalizeReviewThresholds,
  computeReviewLevel,
  computeSpotCheck,
  DEFAULT_SPOT_CHECK_RATE
} = require('../src/functions/analyzeImage/scoring')

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
    mode: 'missing' // 'missing' | 'all'
  }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--apply') args.apply = true
    else if (token === '--dry-run') args.apply = false
    else if (token === '--mode' && argv[i + 1]) {
      const m = argv[++i]
      if (m === 'missing' || m === 'all') args.mode = m
    }
  }
  return args
}

async function backfillReviewLevels(db, options = {}) {
  const apply = Boolean(options.apply)
  const mode = options.mode === 'all' ? 'all' : 'missing'
  const logger = options.logger || console

  let settingsDoc = null
  try {
    const sRes = await db.collection('settings').doc('global').get()
    settingsDoc = (sRes && sRes.data) || null
  } catch (_) {}

  const thresholds = normalizeReviewThresholds(settingsDoc && settingsDoc.reviewThresholds)
  const spotCheckRate = Number.isFinite(Number(settingsDoc && settingsDoc.spotCheckRate))
    ? Math.max(0, Math.min(100, Math.round(Number(settingsDoc.spotCheckRate))))
    : DEFAULT_SPOT_CHECK_RATE

  const pageSize = 200
  let skip = 0
  let scanned = 0
  let updated = 0
  let skipped = 0
  const counts = { low: 0, mid: 0, high: 0, spotCheck: 0 }

  while (true) {
    const res = await db.collection('inspections')
      .where({ status: 'analyzed' })
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(pageSize)
      .get()
    const rows = res.data || []
    if (rows.length === 0) break

    for (const doc of rows) {
      scanned++
      if (!doc || !doc.aiReport) {
        skipped++
        continue
      }
      const hasFields = Boolean(doc.reviewLevel && typeof doc.spotCheck === 'boolean' && doc.reviewStatus)
      if (mode === 'missing' && hasFields) {
        skipped++
        continue
      }

      const reviewLevel = doc.reviewStatus === 'corrected'
        ? (doc.reviewLevel || 'high')
        : computeReviewLevel(doc.aiReport, thresholds)
      const spotCheck = computeSpotCheck(doc._id, spotCheckRate, reviewLevel)
      const reviewStatus = doc.reviewStatus || 'unreviewed'

      counts[reviewLevel] = (counts[reviewLevel] || 0) + 1
      if (spotCheck) counts.spotCheck++

      if (apply) {
        await db.collection('inspections').doc(doc._id).update({
          data: {
            reviewLevel,
            spotCheck,
            reviewStatus
          }
        })
      }
      updated++
    }

    if (rows.length < pageSize) break
    skip += rows.length
  }

  const summary = { apply, mode, scanned, updated, skipped, counts }
  logger.log('[backfill-review-level]', JSON.stringify(summary))
  return summary
}

if (require.main === module) {
  loadEnvFile()
  const db = require('../src/docdb')
  const args = parseArgs(process.argv.slice(2))
  backfillReviewLevels(db, args).catch(err => {
    console.error('[backfill-review-level] 执行失败:', err)
    process.exitCode = 1
  })
}

module.exports = {
  backfillReviewLevels
}
