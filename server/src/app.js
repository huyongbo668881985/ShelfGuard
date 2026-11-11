'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const express = require('express')
const multer = require('multer')
const cloud = require('./cloud-shim')
const files = require('./files')
const auth = require('./auth')
const internal = require('./internal')
const { basePath } = require('./config')

const uploadDir = path.join(os.tmpdir(), 'shelfguard-uploads')
fs.mkdirSync(uploadDir, { recursive: true })

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }
})

function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

  const router = express.Router()
  const handlers = require('./handlers')

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'shelfguard' })
  })

  // 供进销存 (jxc-app) 经营诊断助手调用的内部只读接口（使用 INTERNAL_API_KEY 鉴权）
  router.get('/api/internal/customer-summary', internal.requireInternalKey, internal.customerSummaryHandler)
  router.get('/api/internal/overview', internal.requireInternalKey, internal.overviewHandler)

  router.post('/api/auth/login', auth.loginHandler)

  router.post('/api/fn/:name', auth.requireAuth, async (req, res) => {
    const name = req.params.name
    const fn = handlers[name]
    if (typeof fn !== 'function') {
      return res.status(404).json({ success: false, error: '未知接口' })
    }
    try {
      const result = await cloud.runWithContext(
        { openid: req.user.openid, source: 'client' },
        () => fn(req.body || {})
      )
      return res.json(result == null ? { success: false, error: '空响应' } : result)
    } catch (err) {
      console.error(`[fn] ${name} 异常:`, err)
      return res.status(500).json({ success: false, error: '服务器错误' })
    }
  })

  router.post('/api/upload', auth.requireAuth, (req, res, next) => {
    upload.single('file')(req, res, err => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? '单张照片不能超过 8MB' : '上传失败'
        return res.status(400).json({ success: false, error: message })
      }
      return next()
    })
  }, files.handleUpload)

  router.post('/api/files/delete', auth.requireAuth, async (req, res) => {
    try {
      const result = await cloud.runWithContext(
        { openid: req.user.openid, source: 'client' },
        () => files.deleteFile({ fileList: (req.body && req.body.fileList) || [] }, cloud.getWXContext())
      )
      return res.json(Object.assign({ success: true }, result))
    } catch (err) {
      console.error('删除文件失败:', err)
      return res.status(500).json({ success: false, error: '删除失败' })
    }
  })

  router.get('/files/*', auth.optionalAuth, (req, res) => {
    return files.handleDownload(req, res, req.params[0])
  })

  app.use(basePath() || '/', router)

  app.use((req, res) => {
    res.status(404).json({ success: false, error: '未找到接口' })
  })

  return app
}

module.exports = { createApp }
