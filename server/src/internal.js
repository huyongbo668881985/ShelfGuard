'use strict'

const crypto = require('crypto')
const db = require('./docdb')
const files = require('./files')
const { internalApiKey } = require('./config')

const _ = db.command

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  if (left.length === 0 || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function extractSharePercent(aiReport) {
  if (!aiReport || typeof aiReport !== 'object') return null
  const ov = aiReport.ownBrandOverview
  if (ov && ov.facingSharePercent != null) {
    const n = Number(ov.facingSharePercent)
    if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n * 10) / 10
  }
  const brands = aiReport.competitiveAnalysis && aiReport.competitiveAnalysis.brands
  if (Array.isArray(brands)) {
    const own = brands.find(b => b && (b.brand === '我方品牌' || b.isOwn === true))
    if (own && own.sharePercent != null) {
      const n = Number(own.sharePercent)
      if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n * 10) / 10
    }
  }
  return null
}

function requireInternalKey(req, res, next) {
  const configured = internalApiKey()
  if (!configured || configured.length < 16) {
    return res.status(503).json({
      success: false,
      error: 'ShelfGuard 尚未配置有效的 INTERNAL_API_KEY（至少16位）'
    })
  }
  const authHeader = String(req.headers.authorization || '')
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const headerKey = String(req.headers['x-internal-key'] || '').trim()
  const token = bearer || headerKey

  if (!token || !safeEqual(token, configured)) {
    return res.status(401).json({
      success: false,
      error: '内部接口密钥无效'
    })
  }
  return next()
}

async function customerSummaryHandler(req, res) {
  try {
    const rawJxcId = req.query.jxcCustomerId != null ? String(req.query.jxcCustomerId).trim() : ''
    const rawStoreName = req.query.storeName != null ? String(req.query.storeName).trim() : ''
    const rawDays = parseInt(req.query.days, 10)
    const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(7, rawDays)) : 90

    if (!rawJxcId && !rawStoreName) {
      return res.status(400).json({
        success: false,
        error: '请提供 jxcCustomerId 或 storeName 参数'
      })
    }

    let customerDoc = null
    if (rawJxcId) {
      const candidates = [rawJxcId]
      const numId = Number(rawJxcId)
      if (Number.isFinite(numId)) candidates.push(numId)
      const cRes = await db.collection('customers')
        .where({ jxcCustomerId: _.in(candidates) })
        .limit(1)
        .get()
      if (cRes.data && cRes.data.length > 0) {
        customerDoc = cRes.data[0]
      }
    }

    if (!customerDoc && rawStoreName) {
      const cRes = await db.collection('customers')
        .where({ storeName: rawStoreName })
        .limit(1)
        .get()
      if (cRes.data && cRes.data.length > 0) {
        customerDoc = cRes.data[0]
      }
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const targetStoreName = (customerDoc && customerDoc.storeName) || rawStoreName

    let matchCond = null
    if (customerDoc && customerDoc._id && targetStoreName) {
      matchCond = _.or([
        { customerId: customerDoc._id },
        { storeName: targetStoreName }
      ])
    } else if (customerDoc && customerDoc._id) {
      matchCond = { customerId: customerDoc._id }
    } else {
      matchCond = { storeName: targetStoreName }
    }

    const whereCond = _.and(
      { createdAt: _.gte(since) },
      { 'aiReport.metadata.isMock': _.neq(true) },
      matchCond
    )

    const insRes = await db.collection('inspections')
      .where(whereCond)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get()

    const list = insRes.data || []

    // 收集最近 5 次巡检的首图，生成带签名的临时访问链接
    const recentSlice = list.slice(0, 5)
    const fileIds = []
    recentSlice.forEach(item => {
      if (Array.isArray(item.photoFileIDs) && item.photoFileIDs[0]) {
        fileIds.push(item.photoFileIDs[0])
      }
    })
    const urlMap = {}
    if (fileIds.length > 0) {
      try {
        const tempRes = await files.getTempFileURL({ fileList: fileIds })
        ;(tempRes.fileList || []).forEach(f => {
          if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
        })
      } catch (err) {
        console.warn('[internal] 获取巡检缩略图签名链接失败:', err.message)
      }
    }

    let scoreSum = 0
    let scoredCount = 0
    let shareSum = 0
    let shareCount = 0
    const issueFreq = {}
    const productFreq = {}

    list.forEach(item => {
      const ar = item.aiReport
      if (ar && typeof ar === 'object') {
        const score = Number(ar.score)
        if (Number.isFinite(score) && score >= 0 && score <= 100) {
          scoreSum += score
          scoredCount++
        }
        const share = extractSharePercent(ar)
        if (share != null) {
          shareSum += share
          shareCount++
        }
        if (Array.isArray(ar.issues)) {
          ar.issues.forEach(iss => {
            const text = typeof iss === 'string'
              ? iss.trim()
              : (iss && (iss.issue || iss.description || iss.title) ? String(iss.issue || iss.description || iss.title).trim() : '')
            if (text) issueFreq[text] = (issueFreq[text] || 0) + 1
          })
        }
        if (Array.isArray(ar.products)) {
          ar.products.forEach(p => {
            const pName = typeof p === 'string'
              ? p.trim()
              : (p && p.name ? String(p.name).trim() : '')
            if (pName) productFreq[pName] = (productFreq[pName] || 0) + 1
          })
        }
      }
    })

    const topIssues = Object.entries(issueFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([issue, count]) => ({ issue, count }))

    const detectedProducts = Object.entries(productFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }))

    const recentInspections = recentSlice.map(item => {
      const ar = item.aiReport && typeof item.aiReport === 'object' ? item.aiReport : null
      const firstFileId = Array.isArray(item.photoFileIDs) && item.photoFileIDs[0] ? item.photoFileIDs[0] : ''
      const issues = ar && Array.isArray(ar.issues)
        ? ar.issues.slice(0, 3).map(i => (typeof i === 'string' ? i : (i && (i.issue || i.description || i.title)) || '')).filter(Boolean)
        : []
      const suggestions = ar && Array.isArray(ar.suggestions)
        ? ar.suggestions.slice(0, 2).map(s => (typeof s === 'string' ? s : (s && (s.suggestion || s.description || s.title)) || '')).filter(Boolean)
        : []

      return {
        id: item._id,
        createdAt: item.createdAt,
        userName: item.userName || '',
        taskName: item.taskName || '',
        status: item.status || '',
        score: ar && Number.isFinite(Number(ar.score)) ? Number(ar.score) : null,
        scoreLevel: ar ? (ar.scoreLevel || '') : '',
        sharePercent: extractSharePercent(ar),
        summary: ar ? (ar.summary || '') : '',
        issues,
        suggestions,
        thumbnailURL: firstFileId ? (urlMap[firstFileId] || '') : ''
      }
    })

    return res.json({
      success: true,
      days,
      matchedCustomer: customerDoc ? {
        id: customerDoc._id,
        storeName: customerDoc.storeName || '',
        jxcCustomerId: customerDoc.jxcCustomerId ?? null,
        address: customerDoc.address || '',
        contactName: customerDoc.contactName || '',
        hasLocation: !!(customerDoc.location && customerDoc.location.latitude != null)
      } : null,
      summary: {
        visitCount: list.length,
        scoredCount,
        avgScore: scoredCount > 0 ? Math.round((scoreSum / scoredCount) * 10) / 10 : null,
        avgSharePercent: shareCount > 0 ? Math.round((shareSum / shareCount) * 10) / 10 : null,
        lastVisitAt: list.length > 0 ? list[0].createdAt : null,
        topIssues,
        detectedProducts
      },
      recentInspections
    })
  } catch (err) {
    console.error('[internal] customerSummaryHandler 异常:', err)
    return res.status(500).json({ success: false, error: '查询门店巡检汇总失败' })
  }
}

async function overviewHandler(req, res) {
  try {
    const rawDays = parseInt(req.query.days, 10)
    const days = Number.isFinite(rawDays) ? Math.min(180, Math.max(7, rawDays)) : 30

    let lowVisitThreshold = parseInt(req.query.lowVisitThreshold, 10)
    if (!Number.isFinite(lowVisitThreshold) || lowVisitThreshold < 0) {
      lowVisitThreshold = 2
      try {
        const sRes = await db.collection('settings').doc('global').get()
        const configured = sRes.data && Number(sRes.data.lowVisitThreshold)
        if (Number.isFinite(configured) && configured >= 0 && configured <= 100) {
          lowVisitThreshold = Math.floor(configured)
        }
      } catch (_) {}
    }

    const custRes = await db.collection('customers')
      .where({ isActive: true })
      .limit(1000)
      .get()
    const customers = custRes.data || []

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const insRes = await db.collection('inspections')
      .where(_.and(
        { createdAt: _.gte(since) },
        { 'aiReport.metadata.isMock': _.neq(true) }
      ))
      .orderBy('createdAt', 'desc')
      .limit(1000)
      .get()
    const inspections = insRes.data || []

    const byStoreKey = new Map()
    const byId = new Map()
    const byName = new Map()

    customers.forEach(c => {
      const entry = {
        customerId: c._id,
        jxcCustomerId: c.jxcCustomerId ?? null,
        storeName: c.storeName || '',
        visitCount: 0,
        scoredCount: 0,
        scoreSum: 0,
        shareCount: 0,
        shareSum: 0,
        lastVisitAt: null,
        lastUserName: ''
      }
      byStoreKey.set(c._id, entry)
      byId.set(c._id, entry)
      if (c.storeName) byName.set(c.storeName, entry)
    })

    const bySalesperson = new Map()

    inspections.forEach(ins => {
      let entry = (ins.customerId && byId.get(ins.customerId)) || (ins.storeName && byName.get(ins.storeName))
      if (!entry && ins.storeName) {
        const key = `unlinked:${ins.storeName}`
        entry = byStoreKey.get(key)
        if (!entry) {
          entry = {
            customerId: ins.customerId || '',
            jxcCustomerId: null,
            storeName: ins.storeName,
            visitCount: 0,
            scoredCount: 0,
            scoreSum: 0,
            shareCount: 0,
            shareSum: 0,
            lastVisitAt: null,
            lastUserName: ''
          }
          byStoreKey.set(key, entry)
        }
      }

      const ar = ins.aiReport && typeof ins.aiReport === 'object' ? ins.aiReport : null
      const score = ar && Number.isFinite(Number(ar.score)) ? Number(ar.score) : null
      const share = extractSharePercent(ar)

      if (entry) {
        entry.visitCount++
        if (!entry.lastVisitAt || new Date(ins.createdAt) > new Date(entry.lastVisitAt)) {
          entry.lastVisitAt = ins.createdAt
          entry.lastUserName = ins.userName || ''
        }
        if (score != null) {
          entry.scoredCount++
          entry.scoreSum += score
        }
        if (share != null) {
          entry.shareCount++
          entry.shareSum += share
        }
      }

      const spName = (ins.userName || '未知业务员').trim()
      if (!bySalesperson.has(spName)) {
        bySalesperson.set(spName, { userName: spName, visitCount: 0, scoredCount: 0, scoreSum: 0, stores: new Set() })
      }
      const sp = bySalesperson.get(spName)
      sp.visitCount++
      if (ins.storeName) sp.stores.add(ins.storeName)
      if (score != null) {
        sp.scoredCount++
        sp.scoreSum += score
      }
    })

    const allStores = Array.from(byStoreKey.values()).map(s => ({
      customerId: s.customerId,
      jxcCustomerId: s.jxcCustomerId,
      storeName: s.storeName,
      visitCount: s.visitCount,
      avgScore: s.scoredCount > 0 ? Math.round((s.scoreSum / s.scoredCount) * 10) / 10 : null,
      avgSharePercent: s.shareCount > 0 ? Math.round((s.shareSum / s.shareCount) * 10) / 10 : null,
      lastVisitAt: s.lastVisitAt,
      lastUserName: s.lastUserName
    }))

    const lowVisitStores = allStores
      .filter(s => s.visitCount < lowVisitThreshold)
      .sort((a, b) => a.visitCount - b.visitCount)

    const lowestScoreStores = allStores
      .filter(s => s.avgScore != null)
      .sort((a, b) => a.avgScore - b.avgScore)
      .slice(0, 10)

    const salespersonStats = Array.from(bySalesperson.values())
      .map(sp => ({
        userName: sp.userName,
        visitCount: sp.visitCount,
        coveredStoreCount: sp.stores.size,
        avgScore: sp.scoredCount > 0 ? Math.round((sp.scoreSum / sp.scoredCount) * 10) / 10 : null
      }))
      .sort((a, b) => b.visitCount - a.visitCount)

    return res.json({
      success: true,
      days,
      lowVisitThreshold,
      totals: {
        activeCustomerCount: customers.length,
        inspectionCount: inspections.length,
        visitedStoreCount: allStores.filter(s => s.visitCount > 0).length,
        lowVisitStoreCount: lowVisitStores.length
      },
      lowVisitStores: lowVisitStores.slice(0, 50),
      lowestScoreStores,
      salespersonStats,
      storeStats: allStores
    })
  } catch (err) {
    console.error('[internal] overviewHandler 异常:', err)
    return res.status(500).json({ success: false, error: '查询巡检概览失败' })
  }
}

module.exports = {
  requireInternalKey,
  customerSummaryHandler,
  overviewHandler
}
