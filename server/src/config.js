'use strict'

function basePath() {
  let p = process.env.BASE_PATH || '/shelfguard'
  if (!p.startsWith('/')) p = `/${p}`
  if (p.length > 1) p = p.replace(/\/+$/, '')
  if (p === '/') return ''
  return p
}

function publicBase() {
  return (process.env.PUBLIC_BASE_URL || 'https://game.yft8.cn').replace(/\/+$/, '')
}

function port() {
  const n = parseInt(process.env.PORT || '3100', 10)
  return Number.isFinite(n) && n > 0 ? n : 3100
}

function jwtSecret() {
  return process.env.JWT_SECRET || ''
}

function fileUrlSecret() {
  return process.env.FILE_URL_SECRET || jwtSecret()
}

module.exports = {
  basePath,
  publicBase,
  port,
  jwtSecret,
  fileUrlSecret
}
