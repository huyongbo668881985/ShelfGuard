// utils/auth.js
// 权限检查与引导

/**
 * 检查并请求权限
 * @param {string} scope 权限 scope
 * @param {string} desc 权限说明
 * @returns {Promise<boolean>}
 */
function checkAuth(scope, desc) {
  return new Promise((resolve) => {
    wx.authorize({
      scope,
      success: () => resolve(true),
      fail: () => {
        // 用户拒绝过，引导去设置页
        wx.showModal({
          title: '需要权限',
          content: desc,
          confirmText: '去设置',
          cancelText: '取消',
          success: res => {
            if (res.confirm) {
              wx.openSetting({
                success: settingRes => {
                  resolve(!!settingRes.authSetting[scope])
                },
                fail: () => resolve(false)
              })
            } else {
              resolve(false)
            }
          }
        })
      }
    })
  })
}

/**
 * 检查相机权限
 */
function checkCameraAuth() {
  return checkAuth('scope.camera', '需要使用相机拍摄货架陈列照片')
}

/**
 * 检查位置权限
 */
function checkLocationAuth() {
  return checkAuth('scope.userLocation', '需要获取位置用于记录巡检门店地址')
}

/**
 * 检查相册权限
 */
function checkAlbumAuth() {
  return checkAuth('scope.writePhotosAlbum', '需要相册权限用于保存照片')
}

/**
 * 检查权限状态（不弹窗）
 */
function getAuthStatus(scope) {
  return new Promise((resolve) => {
    wx.getSetting({
      success: res => {
        resolve({
          authorized: res.authSetting[scope] === true,
          denied: res.authSetting[scope] === false,
          unknown: res.authSetting[scope] === undefined
        })
      },
      fail: () => {
        resolve({ authorized: false, denied: false, unknown: true })
      }
    })
  })
}

module.exports = {
  checkAuth,
  checkCameraAuth,
  checkLocationAuth,
  checkAlbumAuth,
  getAuthStatus
}
