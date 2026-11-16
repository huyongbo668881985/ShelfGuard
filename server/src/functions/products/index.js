// cloudfunctions/products/index.js
// 产品库云函数：维护"本品牌"产品资料（品牌名/别名/正背侧面参考照）
//
// 权限模型说明（跟 inspections/getHistory 不一样，注意别搞混）：
// - inspections 是"个人巡检记录"，必须按 _openid 过滤，见 getHistory 的教训。
// - products 是"团队共享资料库"，所有登录用户都应该能看到同一份产品清单，
//   所以这里【不】按 _openid 过滤查询结果，_openid 只记录"谁创建的"用于审计。
// - 产品库写操作仅允许 admin，避免普通业务员误改团队共享资料。

const cloud = require('../../cloud-shim')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ADMIN_ROLES = ['admin']
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

const EDITABLE_FIELDS = ['brandName', 'productLine', 'aliases', 'photos', 'isActive']
const MATERIAL_EDITABLE_FIELDS = ['materialName', 'category', 'aliases', 'visualFeatures', 'photo', 'isActive']
const MATERIAL_CATEGORIES = [
  '灯箱',
  'POP海报',
  '台卡/桌贴',
  '门头店招',
  '冰柜贴/玻璃贴',
  '堆头围挡',
  '展示架/陈列架',
  '条幅/吊旗',
  '价签/跳跳卡',
  '其他'
]

function isCloudFileId(v) {
  return typeof v === 'string' && v.indexOf('sg://') === 0
}

function sanitizeMaterialPhoto(photo) {
  if (photo === '' || photo === null || photo === undefined) return ''
  if (!isCloudFileId(photo)) {
    throw new Error('物料参考照片必须是已上传的文件 ID')
  }
  return photo
}

function pickMaterialEditableFields(material) {
  const picked = {}
  MATERIAL_EDITABLE_FIELDS.forEach(key => {
    if (material && material[key] !== undefined) {
      picked[key] = material[key]
    }
  })
  return picked
}

function sanitizePhotos(photos) {
  const src = photos && typeof photos === 'object' ? photos : {}
  const out = {}
  ;['front', 'back', 'side'].forEach(slot => {
    if (src[slot] === '' || src[slot] === null || src[slot] === undefined) {
      // 允许显式清空
      if (src[slot] === '') out[slot] = ''
      return
    }
    if (!isCloudFileId(src[slot])) {
      throw new Error(`产品照片 ${slot} 必须是已上传的文件 ID`)
    }
    out[slot] = src[slot]
  })
  return out
}

async function deleteCloudFiles(ids) {
  const list = (ids || []).filter(Boolean)
  if (!list.length) return
  try {
    await cloud.deleteFile({ fileList: list })
  } catch (err) {
    console.warn('删除旧产品图失败:', err.message || err)
  }
}


function pickEditableFields(product) {
  const picked = {}
  EDITABLE_FIELDS.forEach(key => {
    if (product && product[key] !== undefined) {
      picked[key] = product[key]
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

async function isAdmin(openid) {
  if (!openid) return false
  const res = await db.collection('users').where({ _openid: openid }).get()
  return !!(res.data[0] && ADMIN_ROLES.includes(res.data[0].role) && !res.data[0].disabled)
}

async function buildPhotoUrlMap(list) {
  const photoIDs = []
  for (const p of list) {
    const photos = p.photos || {}
    ;['front', 'back', 'side'].forEach(slot => {
      if (photos[slot]) photoIDs.push(photos[slot])
    })
  }

  const urlMap = {}
  for (let i = 0; i < photoIDs.length; i += 50) {
    const chunk = photoIDs.slice(i, i + 50)
    try {
      const fileRes = await cloud.getTempFileURL({ fileList: chunk })
      fileRes.fileList.forEach(f => {
        if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
      })
    } catch (err) {
      console.error('获取产品参考照临时链接失败:', err)
    }
  }
  return urlMap
}

async function buildMaterialPhotoUrlMap(list) {
  const photoIDs = []
  for (const m of list) {
    if (m && m.photo && isCloudFileId(m.photo)) {
      photoIDs.push(m.photo)
    }
  }
  const urlMap = {}
  for (let i = 0; i < photoIDs.length; i += 50) {
    const chunk = photoIDs.slice(i, i + 50)
    try {
      const fileRes = await cloud.getTempFileURL({ fileList: chunk })
      fileRes.fileList.forEach(f => {
        if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
      })
    } catch (err) {
      console.error('获取物料参考照临时链接失败:', err)
    }
  }
  return urlMap
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const { action, product, productId, material, materialId } = event

  if (!openid) {
    return { success: false, error: '未获取到用户身份' }
  }

  try {
    // 停用账号拦截
    const callerRes = await db.collection('users').where({ _openid: openid }).get()
    if (callerRes.data[0] && callerRes.data[0].disabled) {
      return { success: false, error: '账号已停用，请联系管理员' }
    }

    switch (action) {
      // 获取产品列表（默认只返回未下架的）
      case 'list': {
        const includeInactive = !!(event && event.includeInactive)
        const query = includeInactive ? {} : { isActive: true }
        const { limit, page, skip } = parsePaging(event)

        const countRes = await db.collection('products').where(query).count()
        const total = countRes.total || 0

        const res = await db.collection('products')
          .where(query)
          .orderBy('createdAt', 'desc')
          .skip(skip)
          .limit(limit)
          .get()

        const urlMap = await buildPhotoUrlMap(res.data)

        const list = res.data.map(p => {
          const photos = p.photos || {}
          const photoURLs = { front: '', back: '', side: '' }
          ;['front', 'back', 'side'].forEach(slot => {
            if (photos[slot]) photoURLs[slot] = urlMap[photos[slot]] || ''
          })
          return { ...p, photoURLs }
        })

        return {
          success: true,
          list,
          total,
          page,
          limit,
          skip,
          hasMore: skip + list.length < total
        }
      }

      // 新增产品
      case 'add': {
        if (!(await isAdmin(openid))) {
          return { success: false, error: '只有管理员可以维护产品库' }
        }
        if (!product || !product.brandName) {
          return { success: false, error: '缺少品牌名称' }
        }
        let photos = {}
        try {
          photos = sanitizePhotos(product.photos || {})
        } catch (photoErr) {
          return { success: false, error: photoErr.message }
        }
        const addRes = await db.collection('products').add({
          data: {
            _openid: openid,
            brandName: product.brandName,
            productLine: product.productLine || '',
            aliases: Array.isArray(product.aliases) ? product.aliases : [],
            photos,
            isActive: true,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })
        return { success: true, _id: addRes._id }
      }

      // 更新产品
      case 'update': {
        if (!(await isAdmin(openid))) {
          return { success: false, error: '只有管理员可以维护产品库' }
        }
        if (!productId) {
          return { success: false, error: '缺少 productId' }
        }
        const updateData = {
          ...pickEditableFields(product),
          updatedAt: db.serverDate()
        }
        let oldPhotos = {}
        try {
          const prev = await db.collection('products').doc(productId).get()
          oldPhotos = (prev.data && prev.data.photos) || {}
        } catch (_) {}
        if (updateData.photos !== undefined) {
          try {
            updateData.photos = sanitizePhotos(updateData.photos)
          } catch (photoErr) {
            return { success: false, error: photoErr.message }
          }
          const toDelete = []
          ;['front', 'back', 'side'].forEach(slot => {
            const next = updateData.photos[slot]
            const prev = oldPhotos[slot]
            if (prev && isCloudFileId(prev) && next !== prev) {
              toDelete.push(prev)
            }
          })
          await db.collection('products').doc(productId).update({ data: updateData })
          await deleteCloudFiles(toDelete)
        } else {
          await db.collection('products').doc(productId).update({ data: updateData })
        }
        return { success: true }
      }

      // 下架产品（软删除，保留历史巡检报告里对这条产品资料的可追溯性）
      case 'remove': {
        if (!(await isAdmin(openid))) {
          return { success: false, error: '只有管理员可以维护产品库' }
        }
        if (!productId) {
          return { success: false, error: '缺少 productId' }
        }
        await db.collection('products').doc(productId).update({
          data: { isActive: false, updatedAt: db.serverDate() }
        })
        return { success: true }
      }

      // 获取广告物料列表（默认只返回未下架的）
      case 'listMaterials': {
        const includeInactive = !!(event && event.includeInactive)
        const query = includeInactive ? {} : { isActive: true }
        const { limit, page, skip } = parsePaging(event)

        const countRes = await db.collection('adMaterials').where(query).count()
        const total = countRes.total || 0

        const res = await db.collection('adMaterials')
          .where(query)
          .orderBy('createdAt', 'desc')
          .skip(skip)
          .limit(limit)
          .get()

        const urlMap = await buildMaterialPhotoUrlMap(res.data || [])
        const list = (res.data || []).map(m => ({
          ...m,
          photoURL: (m.photo && urlMap[m.photo]) || ''
        }))

        return {
          success: true,
          list,
          total,
          page,
          limit,
          skip,
          hasMore: skip + list.length < total,
          categories: MATERIAL_CATEGORIES
        }
      }

      // 新增广告物料
      case 'addMaterial': {
        if (!(await isAdmin(openid))) {
          return { success: false, error: '只有管理员可以维护物料库' }
        }
        const materialName = material && typeof material.materialName === 'string'
          ? material.materialName.trim()
          : ''
        if (!materialName) {
          return { success: false, error: '缺少物料标准名称' }
        }
        let photo = ''
        try {
          photo = sanitizeMaterialPhoto(material.photo)
        } catch (photoErr) {
          return { success: false, error: photoErr.message }
        }
        const category = (material.category && MATERIAL_CATEGORIES.includes(material.category))
          ? material.category
          : '其他'
        const addRes = await db.collection('adMaterials').add({
          data: {
            _openid: openid,
            materialName,
            category,
            aliases: Array.isArray(material.aliases)
              ? material.aliases.map(s => String(s || '').trim()).filter(Boolean)
              : [],
            visualFeatures: String(material.visualFeatures || '').trim(),
            photo,
            isActive: true,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })
        return { success: true, _id: addRes._id }
      }

      // 更新广告物料
      case 'updateMaterial': {
        if (!(await isAdmin(openid))) {
          return { success: false, error: '只有管理员可以维护物料库' }
        }
        if (!materialId) {
          return { success: false, error: '缺少 materialId' }
        }
        const picked = pickMaterialEditableFields(material)
        if (picked.materialName !== undefined) {
          picked.materialName = String(picked.materialName || '').trim()
          if (!picked.materialName) {
            return { success: false, error: '物料标准名称不能为空' }
          }
        }
        if (picked.category !== undefined && !MATERIAL_CATEGORIES.includes(picked.category)) {
          picked.category = '其他'
        }
        if (picked.visualFeatures !== undefined) {
          picked.visualFeatures = String(picked.visualFeatures || '').trim()
        }
        if (picked.aliases !== undefined) {
          picked.aliases = Array.isArray(picked.aliases)
            ? picked.aliases.map(s => String(s || '').trim()).filter(Boolean)
            : []
        }
        let oldPhoto = ''
        try {
          const prev = await db.collection('adMaterials').doc(materialId).get()
          oldPhoto = (prev.data && prev.data.photo) || ''
        } catch (_) {}
        if (picked.photo !== undefined) {
          try {
            picked.photo = sanitizeMaterialPhoto(picked.photo)
          } catch (photoErr) {
            return { success: false, error: photoErr.message }
          }
        }
        const updateData = {
          ...picked,
          updatedAt: db.serverDate()
        }
        await db.collection('adMaterials').doc(materialId).update({ data: updateData })
        if (picked.photo !== undefined && oldPhoto && isCloudFileId(oldPhoto) && picked.photo !== oldPhoto) {
          await deleteCloudFiles([oldPhoto])
        }
        return { success: true }
      }

      // 下架广告物料（软删除）
      case 'removeMaterial': {
        if (!(await isAdmin(openid))) {
          return { success: false, error: '只有管理员可以维护物料库' }
        }
        if (!materialId) {
          return { success: false, error: '缺少 materialId' }
        }
        await db.collection('adMaterials').doc(materialId).update({
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
