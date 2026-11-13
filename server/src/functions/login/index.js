// 云函数：login
// 功能：获取用户 openid，查询/创建/更新用户信息

const cloud = require('../../cloud-shim')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 允许用户自行更新的字段白名单，防止客户端传入 _openid / _id / role 等敏感或
// 系统字段覆盖数据库记录（role 权限应由管理端单独接口修改，这里不开放）
const UPDATABLE_FIELDS = ['name', 'phone', 'department']

// 姓名规则：去首尾空格、合并连续空白，1-20 个字符。客户归属按姓名精确匹配进销存，
// 所以这里不做任何「模糊」处理，只去掉明显误输入的空白。
const NAME_MAX_LEN = 20

function normalizeName(raw) {
  return String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim()
}

function validateName(name) {
  if (!name) return '姓名不能为空'
  if (name.length > NAME_MAX_LEN) return `姓名不能超过 ${NAME_MAX_LEN} 个字`
  return ''
}

function pickUpdatableFields(userInfo) {
  const picked = {}
  UPDATABLE_FIELDS.forEach(key => {
    if (userInfo[key] !== undefined) {
      picked[key] = userInfo[key]
    }
  })
  return picked
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const { action, userInfo } = event

  try {
    // 更新用户信息
    if (action === 'update' && userInfo) {
      const safeUserInfo = pickUpdatableFields(userInfo)
      const userRes = await db.collection('users').where({ _openid: openid }).get()
      const existingUser = userRes.data[0] || null
      if (existingUser && existingUser.disabled) {
        return {
          openid,
          success: false,
          error: '账号已停用，请联系管理员',
          userInfo: existingUser
        }
      }
      let nameLocked = false

      // 业务员姓名决定进销存客户归属：
      // - 还没填过姓名的人可以自己填一次（首次登录的必填弹窗走这里）；
      // - 已经有姓名的非管理员不能自己改（旧版前端的「⚙️ 设置」里改名也会被这里拦下），
      //   要改只能由管理员在「用户与权限管理」里改（users.setName）。
      // - 管理员可以改自己的姓名。
      if (safeUserInfo.name !== undefined) {
        const name = normalizeName(safeUserInfo.name)
        const oldName = normalizeName(existingUser && existingUser.name)
        const isAdminCaller = !!(existingUser && existingUser.role === 'admin')
        if (oldName && !isAdminCaller) {
          if (name !== oldName) nameLocked = true
          delete safeUserInfo.name
        } else {
          const nameErr = validateName(name)
          if (nameErr) {
            return { openid, success: false, error: nameErr }
          }
          safeUserInfo.name = name
        }
      }

      if (Object.keys(safeUserInfo).length === 0) {
        return {
          openid,
          success: !nameLocked,
          nameLocked,
          error: nameLocked ? '姓名已设置，如需修改请联系管理员' : '',
          userInfo: existingUser
        }
      }

      if (existingUser) {
        // 更新已有用户
        await db.collection('users').doc(existingUser._id).update({
          data: {
            ...safeUserInfo,
            updatedAt: db.serverDate()
          }
        })
      } else {
        // 创建新用户，角色默认为业务员（sales），管理端另行提权
        await db.collection('users').add({
          data: {
            _openid: openid,
            role: 'sales',
            disabled: false,   // 账号停用开关，由 admin 在「用户与权限管理」里置 true
            approved: false,   // 新业务员默认未批准，需管理员审批
            ...safeUserInfo,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })
      }

      return {
        openid,
        success: true,
        nameLocked,
        userInfo: { ...(existingUser || {}), ...safeUserInfo, _openid: openid }
      }
    }

    // 查询用户信息（新用户首次登录时自动初始化创建，避免业务员首次提交巡检时因用户不存在被拦截）
    const userRes = await db.collection('users').where({ _openid: openid }).get()

    let userInfoResult = null
    if (userRes.data.length > 0) {
      userInfoResult = userRes.data[0]
    } else {
      // 首次登录自动创建记录
      const defaultUser = {
        _openid: openid,
        role: 'sales',
        disabled: false,
        approved: false,   // 新业务员默认未批准，需管理员审批
        name: '',
        phone: '',
        department: '',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      try {
        const addRes = await db.collection('users').add({ data: defaultUser })
        userInfoResult = { _id: addRes._id, ...defaultUser }
      } catch (addErr) {
        // 若存在极小概率的并发插入，重新查询一次
        const recheck = await db.collection('users').where({ _openid: openid }).get()
        if (recheck.data.length > 0) {
          userInfoResult = recheck.data[0]
        }
      }
    }

    return {
      openid,
      userInfo: userInfoResult
    }
  } catch (err) {
    console.error('login 云函数错误:', err)
    return { openid, userInfo: null, error: err.message }
  }
}
