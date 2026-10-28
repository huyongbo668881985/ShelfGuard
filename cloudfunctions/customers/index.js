// cloudfunctions/customers/index.js
// 客户（门店）管理云函数
//
// 权限模型（数据归属不变，读时按角色放权）：
// - 归属：每条客户记录的 _openid 仍是业务员（含 JXC 同步按业务员写入），
//   绝不为了「看全部」把客户挂到管理员 openid。
// - 读（list / get）：admin、manager 不加 _openid 过滤（全量，仍分页）；
//   sales 仅 _openid === 自己。
// - 写（update / remove）：sales 只能改自己的；admin、manager 可改任意客户。
// - add：新建客户归属当前调用者（不改他人归属）。
// openid 永远从服务端 wxContext 取，不信任客户端传的身份声明。

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const EDITABLE_FIELDS = ['storeName', 'address', 'contactName', 'contactPhone', 'location']
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const MANAGER_ROLES = ['admin', 'manager']

function pickEditableFields(customer) {
  const picked = {}
  EDITABLE_FIELDS.forEach(key => {
    if (customer && customer[key] !== undefined) {
      picked[key] = customer[key]
    }
  })
  return picked
}

function parsePaging(event) {
  let limit = parseInt(event && event.limit, 10)
  if (isNaN(limit) || limit <= 0) limit = DEFAULT_PAGE_SIZE
  if (limit > MAX_PAGE_SIZE) limit = MAX_PAGE_SIZE

  let page = parseInt(event && event.page, 10)
  if (isNaN(page) || page < 1) page = 1

  let skip = parseInt(event && event.skip, 10)
  if (isNaN(skip) || skip < 0) skip = (page - 1) * limit

  return { limit, page, skip }
}

function resolveCaller(callerDoc, openid) {
  const role = (callerDoc && MANAGER_ROLES.includes(callerDoc.role))
    ? callerDoc.role
    : ((callerDoc && callerDoc.role) || 'sales')
  const canSeeAll = MANAGER_ROLES.includes(role)
  return {
    openid,
    role,
    canSeeAll,
    disabled: !!(callerDoc && callerDoc.disabled)
  }
}

function canWriteCustomer(caller, customerDoc) {
  if (!customerDoc) return false
  if (caller.canSeeAll) return true
  return customerDoc._openid === caller.openid
}

function canReadCustomer(caller, customerDoc) {
  if (!customerDoc) return false
  if (caller.canSeeAll) return true
  return customerDoc._openid === caller.openid
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const { action, customer, customerId } = event

  if (!openid) {
    return { success: false, error: '未获取到用户身份' }
  }

  try {
    const callerRes = await db.collection('users').where({ _openid: openid }).limit(1).get()
    const callerDoc = callerRes.data[0] || null
    const caller = resolveCaller(callerDoc, openid)

    if (caller.disabled) {
      return { success: false, error: '账号已停用，请联系管理员' }
    }

    switch (action) {
      // 列表：admin/manager 全量；sales 仅本人。仍分页。
      case 'list': {
        const includeInactive = !!(event && event.includeInactive)
        const query = {}
        if (!caller.canSeeAll) {
          query._openid = openid
        }
        if (!includeInactive) {
          query.isActive = true
        }

        const { limit, page, skip } = parsePaging(event)

        const countRes = await db.collection('customers').where(query).count()
        const total = countRes.total || 0

        const res = await db.collection('customers')
          .where(query)
          .orderBy('createdAt', 'desc')
          .skip(skip)
          .limit(limit)
          .get()

        const list = res.data || []
        return {
          success: true,
          list,
          total,
          page,
          limit,
          skip,
          hasMore: skip + list.length < total,
          scope: caller.canSeeAll ? 'all' : 'self',
          role: caller.role
        }
      }

      // 单条读取：与 list 同一套可见性
      case 'get': {
        if (!customerId) {
          return { success: false, error: '缺少 customerId' }
        }
        let doc
        try {
          const existing = await db.collection('customers').doc(customerId).get()
          doc = existing.data
        } catch (e) {
          return { success: false, error: '客户不存在' }
        }
        if (!canReadCustomer(caller, doc)) {
          return { success: false, error: '无权查看该客户' }
        }
        return {
          success: true,
          customer: doc,
          scope: caller.canSeeAll ? 'all' : 'self',
          role: caller.role
        }
      }

      // 新增：归属当前调用者（不改他人 _openid）
      case 'add': {
        if (!customer || !customer.storeName) {
          return { success: false, error: '缺少门店名称' }
        }
        const addRes = await db.collection('customers').add({
          data: {
            _openid: openid,
            storeName: customer.storeName,
            address: customer.address || '',
            contactName: customer.contactName || '',
            contactPhone: customer.contactPhone || '',
            location: customer.location || null,
            isActive: true,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })
        return { success: true, _id: addRes._id }
      }

      // 更新：sales 仅本人；admin/manager 可改任意。不改动 _openid。
      case 'update': {
        if (!customerId) {
          return { success: false, error: '缺少 customerId' }
        }
        let existingDoc
        try {
          const existing = await db.collection('customers').doc(customerId).get()
          existingDoc = existing.data
        } catch (e) {
          return { success: false, error: '客户不存在' }
        }
        if (!canWriteCustomer(caller, existingDoc)) {
          return { success: false, error: '无权操作该客户记录' }
        }
        const updateData = {
          ...pickEditableFields(customer),
          updatedAt: db.serverDate()
        }
        // 明确不写入 _openid，防止客户端或误传改归属
        delete updateData._openid
        await db.collection('customers').doc(customerId).update({ data: updateData })
        return { success: true }
      }

      // 停用（软删除）：写权限同 update
      case 'remove': {
        if (!customerId) {
          return { success: false, error: '缺少 customerId' }
        }
        let existingDoc
        try {
          const existing = await db.collection('customers').doc(customerId).get()
          existingDoc = existing.data
        } catch (e) {
          return { success: false, error: '客户不存在' }
        }
        if (!canWriteCustomer(caller, existingDoc)) {
          return { success: false, error: '无权操作该客户记录' }
        }
        await db.collection('customers').doc(customerId).update({
          data: { isActive: false, updatedAt: db.serverDate() }
        })
        return { success: true }
      }

      default:
        return { success: false, error: `不支持的操作: ${action}` }
    }
  } catch (err) {
    console.error('customers 云函数出错:', err)
    return { success: false, error: err.message }
  }
}
