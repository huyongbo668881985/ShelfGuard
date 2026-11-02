'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { DatabaseSync } = require('node:sqlite')

let sqlite = null

function dataDir() {
  const configured = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
  return path.isAbsolute(configured) ? configured : path.resolve(__dirname, '..', configured)
}

function getSqlite() {
  if (sqlite) return sqlite
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  sqlite = new DatabaseSync(path.join(dir, 'shelfguard.sqlite'))
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA busy_timeout = 5000')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    )
  `)
  return sqlite
}

function assertCollection(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new Error(`非法集合名: ${name}`)
  }
  return name
}

function assertId(id) {
  if (typeof id !== 'string' || !id || id.length > 220) {
    throw new Error('非法文档 ID')
  }
  if (id.includes('/') || id.includes('\\') || id.includes('..') || id.includes('\0')) {
    throw new Error('非法文档 ID')
  }
  return id
}

function isCmd(v) {
  return !!(v && typeof v === 'object' && !Array.isArray(v) && v.__cmd)
}

function serializeValue(v) {
  if (v instanceof Date) return { __d: v.toISOString() }
  if (Array.isArray(v)) return v.map(serializeValue)
  if (v && typeof v === 'object') {
    if (v.__cmd || v.__regexp || v.__agg) {
      throw new Error('不能把查询指令写入数据库')
    }
    const out = {}
    Object.keys(v).forEach(k => {
      if (v[k] !== undefined) out[k] = serializeValue(v[k])
    })
    return out
  }
  return v
}

function revive(v) {
  if (Array.isArray(v)) return v.map(revive)
  if (v && typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 1 && keys[0] === '__d' && typeof v.__d === 'string') return v.__d
    const out = {}
    keys.forEach(k => { out[k] = revive(v[k]) })
    return out
  }
  return v
}

function timeOf(v) {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function equalValue(a, b) {
  if (a instanceof Date) a = a.toISOString()
  if (b instanceof Date) b = b.toISOString()
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (ta != null && tb != null) return ta === tb
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch (_) {
      return false
    }
  }
  return false
}

function compareValue(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (ta != null && tb != null) return ta - tb
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a)
  const sb = String(b)
  if (sa < sb) return -1
  if (sa > sb) return 1
  return 0
}

function getPath(doc, dotted) {
  if (!doc) return undefined
  if (dotted === '_id') return doc._id
  const parts = String(dotted).split('.')
  let cur = doc
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined
    cur = cur[p]
  }
  return cur
}

function matchValue(actual, expected) {
  if (isCmd(expected)) {
    const op = expected.__cmd
    const arg = expected.args[0]
    if (op === 'and') {
      const parts = Array.isArray(arg) ? arg : expected.args
      return parts.every(p => matchValue(actual, p))
    }
    if (op === 'or') {
      const parts = Array.isArray(arg) ? arg : expected.args
      return parts.some(p => {
        if (p && typeof p === 'object' && !isCmd(p) && !p.__regexp) {
          return false
        }
        return matchValue(actual, p)
      })
    }
    if (op === 'gte' || op === 'lte' || op === 'gt' || op === 'lt') {
      if (actual === undefined || actual === null) return false
      const delta = compareValue(actual, arg)
      if (op === 'gte') return delta >= 0
      if (op === 'lte') return delta <= 0
      if (op === 'gt') return delta > 0
      return delta < 0
    }
    if (op === 'neq') {
      if (actual === undefined) return true
      return !equalValue(actual, arg)
    }
    if (op === 'in') {
      const list = Array.isArray(arg) ? arg : []
      // 数组字段按元素命中（与云数据库 / Mongo 的 $in 一致），标量字段则看值是否在列表里。
      if (Array.isArray(actual)) {
        return actual.some(item => list.some(candidate => equalValue(item, candidate)))
      }
      return list.some(item => equalValue(actual, item))
    }
    if (op === 'exists') {
      const want = arg !== false
      const exists = actual !== undefined
      return want ? exists : !exists
    }
    return false
  }
  if (expected && typeof expected === 'object' && expected.__regexp) {
    if (actual == null) return false
    try {
      const flags = String(expected.options || '').includes('i') ? 'i' : ''
      return new RegExp(expected.__regexp, flags).test(String(actual))
    } catch (_) {
      return false
    }
  }
  return equalValue(actual, expected)
}

function matchQuery(doc, query) {
  if (query == null) return true
  if (isCmd(query)) {
    const parts = Array.isArray(query.args[0]) ? query.args[0] : query.args
    if (query.__cmd === 'and') return parts.every(p => matchQuery(doc, p))
    if (query.__cmd === 'or') return parts.some(p => matchQuery(doc, p))
    return false
  }
  if (typeof query !== 'object' || Array.isArray(query)) return false
  const keys = Object.keys(query)
  if (keys.length === 0) return true
  return keys.every(key => matchValue(getPath(doc, key), query[key]))
}

function loadAll(collection) {
  const rows = getSqlite().prepare(
    'SELECT id, body FROM documents WHERE collection = ?'
  ).all(assertCollection(collection))
  return rows.map(row => {
    const doc = revive(JSON.parse(row.body))
    doc._id = row.id
    return doc
  })
}

function loadOne(collection, id) {
  const row = getSqlite().prepare(
    'SELECT id, body FROM documents WHERE collection = ? AND id = ?'
  ).get(assertCollection(collection), assertId(id))
  if (!row) return null
  const doc = revive(JSON.parse(row.body))
  doc._id = row.id
  return doc
}

function saveDoc(collection, doc) {
  const id = assertId(doc._id)
  const body = JSON.stringify(serializeValue(doc))
  getSqlite().prepare(`
    INSERT INTO documents (collection, id, body) VALUES (?, ?, ?)
    ON CONFLICT(collection, id) DO UPDATE SET body = excluded.body
  `).run(assertCollection(collection), id, body)
}

function applyUpdate(doc, data) {
  const next = revive(JSON.parse(JSON.stringify(serializeValue(doc))))
  Object.keys(data || {}).forEach(key => {
    const value = data[key]
    if (isCmd(value) && value.__cmd === 'inc') {
      next[key] = (Number(next[key]) || 0) + Number(value.args[0] || 0)
      return
    }
    if (isCmd(value)) {
      throw new Error(`不支持的更新指令: ${value.__cmd}`)
    }
    if (value === undefined) return
    next[key] = revive(serializeValue(value))
  })
  next._id = doc._id
  return next
}

function project(doc, fields) {
  if (!fields) return doc
  const out = {}
  Object.keys(fields).forEach(key => {
    if (!fields[key]) return
    if (Object.prototype.hasOwnProperty.call(doc, key)) out[key] = doc[key]
  })
  return out
}

function notFound() {
  const err = new Error('document does not exist')
  err.errCode = -1
  return err
}

class Query {
  constructor(collection, query) {
    this.collection = collection
    this.query = query || {}
    this._order = null
    this._skip = 0
    this._limit = null
    this._fields = null
  }

  where(query) {
    this.query = query || {}
    return this
  }

  orderBy(field, direction) {
    this._order = { field, direction: direction === 'asc' ? 'asc' : 'desc' }
    return this
  }

  skip(n) {
    const v = parseInt(n, 10)
    this._skip = Number.isFinite(v) && v > 0 ? v : 0
    return this
  }

  limit(n) {
    const v = parseInt(n, 10)
    this._limit = Number.isFinite(v) && v > 0 ? Math.min(v, 1000) : 0
    return this
  }

  field(fields) {
    this._fields = fields || null
    return this
  }

  _matched() {
    return loadAll(this.collection).filter(doc => matchQuery(doc, this.query))
  }

  _ordered(rows) {
    if (!this._order) return rows.slice()
    const { field, direction } = this._order
    const mul = direction === 'asc' ? 1 : -1
    return rows.slice().sort((a, b) => {
      const primary = compareValue(getPath(a, field), getPath(b, field))
      if (primary !== 0) return primary * mul
      return compareValue(a._id, b._id)
    })
  }

  async get() {
    let rows = this._ordered(this._matched())
    const start = this._skip || 0
    const limit = this._limit == null ? 100 : this._limit
    rows = rows.slice(start, start + limit)
    if (this._fields) rows = rows.map(row => project(row, this._fields))
    return { data: rows }
  }

  async count() {
    return { total: this._matched().length }
  }

  async update({ data } = {}) {
    const rows = this._matched()
    rows.forEach(row => {
      saveDoc(this.collection, applyUpdate(row, data || {}))
    })
    return { stats: { updated: rows.length } }
  }
}

class DocRef {
  constructor(collection, id) {
    this.collection = collection
    this.id = assertId(String(id))
  }

  async get() {
    const doc = loadOne(this.collection, this.id)
    if (!doc) throw notFound()
    return { data: doc }
  }

  async update({ data } = {}) {
    const doc = loadOne(this.collection, this.id)
    if (!doc) throw notFound()
    saveDoc(this.collection, applyUpdate(doc, data || {}))
    return { stats: { updated: 1 } }
  }

  async set({ data } = {}) {
    const next = revive(serializeValue(data || {}))
    next._id = this.id
    saveDoc(this.collection, next)
    return { _id: this.id, stats: { updated: 1 } }
  }
}

class Aggregate {
  constructor(collection) {
    this.collection = collection
    this._match = null
    this._group = null
  }

  match(query) {
    this._match = query || {}
    return this
  }

  group(spec) {
    this._group = spec || {}
    return this
  }

  async end() {
    let rows = loadAll(this.collection)
    if (this._match) rows = rows.filter(doc => matchQuery(doc, this._match))
    if (!this._group) return { list: rows }
    const acc = { _id: this._group._id == null ? null : this._group._id }
    Object.keys(this._group).forEach(key => {
      if (key === '_id') return
      const spec = this._group[key]
      if (spec && spec.__agg === 'avg') {
        const field = String(spec.field || '').replace(/^\$/, '')
        const nums = rows
          .map(row => getPath(row, field))
          .filter(n => typeof n === 'number' && Number.isFinite(n))
        acc[key] = nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : null
      }
    })
    return { list: [acc] }
  }
}

function addDoc(collection, payload) {
  const data = (payload && payload.data) || {}
  const id = data._id ? assertId(String(data._id)) : crypto.randomBytes(12).toString('hex')
  if (loadOne(collection, id)) {
    const err = new Error('document already exists')
    err.errCode = -1
    throw err
  }
  const doc = revive(serializeValue(data))
  doc._id = id
  saveDoc(collection, doc)
  return { _id: id }
}

class Collection {
  constructor(name) {
    this.name = assertCollection(name)
  }

  where(query) { return new Query(this.name, query || {}) }
  orderBy(field, direction) { return new Query(this.name, {}).orderBy(field, direction) }
  skip(n) { return new Query(this.name, {}).skip(n) }
  limit(n) { return new Query(this.name, {}).limit(n) }
  field(fields) { return new Query(this.name, {}).field(fields) }
  count() { return new Query(this.name, {}).count() }
  aggregate() { return new Aggregate(this.name) }
  doc(id) { return new DocRef(this.name, id) }
  add(payload) { return addDoc(this.name, payload) }
}

function cmd(op, arg) {
  return { __cmd: op, args: [arg] }
}

const command = {
  and(...parts) {
    const list = parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts
    return cmd('and', list)
  },
  or(list) { return cmd('or', list) },
  gte(v) { return cmd('gte', v) },
  lte(v) { return cmd('lte', v) },
  gt(v) { return cmd('gt', v) },
  lt(v) { return cmd('lt', v) },
  neq(v) { return cmd('neq', v) },
  in(list) { return cmd('in', list) },
  exists(flag) { return cmd('exists', flag) },
  inc(n) { return cmd('inc', n) },
  aggregate: {
    avg(field) { return { __agg: 'avg', field } }
  }
}

function CloudRegExp({ regexp, options }) {
  return { __regexp: String(regexp), options: options || '' }
}

const db = {
  command,
  RegExp: CloudRegExp,
  serverDate() { return new Date() },
  collection(name) { return new Collection(name) }
}

module.exports = db
module.exports._internal = { matchQuery, dataDir, getSqlite }
