'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')
const db = require('./docdb')
const files = require('./files')

const als = new AsyncLocalStorage()

function getWXContext() {
  return als.getStore() || { OPENID: '', SOURCE: '' }
}

function runWithContext(ctx, fn) {
  const store = {
    OPENID: ctx && ctx.openid ? String(ctx.openid) : '',
    SOURCE: ctx && ctx.source ? String(ctx.source) : ''
  }
  return als.run(store, fn)
}

async function callFunction({ name, data } = {}) {
  const handlers = require('./handlers')
  const fn = handlers[name]
  if (typeof fn !== 'function') {
    throw new Error(`未知内部调用: ${name}`)
  }
  return als.run({ OPENID: '', SOURCE: 'internal' }, async () => {
    const result = await fn(data || {})
    return { result }
  })
}

const cloud = {
  DYNAMIC_CURRENT_ENV: 'local',
  init() {},
  database() { return db },
  getWXContext,
  getTempFileURL(opts) { return files.getTempFileURL(opts) },
  readFilesAsDataUrls(opts) { return files.readFilesAsDataUrls(opts) },
  deleteFile(opts) { return files.deleteFile(opts, getWXContext()) },
  callFunction,
  runWithContext
}

module.exports = cloud
