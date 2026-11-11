'use strict'

const crypto = require('crypto')
const db = require('./docdb')
const files = require('./files')
const { basePath } = require('./config')

const _ = db.command

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  if (left.length === 0 || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function checkWebMapPasscode(req, res) {
  const requiredPass = (process.env.WEB_MAP_PASSWORD || '').trim()
  if (!requiredPass) return true
  const provided = String(req.headers['x-map-key'] || req.query.key || '').trim()
  if (!provided || !safeEqual(provided, requiredPass)) {
    res.status(401).json({
      success: false,
      needPasscode: true,
      error: '请输入访问口令'
    })
    return false
  }
  return true
}

function extractSharePercent(aiReport) {
  if (!aiReport || typeof aiReport !== 'object') return null
  const ov = aiReport.ownBrandOverview
  if (ov && ov.facingSharePercent != null) {
    const n = Number(ov.facingSharePercent)
    if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n * 10) / 10
  }
  const brands = aiReport.competitiveAnalysis && aiReport.competitiveAnalysis.brands
  if (Array.isArray(brands)) {
    const own = brands.find(b => b && (b.brand === '我方品牌' || b.isOwn === true))
    if (own && own.sharePercent != null) {
      const n = Number(own.sharePercent)
      if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n * 10) / 10
    }
  }
  return null
}

async function mapRouteApiHandler(req, res) {
  if (!checkWebMapPasscode(req, res)) return

  try {
    const dateStr = typeof req.query.date === 'string' ? req.query.date.trim() : ''
    const reqUserId = typeof req.query.userId === 'string' ? req.query.userId.trim() : ''

    const now = new Date()
    let startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
    let endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)

    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [y, m, d] = dateStr.split('-').map(Number)
      startDate = new Date(y, m - 1, d, 0, 0, 0, 0)
      endDate = new Date(y, m - 1, d, 23, 59, 59, 999)
    }

    const dayCond = {
      createdAt: _.and(_.gte(startDate), _.lte(endDate)),
      'aiReport.metadata.isMock': _.neq(true)
    }

    const dayRes = await db.collection('inspections')
      .where(dayCond)
      .orderBy('createdAt', 'asc')
      .limit(800)
      .get()

    const allDayRecords = dayRes.data || []

    // 汇总人员列表：在职已审批人员 + 当日有记录的人员
    const userMap = new Map()
    try {
      const uRes = await db.collection('users').orderBy('createdAt', 'asc').limit(200).get()
      ;(uRes.data || []).forEach(u => {
        if (u.disabled) return
        const isApproved = u.approved === true || (
          (u.approved === undefined || u.approved === null) &&
          (u.role === 'admin' || u.role === 'manager')
        )
        if (!isApproved) return
        const key = u._openid || `id:${u._id}`
        userMap.set(key, {
          userId: u._id || key,
          _openid: u._openid || '',
          name: (u.name && u.name.trim()) ? u.name.trim() : '未命名业务员',
          department: u.department || '',
          visitCount: 0,
          clockInTime: '',
          clockOutTime: '',
          clockCount: 0,
          totalCount: 0
        })
      })
    } catch (e) {
      console.warn('[web-map] 读取用户列表失败:', e.message)
    }

    allDayRecords.forEach(r => {
      const key = r._openid || `name:${r.userName || '未知'}`
      if (!userMap.has(key)) {
        userMap.set(key, {
          userId: key,
          _openid: r._openid || '',
          name: (r.userName && r.userName.trim()) ? r.userName.trim() : '未命名业务员',
          department: '',
          visitCount: 0,
          clockInTime: '',
          clockOutTime: '',
          clockCount: 0,
          totalCount: 0
        })
      }
      const entry = userMap.get(key)
      if ((!entry.name || entry.name === '未命名业务员') && r.userName) {
        entry.name = r.userName.trim()
      }
      const isClock = r.recordType === 'clock_in' || r.recordType === 'clock_out' || r.status === 'clocked'
      const dt = r.createdAt ? new Date(r.createdAt) : null
      const hm = dt && !isNaN(dt.getTime())
        ? `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
        : ''
      if (isClock) {
        entry.clockCount++
        if (r.recordType === 'clock_out') {
          entry.clockOutTime = hm
        } else if (!entry.clockInTime) {
          entry.clockInTime = hm
        }
      } else {
        entry.visitCount++
      }
      entry.totalCount++
    })

    const entries = Array.from(userMap.values()).sort((a, b) => {
      if ((b.totalCount > 0) !== (a.totalCount > 0)) return b.totalCount > 0 ? 1 : -1
      if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount
      return String(a.name).localeCompare(String(b.name), 'zh-CN')
    })

    let selectedUserId = reqUserId
    let selectedUserName = ''
    let targetRecords = []

    if (reqUserId === '__ALL__') {
      selectedUserId = '__ALL__'
      selectedUserName = '全部人员'
      targetRecords = allDayRecords
    } else {
      let targetEntry = reqUserId ? entries.find(e => e.userId === reqUserId) : null
      if (!targetEntry && entries.length > 0) {
        targetEntry = entries[0]
      }
      if (targetEntry) {
        selectedUserId = targetEntry.userId
        selectedUserName = targetEntry.name
        targetRecords = allDayRecords.filter(r => {
          if (targetEntry._openid && r._openid) return r._openid === targetEntry._openid
          return (r.userName || '未命名业务员') === targetEntry.name
        })
      }
    }

    // 为每条记录关联一个稳定的 userId，方便"全部人员"模式下前端按人分组画不同颜色的轨迹线
    const openidToUserId = new Map()
    const nameToUserId = new Map()
    entries.forEach(e => {
      if (e._openid) openidToUserId.set(e._openid, e.userId)
      if (e.name) nameToUserId.set(e.name, e.userId)
    })

    // 批量换取照片签名链接
    const allPhotoIds = []
    targetRecords.forEach(item => {
      if (Array.isArray(item.photoFileIDs)) {
        item.photoFileIDs.forEach(fid => {
          if (fid && !allPhotoIds.includes(fid)) allPhotoIds.push(fid)
        })
      }
    })
    const photoURLMap = {}
    if (allPhotoIds.length > 0) {
      try {
        const fileRes = await files.getTempFileURL({ fileList: allPhotoIds })
        ;(fileRes.fileList || []).forEach(f => {
          if (f.tempFileURL) photoURLMap[f.fileID] = f.tempFileURL
        })
      } catch (err) {
        console.error('[web-map] 获取照片签名链接失败:', err)
      }
    }

    const points = targetRecords.map(item => {
      const photoURLs = Array.isArray(item.photoFileIDs)
        ? item.photoFileIDs.map(fid => photoURLMap[fid] || '').filter(Boolean)
        : []
      const recordType = (item.recordType === 'clock_in' || item.recordType === 'clock_out')
        ? item.recordType
        : (item.status === 'clocked' ? 'clock_in' : 'visit')

      let aiSummary = null
      if (item.aiReport && typeof item.aiReport === 'object') {
        const ar = item.aiReport
        aiSummary = {
          score: ar.score,
          scoreLevel: ar.scoreLevel || '',
          summary: ar.summary || '',
          sharePercent: extractSharePercent(ar),
          issues: Array.isArray(ar.issues) ? ar.issues.slice(0, 5) : [],
          suggestions: Array.isArray(ar.suggestions) ? ar.suggestions.slice(0, 5) : []
        }
      }

      const ownerUserId = (item._openid && openidToUserId.get(item._openid)) ||
        (item.userName && nameToUserId.get(item.userName)) ||
        'unknown'

      return {
        _id: item._id,
        userId: ownerUserId,
        recordType,
        taskName: item.taskName || '',
        storeName: item.storeName || '',
        userName: item.userName || selectedUserName || '未命名',
        customerId: item.customerId || '',
        photoCount: item.photoCount || photoURLs.length,
        photoURLs,
        thumbnailURL: photoURLs[0] || '',
        location: item.location || {},
        status: item.status || '',
        createdAt: item.createdAt,
        aiReport: aiSummary
      }
    })

    const usersList = entries.map(e => ({
      userId: e.userId,
      name: e.name,
      department: e.department,
      visitCount: e.visitCount,
      clockCount: e.clockCount,
      clockInTime: e.clockInTime,
      clockOutTime: e.clockOutTime,
      totalCount: e.totalCount
    }))

    return res.json({
      success: true,
      selectedUserId,
      selectedUserName,
      usersList,
      points
    })
  } catch (err) {
    console.error('[web-map] 查询轨迹失败:', err)
    return res.status(500).json({
      success: false,
      error: err.message || '服务器错误'
    })
  }
}

function mapPageHandler(_req, res) {
  const prefix = basePath() || '/shelfguard'
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.send(renderHtml(prefix))
}

function renderHtml(prefix) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>特8水印 · 拜访轨迹与考勤地图</title>
  <link rel="stylesheet" href="https://cdn.bootcdn.net/ajax/libs/leaflet/1.9.4/leaflet.min.css" onerror="this.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'" />
  <style>
    :root {
      --navy: #1C3D5A;
      --navy-light: #2E5A82;
      --gold: #C2933B;
      --green: #059669;
      --amber: #D97706;
      --bg: #F4F6F9;
      --card: #FFFFFF;
      --text: #1F2933;
      --muted: #627D98;
      --border: #E4E7EB;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    /* Top Header */
    .topbar {
      height: 60px;
      background: linear-gradient(135deg, #1C3D5A 0%, #264F73 100%);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.12);
      z-index: 1000;
      flex-shrink: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .brand-tag {
      font-size: 12px;
      background: rgba(194, 147, 59, 0.9);
      padding: 3px 10px;
      border-radius: 12px;
      font-weight: 600;
    }
    .date-controls {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .btn {
      border: none;
      background: rgba(255,255,255,0.14);
      color: #fff;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover { background: rgba(255,255,255,0.24); }
    .btn-gold { background: var(--gold); font-weight: 600; }
    .btn-gold:hover { background: #b0832f; }
    .date-input {
      background: #fff;
      color: var(--text);
      border: none;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      outline: none;
    }

    /* Main Workspace */
    .workspace {
      flex: 1;
      display: flex;
      min-height: 0;
      position: relative;
    }

    /* Left Sidebar */
    .sidebar {
      width: 370px;
      background: var(--card);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      z-index: 500;
      flex-shrink: 0;
    }
    .sidebar-section {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
    }
    .section-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .user-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      max-height: 150px;
      overflow-y: auto;
    }
    .user-chip {
      padding: 6px 12px;
      border-radius: 18px;
      background: #F0F4F8;
      color: #334E68;
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 2px solid transparent;
      transition: all 0.15s;
      user-select: none;
    }
    .user-chip:hover { background: #E1E8F0; }
    .user-chip.active {
      background: #EBF4FF;
      border-color: var(--navy);
      color: var(--navy);
      font-weight: 600;
    }
    .chip-badge {
      font-size: 11px;
      padding: 1px 7px;
      border-radius: 10px;
      background: #CBD2D9;
      color: #334E68;
      font-weight: 600;
    }
    .chip-badge.has {
      background: var(--gold);
      color: #fff;
    }
    .user-color-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    /* Summary Cards */
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      padding: 12px 16px;
      background: #F8FAFC;
      border-bottom: 1px solid var(--border);
    }
    .stat-box {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 10px;
      text-align: center;
    }
    .stat-title {
      font-size: 11px;
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }
    .stat-val {
      margin-top: 4px;
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
    }
    .stat-val.ok { color: var(--green); }
    .stat-val.warn { color: #9AA0A6; font-weight: 500; font-size: 13px; }

    /* Timeline List */
    .timeline-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
    }
    .timeline-empty {
      padding: 48px 16px;
      text-align: center;
      color: #9AA0A6;
      font-size: 14px;
    }
    .tl-item {
      display: flex;
      gap: 12px;
      padding: 12px;
      border-radius: 12px;
      margin-bottom: 10px;
      border: 1px solid var(--border);
      background: #fff;
      cursor: pointer;
      transition: all 0.15s;
      position: relative;
    }
    .tl-item:hover {
      border-color: #BCCCDC;
      box-shadow: 0 3px 10px rgba(0,0,0,0.05);
    }
    .tl-item.active {
      background: #FFFBF2;
      border-color: var(--gold);
      box-shadow: 0 4px 14px rgba(194,147,59,0.16);
    }
    .tl-badge {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--navy);
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .tl-badge.clock_in { background: var(--green); }
    .tl-badge.clock_out { background: var(--amber); }
    .tl-item.active .tl-badge { background: var(--gold); }
    .tl-body {
      flex: 1;
      min-width: 0;
    }
    .tl-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .tl-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tl-time {
      font-size: 12px;
      color: var(--muted);
      font-weight: 600;
      flex-shrink: 0;
    }
    .tl-sub {
      margin-top: 4px;
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tl-tags {
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tag {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 6px;
      font-weight: 600;
    }
    .tag-user { background: #EBF4FF; color: var(--navy); }
    .tag-score { background: #E6F7F0; color: var(--green); }
    .tag-nocoord { background: #FFF4E0; color: #B26A00; }
    .tl-thumb {
      width: 56px;
      height: 56px;
      border-radius: 8px;
      object-fit: cover;
      background: #EEF2F7;
      flex-shrink: 0;
    }

    /* Map Container */
    .map-stage {
      flex: 1;
      position: relative;
      height: 100%;
    }
    #map {
      width: 100%;
      height: 100%;
      background: #E5E9F0;
    }
    .map-toolbar {
      position: absolute;
      top: 16px;
      right: 16px;
      z-index: 600;
      display: flex;
      gap: 8px;
    }
    .map-tool-btn {
      background: #fff;
      color: var(--navy);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .map-tool-btn:hover { background: #F8FAFC; }

    /* Custom Map Marker Pin */
    .sg-pin-wrap {
      position: relative;
      transform: translate(-50%, -100%);
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      cursor: pointer;
    }
    .sg-pin-bubble {
      white-space: nowrap;
      padding: 5px 10px;
      border-radius: 16px;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      background: var(--navy);
      box-shadow: 0 3px 10px rgba(0,0,0,0.22);
      border: 2px solid #fff;
      display: flex;
      align-items: center;
      gap: 5px;
      transition: transform 0.15s;
    }
    .sg-pin-wrap:hover .sg-pin-bubble,
    .sg-pin-wrap.active .sg-pin-bubble {
      transform: scale(1.1);
      background: var(--gold) !important;
      z-index: 999;
    }
    .sg-pin-arrow {
      width: 0;
      height: 0;
      border-left: 6px solid transparent;
      border-right: 6px solid transparent;
      border-top: 7px solid #fff;
      margin-top: -1px;
    }

    /* Right/Floating Detail Drawer */
    .detail-drawer {
      position: absolute;
      top: 16px;
      right: 16px;
      bottom: 16px;
      width: 400px;
      max-width: calc(100vw - 410px);
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.18);
      z-index: 700;
      display: none;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .detail-drawer.open { display: flex; }
    .drawer-header {
      padding: 16px 18px;
      background: var(--navy);
      color: #fff;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .drawer-title {
      font-size: 17px;
      font-weight: 700;
      line-height: 1.35;
    }
    .drawer-sub {
      margin-top: 4px;
      font-size: 12px;
      opacity: 0.85;
    }
    .drawer-close {
      background: rgba(255,255,255,0.15);
      border: none;
      color: #fff;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      font-size: 16px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .drawer-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 18px;
      background: #F8FAFC;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
    }
    .nav-btn {
      background: #fff;
      border: 1px solid var(--border);
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      color: var(--navy);
      font-weight: 600;
    }
    .nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .drawer-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px 18px;
    }
    .info-list {
      font-size: 13px;
      line-height: 1.7;
      color: #334E68;
      background: #F8FAFC;
      padding: 12px 14px;
      border-radius: 10px;
      margin-bottom: 16px;
    }
    .info-row { display: flex; gap: 8px; }
    .info-key { color: var(--muted); width: 64px; flex-shrink: 0; }
    .info-val { flex: 1; word-break: break-all; font-weight: 500; }

    .photo-section-title {
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 10px;
      color: var(--text);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .photo-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-bottom: 18px;
    }
    .photo-grid.single {
      grid-template-columns: 1fr;
    }
    .photo-card {
      position: relative;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid var(--border);
      background: #EEF2F7;
      cursor: zoom-in;
      aspect-ratio: 4 / 3;
    }
    .photo-card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.2s;
    }
    .photo-card:hover img { transform: scale(1.03); }
    .photo-hint {
      position: absolute;
      right: 8px;
      bottom: 8px;
      background: rgba(0,0,0,0.55);
      color: #fff;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 6px;
    }

    .ai-box {
      border: 1px solid #D9E2EC;
      border-radius: 12px;
      padding: 14px;
      background: #F8FAFC;
    }
    .ai-score-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .ai-score-badge {
      font-size: 20px;
      font-weight: 800;
      color: var(--green);
    }
    .ai-summary {
      font-size: 13px;
      line-height: 1.6;
      color: #334E68;
      margin-bottom: 10px;
    }
    .ai-list {
      font-size: 12px;
      color: #486581;
      line-height: 1.6;
      padding-left: 16px;
    }

    /* Fullscreen Photo Lightbox */
    .lightbox {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.92);
      z-index: 2000;
      display: none;
      align-items: center;
      justify-content: center;
      flex-direction: column;
    }
    .lightbox.open { display: flex; }
    .lb-img-wrap {
      max-width: 92vw;
      max-height: 84vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .lb-img {
      max-width: 92vw;
      max-height: 84vh;
      object-fit: contain;
      border-radius: 8px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      transition: transform 0.15s ease;
    }
    .lb-controls {
      margin-top: 16px;
      display: flex;
      align-items: center;
      gap: 14px;
      color: #fff;
      font-size: 14px;
    }
    .lb-btn {
      background: rgba(255,255,255,0.16);
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 20px;
      cursor: pointer;
      font-size: 13px;
    }
    .lb-btn:hover { background: rgba(255,255,255,0.28); }
    .lb-close {
      position: absolute;
      top: 20px;
      right: 24px;
      background: rgba(255,255,255,0.18);
      color: #fff;
      border: none;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      font-size: 20px;
      cursor: pointer;
    }

    /* Password Auth Modal */
    .auth-modal {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(6px);
      z-index: 3000;
      display: none;
      align-items: center;
      justify-content: center;
    }
    .auth-modal.open { display: flex; }
    .auth-card {
      width: 380px;
      max-width: 90vw;
      background: #fff;
      border-radius: 16px;
      padding: 28px 26px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.35);
      text-align: center;
    }
    .auth-icon {
      font-size: 36px;
      margin-bottom: 10px;
    }
    .auth-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--navy);
    }
    .auth-desc {
      margin-top: 6px;
      font-size: 13px;
      color: var(--muted);
    }
    .auth-input {
      margin-top: 18px;
      width: 100%;
      padding: 11px 14px;
      border: 1px solid #CBD2D9;
      border-radius: 10px;
      font-size: 15px;
      outline: none;
      text-align: center;
      letter-spacing: 1px;
    }
    .auth-input:focus {
      border-color: var(--navy);
      box-shadow: 0 0 0 3px rgba(28,61,90,0.12);
    }
    .auth-err {
      margin-top: 8px;
      font-size: 12px;
      color: #DC2626;
      min-height: 18px;
    }
    .auth-submit {
      margin-top: 10px;
      width: 100%;
      padding: 11px;
      background: var(--navy);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }
    .auth-submit:hover { background: var(--navy-light); }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="brand-logo">🗺️ 特8水印 · 拜访地图</span>
      <span class="brand-tag">团队轨迹与现场照片看板</span>
    </div>
    <div class="date-controls">
      <button class="btn" id="prevDayBtn">‹ 前一天</button>
      <input type="date" class="date-input" id="datePicker" />
      <button class="btn" id="nextDayBtn">后一天 ›</button>
      <button class="btn btn-gold" id="todayBtn">回到今天</button>
      <button class="btn" id="refreshBtn">↻ 刷新</button>
      <button class="btn" id="lockBtn" title="清除本机保存的密码并重新锁屏">🔒 锁屏</button>
    </div>
  </header>

  <div class="workspace">
    <!-- Left Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-section">
        <div class="section-label">
          <span>业务员选择</span>
          <span id="userSummaryText">加载中...</span>
        </div>
        <div class="user-grid" id="userGrid"></div>
      </div>

      <div class="summary-strip">
        <div class="stat-box">
          <div class="stat-title">🌅 上班打卡</div>
          <div class="stat-val warn" id="statClockIn">--</div>
        </div>
        <div class="stat-box">
          <div class="stat-title">🏬 门店拜访</div>
          <div class="stat-val" id="statVisitCount">0 家</div>
        </div>
        <div class="stat-box">
          <div class="stat-title">🌙 下班打卡</div>
          <div class="stat-val warn" id="statClockOut">--</div>
        </div>
      </div>

      <div class="timeline-list" id="timelineList"></div>
    </aside>

    <!-- Map Canvas -->
    <main class="map-stage">
      <div id="map"></div>
      <div class="map-toolbar">
        <button class="map-tool-btn" id="fitBoundsBtn">🎯 全览当前轨迹</button>
      </div>

      <!-- Right Detail & Photo Drawer -->
      <section class="detail-drawer" id="detailDrawer">
        <div class="drawer-header">
          <div>
            <div class="drawer-title" id="drawerTitle">门店详情</div>
            <div class="drawer-sub" id="drawerSub"></div>
          </div>
          <button class="drawer-close" id="drawerCloseBtn" title="关闭">✕</button>
        </div>
        <div class="drawer-nav">
          <button class="nav-btn" id="prevPointBtn">‹ 上一个点</button>
          <span id="drawerIndexText">1 / 1</span>
          <button class="nav-btn" id="nextPointBtn">下一个点 ›</button>
        </div>
        <div class="drawer-content" id="drawerContent"></div>
      </section>
    </main>
  </div>

  <!-- Full-screen Photo Lightbox -->
  <div class="lightbox" id="lightbox">
    <button class="lb-close" id="lbCloseBtn">✕</button>
    <div class="lb-img-wrap">
      <img class="lb-img" id="lbImg" src="" alt="拜访照片预览" />
    </div>
    <div class="lb-controls">
      <button class="lb-btn" id="lbPrevBtn">‹ 上一张</button>
      <span id="lbCounter">1 / 1</span>
      <button class="lb-btn" id="lbNextBtn">下一张 ›</button>
      <button class="lb-btn" id="lbZoomInBtn">＋ 放大</button>
      <button class="lb-btn" id="lbZoomOutBtn">－ 缩小</button>
      <a class="lb-btn" id="lbDownloadBtn" href="#" target="_blank" style="text-decoration:none">⬇ 查看原图</a>
    </div>
  </div>

  <!-- Password Auth Modal -->
  <div class="auth-modal" id="authModal">
    <div class="auth-card">
      <div class="auth-icon">🔒</div>
      <div class="auth-title">拜访地图查看验证</div>
      <div class="auth-desc">请输入团队查看密码以加载轨迹与现场照片</div>
      <input type="password" class="auth-input" id="authInput" placeholder="请输入查看密码" autocomplete="current-password" />
      <div class="auth-err" id="authErr"></div>
      <button class="auth-submit" id="authSubmitBtn">确认进入</button>
    </div>
  </div>

  <script src="https://cdn.bootcdn.net/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
  <script>
    if (typeof L === 'undefined') {
      document.write('<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\\/script>');
    }
  </script>
  <script>
    (function() {
      const API_BASE = ${JSON.stringify(prefix)};
      const USER_COLORS = ['#1C3D5A', '#2563EB', '#7C3AED', '#DB2777', '#0891B2', '#EA580C', '#4F46E5', '#0D9488'];

      function toDateStr(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
      }

      function formatHM(iso) {
        if (!iso) return '--:--';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '--:--';
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }

      function isValidCoord(lat, lng) {
        return Number.isFinite(lat) && Number.isFinite(lng) &&
          (Math.abs(lat) > 0.0001 || Math.abs(lng) > 0.0001) &&
          Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      }

      function escapeHtml(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      const todayStr = toDateStr(new Date());
      let selectedDate = todayStr;
      let selectedUserId = '';
      let usersList = [];
      let points = [];
      let activeIndex = -1;
      let map = null;
      let markersLayer = null;
      let linesLayer = null;
      let markerInstances = [];

      // Lightbox state
      let lbUrls = [];
      let lbIndex = 0;
      let lbScale = 1;

      const datePicker = document.getElementById('datePicker');
      datePicker.value = selectedDate;
      datePicker.max = todayStr;

      function initMap() {
        if (typeof L === 'undefined') {
          setTimeout(initMap, 150);
          return;
        }
        map = L.map('map', {
          center: [30.6586, 104.0648],
          zoom: 12,
          zoomControl: true
        });

        // 高德 GCJ-02 瓦片（与微信小程序 wx.getLocation gcj02 坐标系完全一致，零偏移）
        L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
          subdomains: ['1', '2', '3', '4'],
          maxZoom: 18,
          minZoom: 3,
          attribution: '© 高德地图 · 特8水印'
        }).addTo(map);

        linesLayer = L.layerGroup().addTo(map);
        markersLayer = L.layerGroup().addTo(map);

        loadRoute();
      }

      function getUserColor(userId) {
        const idx = usersList.findIndex(u => u.userId === userId);
        return USER_COLORS[(idx >= 0 ? idx : 0) % USER_COLORS.length];
      }

      function showAuthModal(errMsg) {
        const modal = document.getElementById('authModal');
        const errEl = document.getElementById('authErr');
        const inputEl = document.getElementById('authInput');
        errEl.textContent = errMsg || '';
        modal.classList.add('open');
        setTimeout(() => inputEl.focus(), 50);
      }

      function hideAuthModal() {
        document.getElementById('authModal').classList.remove('open');
        document.getElementById('authErr').textContent = '';
      }

      async function loadRoute() {
        const key = localStorage.getItem('sg_web_map_key') || '';
        const url = API_BASE + '/api/web/map-route?date=' + encodeURIComponent(selectedDate) +
          '&userId=' + encodeURIComponent(selectedUserId);

        try {
          const res = await fetch(url, {
            headers: key ? { 'x-map-key': key } : {}
          });
          if (res.status === 401) {
            showAuthModal(key ? '密码不正确，请重新输入' : '');
            return;
          }
          hideAuthModal();
          const data = await res.json();
          if (!data.success) {
            alert(data.error || '加载失败');
            return;
          }

          usersList = data.usersList || [];
          selectedUserId = data.selectedUserId || '';
          processPoints(data.points || []);
          renderUsers();
          renderSummary();
          renderTimeline();
          renderMapLayers(true);

          if (points.length > 0) {
            selectPoint(0, false);
          } else {
            closeDrawer();
          }
        } catch (err) {
          console.error('加载轨迹失败:', err);
        }
      }

      function processPoints(rawPoints) {
        const seenCoords = new Map();
        const perUserVisitSeq = new Map();

        points = rawPoints.map((item, idx) => {
          const recordType = (item.recordType === 'clock_in' || item.recordType === 'clock_out')
            ? item.recordType
            : (item.status === 'clocked' ? 'clock_in' : 'visit');
          const isClock = recordType === 'clock_in' || recordType === 'clock_out';
          const timeText = formatHM(item.createdAt);
          const uKey = item.userId || item.userName || 'default';

          let badgeText = '';
          let typeLabel = '';
          let displayTitle = '';

          if (recordType === 'clock_in') {
            badgeText = '起';
            typeLabel = '上班打卡';
            displayTitle = '上班打卡';
          } else if (recordType === 'clock_out') {
            badgeText = '终';
            typeLabel = '下班打卡';
            displayTitle = '下班打卡';
          } else {
            const seq = (perUserVisitSeq.get(uKey) || 0) + 1;
            perUserVisitSeq.set(uKey, seq);
            badgeText = String(seq);
            typeLabel = '第' + seq + '站';
            displayTitle = item.storeName || '无门店（常规拜访）';
          }

          const rawLat = item.location ? Number(item.location.latitude) : 0;
          const rawLng = item.location ? Number(item.location.longitude) : 0;
          const hasCoord = isValidCoord(rawLat, rawLng);
          let lat = rawLat;
          let lng = rawLng;

          if (hasCoord) {
            const cKey = rawLat.toFixed(5) + ',' + rawLng.toFixed(5);
            const dup = seenCoords.get(cKey) || 0;
            seenCoords.set(cKey, dup + 1);
            if (dup > 0) {
              const angle = (dup * Math.PI) / 3;
              lat = rawLat + Math.sin(angle) * 0.00012 * dup;
              lng = rawLng + Math.cos(angle) * 0.00012 * dup;
            }
          }

          return Object.assign({}, item, {
            index: idx,
            recordType,
            isClock,
            badgeText,
            typeLabel,
            displayTitle,
            timeText,
            hasCoord,
            lat,
            lng,
            addressText: (item.location && item.location.address) ||
              (hasCoord ? (rawLat.toFixed(5) + ', ' + rawLng.toFixed(5)) : '未记录定位地址'),
            photoURLs: Array.isArray(item.photoURLs) ? item.photoURLs : []
          });
        });
      }

      function renderUsers() {
        const grid = document.getElementById('userGrid');
        const activeUsersCount = usersList.filter(u => u.totalCount > 0).length;
        document.getElementById('userSummaryText').textContent =
          '今日出勤 ' + activeUsersCount + ' / ' + usersList.length + ' 人';

        const totalAll = usersList.reduce((s, u) => s + u.totalCount, 0);
        let html = '<div class="user-chip ' + (selectedUserId === '__ALL__' ? 'active' : '') + '" data-userid="__ALL__">' +
          '<span>👥 全部人员</span>' +
          '<span class="chip-badge ' + (totalAll > 0 ? 'has' : '') + '">' + totalAll + '</span>' +
          '</div>';

        usersList.forEach((u, i) => {
          const isAct = selectedUserId === u.userId;
          const color = USER_COLORS[i % USER_COLORS.length];
          html += '<div class="user-chip ' + (isAct ? 'active' : '') + '" data-userid="' + escapeHtml(u.userId) + '">' +
            '<span class="user-color-dot" style="background:' + color + '"></span>' +
            '<span>' + escapeHtml(u.name) + '</span>' +
            '<span class="chip-badge ' + (u.totalCount > 0 ? 'has' : '') + '">' + u.totalCount + '</span>' +
            '</div>';
        });

        grid.innerHTML = html;
        grid.querySelectorAll('.user-chip').forEach(el => {
          el.addEventListener('click', () => {
            const uid = el.getAttribute('data-userid');
            if (uid && uid !== selectedUserId) {
              selectedUserId = uid;
              loadRoute();
            }
          });
        });
      }

      function renderSummary() {
        const ciEl = document.getElementById('statClockIn');
        const visitEl = document.getElementById('statVisitCount');
        const coEl = document.getElementById('statClockOut');

        const visits = points.filter(p => !p.isClock);
        const ci = points.find(p => p.recordType === 'clock_in');
        const coList = points.filter(p => p.recordType === 'clock_out');
        const co = coList.length > 0 ? coList[coList.length - 1] : null;

        visitEl.textContent = visits.length + ' 家';

        if (selectedUserId === '__ALL__') {
          const ciCount = usersList.filter(u => u.clockInTime).length;
          const coCount = usersList.filter(u => u.clockOutTime).length;
          ciEl.textContent = ciCount + ' 人已打卡';
          ciEl.className = 'stat-val ' + (ciCount > 0 ? 'ok' : 'warn');
          coEl.textContent = coCount + ' 人已打卡';
          coEl.className = 'stat-val ' + (coCount > 0 ? 'ok' : 'warn');
        } else {
          ciEl.textContent = ci ? ci.timeText : '未打卡';
          ciEl.className = 'stat-val ' + (ci ? 'ok' : 'warn');
          coEl.textContent = co ? co.timeText : '未打卡';
          coEl.className = 'stat-val ' + (co ? 'ok' : 'warn');
        }
      }

      function renderTimeline() {
        const container = document.getElementById('timelineList');
        if (points.length === 0) {
          container.innerHTML = '<div class="timeline-empty">当天暂无打卡或门店拜访记录</div>';
          return;
        }

        let html = '';
        points.forEach((p, idx) => {
          const isAct = idx === activeIndex;
          const scoreHtml = (!p.isClock && p.aiReport && typeof p.aiReport.score === 'number')
            ? '<span class="tag tag-score">' + p.aiReport.score + '分</span>'
            : '';
          const userHtml = selectedUserId === '__ALL__'
            ? '<span class="tag tag-user">' + escapeHtml(p.userName) + '</span>'
            : '';
          const noCoordHtml = !p.hasCoord
            ? '<span class="tag tag-nocoord">无定位</span>'
            : '';
          const thumbHtml = p.thumbnailURL
            ? '<img class="tl-thumb" src="' + escapeHtml(p.thumbnailURL) + '" alt="缩略图" />'
            : '';

          html += '<div class="tl-item ' + (isAct ? 'active' : '') + '" id="tl-item-' + idx + '" data-idx="' + idx + '">' +
            '<div class="tl-badge ' + p.recordType + '">' + escapeHtml(p.badgeText) + '</div>' +
            '<div class="tl-body">' +
              '<div class="tl-head">' +
                '<span class="tl-title">' + escapeHtml(p.displayTitle) + '</span>' +
                '<span class="tl-time">' + escapeHtml(p.timeText) + '</span>' +
              '</div>' +
              '<div class="tl-sub">📍 ' + escapeHtml(p.addressText) + '</div>' +
              '<div class="tl-tags">' +
                userHtml + scoreHtml + noCoordHtml +
                '<span style="font-size:11px;color:#829AB1">📷 ' + p.photoURLs.length + '张</span>' +
              '</div>' +
            '</div>' +
            thumbHtml +
          '</div>';
        });

        container.innerHTML = html;
        container.querySelectorAll('.tl-item').forEach(el => {
          el.addEventListener('click', () => {
            const idx = Number(el.getAttribute('data-idx'));
            selectPoint(idx, true);
          });
        });
      }

      function renderMapLayers(shouldFit) {
        if (!map) return;
        linesLayer.clearLayers();
        markersLayer.clearLayers();
        markerInstances = [];

        const coordPoints = points.filter(p => p.hasCoord);

        // 按业务员分组绘制轨迹折线
        const byUser = new Map();
        coordPoints.forEach(p => {
          const k = p.userId || p.userName || 'default';
          if (!byUser.has(k)) byUser.set(k, []);
          byUser.get(k).push(p);
        });

        byUser.forEach((uPoints, uKey) => {
          if (uPoints.length < 2) return;
          const color = getUserColor(uKey);
          const latlngs = uPoints.map(p => [p.lat, p.lng]);
          L.polyline(latlngs, {
            color: color,
            weight: 4,
            opacity: 0.85
          }).addTo(linesLayer);
        });

        // 绘制每个点位的自定义气泡图标
        coordPoints.forEach(p => {
          let bg = getUserColor(p.userId);
          let prefix = p.badgeText + '. ';
          if (p.recordType === 'clock_in') {
            bg = '#059669';
            prefix = '🌅 起·';
          } else if (p.recordType === 'clock_out') {
            bg = '#D97706';
            prefix = '🌙 终·';
          }
          const userPrefix = selectedUserId === '__ALL__' ? ('[' + p.userName + '] ') : '';
          const shortStore = p.displayTitle.length > 8 ? p.displayTitle.slice(0, 8) + '…' : p.displayTitle;
          const label = userPrefix + prefix + shortStore + ' ' + p.timeText;

          const icon = L.divIcon({
            className: 'sg-custom-div-icon',
            html: '<div class="sg-pin-wrap ' + (p.index === activeIndex ? 'active' : '') + '" id="pin-' + p.index + '">' +
              '<div class="sg-pin-bubble" style="background:' + bg + '">' + escapeHtml(label) + '</div>' +
              '<div class="sg-pin-arrow"></div>' +
            '</div>',
            iconSize: [0, 0],
            iconAnchor: [0, 0]
          });

          const marker = L.marker([p.lat, p.lng], {
            icon,
            zIndexOffset: p.index === activeIndex ? 1000 : p.index * 10
          }).addTo(markersLayer);

          marker.on('click', () => {
            selectPoint(p.index, true);
          });

          markerInstances.push({ index: p.index, marker });
        });

        if (shouldFit && coordPoints.length > 0) {
          fitBounds();
        }
      }

      function fitBounds() {
        if (!map) return;
        const coordPoints = points.filter(p => p.hasCoord);
        if (coordPoints.length === 0) return;
        if (coordPoints.length === 1) {
          map.setView([coordPoints[0].lat, coordPoints[0].lng], 15);
          return;
        }
        const bounds = L.latLngBounds(coordPoints.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
      }

      function selectPoint(idx, panToMarker) {
        if (idx < 0 || idx >= points.length) return;
        activeIndex = idx;
        const pt = points[idx];

        document.querySelectorAll('.tl-item').forEach((el, i) => {
          el.classList.toggle('active', i === idx);
        });
        const activeTl = document.getElementById('tl-item-' + idx);
        if (activeTl && panToMarker) {
          activeTl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        document.querySelectorAll('.sg-pin-wrap').forEach(el => {
          el.classList.remove('active');
        });
        const pinEl = document.getElementById('pin-' + idx);
        if (pinEl) pinEl.classList.add('active');

        if (panToMarker && pt.hasCoord && map) {
          map.panTo([pt.lat, pt.lng], { animate: true });
        }

        openDrawer(pt);
      }

      function openDrawer(pt) {
        const drawer = document.getElementById('detailDrawer');
        drawer.classList.add('open');

        document.getElementById('drawerTitle').textContent = pt.typeLabel + ' · ' + pt.displayTitle;
        document.getElementById('drawerSub').textContent =
          '👤 ' + pt.userName + '  |  🕒 ' + selectedDate + ' ' + pt.timeText;
        document.getElementById('drawerIndexText').textContent =
          (pt.index + 1) + ' / ' + points.length;

        document.getElementById('prevPointBtn').disabled = pt.index <= 0;
        document.getElementById('nextPointBtn').disabled = pt.index >= points.length - 1;

        let photosHtml = '';
        if (pt.photoURLs.length > 0) {
          const gridClass = pt.photoURLs.length === 1 ? 'photo-grid single' : 'photo-grid';
          photosHtml = '<div class="' + gridClass + '">';
          pt.photoURLs.forEach((u, i) => {
            photosHtml += '<div class="photo-card" data-photo-idx="' + i + '">' +
              '<img src="' + escapeHtml(u) + '" alt="现场照片" />' +
              '<span class="photo-hint">🔍 点击放大 (' + (i + 1) + '/' + pt.photoURLs.length + ')</span>' +
            '</div>';
          });
          photosHtml += '</div>';
        } else {
          photosHtml = '<div style="padding:24px;text-align:center;color:#9AA0A6;background:#F8FAFC;border-radius:10px;margin-bottom:16px">暂无照片</div>';
        }

        let aiHtml = '';
        if (!pt.isClock && pt.aiReport && typeof pt.aiReport.score === 'number') {
          const ar = pt.aiReport;
          let issuesHtml = '';
          if (Array.isArray(ar.issues) && ar.issues.length > 0) {
            issuesHtml = '<div style="font-size:12px;font-weight:700;margin:8px 0 4px;color:#B91C1C">⚠️ 发现问题：</div><ul class="ai-list">';
            ar.issues.forEach(iss => {
              issuesHtml += '<li>[' + escapeHtml(iss.category || '问题') + '] ' + escapeHtml(iss.description || '') + '</li>';
            });
            issuesHtml += '</ul>';
          }
          aiHtml = '<div class="photo-section-title"><span>🤖 AI 陈列分析报告</span></div>' +
            '<div class="ai-box">' +
              '<div class="ai-score-row">' +
                '<span class="ai-score-badge">' + ar.score + ' 分 (' + escapeHtml(ar.scoreLevel || '已评') + ')</span>' +
                (ar.sharePercent != null ? '<span style="font-size:12px;font-weight:600;color:#1C3D5A">我方排面占比: ' + ar.sharePercent + '%</span>' : '') +
              '</div>' +
              '<div class="ai-summary">' + escapeHtml(ar.summary || '') + '</div>' +
              issuesHtml +
            '</div>';
        }

        const content = document.getElementById('drawerContent');
        content.innerHTML =
          '<div class="info-list">' +
            '<div class="info-row"><span class="info-key">类型：</span><span class="info-val">' + escapeHtml(pt.typeLabel) + '</span></div>' +
            '<div class="info-row"><span class="info-key">任务：</span><span class="info-val">' + escapeHtml(pt.taskName || '--') + '</span></div>' +
            '<div class="info-row"><span class="info-key">地址：</span><span class="info-val">' + escapeHtml(pt.addressText) + '</span></div>' +
          '</div>' +
          '<div class="photo-section-title">' +
            '<span>📷 现场水印照片 (' + pt.photoURLs.length + '张)</span>' +
            '<span style="font-size:12px;color:#627D98;font-weight:400">点击任意照片全屏高清查看</span>' +
          '</div>' +
          photosHtml +
          aiHtml;

        content.querySelectorAll('.photo-card').forEach(el => {
          el.addEventListener('click', () => {
            const pIdx = Number(el.getAttribute('data-photo-idx')) || 0;
            openLightbox(pt.photoURLs, pIdx);
          });
        });
      }

      function closeDrawer() {
        document.getElementById('detailDrawer').classList.remove('open');
      }

      // Lightbox functions
      function openLightbox(urls, index) {
        if (!urls || !urls.length) return;
        lbUrls = urls;
        lbIndex = index;
        lbScale = 1;
        updateLightbox();
        document.getElementById('lightbox').classList.add('open');
      }

      function updateLightbox() {
        const url = lbUrls[lbIndex] || '';
        const img = document.getElementById('lbImg');
        img.src = url;
        img.style.transform = 'scale(' + lbScale + ')';
        document.getElementById('lbCounter').textContent = (lbIndex + 1) + ' / ' + lbUrls.length;
        document.getElementById('lbDownloadBtn').href = url;
      }

      function closeLightbox() {
        document.getElementById('lightbox').classList.remove('open');
      }

      // Event Bindings
      datePicker.addEventListener('change', (e) => {
        if (e.target.value) {
          selectedDate = e.target.value;
          loadRoute();
        }
      });

      document.getElementById('prevDayBtn').addEventListener('click', () => {
        const d = new Date(selectedDate.replace(/-/g, '/') + ' 00:00:00');
        d.setDate(d.getDate() - 1);
        selectedDate = toDateStr(d);
        datePicker.value = selectedDate;
        loadRoute();
      });

      document.getElementById('nextDayBtn').addEventListener('click', () => {
        const d = new Date(selectedDate.replace(/-/g, '/') + ' 00:00:00');
        d.setDate(d.getDate() + 1);
        const next = toDateStr(d);
        if (next > todayStr) return;
        selectedDate = next;
        datePicker.value = selectedDate;
        loadRoute();
      });

      document.getElementById('todayBtn').addEventListener('click', () => {
        selectedDate = todayStr;
        datePicker.value = selectedDate;
        loadRoute();
      });

      document.getElementById('refreshBtn').addEventListener('click', () => loadRoute());
      document.getElementById('lockBtn').addEventListener('click', () => {
        localStorage.removeItem('sg_web_map_key');
        document.getElementById('authInput').value = '';
        showAuthModal('已锁屏，请重新输入密码');
      });
      document.getElementById('authSubmitBtn').addEventListener('click', () => {
        const val = document.getElementById('authInput').value.trim();
        if (!val) {
          document.getElementById('authErr').textContent = '请输入密码';
          return;
        }
        localStorage.setItem('sg_web_map_key', val);
        loadRoute();
      });
      document.getElementById('authInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          document.getElementById('authSubmitBtn').click();
        }
      });
      document.getElementById('fitBoundsBtn').addEventListener('click', () => fitBounds());
      document.getElementById('drawerCloseBtn').addEventListener('click', () => closeDrawer());

      document.getElementById('prevPointBtn').addEventListener('click', () => {
        if (activeIndex > 0) selectPoint(activeIndex - 1, true);
      });
      document.getElementById('nextPointBtn').addEventListener('click', () => {
        if (activeIndex < points.length - 1) selectPoint(activeIndex + 1, true);
      });

      document.getElementById('lbCloseBtn').addEventListener('click', closeLightbox);
      document.getElementById('lightbox').addEventListener('click', (e) => {
        if (e.target.id === 'lightbox') closeLightbox();
      });
      document.getElementById('lbPrevBtn').addEventListener('click', () => {
        lbIndex = (lbIndex - 1 + lbUrls.length) % lbUrls.length;
        lbScale = 1;
        updateLightbox();
      });
      document.getElementById('lbNextBtn').addEventListener('click', () => {
        lbIndex = (lbIndex + 1) % lbUrls.length;
        lbScale = 1;
        updateLightbox();
      });
      document.getElementById('lbZoomInBtn').addEventListener('click', () => {
        lbScale = Math.min(4, lbScale + 0.35);
        updateLightbox();
      });
      document.getElementById('lbZoomOutBtn').addEventListener('click', () => {
        lbScale = Math.max(0.5, lbScale - 0.35);
        updateLightbox();
      });

      window.addEventListener('keydown', (e) => {
        const lbOpen = document.getElementById('lightbox').classList.contains('open');
        if (lbOpen) {
          if (e.key === 'Escape') closeLightbox();
          if (e.key === 'ArrowLeft') document.getElementById('lbPrevBtn').click();
          if (e.key === 'ArrowRight') document.getElementById('lbNextBtn').click();
        }
      });

      initMap();
    })();
  </script>
</body>
</html>`
}

module.exports = {
  mapPageHandler,
  mapRouteApiHandler
}
