// utils/album.js
// 手动保存图片到系统相册（统一处理安卓/iOS 权限与隐私拒绝文案）

function isAlbumAuthDenyError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '').toLowerCase()
  return (
    msg.includes('auth deny') ||
    msg.includes('auth denied') ||
    msg.includes('authorize') ||
    msg.includes('privacy')
  )
}

function showAlbumAuthModal() {
  wx.showModal({
    title: '需要相册权限',
    content: '请在设置中开启相册权限，用于保存拜访照片',
    confirmText: '去设置',
    success: (r) => {
      if (r.confirm) wx.openSetting()
    }
  })
}

/**
 * 批量保存本地图片到系统相册（仅在用户主动点击保存时调用）
 * @param {string[]} filePaths 本地图片路径列表
 * @returns {Promise<{saved: number, total: number, denied: boolean}>}
 */
async function saveImagesToAlbum(filePaths) {
  const list = (filePaths || []).filter(Boolean)
  if (list.length === 0) {
    wx.showToast({ title: '没有可保存的照片', icon: 'none' })
    return { saved: 0, total: 0, denied: false }
  }

  const multi = list.length > 1
  wx.showLoading({
    title: multi ? `保存中 0/${list.length}` : '正在保存...',
    mask: true
  })

  let ok = 0
  let denied = false
  for (let i = 0; i < list.length; i++) {
    if (multi) {
      wx.showLoading({ title: `保存中 ${i + 1}/${list.length}`, mask: true })
    }
    try {
      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath: list[i],
          success: resolve,
          fail: reject
        })
      })
      ok++
    } catch (err) {
      if (isAlbumAuthDenyError(err)) {
        denied = true
        break
      }
    }
  }

  wx.hideLoading()

  if (denied) {
    showAlbumAuthModal()
    return { saved: ok, total: list.length, denied: true }
  }

  if (ok === 0) {
    wx.showToast({ title: '保存失败', icon: 'none' })
    return { saved: 0, total: list.length, denied: false }
  }

  if (list.length === 1) {
    wx.showToast({ title: '已存入系统相册', icon: 'success' })
  } else {
    wx.showToast({
      title: ok === list.length ? `已全部存入（${ok}张）` : `已保存 ${ok}/${list.length} 张`,
      icon: ok === list.length ? 'success' : 'none'
    })
  }
  return { saved: ok, total: list.length, denied: false }
}

module.exports = {
  isAlbumAuthDenyError,
  showAlbumAuthModal,
  saveImagesToAlbum
}
