// 云函数：geocode
// 功能：逆地理编码（坐标 -> 路名/地标），调用腾讯地图 WebService API
// 放在云函数里做的好处：不需要在小程序后台配置 request 合法域名白名单，
// 且 API Key 只存在于服务端环境变量，不会暴露在前端代码里。

const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

// Key 通过云函数环境变量 TENCENT_MAP_KEY 注入（云开发控制台 -> 云函数 -> 函数配置 -> 环境变量）
const MAP_KEY = process.env.TENCENT_MAP_KEY || ''

exports.main = async (event) => {
  const { lat, lng } = event
  if (!lat || !lng) {
    console.log('[geocode] 参数缺失', event)
    return { success: false, address: '', reason: 'PARAM_INVALID' }
  }

  // 未配置 Key 时直接退回坐标，保证不崩溃（并在 reason 里标明，方便前端诊断）
  if (!MAP_KEY) {
    console.log('[geocode] 未配置 TENCENT_MAP_KEY 环境变量')
    return { success: false, address: `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`, reason: 'NO_KEY' }
  }

  try {
    const url = `https://apis.map.qq.com/ws/geocoder/v1/?location=${lat},${lng}&key=${MAP_KEY}&get_poi=0`
    const res = await axios.get(url, { timeout: 8000 })
    const data = res.data || {}

    // 关键修复：腾讯地图 status !== 0 都是失败（如 KEY 失效/未授权/限流），
    // 之前没检测，会把错误响应的坐标当成功返回，导致前端只显示坐标且不报错。
    if (data.status !== 0) {
      console.log('[geocode] 腾讯地图返回错误 status=', data.status, 'message=', data.message)
      return {
        success: false,
        address: `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`,
        reason: `API_ERROR(${data.status}:${data.message || 'unknown'})`
      }
    }

    const result = data.result || {}
    const comp = result.address_component || {}
    const fa = result.formatted_addresses || {}

    // 优先用推荐/标准地址（常含标志性建筑），其次 路名+门牌，最后退回原始 address
    const recommend = fa.recommend || fa.standard_address || ''
    const street = [comp.street, comp.street_number].filter(Boolean).join('')
    const fallback = result.address || `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`

    const address = recommend || street || fallback
    return { success: true, address, reason: '' }
  } catch (err) {
    // 依赖未安装、网络超时等异常都退回坐标，并返回原因供诊断
    console.log('[geocode] 请求异常', err && err.message)
    return {
      success: false,
      address: `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`,
      reason: `DEP_OR_API_ERROR(${err && err.message ? err.message : 'unknown'})`
    }
  }
}
