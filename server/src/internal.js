'use strict'

const crypto = require('crypto')
const db = require('./docdb')
const files = require('./files')
const { internalApiKey } = require('./config')
const {
  extractFacingSummary,
  isOwnHorizontalBannerEntry,
  isOwnCabinetHeaderEntry
} = require('./functions/analyzeImage/scoring')

const _ = db.command
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

function round1(val) {
  if (val == null || !Number.isFinite(val)) return null
  return Math.round(val * 10) / 10
}

function parseShanghaiDayRange(dateStr, nowMs = Date.now()) {
  if (dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim())
    if (!m) return null
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    const check = new Date(Date.UTC(y, mo - 1, d))
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
      return null
    }
    const startMs = Date.UTC(y, mo - 1, d) - SHANGHAI_OFFSET_MS
    return {
      date: `${m[1]}-${m[2]}-${m[3]}`,
      startDate: new Date(startMs),
      endDate: new Date(startMs + DAY_MS)
    }
  }
  const shNow = new Date(nowMs + SHANGHAI_OFFSET_MS)
  const todayStartMs = Date.UTC(shNow.getUTCFullYear(), shNow.getUTCMonth(), shNow.getUTCDate()) - SHANGHAI_OFFSET_MS
  const startMs = todayStartMs - DAY_MS
  const date = new Date(startMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
  return {
    date,
    startDate: new Date(startMs),
    endDate: new Date(todayStartMs)
  }
}

function formatShanghaiHM(value) {
  if (!value) return ''
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(ms)) return ''
  const sh = new Date(ms + SHANGHAI_OFFSET_MS)
  return `${String(sh.getUTCHours()).padStart(2, '0')}:${String(sh.getUTCMinutes()).padStart(2, '0')}`
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  if (left.length === 0 || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function parseStrictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function isParseErrorReport(aiReport) {
  return Boolean(aiReport && typeof aiReport === 'object' && aiReport.metadata && aiReport.metadata.parseError === true)
}

function isNoShelfPhotoReport(aiReport) {
  return Boolean(
    aiReport &&
    typeof aiReport === 'object' &&
    (aiReport.hasShelfPhoto === false || aiReport.scoreLevel === '无货架照')
  )
}

function isNotOnShelfReport(aiReport) {
  return Boolean(
    aiReport &&
    typeof aiReport === 'object' &&
    (aiReport.ownBrandPresent === false || aiReport.scoreLevel === '未上柜')
  )
}

function extractValidScore(aiReport) {
  if (!aiReport || typeof aiReport !== 'object' || isParseErrorReport(aiReport)) return null
  if (isNoShelfPhotoReport(aiReport) || isNotOnShelfReport(aiReport)) return null
  const score = parseStrictNumber(aiReport.score)
  if (score !== null && score >= 0 && score <= 100) return score
  return null
}

function extractOwnFacingCount(aiReport) {
  if (!aiReport || typeof aiReport !== 'object' || isParseErrorReport(aiReport)) return null
  const fs = extractFacingSummary(aiReport)
  return fs && fs.ownFacingCount != null && Number.isFinite(fs.ownFacingCount) && fs.ownFacingCount >= 0
    ? fs.ownFacingCount
    : null
}

function extractSharePercent(aiReport) {
  if (!aiReport || typeof aiReport !== 'object' || isParseErrorReport(aiReport) || isNoShelfPhotoReport(aiReport)) return null
  const fm = aiReport.facingMetrics
  if (fm && typeof fm === 'object') {
    const n = parseStrictNumber(fm.ownFacingShare)
    if (n !== null && n >= 0 && n <= 100) return Math.round(n * 10) / 10
  }
  const ov = aiReport.ownBrandOverview
  if (ov && typeof ov === 'object') {
    const n = parseStrictNumber(ov.facingSharePercent)
    if (n !== null && n >= 0 && n <= 100) return Math.round(n * 10) / 10
  }
  const brands = aiReport.competitiveAnalysis && aiReport.competitiveAnalysis.brands
  if (Array.isArray(brands)) {
    const own = brands.find(b => b && (b.brand === '我方品牌' || b.isOwn === true))
    if (own) {
      const n = parseStrictNumber(own.sharePercent)
      if (n !== null && n >= 0 && n <= 100) return Math.round(n * 10) / 10
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
        const tempRes = await files.getTempFileURL({ fileList: fileIds, variant: 'thumb' })
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
    let facingSum = 0
    let facingCount = 0
    const issueFreq = {}
    const productFreq = {}

    list.forEach(item => {
      const ar = item.aiReport
      if (ar && typeof ar === 'object' && !isParseErrorReport(ar)) {
        const score = extractValidScore(ar)
        if (score != null) {
          scoreSum += score
          scoredCount++
        }
        const share = extractSharePercent(ar)
        if (share != null) {
          shareSum += share
          shareCount++
        }
        const ownFacing = extractOwnFacingCount(ar)
        if (ownFacing != null) {
          facingSum += ownFacing
          facingCount++
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
      const rawAr = item.aiReport && typeof item.aiReport === 'object' ? item.aiReport : null
      const ar = rawAr && !isParseErrorReport(rawAr) ? rawAr : null
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
        score: extractValidScore(ar),
        scoreLevel: rawAr ? (rawAr.scoreLevel || '') : '',
        ownFacingCount: extractOwnFacingCount(ar),
        sharePercent: extractSharePercent(ar),
        summary: rawAr ? (rawAr.summary || '') : '',
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
        avgOwnFacingCount: facingCount > 0 ? Math.round((facingSum / facingCount) * 10) / 10 : null,
        avgSharePercent: shareCount > 0 ? Math.round((shareSum / shareCount) * 10) / 10 : null,
        lastVisitAt: list.length > 0 ? list[0].createdAt : null,
        topIssues,
        detectedProducts
      },
      recentInspections
    })
  } catch (err) {
    console.error('[internal] customerSummaryHandler 异常:', err)
    return res.status(500).json({ success: false, error: '查询门店拜访汇总失败' })
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
        facingCount: 0,
        facingSum: 0,
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
            facingCount: 0,
            facingSum: 0,
            shareCount: 0,
            shareSum: 0,
            lastVisitAt: null,
            lastUserName: ''
          }
          byStoreKey.set(key, entry)
        }
      }

      const ar = ins.aiReport && typeof ins.aiReport === 'object' ? ins.aiReport : null
      const score = extractValidScore(ar)
      const share = extractSharePercent(ar)
      const ownFacing = extractOwnFacingCount(ar)

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
        if (ownFacing != null) {
          entry.facingCount++
          entry.facingSum += ownFacing
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
      avgOwnFacingCount: s.facingCount > 0 ? Math.round((s.facingSum / s.facingCount) * 10) / 10 : null,
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
    return res.status(500).json({ success: false, error: '查询拜访概览失败' })
  }
}

async function buildDailyReportData({ dateStr = '', includeAdmin = false, nowMs = Date.now() } = {}) {
  const range = parseShanghaiDayRange(dateStr, nowMs)
  if (!range) {
    return { ok: false, error: '日期格式无效，请使用 YYYY-MM-DD' }
  }

  // 1. 加载在职已审批人员名单（默认排除 admin 账号）
  const staffMap = new Map()
  const adminOpenids = new Set()
  let uSkip = 0
  while (uSkip < 1000) {
    const uRes = await db.collection('users')
      .orderBy('createdAt', 'asc')
      .skip(uSkip)
      .limit(200)
      .get()
    const uBatch = uRes.data || []
    if (uBatch.length === 0) break

    uBatch.forEach(u => {
      if (!u) return
      if (u.role === 'admin' && u._openid) adminOpenids.add(u._openid)
      if (!includeAdmin && u.role === 'admin') return
      if (u.disabled) return
      const isApproved = u.approved === true || (
        (u.approved === undefined || u.approved === null) &&
        (u.role === 'admin' || u.role === 'manager')
      )
      if (!isApproved) return

      const key = u._openid || `id:${u._id}`
      staffMap.set(key, {
        userId: u._id || key,
        _openid: u._openid || '',
        userName: (u.name && u.name.trim()) ? u.name.trim() : '未命名业务员',
        department: u.department || '',
        role: u.role || 'sales',
        clockInTime: '',
        clockOutTime: '',
        firstVisitTime: '',
        lastVisitTime: '',
        visitSubmissionCount: 0,
        pendingAnalyzeCount: 0,
        analyzeFailedCount: 0,
        stores: new Map()
      })
    })
    uSkip += uBatch.length
    if (uBatch.length < 200) break
  }

  // 2. 分页拉取目标北京自然日内的全部打卡与拜访记录
  let records = []
  let iSkip = 0
  while (iSkip < 5000) {
    const iRes = await db.collection('inspections')
      .where(_.and(
        { createdAt: _.gte(range.startDate) },
        { createdAt: _.lt(range.endDate) },
        { 'aiReport.metadata.isMock': _.neq(true) }
      ))
      .orderBy('createdAt', 'asc')
      .skip(iSkip)
      .limit(500)
      .get()
    const batch = iRes.data || []
    if (batch.length === 0) break
    records = records.concat(batch)
    iSkip += batch.length
    if (batch.length < 500) break
  }

  if (!includeAdmin && adminOpenids.size > 0) {
    records = records.filter(r => !(r._openid && adminOpenids.has(r._openid)))
  }

  // 3. 按人、按店（同店同日去重）聚合
  records.forEach(r => {
    const key = r._openid || `name:${(r.userName && r.userName.trim()) || '未知业务员'}`
    if (!staffMap.has(key)) {
      staffMap.set(key, {
        userId: key,
        _openid: r._openid || '',
        userName: (r.userName && r.userName.trim()) ? r.userName.trim() : '未命名业务员',
        department: '',
        role: 'sales',
        clockInTime: '',
        clockOutTime: '',
        firstVisitTime: '',
        lastVisitTime: '',
        visitSubmissionCount: 0,
        pendingAnalyzeCount: 0,
        analyzeFailedCount: 0,
        stores: new Map()
      })
    }
    const staff = staffMap.get(key)
    if ((!staff.userName || staff.userName === '未命名业务员') && r.userName && r.userName.trim()) {
      staff.userName = r.userName.trim()
    }

    const hm = formatShanghaiHM(r.createdAt)
    const recType = (r.recordType === 'clock_in' || r.recordType === 'clock_out')
      ? r.recordType
      : (r.status === 'clocked' ? 'clock_in' : 'visit')

    if (recType === 'clock_in') {
      if (hm && !staff.clockInTime) staff.clockInTime = hm
      return
    }
    if (recType === 'clock_out') {
      if (hm) staff.clockOutTime = hm
      return
    }

    staff.visitSubmissionCount += 1
    if (hm) {
      if (!staff.firstVisitTime) staff.firstVisitTime = hm
      staff.lastVisitTime = hm
    }
    if (r.status === 'pending' || r.status === 'analyzing') {
      staff.pendingAnalyzeCount += 1
    } else if (r.status === 'analyze_failed') {
      staff.analyzeFailedCount += 1
    }

    const cleanStoreName = (r.storeName && String(r.storeName).trim()) || ''
    const storeKey = (r.customerId && String(r.customerId).trim())
      ? `cid:${String(r.customerId).trim()}`
      : (cleanStoreName ? `name:${cleanStoreName}` : `id:${r._id || staff.visitSubmissionCount}`)

    if (!staff.stores.has(storeKey)) {
      staff.stores.set(storeKey, {
        storeKey,
        storeName: cleanStoreName || '未命名门店',
        hasOwnProduct: false,
        inStockScores: [],
        inStockFacings: [],
        hasHorizontalBanner: false,
        hasCabinetHeader: false
      })
    }
    const store = staff.stores.get(storeKey)
    const ar = r.aiReport && typeof r.aiReport === 'object' ? r.aiReport : null
    if (ar && !isParseErrorReport(ar)) {
      if (ar.ownBrandPresent === true && !isNoShelfPhotoReport(ar)) {
        store.hasOwnProduct = true
        const score = extractValidScore(ar)
        if (score != null) store.inStockScores.push(score)
        const facing = extractOwnFacingCount(ar)
        if (facing != null) store.inStockFacings.push(facing)
      }
      const dcHbScore = parseStrictNumber(
        ar.displayCompliance && ar.displayCompliance.horizontalBanner && ar.displayCompliance.horizontalBanner.score
      )
      const adMats = Array.isArray(ar.adMaterials) ? ar.adMaterials : []
      if ((dcHbScore != null && dcHbScore > 0) || adMats.some(isOwnHorizontalBannerEntry)) {
        store.hasHorizontalBanner = true
      }
      if (adMats.some(isOwnCabinetHeaderEntry)) {
        store.hasCabinetHeader = true
      }
    }
  })

  // 4. 输出分人与团队汇总（平均分/平均排面均仅统计有货门店）
  let teamScoreSum = 0
  let teamScoreCount = 0
  let teamFacingSum = 0
  let teamFacingCount = 0

  const salespersons = Array.from(staffMap.values()).map(st => {
    const storeList = Array.from(st.stores.values())
    const inStockStores = storeList.filter(s => s.hasOwnProduct)

    let scoreSum = 0
    let scoreCount = 0
    let facingSum = 0
    let facingCount = 0

    inStockStores.forEach(s => {
      if (s.inStockScores.length > 0) {
        const storeScore = s.inStockScores.reduce((a, b) => a + b, 0) / s.inStockScores.length
        scoreSum += storeScore
        scoreCount += 1
        teamScoreSum += storeScore
        teamScoreCount += 1
      }
      if (s.inStockFacings.length > 0) {
        const storeFacing = s.inStockFacings.reduce((a, b) => a + b, 0) / s.inStockFacings.length
        facingSum += storeFacing
        facingCount += 1
        teamFacingSum += storeFacing
        teamFacingCount += 1
      }
    })

    const visitCount = storeList.length
    const visitTimeRange = st.firstVisitTime
      ? (st.lastVisitTime && st.lastVisitTime !== st.firstVisitTime
          ? `${st.firstVisitTime}~${st.lastVisitTime}`
          : st.firstVisitTime)
      : ''

    return {
      userId: st.userId,
      userName: st.userName,
      department: st.department,
      role: st.role,
      clockInTime: st.clockInTime || null,
      clockOutTime: st.clockOutTime || null,
      visitCount,
      visitSubmissionCount: st.visitSubmissionCount,
      firstVisitTime: st.firstVisitTime || null,
      lastVisitTime: st.lastVisitTime || null,
      visitTimeRange,
      inStockStoreCount: inStockStores.length,
      inStockAvgScore: scoreCount > 0 ? round1(scoreSum / scoreCount) : null,
      inStockAvgFacing: facingCount > 0 ? round1(facingSum / facingCount) : null,
      horizontalBannerStoreCount: storeList.filter(s => s.hasHorizontalBanner).length,
      cabinetHeaderStoreCount: storeList.filter(s => s.hasCabinetHeader).length,
      pendingAnalyzeCount: st.pendingAnalyzeCount,
      analyzeFailedCount: st.analyzeFailedCount
    }
  }).sort((a, b) => {
    const aActive = Boolean(a.clockInTime || a.clockOutTime || a.visitCount > 0)
    const bActive = Boolean(b.clockInTime || b.clockOutTime || b.visitCount > 0)
    if (bActive !== aActive) return bActive ? 1 : -1
    if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount
    return String(a.userName).localeCompare(String(b.userName), 'zh-CN')
  })

  const totals = {
    totalStaffCount: salespersons.length,
    activeStaffCount: salespersons.filter(p => p.clockInTime || p.clockOutTime || p.visitCount > 0).length,
    clockInCount: salespersons.filter(p => p.clockInTime).length,
    clockOutCount: salespersons.filter(p => p.clockOutTime).length,
    visitCount: salespersons.reduce((sum, p) => sum + p.visitCount, 0),
    visitSubmissionCount: salespersons.reduce((sum, p) => sum + p.visitSubmissionCount, 0),
    inStockStoreCount: salespersons.reduce((sum, p) => sum + p.inStockStoreCount, 0),
    inStockAvgScore: teamScoreCount > 0 ? round1(teamScoreSum / teamScoreCount) : null,
    inStockAvgFacing: teamFacingCount > 0 ? round1(teamFacingSum / teamFacingCount) : null,
    horizontalBannerStoreCount: salespersons.reduce((sum, p) => sum + p.horizontalBannerStoreCount, 0),
    cabinetHeaderStoreCount: salespersons.reduce((sum, p) => sum + p.cabinetHeaderStoreCount, 0),
    pendingAnalyzeCount: salespersons.reduce((sum, p) => sum + p.pendingAnalyzeCount, 0),
    analyzeFailedCount: salespersons.reduce((sum, p) => sum + p.analyzeFailedCount, 0)
  }

  return {
    ok: true,
    date: range.date,
    totals,
    salespersons
  }
}

async function dailyReportHandler(req, res) {
  try {
    const rawDate = req.query.date != null ? String(req.query.date).trim() : ''
    const rawIncludeAdmin = String(req.query.includeAdmin || '').trim().toLowerCase()
    const includeAdmin = rawIncludeAdmin === '1' || rawIncludeAdmin === 'true'

    const data = await buildDailyReportData({ dateStr: rawDate, includeAdmin })
    if (!data.ok) {
      return res.status(400).json({ success: false, error: data.error })
    }
    return res.json({
      success: true,
      date: data.date,
      totals: data.totals,
      salespersons: data.salespersons
    })
  } catch (err) {
    console.error('[internal] dailyReportHandler 异常:', err)
    return res.status(500).json({ success: false, error: '查询每日巡检汇总失败' })
  }
}

module.exports = {
  requireInternalKey,
  customerSummaryHandler,
  overviewHandler,
  dailyReportHandler,
  _internal: {
    isParseErrorReport,
    extractValidScore,
    extractSharePercent,
    extractOwnFacingCount,
    parseShanghaiDayRange,
    formatShanghaiHM,
    buildDailyReportData
  }
}
