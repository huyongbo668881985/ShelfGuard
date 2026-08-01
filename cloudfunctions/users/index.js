// 云函数：users
// 功能：用户与权限管理（仅 admin 可调）。
//   - listUsers：列出全部用户（openid 掩码，不泄露完整标识）
//   - setRole：调整某用户角色（sales / manager / admin），并写 roleChanges 审计
//   - setDisabled：停用 / 启用某用户（不能停用自己）
//
// 安全边界全部在服务端：角色判断只读 users 表的 role 字段，绝不信任客户端传参。
// 非 admin 调用任何动作都会直接被拒。

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

const ADMIN_ROLES = ['admin']
const ALL_ROLES = ['sales', 'manager', 'admin']
const ROLE_LABELS = { sales: '业务员', manager: '管理者', admin: '管理员' }

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  const { action } = event

  if (!openid) {
    return { success: false, error: '未获取到用户身份' }
  }

  try {
    switch (action) {
      case 'listUsers':
        return await handleListUsers(openid)
      case 'setRole':
        return await handleSetRole(openid, event)
      case 'setDisabled':
        return await handleSetDisabled(openid, event)
      default:
        return { success: false, error: `未知操作: ${action}` }
    }
  } catch (err) {
    console.error(`users.${action} 失败:`, err)
    return { success: false, error: err.message }
  }
}

// ============================================================
// 工具
// ============================================================
async function getCaller(openid) {
  const res = await db.collection('users').where({ _openid: openid }).get()
  return res.data[0] || null
}

function maskOpenid(openid) {
  if (!openid) return ''
  const s = String(openid)
  if (s.length <= 6) return '****'
  return `${s.slice(0, 3)}****${s.slice(-3)}`
}

// ============================================================
// 列出用户（仅 admin）
// ============================================================
async function handleListUsers(openid) {
  const me = await getCaller(openid)
  if (!me || !ADMIN_ROLES.includes(me.role)) {
    return { success: false, error: '只有管理员可以查看用户列表' }
  }

  const res = await db.collection('users')
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get()

  const list = res.data.map(u => ({
    _id: u._id,
    openidMasked: maskOpenid(u._openid),
    name: u.name || '',
    phone: u.phone || '',
    department: u.department || '',
    role: u.role || 'sales',
    roleLabel: ROLE_LABELS[u.role || 'sales'] || u.role || 'sales',
    disabled: !!u.disabled,
    createdAt: u.createdAt || null
  }))

  return { success: true, list, meRole: me.role }
}

// ============================================================
// 调整角色（仅 admin）
// 操作目标用用户文档 _id（前端只拿得到掩码 openid，不能拿真实 openid 当凭证）
// ============================================================
async function handleSetRole(openid, event) {
  const me = await getCaller(openid)
  if (!me || !ADMIN_ROLES.includes(me.role)) {
    return { success: false, error: '只有管理员可以管理用户' }
  }

  const { targetId, role } = event
  if (!targetId || !ALL_ROLES.includes(role)) {
    return { success: false, error: '参数错误（角色只能是 sales / manager / admin）' }
  }

  const targetDoc = await db.collection('users').doc(targetId).get()
  const target = targetDoc.data
  if (!target) {
    return { success: false, error: '目标用户不存在' }
  }
  // 不允许管理员改自己的角色，避免把自己降权后锁死账号
  if (target._openid === openid) {
    return { success: false, error: '不能修改自己的角色' }
  }

  const from = target.role || 'sales'
  if (from === role) {
    return { success: true, updated: false }
  }

  await db.collection('users').doc(target._id).update({
    data: { role, updatedAt: db.serverDate() }
  })

  // 角色变更审计（存真实 openid 便于追溯）
  // 审计写入失败不应阻断主操作，但要在日志里留痕
  try {
    await db.collection('roleChanges').add({
      data: {
        byOpenid: openid,
        targetOpenid: target._openid,
        from,
        to: role,
        at: db.serverDate()
      }
    })
  } catch (auditErr) {
    if (auditErr && auditErr.errCode === -502005) {
      console.warn('roleChanges 集合不存在，角色已更新但审计日志未写入。请在云开发控制台创建 roleChanges 集合。')
    } else {
      console.error('写入 roleChanges 审计日志失败:', auditErr)
    }
  }

  return { success: true, updated: true }
}

// ============================================================
// 停用 / 启用（仅 admin，不能操作自己）
// ============================================================
async function handleSetDisabled(openid, event) {
  const me = await getCaller(openid)
  if (!me || !ADMIN_ROLES.includes(me.role)) {
    return { success: false, error: '只有管理员可以管理用户' }
  }

  const { targetId, disabled } = event
  if (!targetId) {
    return { success: false, error: '参数错误' }
  }

  const targetDoc = await db.collection('users').doc(targetId).get()
  const target = targetDoc.data
  if (!target) {
    return { success: false, error: '目标用户不存在' }
  }
  if (target._openid === openid) {
    return { success: false, error: '不能停用或启用自己' }
  }

  const willDisable = !!disabled

  await db.collection('users').doc(target._id).update({
    data: {
      disabled: willDisable,
      disabledAt: willDisable ? db.serverDate() : null,
      disabledBy: willDisable ? openid : ''
    }
  })

  return { success: true, disabled: willDisable }
}
