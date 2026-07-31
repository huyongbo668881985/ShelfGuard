// utils/compress.js
// 智能图片压缩工具

/**
 * 智能压缩图片到目标大小范围
 * @param {string} src 原图路径
 * @param {object} options 配置选项
 * @param {number} options.targetSize 目标大小（KB），默认 700
 * @param {number} options.minSize 最小可接受大小（KB），默认 600
 * @param {number} options.maxSize 最大可接受大小（KB），默认 800
 * @param {number} options.maxWidth 最大宽度，默认 1920
 * @param {number} options.minQuality 最低质量，默认 50
 * @returns {Promise<{tempFilePath: string, size: number}>}
 */
async function smartCompress(src, options = {}) {
  const {
    targetSize = 700,      // 目标 700KB
    minSize = 600,         // 最小 600KB
    maxSize = 800,         // 最大 800KB
    maxWidth = 1920,       // 最大宽度
    minQuality = 50        // 最低质量
  } = options

  // 获取原图信息
  const imgInfo = await getImageInfo(src)
  const originalSize = imgInfo.size / 1024 // KB

  console.log(`[压缩] 原图大小: ${originalSize.toFixed(1)}KB, 尺寸: ${imgInfo.width}x${imgInfo.height}`)

  // 如果原图已经很小，直接返回
  if (originalSize <= maxSize) {
    console.log(`[压缩] 原图已满足大小要求，跳过压缩`)
    return { tempFilePath: src, size: originalSize }
  }

  // 渐进式压缩策略
  let quality = 85
  let width = Math.min(imgInfo.width, maxWidth)
  let compressedPath = src
  let compressedSize = originalSize

  // 最多尝试 5 次
  for (let attempt = 0; attempt < 5; attempt++) {
    console.log(`[压缩] 第 ${attempt + 1} 次尝试: quality=${quality}, width=${width}`)

    try {
      const result = await compressOnce(src, quality, width)
      compressedPath = result.tempFilePath
      compressedSize = result.size / 1024

      console.log(`[压缩] 压缩后大小: ${compressedSize.toFixed(1)}KB`)

      // 检查是否在目标范围内
      if (compressedSize >= minSize && compressedSize <= maxSize) {
        console.log(`[压缩] 达到目标范围，完成`)
        return { tempFilePath: compressedPath, size: compressedSize }
      }

      // 如果还是太大，降低质量或宽度
      if (compressedSize > maxSize) {
        if (quality > minQuality) {
          quality = Math.max(minQuality, quality - 15)
        } else if (width > 1280) {
          width = 1280
        } else if (width > 800) {
          width = 800
        } else {
          // 已经很小了，停止压缩
          break
        }
      } else {
        // 太小了，提高质量
        quality = Math.min(95, quality + 10)
      }
    } catch (err) {
      console.error(`[压缩] 第 ${attempt + 1} 次失败:`, err)
      break
    }
  }

  console.log(`[压缩] 最终结果: ${compressedSize.toFixed(1)}KB`)
  return { tempFilePath: compressedPath, size: compressedSize }
}

/**
 * 单次压缩
 */
function compressOnce(src, quality, compressedWidth) {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src,
      quality,
      compressedWidth,
      success: res => {
        // 获取压缩后的文件大小
        wx.getFileInfo({
          filePath: res.tempFilePath,
          success: infoRes => {
            resolve({
              tempFilePath: res.tempFilePath,
              size: infoRes.size
            })
          },
          fail: err => {
            // 获取文件大小失败，但压缩成功
            resolve({
              tempFilePath: res.tempFilePath,
              size: 0
            })
          }
        })
      },
      fail: reject
    })
  })
}

/**
 * 获取图片信息
 */
function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: res => {
        wx.getFileInfo({
          filePath: src,
          success: infoRes => {
            resolve({
              width: res.width,
              height: res.height,
              size: infoRes.size,
              type: res.type
            })
          },
          fail: err => {
            resolve({
              width: res.width,
              height: res.height,
              size: 0,
              type: res.type
            })
          }
        })
      },
      fail: reject
    })
  })
}

/**
 * 简单压缩（兼容旧接口）
 */
function compressImage(src, quality = 70, maxWidth = 1280) {
  return new Promise((resolve) => {
    wx.compressImage({
      src,
      quality,
      compressedWidth: maxWidth,
      success: res => {
        resolve(res.tempFilePath)
      },
      fail: err => {
        console.warn('压缩失败，使用原图:', err)
        resolve(src)
      }
    })
  })
}

module.exports = {
  smartCompress,
  compressImage,
  getImageInfo
}
