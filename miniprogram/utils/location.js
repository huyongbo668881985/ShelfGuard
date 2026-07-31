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
      success: res => {
        resolve({
          latitude: res.latitude,
          longitude: res.longitude
        })
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
 * 需要在云函数中调用，避免暴露 API Key
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string>} 地址文本
 */
function reverseGeocode(lat, lng) {
  return new Promise((resolve) => {
    // 使用微信内置的逆地理编码能力（需配置腾讯地图 Key）
    // 这里简化处理，实际项目中建议通过云函数调用
    resolve(`${lat.toFixed(6)}, ${lng.toFixed(6)}`)
  })
}

module.exports = {
  getLocation,
  reverseGeocode,
  showLocationAuth
}
