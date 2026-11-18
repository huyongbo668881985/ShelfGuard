// utils/location.js
// 位置获取与逆地理编码

const api = require('./api')
/**
 * 获取当前位置（带权限检查）
 * @param {object} [options]
 * @param {boolean} [options.silent=false] 为 true 时静默失败，不弹权限引导弹窗
 * @returns {Promise<{latitude, longitude}>}
 */
function getLocation(options = {}) {
  const silent = !!(options && options.silent)
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
      success: async res => {
        const location = {
          latitude: res.latitude,
          longitude: res.longitude
        }
        // 逆地理编码：把坐标转成路名/地标，失败时静默降级为坐标
        try {
          const geo = await reverseGeocode(res.latitude, res.longitude)
          location.address = geo.address
          location.geoReason = geo.reason
        } catch (e) {
          location.address = `${res.latitude.toFixed(6)}, ${res.longitude.toFixed(6)}`
          location.geoReason = 'CALL_FAIL'
        }
        resolve(location)
      },
      fail: err => {
        // 静默模式下失败不弹窗；非静默模式（用户主动点击定位）才引导开启位置权限
        const msg = String((err && err.errMsg) || '').toLowerCase()
        if (!silent && (msg.includes('auth deny') || msg.includes('auth denied') || msg.includes('authorize'))) {
          showLocationAuth()
        }
        reject(err)
      }
    })
  })
}

/**
 * 引导用户开启位置权限
 */
function showLocationAuth() {
  wx.showModal({
    title: '需要位置权限',
    content: '请在设置中开启位置权限，用于记录拜访门店地址',
    confirmText: '去设置',
    success: res => {
      if (res.confirm) {
        wx.openSetting()
      }
    }
  })
}

/**
 * 逆地理编码（腾讯地图）
 * 注意：微信小程序没有内置的 wx.reverseGeocoder 这样的原生 API，
 * 必须走腾讯地图（调用 geocode 云函数，避免在前端暴露 Key、也避免配置域名白名单）。
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string>} 地址文本
 */
function reverseGeocode(lat, lng) {
  return api.callFunction({
    name: 'geocode',
    data: { lat, lng }
  }).then(res => {
    const r = (res && res.result) ? res.result : {}
    return {
      address: r.address || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      reason: r.reason || (r.success ? '' : 'GEOCODE_FAIL')
    }
  }).catch(err => ({
    address: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    reason: `CALL_FAIL:${err && (err.errMsg || err.message) ? (err.errMsg || err.message) : 'unknown'}`
  }))
}

module.exports = {
  getLocation,
  reverseGeocode,
  showLocationAuth
}
