// utils/location.js
// 位置获取与逆地理编码

/**
 * 获取当前位置（带权限检查）
 * @returns {Promise<{latitude, longitude}>}
 */
function getLocation() {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
      success: async res => {
        const location = {
          latitude: res.latitude,
          longitude: res.longitude
        }
        // 逆地理编码：把坐标转成路名/地标，方便水印直接显示可读地址
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
        // 某些失败场景 errMsg 可能不存在，先判空避免 TypeError 崩溃
        if (err.errMsg && (err.errMsg.indexOf('auth deny') !== -1 ||
            err.errMsg.indexOf('authorize') !== -1)) {
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
    content: '请在设置中开启位置权限，用于记录巡检门店地址',
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
  return new Promise((resolve) => {
    wx.cloud.callFunction({
      name: 'geocode',
      data: { lat, lng },
      success: (res) => {
        const r = (res && res.result) ? res.result : {}
        resolve({
          address: r.address || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
          reason: r.reason || (r.success ? '' : 'GEOCODE_FAIL')
        })
      },
      fail: (err) => resolve({
        address: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
        reason: `CALL_FAIL:${err && err.errMsg ? err.errMsg : 'unknown'}`
      })
    })
  })
}

module.exports = {
  getLocation,
  reverseGeocode,
  showLocationAuth
}
