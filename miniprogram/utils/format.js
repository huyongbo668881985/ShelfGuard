// utils/format.js
// 格式化工具

/**
 * 格式化文件大小
 */
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0B'
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

/**
 * 格式化评分等级
 * 与 AI 报告（analyzeImage 的 SYSTEM_PROMPT / validateAndNormalize）及数据库口径保持一致：
 * ≥90 卓越 / 80 优秀 / 70 良好 / 60 一般 / 40 较差 / <40 不合格
 */
function formatScoreLevel(score) {
  if (score >= 90) return { level: '卓越', color: '#2e7d32' }
  if (score >= 80) return { level: '优秀', color: '#4caf50' }
  if (score >= 70) return { level: '良好', color: '#8bc34a' }
  if (score >= 60) return { level: '一般', color: '#ff9800' }
  if (score >= 40) return { level: '较差', color: '#ff5722' }
  return { level: '不合格', color: '#f44336' }
}

/**
 * 格式化状态文本
 */
function formatStatus(status) {
  const map = {
    'uploaded': { text: '待分析', color: '#ff9800' },
    'analyzing': { text: '分析中', color: '#2196f3' },
    'analyzed': { text: '已完成', color: '#4caf50' },
    'analyze_failed': { text: '分析失败', color: '#f44336' }
  }
  return map[status] || { text: '未知', color: '#999' }
}

/**
 * 截断文本
 */
function truncate(text, maxLength = 50) {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + '...'
}

/**
 * 格式化数字（如 1234 → 1.2k）
 */
function formatNumber(num) {
  if (!num) return '0'
  if (num < 1000) return String(num)
  if (num < 10000) return (num / 1000).toFixed(1) + 'k'
  return (num / 10000).toFixed(1) + 'w'
}

module.exports = {
  formatFileSize,
  formatScoreLevel,
  formatStatus,
  truncate,
  formatNumber
}
