// utils/date.js
// 日期格式化工具

/**
 * 格式化日期
 * @param {Date|string|number} date 日期
 * @param {string} fmt 格式，默认 'YYYY-MM-DD HH:mm:ss'
 * @returns {string}
 */
function formatDate(date, fmt = 'YYYY-MM-DD HH:mm:ss') {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''

  const map = {
    'YYYY': d.getFullYear(),
    'MM': String(d.getMonth() + 1).padStart(2, '0'),
    'DD': String(d.getDate()).padStart(2, '0'),
    'HH': String(d.getHours()).padStart(2, '0'),
    'mm': String(d.getMinutes()).padStart(2, '0'),
    'ss': String(d.getSeconds()).padStart(2, '0')
  }

  let result = fmt
  for (const key in map) {
    result = result.replace(key, String(map[key]))
  }
  return result
}

/**
 * 获取相对时间描述（如 "3分钟前"）
 * @param {Date|string|number} date
 * @returns {string}
 */
function timeAgo(date) {
  if (!date) return ''
  const now = Date.now()
  const d = new Date(date).getTime()
  if (isNaN(d)) return ''
  
  const diff = now - d

  if (diff < 0) return '刚刚'
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)}小时前`
  if (diff < 7 * 86400 * 1000) return `${Math.floor(diff / 86400000)}天前`
  
  // 超过 7 天显示具体日期
  const dateObj = new Date(d)
  const nowObj = new Date(now)
  
  // 同一年
  if (dateObj.getFullYear() === nowObj.getFullYear()) {
    return `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`
  }
  
  return `${dateObj.getFullYear()}年${dateObj.getMonth() + 1}月${dateObj.getDate()}日`
}

/**
 * 判断是否是今天
 */
function isToday(date) {
  const d = new Date(date)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
}

/**
 * 判断是否是本周
 */
function isThisWeek(date) {
  const d = new Date(date)
  const now = new Date()
  const weekAgo = new Date(now)
  weekAgo.setDate(now.getDate() - 7)
  return d >= weekAgo && d <= now
}

/**
 * 获取日期范围描述
 */
function getDateRangeLabel(filterDate) {
  const labels = {
    'today': '今天',
    'week': '近7天',
    'month': '近30天'
  }
  return labels[filterDate] || '全部'
}

module.exports = {
  formatDate,
  timeAgo,
  isToday,
  isThisWeek,
  getDateRangeLabel
}
