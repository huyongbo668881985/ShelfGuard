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

    // 当前选中的轨迹点
    activeIndex: 0,
    activePoint: null,

    // 地图组件数据
    mapCenter: DEFAULT_CENTER,
    mapScale: 13,
    markers: [],
    polyline: [],
    includePoints: []
  },

  onLoad(options) {
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
          badgeText = '起'
          displayTitle = '上班打卡'
          shortTitle = '上班打卡'
        } else if (recordType === 'clock_out') {
          typeLabel = '下班打卡'
          badgeText = '终'
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
          score,
          scoreColor
        }

        if (recordType === 'clock_in' && !clockInPoint) clockInPoint = formatted
        if (recordType === 'clock_out') clockOutPoint = formatted

        return formatted
      })

      const coordPoints = points.filter(p => p.hasCoord)
      const hasValidCoords = coordPoints.length > 0
      const activeIndex = points.length > 0 ? 0 : -1
      const activePoint = activeIndex >= 0 ? points[activeIndex] : null

      const polyline = coordPoints.length >= 2
        ? [{
            points: coordPoints.map(p => ({ latitude: p.lat, longitude: p.lng })),
            color: '#1C3D5A',
            width: 5,
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
        setTimeout(() => this.fitAllPoints(), 150)
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

  buildMarkers(points, activeIndex) {
    return (points || [])
      .filter(p => p.hasCoord)
      .map(p => {
        const isSelected = p.index === activeIndex
        let bgColor = '#1C3D5A'
        let prefix = `${p.badgeText}. `
        if (p.recordType === 'clock_in') {
          bgColor = '#059669'
          prefix = '🌅 起·'
        } else if (p.recordType === 'clock_out') {
          bgColor = '#D97706'
          prefix = '🌙 终·'
        }
        if (isSelected) {
          bgColor = '#C2933B'
        }

        const content = `${prefix}${p.shortTitle} ${p.timeText}`

        return {
          id: p.index,
          latitude: p.lat,
          longitude: p.lng,
          width: isSelected ? 28 : 22,
          height: isSelected ? 28 : 22,
          zIndex: isSelected ? 99 : p.index + 1,
          callout: {
            content,
            color: '#FFFFFF',
            fontSize: isSelected ? 13 : 11,
            borderRadius: 14,
            bgColor,
            padding: 7,
            display: 'ALWAYS',
            textAlign: 'center'
          }
        }
      })
  },

  selectPointByIndex(idx) {
    const points = this.data.points || []
    if (idx < 0 || idx >= points.length) return
    const pt = points[idx]
    const markers = this.buildMarkers(points, idx)
    const nextState = {
      activeIndex: idx,
      activePoint: pt,
      markers
    }
    if (pt.hasCoord) {
      nextState.mapCenter = { latitude: pt.lat, longitude: pt.lng }
    }
    this.setData(nextState)
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
    const nextIdx = this.data.activeIndex + delta
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
