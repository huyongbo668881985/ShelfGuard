'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const db = require('./docdb')
const { publicBase, basePath, fileUrlSecret } = require('./config')

const URL_TTL_MS = 2 * 60 * 60 * 1000
const DATA_URL_MAX_BYTES = 3 * 1024 * 1024

function filesRoot() {
  return path.join(require('./docdb')._internal.dataDir(), 'files')
}

function safeRel(rel) {
  if (typeof rel !== 'string') return null
  let value = rel.replace(/\\/g, '/')
  if (value.startsWith('sg://')) value = value.slice('sg://'.length)
  value = value.replace(/^\/+/, '')
  if (!value || value.includes('..') || value.includes('\0')) return null
  if (!/^(inspections\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._-]{1,180}|products\/[A-Za-z0-9._-]{1,180})$/.test(value)) {
    return null
  }
  return value
}

function absPath(rel) {
  const root = path.resolve(filesRoot())
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

function sign(rel, exp) {
  const secret = fileUrlSecret()
  if (!secret) throw new Error('未配置 FILE_URL_SECRET / JWT_SECRET')
  return crypto.createHmac('sha256', secret)
    .update(`${rel}|${exp}`)
    .digest('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function signedUrl(rel) {
  const exp = Date.now() + URL_TTL_MS
  const sig = sign(rel, exp)
  const encoded = rel.split('/').map(encodeURIComponent).join('/')
  return `${publicBase()}${basePath()}/files/${encoded}?exp=${exp}&sig=${encodeURIComponent(sig)}`
}

function mimeOf(rel) {
  const ext = path.extname(rel).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/jpeg'
}

function fileIdOf(rel) {
  return `sg://${rel}`
}

async function getCallerUser(openid) {
  if (!openid) return null
  const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
  return res.data[0] || null
}

async function isAdmin(openid) {
  const user = await getCallerUser(openid)
  return !!(user && user.role === 'admin' && !user.disabled)
}

async function isManager(openid) {
  const user = await getCallerUser(openid)
  return !!(user && (user.role === 'admin' || user.role === 'manager') && !user.disabled)
}

async function isDisabled(openid) {
  const user = await getCallerUser(openid)
  return !!(user && user.disabled)
}

function ownerOf(rel) {
  const m = /^inspections\/([^/]+)\//.exec(rel)
  return m ? m[1] : ''
}

async function getTempFileURL({ fileList } = {}) {
  const list = Array.isArray(fileList) ? fileList : []
  return {
    fileList: list.map(fileID => {
      const rel = safeRel(fileID)
      const abs = rel && absPath(rel)
      const ok = !!(abs && fs.existsSync(abs))
      return {
        fileID,
        tempFileURL: ok ? signedUrl(rel) : '',
        status: ok ? 0 : -1
      }
    })
  }
}

async function readFilesAsDataUrls({ fileList } = {}) {
  const list = Array.isArray(fileList) ? fileList : []
  return {
    fileList: list.map(fileID => {
      const rel = safeRel(fileID)
      const abs = rel && absPath(rel)
      if (!abs || !fs.existsSync(abs)) {
        return { fileID, tempFileURL: '', status: -1 }
      }
      const size = fs.statSync(abs).size
      if (size > DATA_URL_MAX_BYTES) {
        return { fileID, tempFileURL: signedUrl(rel), status: 0 }
      }
      const buf = fs.readFileSync(abs)
      const url = `data:${mimeOf(rel)};base64,${buf.toString('base64')}`
      return { fileID, tempFileURL: url, status: 0 }
    })
  }
}

async function deleteFile({ fileList } = {}, ctx = {}) {
  const openid = ctx.OPENID || ''
  const caller = await getCallerUser(openid)
  const callerDisabled = !!(caller && caller.disabled)
  const admin = !!(caller && caller.role === 'admin' && !caller.disabled)
  const out = []
  for (const fileID of (fileList || [])) {
    const rel = safeRel(fileID)
    const abs = rel && absPath(rel)
    if (!rel || !abs) {
      out.push({ fileID, status: -1, errMsg: '非法文件' })
      continue
    }
    if (callerDisabled) {
      out.push({ fileID, status: -1, errMsg: '账号已停用' })
      continue
    }
    const owner = ownerOf(rel)
    const allowed = admin || (owner && owner === openid) || (rel.startsWith('products/') && admin)
    if (!allowed) {
      out.push({ fileID, status: -1, errMsg: '无权删除' })
      continue
    }
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs)
      out.push({ fileID, status: 0 })
    } catch (err) {
      out.push({ fileID, status: -1, errMsg: err.message })
    }
  }
  return { fileList: out }
}

async function handleUpload(req, res) {
  const openid = req.user && req.user.openid
  const tmp = req.file && req.file.path
  const cleanup = () => {
    if (tmp && fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp) } catch (_) {}
    }
  }
  try {
    if (!openid) {
      cleanup()
      return res.status(401).json({ success: false, error: '未登录' })
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: '缺少文件' })
    }
    if (await isDisabled(openid)) {
      cleanup()
      return res.status(403).json({ success: false, error: '账号已停用，无法上传照片' })
    }
    const rel = safeRel(String((req.body && req.body.cloudPath) || ''))
    if (!rel) {
      cleanup()
      return res.status(400).json({ success: false, error: '上传路径不合法' })
    }
    if (rel.startsWith('products/')) {
      if (!(await isAdmin(openid))) {
        cleanup()
        return res.status(403).json({ success: false, error: '只有管理员可以上传产品参考图' })
      }
    } else if (ownerOf(rel) !== openid) {
      cleanup()
      return res.status(403).json({ success: false, error: '只能上传到自己的巡检目录' })
    }
    const dest = absPath(rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.renameSync(tmp, dest)
    } catch (err) {
      // systemd PrivateTmp puts /tmp on a different device than data/
      if (!err || err.code !== 'EXDEV') throw err
      fs.copyFileSync(tmp, dest)
      fs.unlinkSync(tmp)
    }
    return res.json({ fileID: fileIdOf(rel) })
  } catch (err) {
    cleanup()
    console.error('上传失败:', err)
    return res.status(500).json({ success: false, error: '上传失败' })
  }
}

async function handleDownload(req, res, relRaw) {
  let rel
  try {
    rel = safeRel(decodeURIComponent(relRaw || ''))
  } catch (_) {
    rel = null
  }
  if (!rel) return res.status(404).json({ success: false, error: '文件不存在' })
  const abs = absPath(rel)
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ success: false, error: '文件不存在' })

  const exp = parseInt(req.query.exp, 10)
  const sig = req.query.sig ? String(req.query.sig) : ''
  let allowed = false
  if (sig && Number.isFinite(exp) && exp > Date.now() && safeEqual(sig, sign(rel, exp))) {
    allowed = true
  }
  if (!allowed && req.user && req.user.openid) {
    const openid = req.user.openid
    const caller = await getCallerUser(openid)
    const active = !(caller && caller.disabled)
    const manager = !!(caller && (caller.role === 'admin' || caller.role === 'manager') && !caller.disabled)
    if (active && (ownerOf(rel) === openid || manager)) allowed = true
  }
  if (!allowed) return res.status(401).json({ success: false, error: '无权访问该照片' })

  res.setHeader('Content-Type', mimeOf(rel))
  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.sendFile(abs)
}

module.exports = {
  getTempFileURL,
  readFilesAsDataUrls,
  deleteFile,
  handleUpload,
  handleDownload,
  safeRel,
  fileIdOf
}
