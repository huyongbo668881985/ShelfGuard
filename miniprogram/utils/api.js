// 自建后端请求封装。替代 wx.cloud.callFunction / uploadFile / deleteFile。
// 登录 token 存在本地，过期后自动再用 wx.login 换一次。

const { apiBase } = require('./config')

const TOKEN_KEY = 'sg_token'

function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || ''
  } catch (_) {
    return ''
  }
}

function setToken(token) {
  try {
    wx.setStorageSync(TOKEN_KEY, token || '')
  } catch (_) {}
}

function rawRequest(path, data, auth) {
  return new Promise((resolve, reject) => {
    const header = { 'Content-Type': 'application/json' }
    if (auth) {
      const token = getToken()
      if (token) header.Authorization = 'Bearer ' + token
    }
    wx.request({
      url: apiBase + path,
      method: 'POST',
      data: data || {},
      header,
      timeout: 60000,
      success(res) {
        const body = res.data
        if (res.statusCode === 401) {
          const err = new Error((body && body.error) || '登录已过期')
          err.statusCode = 401
          reject(err)
          return
        }
        if (res.statusCode >= 400) {
          reject(new Error((body && body.error) || '请求失败'))
          return
        }
        resolve(body)
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '网络请求失败'))
      }
    })
  })
}

let loginTask = null

function loginWithCode(code) {
  return rawRequest('/api/auth/login', { code }, false).then(body => {
    if (body && body.token) setToken(body.token)
    return body
  })
}

function relogin() {
  if (loginTask) return loginTask
  loginTask = new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (!res.code) {
          loginTask = null
          reject(new Error('未取得登录凭证'))
          return
        }
        loginWithCode(res.code).then(body => {
          loginTask = null
          resolve(body)
        }).catch(err => {
          loginTask = null
          reject(err)
        })
      },
      fail(err) {
        loginTask = null
        reject(new Error((err && err.errMsg) || '登录失败'))
      }
    })
  })
  return loginTask
}

async function request(path, data) {
  try {
    return await rawRequest(path, data, true)
  } catch (err) {
    if (err && err.statusCode === 401) {
      await relogin()
      return rawRequest(path, data, true)
    }
    throw err
  }
}

function callFunction({ name, data }) {
  return request('/api/fn/' + name, data || {}).then(result => ({ result }))
}

function uploadFile({ cloudPath, filePath }) {
  const attempt = (retried) => new Promise((resolve, reject) => {
    wx.uploadFile({
      url: apiBase + '/api/upload',
      filePath,
      name: 'file',
      formData: { cloudPath },
      header: { Authorization: 'Bearer ' + getToken() },
      timeout: 60000,
      success(res) {
        let body = {}
        try {
          body = JSON.parse(res.data || '{}')
        } catch (_) {}
        if (res.statusCode === 401 && !retried) {
          relogin().then(() => attempt(true).then(resolve, reject)).catch(reject)
          return
        }
        if (res.statusCode >= 400 || !body.fileID) {
          reject(new Error(body.error || '照片上传失败'))
          return
        }
        resolve({ fileID: body.fileID })
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '照片上传失败'))
      }
    })
  })
  return attempt(false)
}

function deleteFile({ fileList }) {
  return request('/api/files/delete', { fileList: fileList || [] })
}

module.exports = {
  callFunction,
  uploadFile,
  deleteFile,
  loginWithCode,
  getToken,
  setToken
}
