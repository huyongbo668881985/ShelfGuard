// pages/visit-map/visit-map.js
// 拜访地图页：展示每日上下班打卡位置与门店拜访轨迹路线，点选点位直接查看现场照片

const api = require('../../utils/api')
const { formatDate } = require('../../utils/date')
const { formatScoreLevel } = require('../../utils/format')
const app = getApp()

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
// 默认地图中心（北京天安门兜底，有实际坐标时会自动缩放至轨迹区域）
const DEFAULT_CENTER = { latitude: 39.908823, longitude: 116.39747 }

function pad(n) {
  return String(n).padStart(2, '0')
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function isValidCoord(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    (Math.abs(lat) > 0.0001 || Math.abs(lng) > 0.0001) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  )
}

Page({
  data: {
    isManager: false,
    loading: false,

    // 日期筛选
    todayStr: '',
    selectedDate: '',
    isToday: true,
    dateLabel: '',

    // 人员筛选（管理者可见全部人员，业务员仅自己）
    usersList: [],
    selectedUserId: '',
    selectedUserName: '',

    // 轨迹点与统计
    points: [],
    visitCount: 0,
    clockInPoint: null,
    clockOutPoint: null,
    noCoordCount: 0,
    hasValidCoords: false,

    // 当前选中的轨迹点（默认 -1 不展开图片详情，优先展示全览轨迹）
    activeIndex: -1,
    activePoint: null,

    // 地图组件数据
    mapCenter: DEFAULT_CENTER,
    mapScale: 13,
    markers: [],
    polyline: [],
    includePoints: []
  },

  onLoad(options) {
    this._numIconCache = {}
    const todayStr = toDateStr(new Date())
    const initDate = (options && options.date) ? decodeURIComponent(options.date) : todayStr
    const initUserId = (options && options.userId) ? decodeURIComponent(options.userId) : ''

    this.setData({
      todayStr,
      selectedDate: initDate,
      selectedUserId: initUserId
    })
    this.updateDateLabel(initDate)
    this.loadRoute()
  },

  updateDateLabel(dateStr) {
    const isToday = dateStr === this.data.todayStr
    const d = new Date(`${dateStr.replace(/-/g, '/')} 00:00:00`)
    const label = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_NAMES[d.getDay()]}${isToday ? ' (今天)' : ''}`
    this.setData({ isToday, dateLabel: label })
  },

  onDateChange(e) {
    const nextDate = e.detail.value
    if (!nextDate || nextDate === this.data.selectedDate) return
    this.setData({ selectedDate: nextDate })
    this.updateDateLabel(nextDate)
    this.loadRoute()
  },

  shiftDay(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 0
    const d = new Date(`${this.data.selectedDate.replace(/-/g, '/')} 00:00:00`)
    d.setDate(d.getDate() + delta)
    const next = toDateStr(d)
    if (next > this.data.todayStr) return
    this.setData({ selectedDate: next })
    this.updateDateLabel(next)
    this.loadRoute()
  },

  backToToday() {
    if (this.data.selectedDate === this.data.todayStr) return
    this.setData({ selectedDate: this.data.todayStr })
    this.updateDateLabel(this.data.todayStr)
    this.loadRoute()
  },

  onSelectUser(e) {
    const userId = e.currentTarget.dataset.userid
    if (!userId || userId === this.data.selectedUserId) return
    this.setData({ selectedUserId: userId })
    this.loadRoute()
  },

  async loadRoute() {
    this._reqSeq = (this._reqSeq || 0) + 1
    const seq = this._reqSeq
    this.setData({ loading: true })
    wx.showLoading({ title: '加载轨迹...', mask: false })

    try {
      const start = new Date(`${this.data.selectedDate.replace(/-/g, '/')} 00:00:00`)
      const end = new Date(start.getTime() + 864e5 - 1)

      const res = await api.callFunction({
        name: 'getHistory',
        data: {
          action: 'mapRoute',
          targetUserId: this.data.selectedUserId,
          where: {
            startDateISO: start.toISOString(),
            endDateISO: end.toISOString()
          }
        }
      })

      if (seq !== this._reqSeq) return
      const result = (res && res.result) || {}
      if (!result.success) {
        throw new Error(result.error || '加载轨迹失败')
      }

      const rawPoints = result.points || []
      let visitSeq = 0
      let visitCount = 0
      let noCoordCount = 0
      let clockInPoint = null
      let clockOutPoint = null

      // 记录已出现过的坐标，完全重合时微调偏移约 12 米，避免地图气泡完全重叠无法点选
      const seenCoords = new Map()

      const points = rawPoints.map((item, idx) => {
        const recordType = (item.recordType === 'clock_in' || item.recordType === 'clock_out')
          ? item.recordType
          : (item.status === 'clocked' ? 'clock_in' : 'visit')
        const isClock = recordType === 'clock_in' || recordType === 'clock_out'
        const timeText = formatDate(item.createdAt, 'HH:mm')

        let typeLabel = ''
        let badgeText = ''
        let displayTitle = ''
        let shortTitle = ''

        if (recordType === 'clock_in') {
          typeLabel = '上班打卡'
          badgeText = '☀️'
          displayTitle = '上班打卡'
          shortTitle = '上班打卡'
        } else if (recordType === 'clock_out') {
          typeLabel = '下班打卡'
          badgeText = '🌙'
          displayTitle = '下班打卡'
          shortTitle = '下班打卡'
        } else {
          visitSeq++
          visitCount++
          typeLabel = `第${visitSeq}站`
          badgeText = String(visitSeq)
          displayTitle = item.storeName || '无门店（常规拜访）'
          shortTitle = displayTitle.length > 7 ? displayTitle.slice(0, 7) + '…' : displayTitle
        }

        const rawLat = item.location ? Number(item.location.latitude) : 0
        const rawLng = item.location ? Number(item.location.longitude) : 0
        const hasCoord = isValidCoord(rawLat, rawLng)
        let lat = rawLat
        let lng = rawLng

        if (hasCoord) {
          const coordKey = `${rawLat.toFixed(5)},${rawLng.toFixed(5)}`
          const dupCount = seenCoords.get(coordKey) || 0
          seenCoords.set(coordKey, dupCount + 1)
          if (dupCount > 0) {
            const angle = (dupCount * Math.PI) / 3
            lat = rawLat + Math.sin(angle) * 0.00012 * dupCount
            lng = rawLng + Math.cos(angle) * 0.00012 * dupCount
          }
        } else {
          noCoordCount++
        }

        let score
        let scoreColor = ''
        if (!isClock && item.aiReport && typeof item.aiReport.score === 'number') {
          const info = formatScoreLevel(item.aiReport.score)
          score = item.aiReport.score
          scoreColor = info.color
        }

        const formatted = {
          ...item,
          index: idx,
          recordType,
          isClock,
          visitSeq: isClock ? 0 : visitSeq,
          typeLabel,
          badgeText,
          displayTitle,
          shortTitle,
          timeText,
          hasCoord,
          lat,
          lng,
          addressText: (item.location && item.location.address) || (hasCoord ? `${rawLat.toFixed(5)}, ${rawLng.toFixed(5)}` : '未记录定位地址'),
          photoURLs: Array.isArray(item.photoURLs) ? item.photoURLs : [],
          photoThumbURLs: Array.isArray(item.photoThumbURLs) ? item.photoThumbURLs : [],
          score,
          scoreColor
        }

        if (recordType === 'clock_in' && !clockInPoint) clockInPoint = formatted
        if (recordType === 'clock_out') clockOutPoint = formatted

        return formatted
      })

      const coordPoints = points.filter(p => p.hasCoord)
      const hasValidCoords = coordPoints.length > 0
      const activeIndex = -1
      const activePoint = null

      const polyline = coordPoints.length >= 2
        ? [{
            points: coordPoints.map(p => ({ latitude: p.lat, longitude: p.lng })),
            color: '#1C3D5A',
            width: 6,
            arrowLine: true,
            borderColor: '#FFFFFF',
            borderWidth: 1
          }]
        : []

      const includePoints = coordPoints.map(p => ({
        latitude: p.lat,
        longitude: p.lng
      }))

      const mapCenter = hasValidCoords
        ? { latitude: coordPoints[0].lat, longitude: coordPoints[0].lng }
        : DEFAULT_CENTER

      const markers = this.buildMarkers(points, activeIndex)

      this.setData({
        isManager: !!result.isManager,
        usersList: result.usersList || [],
        selectedUserId: result.selectedUserId || this.data.selectedUserId,
        selectedUserName: result.selectedUserName || '',
        points,
        visitCount,
        clockInPoint,
        clockOutPoint,
        noCoordCount,
        hasValidCoords,
        activeIndex,
        activePoint,
        mapCenter,
        markers,
        polyline,
        includePoints,
        loading: false
      })

      if (includePoints.length > 0) {
        setTimeout(() => this.fitAllPoints(), 180)
      }
    } catch (err) {
      console.error('加载拜访地图失败:', err)
      if (seq === this._reqSeq) {
        this.setData({ loading: false })
        wx.showToast({ title: err.message || '加载失败', icon: 'none' })
      }
    } finally {
      if (seq === this._reqSeq) {
        wx.hideLoading()
      }
    }
  },

  getNumberDotIcon(badgeText, isActive) {
    const key = `${badgeText}_${isActive ? 1 : 0}`
    if (!this._numIconCache) this._numIconCache = {}
    if (this._numIconCache[key]) return this._numIconCache[key]

    try {
      if (typeof wx.createOffscreenCanvas !== 'function' || !wx.env || !wx.env.USER_DATA_PATH) {
        return ''
      }
      const size = 64
      const canvas = wx.createOffscreenCanvas({ type: '2d', width: size, height: size })
      const ctx = canvas.getContext('2d')
      if (!ctx || typeof canvas.toDataURL !== 'function') return ''

      ctx.clearRect(0, 0, size, size)
      // 柔和阴影
      ctx.beginPath()
      ctx.arc(32, 33, 27, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)'
      ctx.fill()

      // 圆点底色与白色外环
      ctx.beginPath()
      ctx.arc(32, 32, 26, 0, Math.PI * 2)
      ctx.fillStyle = isActive ? '#C2933B' : '#1C3D5A'
      ctx.fill()
      ctx.lineWidth = 5
      ctx.strokeStyle = '#FFFFFF'
      ctx.stroke()

      // 居中数字
      const text = String(badgeText || '')
      const fontSize = text.length >= 3 ? 19 : (text.length === 2 ? 23 : 28)
      ctx.fillStyle = '#FFFFFF'
      ctx.font = `bold ${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, 32, 33)

      const dataUrl = canvas.toDataURL('image/png')
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
      const safeName = text.replace(/[^a-zA-Z0-9]/g, '_')
      const filePath = `${wx.env.USER_DATA_PATH}/sg_dot_${safeName}_${isActive ? 1 : 0}.png`
      wx.getFileSystemManager().writeFileSync(filePath, base64, 'base64')
      this._numIconCache[key] = filePath
      return filePath
    } catch (e) {
      return ''
    }
  },

  buildPointMarker(p, isSelected) {
    let iconPath = ''
    let width = isSelected ? 34 : 28
    let height = isSelected ? 34 : 28
    let useFallbackCallout = false

    if (p.recordType === 'clock_in') {
      iconPath = isSelected ? '/images/map-sun-active.png' : '/images/map-sun.png'
      width = isSelected ? 36 : 30
      height = isSelected ? 36 : 30
    } else if (p.recordType === 'clock_out') {
      iconPath = isSelected ? '/images/map-moon-active.png' : '/images/map-moon.png'
      width = isSelected ? 36 : 30
      height = isSelected ? 36 : 30
    } else {
      iconPath = this.getNumberDotIcon(p.badgeText, isSelected)
      if (!iconPath) {
        iconPath = isSelected ? '/images/map-dot-active.png' : '/images/map-dot.png'
        useFallbackCallout = true
      }
    }

    const marker = {
      id: p.index,
      latitude: p.lat,
      longitude: p.lng,
      iconPath,
      width,
      height,
      anchor: { x: 0.5, y: 0.5 },
      zIndex: isSelected ? 99 : p.index + 1
    }

    if (isSelected) {
      const bgColor = p.recordType === 'clock_in'
        ? '#059669'
        : (p.recordType === 'clock_out' ? '#D97706' : '#C2933B')
      const content = p.isClock
        ? `${p.displayTitle} ${p.timeText}`
        : `${p.typeLabel} · ${p.shortTitle} ${p.timeText}`
      marker.callout = {
        content,
        color: '#FFFFFF',
        fontSize: 12,
        borderRadius: 12,
        bgColor,
        padding: 6,
        display: 'ALWAYS',
        textAlign: 'center'
      }
    } else if (useFallbackCallout) {
      marker.callout = {
        content: p.badgeText,
        color: '#FFFFFF',
        fontSize: 11,
        borderRadius: 12,
        bgColor: '#1C3D5A',
        padding: 5,
        display: 'ALWAYS',
        textAlign: 'center'
      }
    }

    return marker
  },

  buildMarkers(points, activeIndex) {
    return (points || [])
      .filter(p => p.hasCoord)
      .map(p => this.buildPointMarker(p, p.index === activeIndex))
  },

  selectPointByIndex(idx) {
    const points = this.data.points || []
    if (idx < 0 || idx >= points.length) return
    const prevIdx = this.data.activeIndex
    const pt = points[idx]
    const markers = this.data.markers || []
    const updates = {
      activeIndex: idx,
      activePoint: pt
    }

    if (prevIdx >= 0 && prevIdx !== idx) {
      const oldMarkerPos = markers.findIndex(m => m.id === prevIdx)
      if (oldMarkerPos >= 0 && points[prevIdx]) {
        updates[`markers[${oldMarkerPos}]`] = this.buildPointMarker(points[prevIdx], false)
      }
    }
    const newMarkerPos = markers.findIndex(m => m.id === idx)
    if (newMarkerPos >= 0) {
      updates[`markers[${newMarkerPos}]`] = this.buildPointMarker(pt, true)
    }

    if (pt.hasCoord) {
      updates.mapCenter = { latitude: pt.lat, longitude: pt.lng }
    }
    this.setData(updates)
  },

  clearSelection() {
    const prevIdx = this.data.activeIndex
    if (prevIdx < 0 && !this.data.activePoint) return
    const points = this.data.points || []
    const markers = this.data.markers || []
    const updates = {
      activeIndex: -1,
      activePoint: null
    }
    if (prevIdx >= 0 && points[prevIdx]) {
      const oldMarkerPos = markers.findIndex(m => m.id === prevIdx)
      if (oldMarkerPos >= 0) {
        updates[`markers[${oldMarkerPos}]`] = this.buildPointMarker(points[prevIdx], false)
      }
    }
    this.setData(updates)
  },

  onMapTap() {
    this.clearSelection()
  },

  onMarkerTap(e) {
    const markerId = e && e.detail ? Number(e.detail.markerId) : -1
    if (Number.isFinite(markerId) && markerId >= 0) {
      this.selectPointByIndex(markerId)
    }
  },

  onSelectNode(e) {
    const idx = Number(e.currentTarget.dataset.index)
    if (Number.isFinite(idx)) {
      this.selectPointByIndex(idx)
    }
  },

  onQuickSelectById(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const idx = (this.data.points || []).findIndex(p => p._id === id)
    if (idx >= 0) {
      this.selectPointByIndex(idx)
    }
  },

  stepNode(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 0
    const baseIdx = this.data.activeIndex < 0 ? 0 : this.data.activeIndex
    const nextIdx = this.data.activeIndex < 0 ? 0 : baseIdx + delta
    if (nextIdx < 0 || nextIdx >= this.data.points.length) return
    this.selectPointByIndex(nextIdx)
  },

  fitAllPoints() {
    const includePoints = this.data.includePoints || []
    if (!includePoints.length) return
    try {
      const mapCtx = wx.createMapContext('visitMap', this)
      mapCtx.includePoints({
        points: includePoints,
        padding: [60, 50, 60, 50]
      })
    } catch (e) {}
  },

  previewPointPhoto(e) {
    const current = e.currentTarget.dataset.url
    const urls = (this.data.activePoint && this.data.activePoint.photoURLs) || []
    if (!current || !urls.length) return
    wx.previewImage({
      current,
      urls
    })
  },

  goPointReport() {
    const pt = this.data.activePoint
    if (!pt || !pt._id) return
    wx.navigateTo({
      url: `/pages/report/report?id=${pt._id}`
    })
  }
})
