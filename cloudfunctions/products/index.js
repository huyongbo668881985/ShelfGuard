// cloudfunctions/products/index.js
// 产品库云函数：维护"本品牌"产品资料（品牌名/别名/正背侧面参考照）
//
// 权限模型说明（跟 inspections/getHistory 不一样，注意别搞混）：
// - inspections 是"个人巡检记录"，必须按 _openid 过滤，见 getHistory 的教训。
// - products 是"团队共享资料库"，所有登录用户都应该能看到同一份产品清单，
//   所以这里【不】按 _openid 过滤查询结果，_openid 只记录"谁创建的"用于审计。
// - 当前版本没有做角色权限控制（任何登录用户都能增删改），这是"先跑起来"的
//   简化设计。以后如果要限制只有管理员能维护产品库，在 add/update/remove 这几个
//   分支里加一次 users 表的 role 校验即可，不需要改前端调用方式。

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const EDITABLE_FIELDS = ['brandName', 'productLine', 'aliases', 'photos', 'isActive']

function pickEditableFields(product) {
  const picked = {}
  EDITABLE_FIELDS.forEach(key => {
    if (product && product[key] !== undefined) {
      picked[key] = product[key]
    }
  })
  return picked
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const { action, product, productId } = event

  try {
    switch (action) {
      // 获取产品列表（默认只返回未下架的）
      case 'list': {
        const includeInactive = !!(event && event.includeInactive)
        const query = includeInactive ? {} : { isActive: true }
        const res = await db.collection('products')
          .where(query)
          .orderBy('createdAt', 'desc')
          .get()
        return { success: true, list: res.data }
      }

      // 新增产品
      case 'add': {
        if (!product || !product.brandName) {
          return { success: false, error: '缺少品牌名称' }
        }
        const addRes = await db.collection('products').add({
          data: {
            _openid: openid,
            brandName: product.brandName,
            productLine: product.productLine || '',
            aliases: Array.isArray(product.aliases) ? product.aliases : [],
            photos: product.photos || {}, // { front, back, side } 均为 fileID
            isActive: true,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })
        return { success: true, _id: addRes._id }
      }

      // 更新产品
      case 'update': {
        if (!productId) {
          return { success: false, error: '缺少 productId' }
        }
        const updateData = {
          ...pickEditableFields(product),
          updatedAt: db.serverDate()
        }
        await db.collection('products').doc(productId).update({ data: updateData })
        return { success: true }
      }

      // 下架产品（软删除，保留历史巡检报告里对这条产品资料的可追溯性）
      case 'remove': {
        if (!productId) {
          return { success: false, error: '缺少 productId' }
        }
        await db.collection('products').doc(productId).update({
          data: { isActive: false, updatedAt: db.serverDate() }
        })
        return { success: true }
      }

      default:
        return { success: false, error: `不支持的操作: ${action}` }
    }
  } catch (err) {
    console.error('products 云函数出错:', err)
    return { success: false, error: err.message }
  }
}
