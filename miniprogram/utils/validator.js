// utils/validator.js
// 数据验证工具

/**
 * 验证巡检数据完整性
 */
function validateInspection(data) {
  const errors = []

  if (!data.photoPath && (!data.photos || data.photos.length === 0)) {
    errors.push('请至少拍摄一张照片')
  }

  if (!data.taskName || !data.taskName.trim()) {
    errors.push('请填写任务名称')
  }

  // 注意：位置（location）不在此处做必填校验。
  // camera 页在 confirmPhoto 里对“定位失败”有专门的弹窗兜底（继续 / 重新定位），
  // 若这里强制要求 location，会因校验失败把“拍照→下一步”主链路卡死。
  // 如果调用方确实需要校验位置，应传入有效坐标；latitude 为 0（如赤道）也视为有效。

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * 验证用户信息
 */
function validateUserInfo(data) {
  const errors = []

  if (!data.name || !data.name.trim()) {
    errors.push('请填写姓名')
  }

  if (data.phone && !/^1[3-9]\d{9}$/.test(data.phone)) {
    errors.push('手机号格式不正确')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * 验证图片有效性
 */
function isValidImagePath(path) {
  if (!path) return false
  return path.startsWith('wxfile://') || 
    path.startsWith('http://') || 
    path.startsWith('https://') ||
    path.startsWith('/tmp/')
}

/**
 * 验证云文件 ID
 */
function isValidFileID(fileID) {
  if (!fileID) return false
  return fileID.startsWith('cloud://')
}

module.exports = {
  validateInspection,
  validateUserInfo,
  isValidImagePath,
  isValidFileID
}
