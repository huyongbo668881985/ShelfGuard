'use strict'

const { isValidCoord, gcj02ToWgs84, formatCoordFallback } = require('./coord')

let cachedAxios = null
try {
  cachedAxios = require('axios')
} catch (_) {
  cachedAxios = null
}

async function defaultHttpGet(url, config = {}) {
  if (cachedAxios) {
    return cachedAxios.get(url, config)
  }
  const target = new URL(url)
  if (config.params && typeof config.params === 'object') {
    Object.keys(config.params).forEach(k => {
      if (config.params[k] !== undefined && config.params[k] !== null) {
        target.searchParams.set(k, String(config.params[k]))
      }
    })
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller && config.timeout
    ? setTimeout(() => controller.abort(), config.timeout)
    : null
  try {
    const res = await fetch(target.toString(), {
      method: 'GET',
      headers: config.headers || {},
      signal: controller ? controller.signal : undefined
    })
    const rawText = await res.text()
    let data = {}
    if (rawText) {
      try {
        data = JSON.parse(rawText)
      } catch (_) {
        data = { raw: rawText.slice(0, 200) }
      }
    }
    if (!res.ok) {
      const err = new Error(`Request failed with status code ${res.status}`)
      err.response = { status: res.status, data }
      throw err
    }
    return { status: res.status, data }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const TIANDITU_GEOCODER_URL = 'https://api.tianditu.gov.cn/geocoder'
const TENCENT_GEOCODER_URL = 'https://apis.map.qq.com/ws/geocoder/v1/'
// 天地图“服务器端”类型 Key 会拦截浏览器 UA（403 code:301013），需使用服务端标识 UA
const DEFAULT_USER_AGENT = 'ShelfGuard-Server/1.0'
const MAX_ADDRESS_LEN = 60

function trimText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function truncateAddress(text) {
  const s = trimText(text)
  if (!s) return ''
  return s.length > MAX_ADDRESS_LEN ? `${s.slice(0, MAX_ADDRESS_LEN - 1)}…` : s
}

function isPureAdminName(s, rawAdmin) {
  if (!s) return true
  for (const a of rawAdmin) {
    const shortA = a.replace(/[省市区县]$/, '')
    if (s === a || (shortA && s === shortA)) return true
  }
  return false
}

function stripAdminPrefix(text, comp) {
  let s = trimText(text)
  if (!s || !comp) return s
  const rawAdmin = [comp.province, comp.city, comp.county, comp.town]
    .map(trimText)
    .filter(Boolean)
  // 若整个文本仅重复了省/市/区/街道名称（如 "北京市"、"北京" 或裁掉省后仅剩 "杭州市"），视为无效街道/POI
  if (isPureAdminName(s, rawAdmin)) return ''
  for (const p of rawAdmin) {
    if (s.startsWith(p)) {
      s = s.slice(p.length).trim()
      if (isPureAdminName(s, rawAdmin)) return ''
    }
  }
  return s
}

function formatHttpErrorDetail(err) {
  const base = err && err.message ? err.message : 'unknown'
  const respData = err && err.response && err.response.data
  if (respData && typeof respData === 'object') {
    const code = respData.code ?? respData.status
    const msg = trimText(respData.msg || respData.message || respData.resolve)
    const parts = [code, msg].filter(v => v !== undefined && v !== null && v !== '')
    if (parts.length > 0) {
      return `${base}[${parts.join(':')}]`
    }
  }
  return base
}

/**
 * 将天地图逆地理结果格式化为适合水印和门店卡片的简洁路名/地标。
 * 彻底剔除易出错的 town 字段，按「区/县(回退市) + 路名 + 标志性建筑/小区(回退 address)」优先级拼接；
 * 结构化要素全部缺失时再退回 formatted_address。
 */
function formatTiandituAddress(result) {
  if (!result || typeof result !== 'object') return ''
  const comp = result.addressComponent && typeof result.addressComponent === 'object'
    ? result.addressComponent
    : {}

  const area = trimText(comp.county) || trimText(comp.city)
  const road = stripAdminPrefix(comp.road, comp)
  const cleanPoi = stripAdminPrefix(comp.poi, comp)
  const cleanAddr = stripAdminPrefix(comp.address, comp)
  const poi = cleanPoi || cleanAddr
  const poiFromAddress = !cleanPoi && Boolean(cleanAddr)
  const formatted = trimText(result.formatted_address)

  let body = ''
  if (road && poi) {
    if (poi.includes(road)) {
      body = poi
    } else if (road.includes(poi)) {
      body = road
    } else if (poiFromAddress && /^\d+/.test(poi)) {
      // poi 为空回退到 address 且仅为纯门牌号（如 "31号"）时直接拼接，不加括号
      body = `${road}${poi}`
    } else {
      body = `${road}(${poi})`
    }
  } else {
    body = road || poi
  }

  const town = trimText(comp.town)
  if (!body && formatted) {
    let strippedFormatted = stripAdminPrefix(formatted, comp)
    if (town && strippedFormatted.includes(town)) {
      strippedFormatted = strippedFormatted.replace(town, '').trim()
    }
    if (strippedFormatted) {
      body = strippedFormatted
    }
  }

  if (body) {
    const withArea = area && !body.startsWith(area) ? `${area}${body}` : body
    return truncateAddress(withArea)
  }
  if (area) return truncateAddress(area)
  if (formatted) {
    const cleanedFormatted = town && formatted.includes(town)
      ? formatted.replace(town, '').trim()
      : formatted
    return truncateAddress(cleanedFormatted || formatted)
  }
  return ''
}

/**
 * 调用天地图逆地理编码（输入为 GCJ-02，内部自动转为 WGS-84/CGCS2000 后请求天地图）。
 */
async function reverseGeocodeTianditu(lat, lng, key, deps = {}) {
  const httpGet = deps.httpGet || defaultHttpGet
  const fallback = formatCoordFallback(lat, lng)
  const wgs = gcj02ToWgs84(lat, lng)

  try {
    const res = await httpGet(TIANDITU_GEOCODER_URL, {
      params: {
        type: 'geocode',
        tk: key,
        postStr: JSON.stringify({
          lon: Number(wgs.lng.toFixed(6)),
          lat: Number(wgs.lat.toFixed(6)),
          ver: 1
        })
      },
      headers: {
        'User-Agent': DEFAULT_USER_AGENT
      },
      timeout: deps.timeoutMs || 8000
    })

    const data = (res && res.data) || {}
    if (String(data.status) !== '0' || !data.result) {
      const msg = trimText(data.msg) || 'unknown'
      console.log('[geocode] 天地图返回错误 status=', data.status, 'msg=', msg)
      return {
        success: false,
        address: fallback,
        reason: `TIANDITU_API_ERROR(${data.status ?? 'unknown'}:${msg})`,
        provider: 'tianditu'
      }
    }

    const resolved = formatTiandituAddress(data.result)
    if (!resolved) {
      console.log('[geocode] 天地图未返回有效地址文本', data.result)
      return {
        success: false,
        address: fallback,
        reason: 'TIANDITU_EMPTY_ADDRESS',
        provider: 'tianditu'
      }
    }
    return {
      success: true,
      address: resolved,
      reason: '',
      provider: 'tianditu'
    }
  } catch (err) {
    const errDetail = formatHttpErrorDetail(err)
    console.log('[geocode] 天地图请求异常', errDetail)
    return {
      success: false,
      address: fallback,
      reason: `TIANDITU_REQ_ERROR(${errDetail})`,
      provider: 'tianditu'
    }
  }
}

/**
 * 调用腾讯地图逆地理编码（过渡兜底用，直传 GCJ-02）。
 */
async function reverseGeocodeTencent(lat, lng, key, deps = {}) {
  const httpGet = deps.httpGet || defaultHttpGet
  const fallback = formatCoordFallback(lat, lng)

  try {
    const url = `${TENCENT_GEOCODER_URL}?location=${lat},${lng}&key=${encodeURIComponent(key)}&get_poi=0`
    const res = await httpGet(url, { timeout: deps.timeoutMs || 8000 })
    const data = (res && res.data) || {}

    if (data.status !== 0) {
      console.log('[geocode] 腾讯地图返回错误 status=', data.status, 'message=', data.message)
      return {
        success: false,
        address: fallback,
        reason: `API_ERROR(${data.status}:${data.message || 'unknown'})`,
        provider: 'tencent'
      }
    }

    const result = data.result || {}
    const comp = result.address_component || {}
    const fa = result.formatted_addresses || {}
    const recommend = fa.recommend || fa.standard_address || ''
    const street = [comp.street, comp.street_number].filter(Boolean).join('')
    const resolved = trimText(recommend || street || result.address)
    if (!resolved) {
      return {
        success: false,
        address: fallback,
        reason: 'TENCENT_EMPTY_ADDRESS',
        provider: 'tencent'
      }
    }

    return {
      success: true,
      address: resolved,
      reason: '',
      provider: 'tencent'
    }
  } catch (err) {
    const errMsg = err && err.message ? err.message : 'unknown'
    console.log('[geocode] 腾讯地图请求异常', errMsg)
    return {
      success: false,
      address: fallback,
      reason: `DEP_OR_API_ERROR(${errMsg})`,
      provider: 'tencent'
    }
  }
}

/**
 * 统一逆地理入口：
 * - 默认优先天地图（TIANDITU_KEY），失败或未配置时若存在 TENCENT_MAP_KEY 自动兜底。
 * - 可通过 GEOCODE_PROVIDER=tianditu|tencent|auto 显式指定模式。
 */
async function reverseGeocodeCoords(lat, lng, options = {}) {
  const numLat = Number(lat)
  const numLng = Number(lng)
  if (!isValidCoord(numLat, numLng)) {
    return { success: false, address: '', reason: 'PARAM_INVALID', error: '坐标不合法' }
  }

  const env = options.env || process.env
  const tiandituKey = trimText(options.tiandituKey !== undefined ? options.tiandituKey : env.TIANDITU_KEY)
  const tencentKey = trimText(options.tencentKey !== undefined ? options.tencentKey : env.TENCENT_MAP_KEY)
  const rawProvider = trimText(options.provider !== undefined ? options.provider : env.GEOCODE_PROVIDER).toLowerCase()
  const provider = rawProvider === 'tianditu' || rawProvider === 'tencent' ? rawProvider : 'auto'
  const fallback = formatCoordFallback(numLat, numLng)
  const deps = { httpGet: options.httpGet, timeoutMs: options.timeoutMs }

  if (provider === 'tianditu') {
    if (!tiandituKey) {
      return { success: false, address: fallback, reason: 'NO_KEY' }
    }
    return reverseGeocodeTianditu(numLat, numLng, tiandituKey, deps)
  }

  if (provider === 'tencent') {
    if (!tencentKey) {
      return { success: false, address: fallback, reason: 'NO_KEY' }
    }
    return reverseGeocodeTencent(numLat, numLng, tencentKey, deps)
  }

  // auto 模式：优先天地图，必要时过渡兜底腾讯地图
  if (tiandituKey) {
    const tdtRes = await reverseGeocodeTianditu(numLat, numLng, tiandituKey, deps)
    if (tdtRes.success) return tdtRes

    if (tencentKey) {
      console.warn(`[geocode] 天地图失败(${tdtRes.reason})，已自动兜底腾讯地图`)
      const txRes = await reverseGeocodeTencent(numLat, numLng, tencentKey, deps)
      if (txRes.success) {
        return { ...txRes, fallbackFrom: 'tianditu' }
      }
      return {
        success: false,
        address: fallback,
        reason: `${tdtRes.reason};FALLBACK:${txRes.reason}`
      }
    }
    return tdtRes
  }

  if (tencentKey) {
    return reverseGeocodeTencent(numLat, numLng, tencentKey, deps)
  }

  console.log('[geocode] 未配置 TIANDITU_KEY 或 TENCENT_MAP_KEY 环境变量')
  return { success: false, address: fallback, reason: 'NO_KEY' }
}

module.exports = {
  formatTiandituAddress,
  reverseGeocodeTianditu,
  reverseGeocodeTencent,
  reverseGeocodeCoords
}
