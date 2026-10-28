// cloudfunctions/syncJxcCustomers/index.js
// 功能：从鸭鸭进销存 (jxc-app) 的 /api/v1/customers 接口增量同步客户到 ShelfGuard 的 customers 集合。
//
// 策略规则：
// 1. 业务员对齐（方式 A）：优先用进销存业务员账号手机号匹配 users.phone；
//    姓名仅在唯一命中时使用（重名不自动绑定，归管理员兜底并记入 warnings）。
// 2. 坐标对齐（策略 B）：同步过来的 location 初始为 null；已有现场打卡坐标绝不覆盖。
// 3. 运行方式：定时触发器 + 管理员手动「立即同步」。
// 4. 查询：users 分页拉全；customers 按 jxcCustomerId 批量 _.in，避免逐条 N+1。

const cloud = require('wx-server-sdk')
const http = require('http')
const https = require('https')
const { URL } = require('url')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

const SETTINGS_DOC_ID = 'global'
const ADMIN_ROLES = ['admin']
const USERS_PAGE_SIZE = 100
const USERS_HARD_CAP = 2000
const CUSTOMERS_IN_CHUNK = 20 // 微信云开发 _.in 建议一次别太大

function httpRequest(urlStr, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(urlStr)
      const isHttps = parsedUrl.protocol === 'https:'
      const client = isHttps ? https : http

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ShelfGuard-SyncBot/1.0',
          ...headers
        },
        timeout: timeoutMs
      }

      const req = client.request(options, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const data = JSON.parse(body)
              resolve({ statusCode: res.statusCode, data })
            } catch (err) {
              reject(new Error(`解析响应 JSON 失败: ${err.message}`))
            }
          } else {
            let errMsg = `HTTP ${res.statusCode}`
            try {
              const errObj = JSON.parse(body)
              if (errObj && errObj.error && errObj.error.message) {
                errMsg += `: ${errObj.error.message}`
              }
            } catch (_) {}
            reject(new Error(errMsg))
          }
        })
      })

      req.on('error', err => reject(err))
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('请求进销存接口超时'))
      })
      req.end()
    } catch (err) {
      reject(err)
    }
  })
}

async function fetchAllJxcCustomers(baseUrl, apiKey) {
  const cleanBase = baseUrl.replace(/\/+$/, '')
  const allItems = []
  let page = 1
  const pageSize = 100
  let totalPages = 1

  while (page <= totalPages && page <= 50) {
    const url = `${cleanBase}/api/v1/customers?page=${page}&size=${pageSize}`
    const res = await httpRequest(url, {
      'Authorization': `Bearer ${apiKey}`
    })

    const data = res.data || {}
    const items = data.items || []
    allItems.push(...items)

    totalPages = data.total_pages || 1
    if (items.length === 0 || page >= totalPages) {
      break
    }
    page++
  }

  return allItems
}

/** 分页拉全 users，避免 limit(100) 截断；超过硬上限时写入警告 */
async function loadAllUsers() {
  const users = []
  let skip = 0
  let truncated = false

  while (skip < USERS_HARD_CAP) {
    const res = await db.collection('users').skip(skip).limit(USERS_PAGE_SIZE).get()
    const batch = res.data || []
    users.push(...batch)
    if (batch.length < USERS_PAGE_SIZE) break
    skip += USERS_PAGE_SIZE
    if (skip >= USERS_HARD_CAP) {
      truncated = true
      break
    }
  }

  return { users, truncated, loaded: users.length }
}

/** 批量按 jxcCustomerId 拉已有客户，返回 Map(jxcId -> doc) */
async function loadCustomersByJxcIds(jxcIds) {
  const map = new Map()
  const unique = [...new Set(jxcIds.filter(id => id !== undefined && id !== null && id !== ''))]
  for (let i = 0; i < unique.length; i += CUSTOMERS_IN_CHUNK) {
    const chunk = unique.slice(i, i + CUSTOMERS_IN_CHUNK)
    try {
      const res = await db.collection('customers').where({
        jxcCustomerId: _.in(chunk)
      }).limit(100).get()
      ;(res.data || []).forEach(doc => {
        if (doc.jxcCustomerId !== undefined && doc.jxcCustomerId !== null) {
          map.set(doc.jxcCustomerId, doc)
        }
      })
    } catch (err) {
      console.error('批量查询 jxcCustomerId 失败:', err)
    }
  }
  return map
}

function buildUserMaps(users) {
  const phoneToOpenid = {}
  const nameToOpenids = {} // name -> [openid,...] 用于检测重名
  let fallbackOpenid = ''

  users.forEach(u => {
    if (u.disabled) return
    if (u.phone && String(u.phone).trim()) {
      phoneToOpenid[String(u.phone).trim()] = u._openid
    }
    if (u.name && String(u.name).trim()) {
      const n = String(u.name).trim()
      if (!nameToOpenids[n]) nameToOpenids[n] = []
      if (!nameToOpenids[n].includes(u._openid)) {
        nameToOpenids[n].push(u._openid)
      }
    }
    if (u.role === 'admin' && !fallbackOpenid) {
      fallbackOpenid = u._openid
    }
  })

  return { phoneToOpenid, nameToOpenids, fallbackOpenid }
}

function resolveTargetOpenid(item, maps, warnings) {
  const { phoneToOpenid, nameToOpenids, fallbackOpenid } = maps
  const opUsername = String(item.operator_username || '').trim()
  const opName = String(item.operator_name || '').trim()

  // 优先手机号 / 账号
  if (opUsername && phoneToOpenid[opUsername]) {
    return phoneToOpenid[opUsername]
  }

  // 姓名仅唯一命中时可用；重名归兜底并记警告
  if (opName && nameToOpenids[opName]) {
    const hits = nameToOpenids[opName]
    if (hits.length === 1) {
      return hits[0]
    }
    warnings.push(`客户「${item.name || item.id}」业务员姓名「${opName}」在 ShelfGuard 中重名(${hits.length})，已归属管理员`)
  }

  return fallbackOpenid
}

exports.main = async (event, context) => {
  const isTimerTrigger = event && (event.Type === 'Timer' || event.triggerName)
  const wxContext = cloud.getWXContext()
  const openid = wxContext ? (wxContext.OPENID || '') : ''

  if (!isTimerTrigger) {
    if (!openid) {
      return { success: false, error: '未获取到用户身份' }
    }
    const callerRes = await db.collection('users').where({ _openid: openid }).get()
    const caller = callerRes.data[0]
    if (!caller || !ADMIN_ROLES.includes(caller.role)) {
      return { success: false, error: '只有管理员可以执行进销存客户同步' }
    }
    if (caller.disabled) {
      return { success: false, error: '账号已停用，无法操作' }
    }
  }

  let jxcBaseUrl = process.env.JXC_BASE_URL || ''
  let jxcApiKey = process.env.JXC_API_KEY || ''

  try {
    const settingsRes = await db.collection('settings').doc(SETTINGS_DOC_ID).get()
    const settings = settingsRes.data || {}
    if (!jxcBaseUrl && settings.jxcBaseUrl) {
      jxcBaseUrl = settings.jxcBaseUrl
    }
    if (!jxcApiKey && settings.jxcApiKey) {
      jxcApiKey = settings.jxcApiKey
    }
  } catch (err) {
    console.warn('读取 settings 配置失败:', err.message)
  }

  if (!jxcBaseUrl || !jxcApiKey) {
    return {
      success: false,
      error: '尚未配置进销存服务地址 (jxcBaseUrl) 或 API Key，请在设置中配置'
    }
  }

  let jxcCustomers = []
  try {
    jxcCustomers = await fetchAllJxcCustomers(jxcBaseUrl, jxcApiKey)
  } catch (err) {
    console.error('从进销存拉取客户失败:', err)
    return {
      success: false,
      error: `从进销存拉取客户失败: ${err.message}`
    }
  }

  const warnings = []
  const { users, truncated, loaded } = await loadAllUsers()
  if (truncated) {
    warnings.push(`users 超过硬上限 ${USERS_HARD_CAP}，本次仅加载前 ${loaded} 条，部分业务员可能匹配不到`)
  }

  const maps = buildUserMaps(users)
  if (!maps.fallbackOpenid && openid) {
    maps.fallbackOpenid = openid
  }

  // 批量预取已有 jxc 客户，去掉逐条 where
  const jxcIds = jxcCustomers.map(c => c.id).filter(id => id !== undefined && id !== null)
  const existingByJxcId = await loadCustomersByJxcIds(jxcIds)

  let added = 0
  let updated = 0
  let unchanged = 0
  let errors = 0
  let skippedSoftDeadline = 0

  const WRITE_CONCURRENCY = 10
  const SOFT_DEADLINE_MS = 45 * 1000
  const syncStartedAt = Date.now()

  async function syncOneCustomer(item) {
    const jxcId = item.id
    const storeName = (item.name || '').trim()
    if (!storeName) return { kind: 'skip' }

    const address = (item.address || '').trim()
    const contactName = (item.contact || '').trim()
    const contactPhone = (item.phone || '').trim()
    const targetOpenid = resolveTargetOpenid(item, maps, warnings)
    const existing = existingByJxcId.get(jxcId)

    if (existing) {
      const needUpdate =
        existing.storeName !== storeName ||
        (address && existing.address !== address) ||
        (contactName && existing.contactName !== contactName) ||
        (contactPhone && existing.contactPhone !== contactPhone) ||
        (targetOpenid && existing._openid !== targetOpenid)

      if (needUpdate) {
        const updateData = {
          storeName,
          updatedAt: db.serverDate()
        }
        if (address) updateData.address = address
        if (contactName) updateData.contactName = contactName
        if (contactPhone) updateData.contactPhone = contactPhone
        if (targetOpenid) updateData._openid = targetOpenid
        await db.collection('customers').doc(existing._id).update({ data: updateData })
        return { kind: 'updated' }
      }
      return { kind: 'unchanged' }
    }

    let matchedOld = null
    if (targetOpenid) {
      try {
        const sameNameRes = await db.collection('customers').where({
          storeName,
          _openid: targetOpenid
        }).limit(5).get()
        matchedOld = (sameNameRes.data || []).find(d => !d.jxcCustomerId) || null
      } catch (_) {}
    }

    if (matchedOld) {
      await db.collection('customers').doc(matchedOld._id).update({
        data: {
          jxcCustomerId: jxcId,
          updatedAt: db.serverDate()
        }
      })
      existingByJxcId.set(jxcId, { ...matchedOld, jxcCustomerId: jxcId })
      return { kind: 'updated' }
    }

    const addRes = await db.collection('customers').add({
      data: {
        _openid: targetOpenid,
        jxcCustomerId: jxcId,
        storeName,
        address,
        contactName,
        contactPhone,
        location: null,
        isActive: true,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    existingByJxcId.set(jxcId, { _id: addRes._id, jxcCustomerId: jxcId })
    return { kind: 'added' }
  }

  for (let i = 0; i < jxcCustomers.length; i += WRITE_CONCURRENCY) {
    if (Date.now() - syncStartedAt > SOFT_DEADLINE_MS) {
      skippedSoftDeadline = jxcCustomers.length - i
      warnings.push(`写入触达软截止 ${SOFT_DEADLINE_MS / 1000}s，剩余 ${skippedSoftDeadline} 家下次继续`)
      break
    }
    const chunk = jxcCustomers.slice(i, i + WRITE_CONCURRENCY)
    const results = await Promise.all(chunk.map(async (item) => {
      try {
        return await syncOneCustomer(item)
      } catch (itemErr) {
        console.error(`同步客户 ${item.id} (${item.name}) 失败:`, itemErr)
        return { kind: 'error' }
      }
    }))
    for (const r of results) {
      if (r.kind === 'added') added++
      else if (r.kind === 'updated') updated++
      else if (r.kind === 'unchanged') unchanged++
      else if (r.kind === 'error') errors++
    }
  }

  const summary = {
    totalFetched: jxcCustomers.length,
    added,
    updated,
    unchanged,
    errors,
    skippedSoftDeadline,
    elapsedMs: Date.now() - syncStartedAt,
    usersLoaded: loaded,
    usersTruncated: truncated,
    warnings: warnings.slice(0, 20)
  }

  try {
    await db.collection('settings').doc(SETTINGS_DOC_ID).update({
      data: {
        jxcLastSyncAt: db.serverDate(),
        jxcLastSyncTriggeredBy: isTimerTrigger ? 'timer' : (openid || 'manual'),
        jxcLastSyncSummary: summary,
        updatedAt: db.serverDate()
      }
    })
  } catch (syncLogErr) {
    console.warn('回写同步记录到 settings 失败:', syncLogErr.message)
  }

  return {
    success: true,
    summary
  }
}
