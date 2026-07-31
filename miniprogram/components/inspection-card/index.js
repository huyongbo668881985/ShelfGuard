// components/inspection-card/index.js
Component({
  properties: {
    item: { type: Object, value: {} }
  },

  data: {
    displayDate: '',
    statusText: ''
  },

  lifetimes: {
    attached() {
      this.formatData()
    }
  },

  methods: {
    formatData() {
      const item = this.properties.item
      if (!item) return

      // 格式化日期
      let dateStr = ''
      if (item.createdAt) {
        const date = new Date(item.createdAt)
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const hour = String(date.getHours()).padStart(2, '0')
        const min = String(date.getMinutes()).padStart(2, '0')
        dateStr = `${month}-${day} ${hour}:${min}`
      }

      // 状态文本
      let statusText = '待分析'
      if (item.status === 'analyzed') statusText = '已完成'
      else if (item.status === 'uploaded') statusText = '分析中'

      this.setData({ displayDate: dateStr, statusText })
    }
  }
})
