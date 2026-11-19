'use strict'

const PI = Math.PI
const AXIS_A = 6378245.0
const EE = 0.00669342162296594323

function isValidCoord(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  if (lat < -90 || lat > 90) return false
  if (lng < -180 || lng > 180) return false
  // 拒绝明显无效的 0,0
  if (lat === 0 && lng === 0) return false
  return true
}

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

function gcj02Delta(lat, lng) {
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((AXIS_A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((AXIS_A / sqrtMagic) * Math.cos(radLat) * PI)
  return { dLat, dLng }
}

/**
 * 将 GCJ-02（火星坐标）转换为 WGS-84 / CGCS2000 坐标（用于天地图接口请求）。
 * 境外坐标保持原值不变。
 */
function gcj02ToWgs84(lat, lng) {
  if (!isValidCoord(lat, lng) || outOfChina(lat, lng)) {
    return { lat, lng }
  }
  const { dLat, dLng } = gcj02Delta(lat, lng)
  return {
    lat: lat - dLat,
    lng: lng - dLng
  }
}

/**
 * 判断地址文本是否为空或仅包含纯经纬度坐标（如 "30.250000, 120.160000"）。
 * 用于老客户地址的平滑补全识别。
 */
function isCoordinateAddress(addr) {
  if (typeof addr !== 'string') return true
  const s = addr.trim()
  if (!s) return true
  return /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(s)
}

function formatCoordFallback(lat, lng) {
  return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`
}

/**
 * 计算两点间的球面距离（单位：公里，Haversine 公式）。
 */
function distanceInKm(lat1, lng1, lat2, lng2) {
  const toRad = deg => (deg * PI) / 180
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

module.exports = {
  isValidCoord,
  outOfChina,
  gcj02ToWgs84,
  isCoordinateAddress,
  formatCoordFallback,
  distanceInKm
}
