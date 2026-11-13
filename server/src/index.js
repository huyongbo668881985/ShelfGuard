'use strict'

const fs = require('fs')
const path = require('path')

function loadEnvFile() {
  const file = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value
  })
}

loadEnvFile()

if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai'

if (!process.env.JWT_SECRET) {
  console.error('缺少环境变量 JWT_SECRET。请在 server/.env 中设置一个足够长的随机字符串。')
  process.exit(1)
}

if (process.env.SHELFGUARD_TEST_LOGIN === '1') {
  console.warn('警告：SHELFGUARD_TEST_LOGIN=1，任何人都可以用 testOpenid 冒充用户。生产环境必须关闭。')
}

const { createApp } = require('./app')
const { createScheduler } = require('./scheduler')
const { port, basePath } = require('./config')
const db = require('./docdb')

const app = createApp()
let scheduler = null
const server = app.listen(port(), '0.0.0.0', () => {
  console.log(`ShelfGuard API 已启动 http://127.0.0.1:${port()}${basePath()}`)
  if (process.env.DISABLE_CRON === '1') {
    console.log('定时任务已关闭（DISABLE_CRON=1）')
  } else {
    scheduler = createScheduler()
    scheduler.start()
  }
})

server.on('error', err => {
  console.error('监听端口失败:', err.message)
  process.exit(1)
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`收到 ${signal}，正在优雅关闭服务...`)
  if (scheduler) {
    try { scheduler.stop() } catch (_) {}
  }
  const forceTimer = setTimeout(() => {
    try { db._internal.closeSqlite() } catch (_) {}
    process.exit(0)
  }, 10000)
  if (typeof forceTimer.unref === 'function') forceTimer.unref()

  server.close(() => {
    try { db._internal.closeSqlite() } catch (_) {}
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
