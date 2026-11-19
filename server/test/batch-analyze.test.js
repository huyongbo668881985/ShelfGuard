'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { test, after } = require('node:test')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfguard-batch-'))
process.env.DATA_DIR = tmp
process.env.DISABLE_CRON = '1'

const cloud = require('../src/cloud-shim')
const db = require('../src/docdb')
const batchAnalyze = require('../src/functions/batchAnalyze/index.js')

after(() => {
  try { db._internal.closeSqlite() } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
})

test('runNow 异步全量排空超过 8 条与多业务员队列，并与定时/重复触发互斥', async () => {
  await db.collection('users').add({
    data: { _openid: 'admin_1', role: 'admin', approved: true, disabled: false }
  })
  await db.collection('settings').add({
    data: {
      _id: 'global',
      analyzeMode: 'batch',
      analyzeTime: '21:00',
      windowMinutes: 180,
      batchSize: 1
    }
  })

  // 插入 13 条 pending（u1 10 条、u2 3 条），验证突破单批 8 条上限并跨业务员全部跑完
  const baseMs = Date.parse('2026-11-19T01:00:00.000Z')
  for (let i = 0; i < 10; i++) {
    await db.collection('inspections').add({
      data: {
        _openid: 'u1',
        storeName: `门店A-${i + 1}`,
        photoFileIDs: [`sg://inspections/u1/${i}.jpg`],
        status: 'pending',
        analyzeAttempts: 0,
        createdAt: new Date(baseMs + i * 1000)
      }
    })
  }
  for (let i = 0; i < 3; i++) {
    await db.collection('inspections').add({
      data: {
        _openid: 'u2',
        storeName: `门店B-${i + 1}`,
        photoFileIDs: [`sg://inspections/u2/${i}.jpg`],
        status: 'pending',
        analyzeAttempts: 0,
        createdAt: new Date(baseMs + (20 + i) * 1000)
      }
    })
  }

  const origCallFunction = cloud.callFunction
  const analyzedIds = []
  const dailySummaries = []
  let releaseFirstCall
  const firstCallGate = new Promise(resolve => { releaseFirstCall = resolve })
  let firstCallStartedResolve
  const firstCallStarted = new Promise(resolve => { firstCallStartedResolve = resolve })

  cloud.callFunction = async ({ name, data }) => {
    assert.equal(name, 'analyzeImage')
    if (data && data.action === 'dailySummary') {
      dailySummaries.push(data.inspectionIds)
      return { result: { success: true } }
    }
    if (analyzedIds.length === 0) {
      firstCallStartedResolve()
      await firstCallGate
    }
    analyzedIds.push(data.inspectionId)
    await db.collection('inspections').doc(data.inspectionId).update({
      data: { status: 'analyzed', analyzedAt: new Date() }
    })
    return { result: { success: true } }
  }

  try {
    // 1. 管理员触发 async runNow，应当立即返回，不等待 13 条跑完
    const startRes = await cloud.runWithContext({ openid: 'admin_1', source: 'client' }, () => (
      batchAnalyze.main({ action: 'runNow', async: true }, {})
    ))
    assert.equal(startRes.success, true)
    assert.equal(startRes.started, true)
    assert.equal(startRes.async, true)
    assert.equal(startRes.queued, 13)
    assert.equal(startRes.remaining, 13)

    // 等待第 1 条真正进入 analyzeImage，确保后台任务处于运行态
    await firstCallStarted

    // 2. 运行期间再次手动触发应被互斥拦截
    const dupRes = await cloud.runWithContext({ openid: 'admin_1', source: 'client' }, () => (
      batchAnalyze.main({ action: 'runNow', async: true }, {})
    ))
    assert.equal(dupRes.success, true)
    assert.equal(dupRes.started, false)
    assert.equal(dupRes.alreadyRunning, true)

    // 3. 运行期间定时触发应跳过（busy: true）
    const timerRes = await cloud.runWithContext({ openid: '', source: 'timer' }, () => (
      batchAnalyze.main({ Type: 'Timer', TriggerName: 'batchAnalyzeTimer' }, {})
    ))
    assert.equal(timerRes.success, true)
    assert.equal(timerRes.skipped, true)
    assert.equal(timerRes.busy, true)

    // 放行并等待后台全量分析完成
    releaseFirstCall()
    const finalSummary = await batchAnalyze._internal.waitForActiveJob()
    assert.equal(batchAnalyze._internal.getActiveJob(), null)
    assert.equal(finalSummary.processed, 13)
    assert.equal(finalSummary.succeeded, 13)
    assert.equal(finalSummary.failed, 0)
    assert.equal(finalSummary.remaining, 0)
    assert.equal(finalSummary.batches, 3) // u1: 8 + 2，u2: 3
    assert.equal(analyzedIds.length, 13)
    assert.deepEqual(dailySummaries.map(list => list.length), [8, 2, 3])

    // 4. 数据库已全部落成 analyzed，无 pending/analyzing 残留
    const pendingAfter = await db.collection('inspections').where({ status: 'pending' }).count()
    const analyzedAfter = await db.collection('inspections').where({ status: 'analyzed' }).count()
    assert.equal(pendingAfter.total, 0)
    assert.equal(analyzedAfter.total, 13)

    // 5. 队列为空时再次点击 runNow 返回 started: false
    const emptyRes = await cloud.runWithContext({ openid: 'admin_1', source: 'client' }, () => (
      batchAnalyze.main({ action: 'runNow', async: true }, {})
    ))
    assert.equal(emptyRes.success, true)
    assert.equal(emptyRes.started, false)
    assert.equal(emptyRes.remaining, 0)
  } finally {
    cloud.callFunction = origCallFunction
  }
})
