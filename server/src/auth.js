'use strict'

const crypto = require('crypto')
const axios = require('axios')
const cloud = require('./cloud-shim')
const { jwtSecret } = require('./config')

const TOKEN_PREFIX = 'sg1'

function tokenTtlMs() {
  const days = parseInt(process.env.TOKEN_TTL_DAYS || '30', 10)
  const safe = Number.isFinite(days) && days > 0 && days <= 365 ? days : 30
  return safe * 24 * 60 * 60 * 1000
}

function signToken(openid) {
  const secret = jwtSecret()
  if (!secret) throw new Error('未配置 JWT_SECRET')
  const payload = Buffer.from(JSON.stringify({
    openid,
    exp: Date.now() + tokenTtlMs()
  })).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${TOKEN_PREFIX}.${payload}.${sig}`
}

function verifyToken(token) {
  const secret = jwtSecret()
  if (!secret || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null
  const expected = crypto.createHmac('sha256', secret).update(parts[1]).digest('base64url')
  const left = Buffer.from(parts[2])
  const right = Buffer.from(expected)
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch (_) {
    return null
  }
  if (!payload || typeof payload.openid !== 'string' || !payload.openid) return null
  if (!payload.exp || payload.exp < Date.now()) return null
  return { openid: payload.openid }
}

function bearerFrom(req) {
  const header = req.headers.authorization || req.headers.Authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim())
  return m ? m[1].trim() : ''
}

function requireAuth(req, res, next) {
  const user = verifyToken(bearerFrom(req))
  if (!user) {
    return res.status(401).json({ success: false, error: '未登录或登录已过期' })
  }
  req.user = user
  return next()
}

function optionalAuth(req, _res, next) {
  const user = verifyToken(bearerFrom(req))
  if (user) req.user = user
  return next()
}

async function code2session(code) {
  const appid = process.env.WECHAT_APPID || ''
  const secret = process.env.WECHAT_SECRET || ''
  if (!appid || !secret) {
    const err = new Error('未配置 WECHAT_APPID / WECHAT_SECRET')
    err.status = 500
    throw err
  }
  if (!code || typeof code !== 'string') {
    const err = new Error('缺少登录 code')
    err.status = 400
    throw err
  }
  const res = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
    params: {
      appid,
      secret,
      js_code: code,
      grant_type: 'authorization_code'
    },
    timeout: 8000
  })
  const data = res.data || {}
  if (!data.openid) {
    const err = new Error(data.errmsg || '微信登录失败')
    err.status = 401
    throw err
  }
  return data.openid
}

function testOpenid(body) {
  if (process.env.SHELFGUARD_TEST_LOGIN !== '1') return ''
  const raw = body && body.testOpenid
  if (typeof raw !== 'string') return ''
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return ''
  return raw
}

async function loginHandler(req, res) {
  try {
    const handlers = require('./handlers')
    let openid = testOpenid(req.body)
    if (!openid) openid = await code2session(req.body && req.body.code)
    const event = Object.assign({}, req.body || {})
    delete event.code
    delete event.testOpenid
    const result = await cloud.runWithContext({ openid, source: 'client' }, () => handlers.login(event))
    const token = signToken(openid)
    return res.json(Object.assign({}, result, { token }))
  } catch (err) {
    const status = err.status || 401
    console.error('登录失败:', err.message)
    return res.status(status).json({ success: false, error: err.message || '登录失败' })
  }
}

module.exports = {
  signToken,
  verifyToken,
  requireAuth,
  optionalAuth,
  loginHandler
}
