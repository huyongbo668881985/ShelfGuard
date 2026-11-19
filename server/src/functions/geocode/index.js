// 云函数：geocode
// 功能：逆地理编码（坐标 -> 路名/地标），优先调用天地图 API，过渡期可自动兜底腾讯地图
// 放在服务端做的好处：不需要在小程序后台配置 request 合法域名白名单，
// 且 API Key 只存在于服务端环境变量，不会暴露在前端代码里。

const cloud = require('../../cloud-shim')
const { isValidCoord } = require('../../utils/coord')
const { reverseGeocodeCoords } = require('../../utils/geocode-service')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 简单内存限流：每 openid 滑动窗口约 30 次/分钟（冷启动清零可接受）
const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const rateBuckets = new Map()

function checkRateLimit(openid) {
  const now = Date.now()
  let bucket = rateBuckets.get(openid)
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 }
    rateBuckets.set(openid, bucket)
  }
  bucket.count += 1
  // 防止 Map 无限增长：偶发清理过期桶
  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) {
      if (now - v.windowStart >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k)
    }
  }
  return bucket.count <= RATE_LIMIT_MAX
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  if (!openid) {
    return { success: false, address: '', reason: 'NO_OPENID', error: '未获取到用户身份' }
  }

  // 停用账号拒绝消耗地图额度
  try {
    const userRes = await db.collection('users').where({ _openid: openid }).limit(1).get()
    const user = userRes.data[0]
    if (user && user.disabled) {
      return { success: false, address: '', reason: 'DISABLED', error: '账号已停用' }
    }
  } catch (e) {
    console.warn('[geocode] 查用户失败，继续限流校验:', e.message)
  }

  if (!checkRateLimit(openid)) {
    return { success: false, address: '', reason: 'RATE_LIMIT', error: '调用过于频繁，请稍后再试' }
  }

  const lat = Number(event.lat)
  const lng = Number(event.lng)
  if (!isValidCoord(lat, lng)) {
    console.log('[geocode] 非法坐标', event)
    return { success: false, address: '', reason: 'PARAM_INVALID', error: '坐标不合法' }
  }

  return reverseGeocodeCoords(lat, lng)
}
