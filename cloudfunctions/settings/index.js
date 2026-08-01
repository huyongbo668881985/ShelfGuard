// 云函数：settings
// 功能：读写全局系统配置（分析模式、集中分析时间、API Key），返回队列统计，以及首管理员激活。
//
// 配置存在 settings 集合的固定文档 _id = 'global' 里，全系统共用一份。
//
// 权限模型：
// - 读（get）：任何登录用户都可以读，但 API Key 永远只返回掩码，不返回明文。
//   明文只有 analyzeImage 云函数在服务端读取，不会经过前端。
// - 写（save / retryFailed）：仅 admin。
// - 首管理员激活（activateAdmin）：一次性，凭云函数环境变量 ADMIN_SETUP_CODE，
//   把"当前用户"升为 admin。激活后系统里有了管理员，这条路就永久关闭——
//   后续任何人想成为 admin，只能由已有的 admin 在「用户与权限管理」里提拔。
//   注意：这里**不再**保留"系统无管理员则任何人可管理"的自举逻辑，那个是安全漏洞。

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

const SETTINGS_DOC_ID = 'global'
const ADMIN_ROLES = ['admin']
const MANAGER_ROLES = ['admin', 'manager'] // 仅用于"系统里是否已有管理者"的判断

const DEFAULT_SETTINGS = {
  analyzeMode: 'batch',
  analyzeTime: '21:00',
  windowMinutes: 180,
  batchSize: 2
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  const { action = 'get' } = event

  if (!openid) {
    return { success: false, error: '未获取到用户身份' }
  }

  // 除"激活管理员"外，所有动作都先校验账号是否被停用（含读）。
  // 停用账号不能改设置、不能看队列，从源头掐断。
  if (action !== 'activateAdmin') {
    const caller = await getCaller(openid)
    if (caller && caller.disabled) {
      return { success: false, error: '账号已停用，请联系管理员' }
    }
  }

  try {
    switch (action) {
      case 'get':
        return await handleGet(openid)
      case 'save':
        return await handleSave(openid, event.settings || {})
      case 'retryFailed':
        return await handleRetryFailed(openid)
      case 'activateAdmin':
        return await handleActivateAdmin(openid, event.code)
      default:
        return { success: false, error: `未知操作: ${action}` }
    }
  } catch (err) {
    console.error(`settings.${action} 失败:`, err)
    return { success: false, error: err.message }
  }
}

// ============================================================
// 工具
// ============================================================
async function getCaller(openid) {
  try {
    const res = await db.collection('users').where({ _openid: openid }).get()
    return res.data[0] || null
  } catch (err) {
    console.error('查询用户失败:', err)
    return null
  }
}

async function isAdmin(openid) {
  const caller = await getCaller(openid)
  return !!(caller && ADMIN_ROLES.includes(caller.role))
}

async function loadSettings() {
  try {
    const res = await db.collection('settings').doc(SETTINGS_DOC_ID).get()
    return { ...DEFAULT_SETTINGS, ...(res.data || {}) }
  } catch (err) {
    return { ...DEFAULT_SETTINGS }
  }
}

async function countByStatus(status) {
  try {
    const res = await db.collection('inspections').where({ status }).count()
    return res.total
  } catch (err) {
    return 0
  }
}

function maskKey(key) {
  if (!key) return ''
  const s = String(key)
  if (s.length <= 8) return '****'
  return `${s.slice(0, 3)}****${s.slice(-4)}`
}

function parseTimeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

// ============================================================
// 读取配置 + 队列统计
// ============================================================
async function handleGet(openid) {
  const settings = await loadSettings()
  const caller = await getCaller(openid)
  const role = (caller && caller.role) || 'sales'
  const canEdit = ADMIN_ROLES.includes(role)

  // 系统里是否已经存在管理者（admin/manager）。用于前端判断要不要展示"激活管理员"入口。
  const adminRes = await db.collection('users').where({ role: _.in(MANAGER_ROLES) }).count()
  const hasAdmin = adminRes.total > 0

  const [pending, analyzing, failed] = await Promise.all([
    countByStatus('pending'),
    countByStatus('analyzing'),
    countByStatus('analyze_failed')
  ])

  return {
    success: true,
    canEdit,
    role,
    hasAdmin,
    settings: {
      analyzeMode: settings.analyzeMode,
      analyzeTime: settings.analyzeTime,
      windowMinutes: settings.windowMinutes,
      batchSize: settings.batchSize,
      // API Key 只回掩码，明文不出服务端
      hasApiKey: !!settings.dashscopeApiKey,
      apiKeyMasked: maskKey(settings.dashscopeApiKey),
      lastRunAt: settings.lastRunAt || null,
      lastRunTriggeredBy: settings.lastRunTriggeredBy || '',
      lastRunSummary: settings.lastRunSummary || null
    },
    queue: { pending, analyzing, failed }
  }
}

// ============================================================
// 保存配置（仅 admin）
// ============================================================
async function handleSave(openid, input) {
  if (!(await isAdmin(openid))) {
    return { success: false, error: '只有管理员可以修改系统设置' }
  }

  const data = {}

  if (input.analyzeMode !== undefined) {
    if (!['batch', 'instant'].includes(input.analyzeMode)) {
      return { success: false, error: '分析模式只能是 batch 或 instant' }
    }
    data.analyzeMode = input.analyzeMode
  }

  if (input.analyzeTime !== undefined) {
    if (parseTimeToMinutes(input.analyzeTime) === null) {
      return { success: false, error: '分析时间格式不对，应为 HH:mm，例如 21:00' }
    }
    data.analyzeTime = input.analyzeTime
  }

  if (input.windowMinutes !== undefined) {
    const w = parseInt(input.windowMinutes, 10)
    if (isNaN(w) || w < 10 || w > 720) {
      return { success: false, error: '分析时长需在 10-720 分钟之间' }
    }
    data.windowMinutes = w
  }

  if (input.batchSize !== undefined) {
    const b = parseInt(input.batchSize, 10)
    if (isNaN(b) || b < 1 || b > 10) {
      return { success: false, error: '每轮处理条数需在 1-10 之间' }
    }
    data.batchSize = b
  }

  // API Key：空字符串表示"不修改"，避免前端拿掩码回传把真 Key 覆盖掉。
  // 要清空 Key 得显式传 clearApiKey: true。
  if (input.clearApiKey === true) {
    data.dashscopeApiKey = ''
  } else if (input.dashscopeApiKey) {
    const key = String(input.dashscopeApiKey).trim()
    if (key.includes('*')) {
      return { success: false, error: '请输入完整的 API Key，不要提交带星号的掩码' }
    }
    data.dashscopeApiKey = key
  }

  if (Object.keys(data).length === 0) {
    return { success: false, error: '没有需要保存的内容' }
  }

  data.updatedAt = db.serverDate()
  data.updatedBy = openid

  try {
    await db.collection('settings').doc(SETTINGS_DOC_ID).update({ data })
  } catch (err) {
    if (err && err.errCode === -502005) {
      return {
        success: false,
        error: '数据库集合 settings 不存在。请先在云开发控制台 → 数据库 → 创建集合 settings，然后再保存。'
      }
    }
    // 文档不存在则新建（首次配置）。注意：集合必须已存在，否则上面的 -502005 已经拦截。
    try {
      await db.collection('settings').add({
        data: { _id: SETTINGS_DOC_ID, ...DEFAULT_SETTINGS, ...data }
      })
    } catch (addErr) {
      if (addErr && addErr.errCode === -502005) {
        return {
          success: false,
          error: '数据库集合 settings 不存在。请先在云开发控制台 → 数据库 → 创建集合 settings，然后再保存。'
        }
      }
      throw addErr
    }
  }

  return { success: true }
}

// ============================================================
// 把失败/卡死的记录重新排进队列（仅 admin）
// ============================================================
/**
 * 这个动作同时处理两类"跑不动了"的记录，用户视角就是一个「重新分析」按钮：
 *
 * 1. status = analyze_failed —— 正常失败，AI 报了错并写回了状态
 * 2. status = analyzing 且卡了超过 3 分钟 —— 云函数被 60 秒硬上限杀掉，
 *    进程直接终止，来不及写任何终态，记录就永远停在"分析中"。
 *    这类记录光靠 retryFailed 的老逻辑（只查 analyze_failed）是捞不出来的，
 *    用户界面上会看到"失败 0 条"却有一堆转圈的记录，只能干等定时器回收。
 *
 * 两类都要把 analyzeAttempts 清零，否则重排回队列后一旦再失败一次，
 * 就会因为累计次数超限被直接判死，等于只给了一次机会。
 */
const STUCK_THRESHOLD_MS = 3 * 60 * 1000

async function handleRetryFailed(openid) {
  if (!(await isAdmin(openid))) {
    return { success: false, error: '只有管理员可以重排失败记录' }
  }

  const resetData = {
    status: 'pending',
    analyzeAttempts: 0,   // 重试次数清零，否则一进队列就被判超限
    analyzeError: ''
  }

  // updateMany 在云函数里可以直接用 where().update()
  const failedRes = await db.collection('inspections')
    .where({ status: 'analyze_failed' })
    .update({ data: resetData })

  const stuckRes = await db.collection('inspections')
    .where({
      status: 'analyzing',
      analyzeStartedAt: _.lt(new Date(Date.now() - STUCK_THRESHOLD_MS))
    })
    .update({ data: resetData })

  const failed = failedRes.stats.updated
  const stuck = stuckRes.stats.updated

  return { success: true, updated: failed + stuck, failed, stuck }
}

// ============================================================
// 首管理员激活（一次性，凭环境变量激活码）
// ============================================================
async function handleActivateAdmin(openid, code) {
  const setupCode = process.env.ADMIN_SETUP_CODE
  if (!setupCode) {
    return {
      success: false,
      error: '未配置激活码：请在云函数 settings 的环境变量中设置 ADMIN_SETUP_CODE（自行设定一个只有你知道的字符串）'
    }
  }

  // 已有任何管理者则不再开放激活，避免被外人借机提权
  const adminRes = await db.collection('users').where({ role: _.in(MANAGER_ROLES) }).count()
  if (adminRes.total > 0) {
    return { success: false, error: '系统已有管理员，请联系管理员操作（无法重复激活）' }
  }

  if (!code || String(code).trim() !== String(setupCode).trim()) {
    return { success: false, error: '激活码错误' }
  }

  const caller = await getCaller(openid)
  if (caller && caller.disabled) {
    return { success: false, error: '账号已停用，无法激活' }
  }

  if (caller) {
    await db.collection('users').doc(caller._id).update({
      data: {
        role: 'admin',
        promotedAt: db.serverDate(),
        promotedBy: 'self-setup',
        updatedAt: db.serverDate()
      }
    })
  } else {
    // 兜底：理论上 login 已建记录，这里极少触发
    await db.collection('users').add({
      data: {
        _openid: openid,
        role: 'admin',
        promotedAt: db.serverDate(),
        promotedBy: 'self-setup',
        disabled: false,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
  }

  return { success: true, role: 'admin' }
}
