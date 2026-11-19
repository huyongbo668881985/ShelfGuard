// 云函数：shelfStats
// 功能：排面份额夜间预计算 + 看板 / 单店趋势查询
//
// 为什么预计算：
// 环比/同比要对大量巡检按店按月聚合。看板打开时现扫会慢甚至超时。
// 做成每天算一次（定时触发），白天只读 shelfMonthlyByStore / shelfMonthlyOverall。
//
// 定时：config.json triggers shelfStatsNightly = "0 0 3 * * *"
// 即每天 03:00（云开发定时器按北京时间理解；部署后请在控制台核对）。
// 定时触发 event 形如 { Type: 'Timer', TriggerName, Time }，无 action，入口按 rebuild 处理。
//
// 角色：永远从 users 表按 openid 查，不信任客户端角色声明（同 getHistory）。

const cloud = require('../../cloud-shim')
const { extractFacingSummary } = require('../analyzeImage/scoring')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

const MANAGER_ROLES = ['admin', 'manager']
const SETTINGS_DOC_ID = 'global'
const DEFAULT_LOW_VISIT_THRESHOLD = 2
const REBUILD_MONTHS = 14
const PAGE_SIZE = 100
// 云函数 60s 上限；预留余量，超时则下次定时/手动再跑
// 自建进程没有云函数 60 秒上限，夜间重建允许跑完最近 14 个月。
const SOFT_DEADLINE_MS = 10 * 60 * 1000
const COL_BY_STORE = 'shelfMonthlyByStore'
const COL_OVERALL = 'shelfMonthlyOverall'

function pad2(n) {
  return String(n).padStart(2, '0')
}

function toYearMonth(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

function shiftYearMonth(yearMonth, deltaMonths) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(yearMonth || ''))
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + deltaMonths, 1)
  return toYearMonth(d)
}

function monthRange(yearMonth) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(yearMonth || ''))
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const start = new Date(y, mo, 1, 0, 0, 0, 0)
  const end = new Date(y, mo + 1, 1, 0, 0, 0, 0)
  return { start, end }
}

function lastNYearMonths(n) {
  const out = []
  const now = new Date()
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push(toYearMonth(d))
  }
  return out
}

function round1(n) {
  if (n == null || !Number.isFinite(n)) return null
  return Math.round(n * 10) / 10
}

function normalizeShare(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return n
}

async function getCaller(openid) {
  if (!openid) return null
  try {
    const res = await db.collection('users').where({ _openid: openid }).get()
    return res.data[0] || null
  } catch (err) {
    console.error('查询用户失败:', err)
    return null
  }
}

function resolveRole(caller) {
  const role = (caller && MANAGER_ROLES.includes(caller.role)) ? caller.role : 'sales'
  return {
    role,
    isManager: MANAGER_ROLES.includes(role),
    disabled: !!(caller && caller.disabled)
  }
}

async function loadLowVisitThreshold() {
  try {
    const res = await db.collection('settings').doc(SETTINGS_DOC_ID).get()
    const n = res.data && Number(res.data.lowVisitThreshold)
    if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.floor(n)
  } catch (e) {}
  return DEFAULT_LOW_VISIT_THRESHOLD
}

async function saveLowVisitThreshold(n) {
  const data = {
    lowVisitThreshold: n,
    updatedAt: db.serverDate()
  }
  try {
    await db.collection('settings').doc(SETTINGS_DOC_ID).update({ data })
  } catch (err) {
    if (err && (err.errCode === -1 || String(err.message || '').includes('does not exist'))) {
      await db.collection('settings').doc(SETTINGS_DOC_ID).set({
        data: Object.assign({ createdAt: db.serverDate() }, data)
      })
    } else {
      throw err
    }
  }
}

/**
 * 终端广告物料门店覆盖统计
 * 口径：以客户库（customers）门店为分母（如业务员名下 200 家店），
 * 合并客户档案沉淀的 adMaterials 与近 N 天（默认 180 天）已分析拜访记录中的 aiReport.adMaterials，
 * 按物料库标准名称统计每一种广告物料在多少家门店存在、覆盖率及已铺设/未铺设门店清单。
 */
async function handleMaterialStats({ isManager, caller, openid, userNameFilter, days }) {
  const windowDays = Math.min(365, Math.max(7, parseInt(days, 10) || 180))
  const cutoffDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  // 1. 加载启用中的广告物料库
  let activeMaterials = []
  try {
    const mRes = await db.collection('adMaterials').where({ isActive: true }).limit(200).get()
    activeMaterials = mRes.data || []
  } catch (_) {}

  const aliasToMaterial = new Map()
  activeMaterials.forEach(m => {
    if (!m || !m.materialName) return
    const std = String(m.materialName).trim()
    if (!std) return
    aliasToMaterial.set(std.toLowerCase(), m)
    if (Array.isArray(m.aliases)) {
      m.aliases.forEach(a => {
        const k = String(a || '').trim().toLowerCase()
        if (k) aliasToMaterial.set(k, m)
      })
    }
  })

  function resolveCanonicalMaterial(rawName, rawCategory) {
    const clean = String(rawName || '').trim()
    if (!clean) return null
    const matched = aliasToMaterial.get(clean.toLowerCase())
    if (matched) {
      return {
        name: String(matched.materialName).trim(),
        category: matched.category || rawCategory || '其他'
      }
    }
    return {
      name: clean,
      category: String(rawCategory || '其他').trim() || '其他'
    }
  }

  // 2. 加载用户列表（用于映射业务员姓名，以及 manager 角色隔离 admin 记录）
  const userByOpenid = new Map()
  const adminOpenids = new Set()
  try {
    const uRes = await db.collection('users').limit(500).get()
    ;(uRes.data || []).forEach(u => {
      if (!u || !u._openid) return
      userByOpenid.set(u._openid, u)
      if (u.role === 'admin') adminOpenids.add(u._openid)
    })
  } catch (_) {}

  const callerRole = (caller && caller.role) || 'sales'

  // 3. 加载职责范围内的全部客户门店（分母，例如业务员名下 200 家店）
  const storeMap = new Map() // key: customerId -> store entry
  const storeNameToId = new Map()
  let custSkip = 0
  const custQuery = isManager ? {} : { _openid: openid }
  while (custSkip < 3000) {
    const cRes = await db.collection('customers')
      .where(custQuery)
      .skip(custSkip)
      .limit(100)
      .get()
    const batch = cRes.data || []
    if (batch.length === 0) break

    for (const c of batch) {
      if (!c || !c._id) continue
      // manager 角色默认不混入无进销存归属的纯 admin 测试门店
      if (callerRole === 'manager' && adminOpenids.has(c._openid) && !c.jxcOperatorName) {
        continue
      }
      const ownerUser = userByOpenid.get(c._openid)
      const userName = (ownerUser && ownerUser.name && String(ownerUser.name).trim())
        || (c.jxcOperatorName && String(c.jxcOperatorName).trim())
        || '未分配'
      const sName = String(c.storeName || '未命名门店').trim()
      const matMap = new Map()

      if (Array.isArray(c.adMaterials)) {
        c.adMaterials.forEach(item => {
          if (!item) return
          const resolved = resolveCanonicalMaterial(item.name || item.materialName, item.category)
          if (!resolved) return
          matMap.set(resolved.name, {
            name: resolved.name,
            category: resolved.category,
            count: Math.max(1, parseInt(item.count, 10) || 1),
            condition: item.condition || '完好'
          })
        })
      }

      storeMap.set(c._id, {
        customerId: c._id,
        storeName: sName,
        ownerOpenid: c._openid || '',
        userName,
        visited: false,
        materials: matMap
      })
      if (sName) {
        storeNameToId.set(`${c._openid || ''}||${sName}`, c._id)
        if (!storeNameToId.has(`*||${sName}`)) {
          storeNameToId.set(`*||${sName}`, c._id)
        }
      }
    }

    custSkip += batch.length
    if (batch.length < 100) break
  }

  // 4. 扫描时间窗口内的拜访记录，合并 AI 识别到的 adMaterials
  let inspSkip = 0
  const inspQuery = isManager
    ? { createdAt: _.gte(cutoffDate) }
    : { _openid: openid, createdAt: _.gte(cutoffDate) }

  while (inspSkip < 3000) {
    const iRes = await db.collection('inspections')
      .where(inspQuery)
      .orderBy('createdAt', 'desc')
      .skip(inspSkip)
      .limit(100)
      .field({
        _id: true,
        _openid: true,
        customerId: true,
        storeName: true,
        userName: true,
        recordType: true,
        aiReport: true,
        createdAt: true
      })
      .get()
    const rows = iRes.data || []
    if (rows.length === 0) break

    for (const row of rows) {
      if (!row || row.recordType === 'clock_in' || row.recordType === 'clock_out') continue
      if (callerRole === 'manager' && adminOpenids.has(row._openid)) continue

      let cid = row.customerId && String(row.customerId).trim()
      const sName = String(row.storeName || '').trim()
      if (!cid && sName) {
        cid = storeNameToId.get(`${row._openid || ''}||${sName}`) || storeNameToId.get(`*||${sName}`) || ''
      }

      let storeEntry = cid ? storeMap.get(cid) : null
      if (!storeEntry && sName) {
        const fallbackKey = `virtual_${row._openid || ''}_${sName}`
        storeEntry = storeMap.get(fallbackKey)
        if (!storeEntry) {
          const ownerUser = userByOpenid.get(row._openid)
          const uName = (row.userName && String(row.userName).trim())
            || (ownerUser && ownerUser.name && String(ownerUser.name).trim())
            || '未分配'
          storeEntry = {
            customerId: cid || '',
            storeName: sName,
            ownerOpenid: row._openid || '',
            userName: uName,
            visited: true,
            materials: new Map()
          }
          storeMap.set(fallbackKey, storeEntry)
        }
      }

      if (!storeEntry) continue
      storeEntry.visited = true

      const rawMats = row.aiReport && Array.isArray(row.aiReport.adMaterials)
        ? row.aiReport.adMaterials
        : []
      rawMats.forEach(item => {
        if (!item || item.isOwn === false) return
        const resolved = resolveCanonicalMaterial(item.name || item.materialName, item.category)
        if (!resolved) return
        if (!storeEntry.materials.has(resolved.name)) {
          storeEntry.materials.set(resolved.name, {
            name: resolved.name,
            category: resolved.category,
            count: Math.max(1, parseInt(item.count, 10) || 1),
            condition: item.condition || '完好'
          })
        }
      })
    }

    inspSkip += rows.length
    if (rows.length < 100) break
  }

  const allStores = Array.from(storeMap.values())

  // 5. 统计各业务员门店数与覆盖数（供胶囊筛选）
  const salesMap = new Map()
  allStores.forEach(s => {
    const uName = s.userName || '未分配'
    if (!salesMap.has(uName)) {
      salesMap.set(uName, { name: uName, totalStores: 0, coveredStores: 0 })
    }
    const g = salesMap.get(uName)
    g.totalStores += 1
    if (s.materials.size > 0) g.coveredStores += 1
  })
  const salesGroups = Array.from(salesMap.values())
    .sort((a, b) => b.totalStores - a.totalStores || a.name.localeCompare(b.name, 'zh-CN'))

  const targetUser = String(userNameFilter || '').trim()
  const filteredStores = targetUser
    ? allStores.filter(s => s.userName === targetUser)
    : allStores

  const totalStores = filteredStores.length
  const visitedStores = filteredStores.filter(s => s.visited).length
  const coveredStores = filteredStores.filter(s => s.materials.size > 0).length
  const uncoveredStores = Math.max(0, totalStores - coveredStores)
  const overallCoveragePercent = totalStores > 0 ? round1((coveredStores / totalStores) * 100) : 0

  // 6. 构建物料维度汇总列表（先放物料库中启用的标准物料，再补齐巡检中识别到的其他物料）
  const materialOrder = []
  const materialMeta = new Map()
  activeMaterials.forEach(m => {
    const name = String(m.materialName || '').trim()
    if (!name || materialMeta.has(name)) return
    materialOrder.push(name)
    materialMeta.set(name, {
      materialId: m._id || '',
      materialName: name,
      category: m.category || '其他',
      visualFeatures: m.visualFeatures || ''
    })
  })
  filteredStores.forEach(s => {
    for (const [mName, mVal] of s.materials.entries()) {
      if (!materialMeta.has(mName)) {
        materialOrder.push(mName)
        materialMeta.set(mName, {
          materialId: '',
          materialName: mName,
          category: mVal.category || '其他',
          visualFeatures: ''
        })
      }
    }
  })

  const materialBreakdown = materialOrder.map(mName => {
    const meta = materialMeta.get(mName)
    const storesWith = []
    const storesWithout = []

    filteredStores.forEach(s => {
      const hit = s.materials.get(mName)
      if (hit) {
        storesWith.push({
          customerId: s.customerId,
          storeName: s.storeName,
          userName: s.userName,
          count: hit.count || 1,
          condition: hit.condition || '完好'
        })
      } else {
        storesWithout.push({
          customerId: s.customerId,
          storeName: s.storeName,
          userName: s.userName
        })
      }
    })

    const storeCount = storesWith.length
    const missingStoreCount = storesWithout.length
    const coveragePercent = totalStores > 0 ? round1((storeCount / totalStores) * 100) : 0

    return {
      materialId: meta.materialId,
      materialName: meta.materialName,
      category: meta.category,
      storeCount,
      missingStoreCount,
      totalStores,
      coveragePercent,
      storesWith: storesWith.slice(0, 250),
      storesWithout: storesWithout.slice(0, 250)
    }
  })

  return {
    success: true,
    isManager,
    windowDays,
    userNameFilter: targetUser,
    totalStores,
    visitedStores,
    coveredStores,
    uncoveredStores,
    overallCoveragePercent,
    salesGroups,
    materials: materialBreakdown
  }
}

// 加载产品库品牌名，用于从 competitiveAnalysis / productIdentification 识别「我方」排面
async function loadOwnBrandNames() {
  const names = new Set()
  let skip = 0
  try {
    while (skip < 1000) {
      const res = await db.collection('products')
        .skip(skip)
        .limit(100)
        .field({ brandName: true, brand: true, name: true, status: true })
        .get()
      if (!res.data || res.data.length === 0) break
      res.data.forEach(p => {
        if (p && (p.status === 'disabled' || p.status === 'off')) return
        const b = (p.brandName || p.brand || '').trim()
        if (b) names.add(b)
      })
      skip += res.data.length
      if (res.data.length < 100) break
    }
  } catch (err) {
    console.warn('加载产品库品牌失败，将仅用显式我方字段:', err.message || err)
  }
  return names
}

/**
 * 从单次巡检 aiReport 提取我方排面份额（0-100）。
 * 口径优先级：
 * 1) ownBrandOverview.facingSharePercent（日报映射 / 未来字段）
 * 2) competitiveAnalysis.brands 中 brand=我方品牌 或命中产品库品牌名
 * 3) 用 productIdentification.facingCount：我方 facing / 总 facing * 100
 * 无可用数据则返回 null（不计入平均值，不造 0）
 */
function extractSharePercent(aiReport, ownBrandNames) {
  if (!aiReport || typeof aiReport !== 'object') return null

  const fm = aiReport.facingMetrics
  if (fm && fm.ownFacingShare != null) {
    const directFm = normalizeShare(fm.ownFacingShare)
    if (directFm !== null) return directFm
  }

  const ov = aiReport.ownBrandOverview
  if (ov) {
    const direct = normalizeShare(ov.facingSharePercent)
    if (direct !== null) return direct
  }

  const brands = aiReport.competitiveAnalysis && aiReport.competitiveAnalysis.brands
  if (Array.isArray(brands) && brands.length > 0) {
    const explicit = brands.find(b => b && (b.brand === '我方品牌' || b.isOwn === true))
    if (explicit) {
      const v = normalizeShare(explicit.sharePercent)
      if (v !== null) return v
    }
    if (ownBrandNames && ownBrandNames.size > 0) {
      let sum = 0
      let hit = false
      brands.forEach(b => {
        if (!b || !b.brand) return
        if (ownBrandNames.has(String(b.brand).trim())) {
          const v = normalizeShare(b.sharePercent)
          if (v !== null) {
            sum += v
            hit = true
          }
        }
      })
      if (hit) return normalizeShare(Math.min(100, sum))
    }
  }

  const products = aiReport.productIdentification
  if (Array.isArray(products) && products.length > 0 && ownBrandNames && ownBrandNames.size > 0) {
    let total = 0
    let own = 0
    products.forEach(p => {
      const fc = Number(p && p.facingCount)
      if (!Number.isFinite(fc) || fc <= 0) return
      total += fc
      const brand = p && p.brand ? String(p.brand).trim() : ''
      if (brand && ownBrandNames.has(brand)) own += fc
    })
    if (total > 0 && own > 0) {
      return normalizeShare((own / total) * 100)
    }
  }

  return null
}

function normalizeScore(value) {
  if (value === null || value === undefined || value === '') return null
  const score = Number(value)
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null
}

async function upsertDoc(collection, docId, data) {
  try {
    await db.collection(collection).doc(docId).set({
      data: Object.assign({}, data, { updatedAt: db.serverDate() })
    })
  } catch (err) {
    console.error(`写入 ${collection}/${docId} 失败:`, err)
    throw err
  }
}

function byStoreDocId(ownerOpenid, customerId, yearMonth) {
  // 文档 _id 不能含特殊字符过多；openid/customerId 一般是安全字符
  return `s_${ownerOpenid}_${customerId}_${yearMonth}`
}

function overallDocId(scope, ownerOpenid, yearMonth) {
  if (scope === 'team') return `o_team_${yearMonth}`
  return `o_user_${ownerOpenid}_${yearMonth}`
}

/**
 * 重建最近 REBUILD_MONTHS 个月的汇总。
 * 店月口径：该月该店各次可用 sharePercent 的算术平均；visitCount 为有 customerId 的拜访次数。
 * 整体口径：对该 scope 下各店月 avgSharePercent 再取平均（跳过无份额的店）。
 */
async function rebuildAll({ startedAt, lowVisitThreshold }) {
  const yearMonths = lastNYearMonths(REBUILD_MONTHS)
  const oldestYm = yearMonths[yearMonths.length - 1]
  const range = monthRange(oldestYm)
  if (!range) {
    return { success: false, error: '无法计算重建月份范围' }
  }

  const ownBrandNames = await loadOwnBrandNames()

  // key: `${openid}||${customerId}||${yearMonth}` -> agg
  const storeMap = new Map()
  let scanned = 0
  let usedShare = 0
  let skip = 0
  let timedOut = false

  while (true) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      timedOut = true
      break
    }
    // 只按时间窗口查（避免 customerId+createdAt 复合索引缺失）；无 customerId 的在内存跳过
    const res = await db.collection('inspections')
      .where({
        createdAt: _.gte(range.start)
      })
      .orderBy('createdAt', 'asc')
      .skip(skip)
      .limit(PAGE_SIZE)
      .field({
        _id: true,
        _openid: true,
        customerId: true,
        storeName: true,
        userName: true,
        createdAt: true,
        aiReport: true,
        status: true
      })
      .get()

    const rows = res.data || []
    if (rows.length === 0) break

    for (const row of rows) {
      scanned += 1
      const customerId = row.customerId && String(row.customerId).trim()
      if (!customerId) continue
      const openid = row._openid || ''
      if (!openid) continue
      const ym = toYearMonth(row.createdAt)
      if (!ym || !yearMonths.includes(ym)) continue

      const key = `${openid}||${customerId}||${ym}`
      let agg = storeMap.get(key)
      if (!agg) {
        agg = {
          ownerOpenid: openid,
          customerId,
          storeName: row.storeName || '',
          userName: row.userName || '',
          yearMonth: ym,
          visitCount: 0,
          shareSum: 0,
          shareN: 0,
          facingSum: 0,
          facingN: 0,
          scoreSum: 0,
          scoreN: 0,
          shelfVisitCount: 0,
          ownBrandPresentCount: 0,
          outOfStockCount: 0,
          noShelfPhotoCount: 0,
          lastSharePercent: null,
          lastFacingCount: null,
          lastScore: null,
          lastInspectionId: '',
          lastCreatedAt: 0
        }
        storeMap.set(key, agg)
      }

      agg.visitCount += 1
      if (row.storeName) agg.storeName = row.storeName
      if (row.userName) agg.userName = row.userName

      const ownBrandLower = new Set(Array.from(ownBrandNames).map(s => String(s || '').toLowerCase()))
      const validReport = (
        row.aiReport &&
        typeof row.aiReport === 'object' &&
        !(row.aiReport.metadata && (row.aiReport.metadata.isMock || row.aiReport.metadata.parseError))
      ) ? row.aiReport : null
      const share = extractSharePercent(validReport, ownBrandNames)
      const fs = extractFacingSummary(validReport, ownBrandLower)
      const score = validReport ? normalizeScore(validReport.score) : null
      const createdMs = row.createdAt ? new Date(row.createdAt).getTime() : 0

      if (share !== null) {
        usedShare += 1
        agg.shareSum += share
        agg.shareN += 1
      }
      if (fs.ownFacingCount !== null) {
        agg.facingSum += fs.ownFacingCount
        agg.facingN += 1
      }
      if (score !== null) {
        agg.scoreSum += score
        agg.scoreN += 1
      }
      if (validReport) {
        if (fs.hasShelfPhoto === false) {
          agg.noShelfPhotoCount += 1
        } else if (fs.hasShelfPhoto === true) {
          agg.shelfVisitCount += 1
          if (fs.ownBrandPresent === false) {
            agg.outOfStockCount += 1
          } else if (fs.ownBrandPresent === true) {
            agg.ownBrandPresentCount += 1
          }
        }
      }

      if (createdMs >= agg.lastCreatedAt) {
        agg.lastCreatedAt = createdMs
        agg.lastInspectionId = row._id || ''
        if (share !== null) agg.lastSharePercent = share
        if (fs.ownFacingCount !== null) agg.lastFacingCount = fs.ownFacingCount
        if (score !== null) agg.lastScore = score
      }
    }

    skip += rows.length
    if (rows.length < PAGE_SIZE) break
  }

  // 写出店月汇总
  let storeDocs = 0
  for (const agg of storeMap.values()) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      timedOut = true
      break
    }
    const avgShare = agg.shareN > 0 ? round1(agg.shareSum / agg.shareN) : null
    const avgFacingCount = agg.facingN > 0 ? round1(agg.facingSum / agg.facingN) : null
    const avgScore = agg.scoreN > 0 ? Math.round(agg.scoreSum / agg.scoreN) : null
    const inStockRate = agg.shelfVisitCount > 0
      ? round1((agg.ownBrandPresentCount / agg.shelfVisitCount) * 100)
      : null
    const docId = byStoreDocId(agg.ownerOpenid, agg.customerId, agg.yearMonth)
    await upsertDoc(COL_BY_STORE, docId, {
      ownerOpenid: agg.ownerOpenid,
      customerId: agg.customerId,
      storeName: agg.storeName,
      userName: agg.userName,
      yearMonth: agg.yearMonth,
      visitCount: agg.visitCount,
      avgSharePercent: avgShare,
      lastSharePercent: agg.lastSharePercent,
      avgFacingCount,
      lastFacingCount: agg.lastFacingCount,
      avgScore,
      lastScore: agg.lastScore,
      shelfVisitCount: agg.shelfVisitCount,
      ownBrandPresentCount: agg.ownBrandPresentCount,
      outOfStockCount: agg.outOfStockCount,
      noShelfPhotoCount: agg.noShelfPhotoCount,
      inStockRate,
      lastInspectionId: agg.lastInspectionId,
      shareSampleCount: agg.shareN
    })
    storeDocs += 1
  }

  // 按 scope 聚合整体：team + 每位业务员
  const userMonthStores = new Map()
  const teamMonthStores = new Map()

  for (const agg of storeMap.values()) {
    const avgShare = agg.shareN > 0 ? (agg.shareSum / agg.shareN) : null
    const avgFacing = agg.facingN > 0 ? (agg.facingSum / agg.facingN) : null
    const avgScore = agg.scoreN > 0 ? (agg.scoreSum / agg.scoreN) : null
    const storeRow = {
      customerId: agg.customerId,
      storeName: agg.storeName,
      userName: agg.userName || '',
      visitCount: agg.visitCount,
      avgSharePercent: avgShare,
      avgFacingCount: avgFacing,
      avgScore,
      shelfVisitCount: agg.shelfVisitCount,
      ownBrandPresentCount: agg.ownBrandPresentCount,
      outOfStockCount: agg.outOfStockCount,
      noShelfPhotoCount: agg.noShelfPhotoCount,
      lastScore: agg.lastScore,
      lastCreatedAt: agg.lastCreatedAt || 0
    }
    if (!userMonthStores.has(agg.ownerOpenid)) userMonthStores.set(agg.ownerOpenid, new Map())
    const um = userMonthStores.get(agg.ownerOpenid)
    if (!um.has(agg.yearMonth)) um.set(agg.yearMonth, [])
    um.get(agg.yearMonth).push(storeRow)

    if (!teamMonthStores.has(agg.yearMonth)) teamMonthStores.set(agg.yearMonth, [])
    teamMonthStores.get(agg.yearMonth).push(storeRow)
  }

  async function writeOverall(scope, ownerOpenid, yearMonth, stores) {
    const customerCount = stores.length
    const totalVisits = stores.reduce((s, x) => s + (x.visitCount || 0), 0)
    const shareVals = stores.map(s => s.avgSharePercent).filter(v => v != null && Number.isFinite(v))
    const avgSharePercent = shareVals.length > 0
      ? round1(shareVals.reduce((a, b) => a + b, 0) / shareVals.length)
      : null
    const facingVals = stores.map(s => s.avgFacingCount).filter(v => v != null && Number.isFinite(v))
    const avgFacingCount = facingVals.length > 0
      ? round1(facingVals.reduce((a, b) => a + b, 0) / facingVals.length)
      : null
    const scoreVals = stores.map(s => s.avgScore).filter(v => v != null && Number.isFinite(v))
    const avgScore = scoreVals.length > 0
      ? Math.round(scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length)
      : null
    const shelfVisitTotal = stores.reduce((s, x) => s + (x.shelfVisitCount || 0), 0)
    const presentTotal = stores.reduce((s, x) => s + (x.ownBrandPresentCount || 0), 0)
    const outOfStockCount = stores.reduce((s, x) => s + (x.outOfStockCount || 0), 0)
    const noShelfPhotoCount = stores.reduce((s, x) => s + (x.noShelfPhotoCount || 0), 0)
    const inStockRate = shelfVisitTotal > 0 ? round1((presentTotal / shelfVisitTotal) * 100) : null

    const avgVisitsPerCustomer = customerCount > 0 ? round1(totalVisits / customerCount) : 0
    const lowList = stores
      .filter(s => (s.visitCount || 0) < lowVisitThreshold)
      .map(s => {
        let lastVisitDate = ''
        if (s.lastCreatedAt) {
          const dt = new Date(s.lastCreatedAt)
          if (!isNaN(dt.getTime())) {
            lastVisitDate = `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
          }
        }
        return {
          customerId: s.customerId,
          storeName: s.storeName,
          userName: s.userName || '',
          visitCount: s.visitCount,
          avgSharePercent: s.avgSharePercent != null ? round1(s.avgSharePercent) : null,
          avgFacingCount: s.avgFacingCount != null ? round1(s.avgFacingCount) : null,
          lastScore: s.lastScore != null ? s.lastScore : null,
          lastVisitDate
        }
      })

    const docId = overallDocId(scope, ownerOpenid, yearMonth)
    await upsertDoc(COL_OVERALL, docId, {
      yearMonth,
      scope,
      ownerOpenid: scope === 'team' ? '' : ownerOpenid,
      customerCount,
      avgSharePercent,
      avgFacingCount,
      avgScore,
      inStockRate,
      shelfVisitTotal,
      outOfStockCount,
      noShelfPhotoCount,
      totalVisits,
      avgVisitsPerCustomer,
      lowVisitThreshold,
      lowVisitCount: lowList.length,
      lowVisitCustomers: lowList.slice(0, 200),
      storeShareSampleCount: shareVals.length
    })
  }

  let overallDocs = 0
  for (const [ym, stores] of teamMonthStores.entries()) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      timedOut = true
      break
    }
    await writeOverall('team', '', ym, stores)
    overallDocs += 1
  }
  for (const [openid, ymMap] of userMonthStores.entries()) {
    for (const [ym, stores] of ymMap.entries()) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
        timedOut = true
        break
      }
      await writeOverall('user', openid, ym, stores)
      overallDocs += 1
    }
  }

  return {
    success: true,
    scanned,
    usedShare,
    storeDocs,
    overallDocs,
    yearMonths,
    lowVisitThreshold,
    timedOut,
    elapsedMs: Date.now() - startedAt
  }
}

async function getOverallSnapshot(scope, ownerOpenid, yearMonth) {
  const docId = overallDocId(scope, ownerOpenid, yearMonth)
  try {
    const res = await db.collection(COL_OVERALL).doc(docId).get()
    return res.data || null
  } catch (e) {
    return null
  }
}

function deltaPct(current, baseline) {
  if (current == null || baseline == null) return null
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null
  if (baseline === 0) return null
  return round1(((current - baseline) / baseline) * 100)
}

function absDelta(current, baseline) {
  if (current == null || baseline == null) return null
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null
  return round1(current - baseline)
}

async function handleDashboard({ isManager, openid, yearMonth, compareYearMonth }) {
  const ym = yearMonth || toYearMonth(new Date())
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    return { success: false, error: 'yearMonth 格式应为 YYYY-MM' }
  }
  const scope = isManager ? 'team' : 'user'
  const ownerOpenid = isManager ? '' : openid

  const current = await getOverallSnapshot(scope, ownerOpenid, ym)
  const prevYm = shiftYearMonth(ym, -1)
  const yoyYm = shiftYearMonth(ym, -12)
  const prev = prevYm ? await getOverallSnapshot(scope, ownerOpenid, prevYm) : null
  const yoy = yoyYm ? await getOverallSnapshot(scope, ownerOpenid, yoyYm) : null

  let compare = null
  let safeCompareYm = ''
  if (compareYearMonth && /^\d{4}-\d{2}$/.test(compareYearMonth) && compareYearMonth !== ym) {
    safeCompareYm = compareYearMonth
    compare = await getOverallSnapshot(scope, ownerOpenid, safeCompareYm)
  }

  const curShare = current && current.avgSharePercent != null ? current.avgSharePercent : null
  const prevShare = prev && prev.avgSharePercent != null ? prev.avgSharePercent : null
  const yoyShare = yoy && yoy.avgSharePercent != null ? yoy.avgSharePercent : null
  const cmpShare = compare && compare.avgSharePercent != null ? compare.avgSharePercent : null

  // 兼容旧版未写 userName 的预计算快照：在打开看板时自动从店月汇总补全业务员姓名和排面占比
  let enrichedLowVisit = (current && Array.isArray(current.lowVisitCustomers))
    ? current.lowVisitCustomers
    : []
  if (enrichedLowVisit.length > 0 && enrichedLowVisit.some(c => !c.userName)) {
    try {
      const storeQuery = isManager ? { yearMonth: ym } : { yearMonth: ym, ownerOpenid: openid }
      const sRes = await db.collection(COL_BY_STORE).where(storeQuery).limit(500).get()
      const byCust = new Map()
      ;(sRes.data || []).forEach(r => {
        if (r && r.customerId) byCust.set(r.customerId, r)
      })
      enrichedLowVisit = enrichedLowVisit.map(c => {
        const hit = byCust.get(c.customerId)
        if (!hit) return c
        return Object.assign({}, c, {
          userName: c.userName || hit.userName || '',
          avgSharePercent: c.avgSharePercent != null ? c.avgSharePercent : (hit.avgSharePercent != null ? hit.avgSharePercent : null),
          lastScore: c.lastScore != null ? c.lastScore : (hit.lastScore != null ? hit.lastScore : null)
        })
      })
    } catch (_) {}
  }

  return {
    success: true,
    isManager,
    yearMonth: ym,
    metricNote: '店月排面=当月各次可用 sharePercent 算术平均；整体=各店月平均再平均。无份额记录不计入。',
    overall: current ? {
      yearMonth: ym,
      customerCount: current.customerCount || 0,
      avgSharePercent: curShare,
      avgFacingCount: current.avgFacingCount != null ? current.avgFacingCount : null,
      avgScore: current.avgScore != null ? current.avgScore : null,
      inStockRate: current.inStockRate != null ? current.inStockRate : null,
      outOfStockCount: current.outOfStockCount || 0,
      noShelfPhotoCount: current.noShelfPhotoCount || 0,
      totalVisits: current.totalVisits || 0,
      avgVisitsPerCustomer: current.avgVisitsPerCustomer != null ? current.avgVisitsPerCustomer : null,
      lowVisitThreshold: current.lowVisitThreshold != null ? current.lowVisitThreshold : DEFAULT_LOW_VISIT_THRESHOLD,
      lowVisitCount: current.lowVisitCount || 0,
      lowVisitCustomers: enrichedLowVisit,
      updatedAt: current.updatedAt || null
    } : null,
    mom: {
      compareYearMonth: prevYm,
      baselineSharePercent: prevShare,
      deltaPoints: absDelta(curShare, prevShare),
      deltaPercent: deltaPct(curShare, prevShare),
      available: prevShare != null && curShare != null
    },
    yoy: {
      compareYearMonth: yoyYm,
      baselineSharePercent: yoyShare,
      deltaPoints: absDelta(curShare, yoyShare),
      deltaPercent: deltaPct(curShare, yoyShare),
      available: yoyShare != null && curShare != null
    },
    vsMonth: safeCompareYm ? {
      compareYearMonth: safeCompareYm,
      baselineSharePercent: cmpShare,
      deltaPoints: absDelta(curShare, cmpShare),
      deltaPercent: deltaPct(curShare, cmpShare),
      available: cmpShare != null && curShare != null
    } : null,
    empty: !current
  }
}

async function handleStoreTrend({ isManager, openid, customerId, months }) {
  const cid = String(customerId || '').trim()
  if (!cid) return { success: false, error: '缺少 customerId' }

  const monthCount = Math.min(24, Math.max(1, Math.floor(Number(months) || 12)))
  const yearMonths = lastNYearMonths(monthCount)

  // 权限：业务员只能看自己名下该客户的店月；管理者可看该客户所有业务员汇总或任一条
  let query = { customerId: cid, yearMonth: _.in(yearMonths) }
  if (!isManager) {
    query.ownerOpenid = openid
  }

  let rows = []
  try {
    // 分页拉全
    let skip = 0
    while (skip < 2000) {
      const res = await db.collection(COL_BY_STORE)
        .where(query)
        .skip(skip)
        .limit(100)
        .get()
      const batch = res.data || []
      rows = rows.concat(batch)
      skip += batch.length
      if (batch.length < 100) break
    }
  } catch (err) {
    console.error('查询店月趋势失败:', err)
    return { success: false, error: err.message || '查询失败' }
  }

  // 管理者：同一客户可能被多个业务员拜访 → 按 yearMonth 合并
  const byYm = new Map()
  rows.forEach(r => {
    const ym = r.yearMonth
    if (!byYm.has(ym)) {
      byYm.set(ym, {
        yearMonth: ym,
        visitCount: 0,
        shareSum: 0,
        shareN: 0,
        facingSum: 0,
        facingN: 0,
        scoreSum: 0,
        scoreN: 0,
        storeName: r.storeName || '',
        userName: r.userName || '',
        lastInspectionId: r.lastInspectionId || ''
      })
    }
    const a = byYm.get(ym)
    a.visitCount += r.visitCount || 0
    if (r.avgSharePercent != null && Number.isFinite(r.avgSharePercent)) {
      a.shareSum += r.avgSharePercent
      a.shareN += 1
    }
    if (r.avgFacingCount != null && Number.isFinite(r.avgFacingCount)) {
      a.facingSum += r.avgFacingCount
      a.facingN += 1
    }
    if (r.avgScore != null && Number.isFinite(r.avgScore)) {
      a.scoreSum += r.avgScore
      a.scoreN += 1
    }
    if (r.storeName) a.storeName = r.storeName
    if (r.userName) a.userName = r.userName
    if (r.lastInspectionId) a.lastInspectionId = r.lastInspectionId
  })

  const series = yearMonths.slice().reverse().map(ym => {
    const a = byYm.get(ym)
    if (!a) {
      return { yearMonth: ym, visitCount: 0, avgSharePercent: null, avgFacingCount: null, avgScore: null, available: false }
    }
    return {
      yearMonth: ym,
      visitCount: a.visitCount,
      avgSharePercent: a.shareN > 0 ? round1(a.shareSum / a.shareN) : null,
      avgFacingCount: a.facingN > 0 ? round1(a.facingSum / a.facingN) : null,
      avgScore: a.scoreN > 0 ? Math.round(a.scoreSum / a.scoreN) : null,
      storeName: a.storeName,
      userName: a.userName,
      available: true
    }
  })

  const latestYm = toYearMonth(new Date())
  const cur = series.find(s => s.yearMonth === latestYm) || series[series.length - 1]
  const prevYm = shiftYearMonth(cur && cur.yearMonth, -1)
  const yoyYm = shiftYearMonth(cur && cur.yearMonth, -12)
  const prev = series.find(s => s.yearMonth === prevYm)
  const yoy = series.find(s => s.yearMonth === yoyYm)
  const curShare = cur && cur.avgSharePercent != null ? cur.avgSharePercent : null

  return {
    success: true,
    customerId: cid,
    storeName: (cur && cur.storeName) || (rows[0] && rows[0].storeName) || '',
    series,
    current: cur || null,
    mom: {
      compareYearMonth: prevYm,
      baselineSharePercent: prev && prev.avgSharePercent != null ? prev.avgSharePercent : null,
      deltaPoints: absDelta(curShare, prev && prev.avgSharePercent),
      deltaPercent: deltaPct(curShare, prev && prev.avgSharePercent),
      available: !!(prev && prev.avgSharePercent != null && curShare != null)
    },
    yoy: {
      compareYearMonth: yoyYm,
      baselineSharePercent: yoy && yoy.avgSharePercent != null ? yoy.avgSharePercent : null,
      deltaPoints: absDelta(curShare, yoy && yoy.avgSharePercent),
      deltaPercent: deltaPct(curShare, yoy && yoy.avgSharePercent),
      available: !!(yoy && yoy.avgSharePercent != null && curShare != null)
    }
  }
}

exports.main = async (event, context) => {
  const startedAt = Date.now()
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  const isInternalCall = !openid

  // 定时触发没有 action
  const action = event.action || (event.Type === 'Timer' ? 'rebuild' : 'dashboard')

  try {
    if (action === 'rebuild') {
      if (!isInternalCall) {
        const caller = await getCaller(openid)
        const { isManager, disabled } = resolveRole(caller)
        if (disabled) return { success: false, error: '账号已停用，请联系管理员' }
        if (!isManager) return { success: false, error: '只有管理员可以手动重建统计' }
      }
      const lowVisitThreshold = await loadLowVisitThreshold()
      const result = await rebuildAll({ startedAt, lowVisitThreshold })
      return result
    }

    // 以下需要登录用户
    if (!openid) {
      return { success: false, error: '未获取到用户身份' }
    }
    const caller = await getCaller(openid)
    const { isManager, disabled } = resolveRole(caller)
    if (disabled) return { success: false, error: '账号已停用，请联系管理员' }

    if (action === 'dashboard') {
      return await handleDashboard({
        isManager,
        openid,
        yearMonth: event.yearMonth,
        compareYearMonth: event.compareYearMonth
      })
    }

    if (action === 'materialStats') {
      return await handleMaterialStats({
        isManager,
        caller,
        openid,
        userNameFilter: event.userNameFilter,
        days: event.days
      })
    }

    if (action === 'storeTrend') {
      return await handleStoreTrend({
        isManager,
        openid,
        customerId: event.customerId,
        months: event.months
      })
    }

    if (action === 'setLowVisitThreshold') {
      if (!isManager) return { success: false, error: '只有管理员可以修改阈值' }
      const n = Math.floor(Number(event.threshold))
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return { success: false, error: 'threshold 应为 0-100 的整数' }
      }
      await saveLowVisitThreshold(n)
      return { success: true, lowVisitThreshold: n }
    }

    if (action === 'getLowVisitThreshold') {
      const n = await loadLowVisitThreshold()
      return { success: true, lowVisitThreshold: n }
    }

    return { success: false, error: `未知 action: ${action}` }
  } catch (err) {
    console.error(`shelfStats.${action} 失败:`, err)
    return { success: false, error: err.message || String(err) }
  }
}
