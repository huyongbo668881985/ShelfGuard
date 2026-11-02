'use strict'

const NAMES = [
  'login',
  'users',
  'customers',
  'products',
  'settings',
  'getHistory',
  'getReport',
  'geocode',
  'submitInspection',
  'analyzeImage',
  'batchAnalyze',
  'shelfStats',
  'syncJxcCustomers'
]

const handlers = {}
NAMES.forEach(name => {
  handlers[name] = require(`./functions/${name}/index.js`).main
})

module.exports = handlers
