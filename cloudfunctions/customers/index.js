// cloudfunctions/customers/index.js
// 客户（门店）管理云函数：每个业务员维护自己的客户资料
//
// 权限模型说明（跟 products 正好相反，注意别搞混）：
// - products 是"团队共享资料库"，所有登录用户看到同一份，不按 _openid 过滤。
// - customers 是"业务员私有资源"，必须强制按 _openid 过滤，业务员之间互相看
//   不到对方的客户列表。openid 永远从服务端 wxContext 里取，不信任客户端传的
//   任何 openid/身份声明——这条是 getHistory 那次数据泄露漏洞学到的教训，
//   这里从设计第一天就按对的方式做。

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const EDITABLE_FIELDS = ['storeName', 'address', 'contactName', 'contactPhone', 'location']

function pickEditableFields(customer) {
  const picked = {}
  EDITABLE_FIELDS.forEach(key => {
    if (customer && customer[key] !== undefined) {
      picked[key] = customer[key]
    }
  })
  return picked
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const { action, customer, customerId } = event

  try {
    switch (action) {
      // 获取当前业务员自己的客户列表（默认只返回未停用的）
      case 'list': {
        const includeInactive = !!(event && event.includeInactive)
        const query = includeInactive
          ? { _openid: openid }
          : { _openid: openid, isActive: true }
        const res = await db.collection('customers')
          .where(query)
          .orderBy('createdAt', 'desc')
          .get()
        return { success: true, list: res.data }
      }

      // 新增客户
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
            location: customer.location || null, // { latitude, longitude }，新建时可选获取
            isActive: true,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })
        return { success: true, _id: addRes._id }
      }

      // 更新客户资料
      case 'update': {
        if (!customerId) {
          return { success: false, error: '缺少 customerId' }
        }
        // 归属校验：即使传了别人的 customerId，也不允许改到别人的记录上
        const existing = await db.collection('customers').doc(customerId).get()
        if (!existing.data || existing.data._openid !== openid) {
          return { success: false, error: '无权操作该客户记录' }
        }
        const updateData = {
          ...pickEditableFields(customer),
          updatedAt: db.serverDate()
        }
        await db.collection('customers').doc(customerId).update({ data: updateData })
        return { success: true }
      }

      // 停用客户（软删除，保留历史巡检记录里对这个门店的可追溯性）
      case 'remove': {
        if (!customerId) {
          return { success: false, error: '缺少 customerId' }
        }
        const existing = await db.collection('customers').doc(customerId).get()
        if (!existing.data || existing.data._openid !== openid) {
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
