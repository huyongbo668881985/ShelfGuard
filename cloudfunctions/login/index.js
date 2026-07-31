// 云函数：login
// 功能：获取用户 openid，查询/创建/更新用户信息

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 允许用户自行更新的字段白名单，防止客户端传入 _openid / _id / role 等敏感或
// 系统字段覆盖数据库记录（role 权限应由管理端单独接口修改，这里不开放）
const UPDATABLE_FIELDS = ['name', 'phone', 'department']

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

      if (userRes.data.length > 0) {
        // 更新已有用户
        await db.collection('users').doc(userRes.data[0]._id).update({
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
            ...safeUserInfo,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })
      }

      return { openid, userInfo: { ...safeUserInfo, _openid: openid } }
    }

    // 查询用户信息
    const userRes = await db.collection('users').where({ _openid: openid }).get()

    let userInfoResult = null
    if (userRes.data.length > 0) {
      userInfoResult = userRes.data[0]
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
