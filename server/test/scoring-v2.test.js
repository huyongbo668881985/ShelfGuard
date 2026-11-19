'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_SCORING_RULES,
  validateScoringRules,
  normalizeScoringRules,
  deriveDimensionStatus,
  deriveScoreLevel,
  snapThreeTierScore,
  computeFacingScore,
  computeGoldenPositionScoreFromFacings,
  computeLabelOrientationScoreFromFacings,
  normalizeImageQuality,
  normalizeFramingType,
  selectHorizontalBannerRefs,
  selectProductRefs,
  validateAndNormalizeReport,
  extractFacingSummary,
  aggregateDailyMetrics,
  mergeDailyReports
} = require('../src/functions/analyzeImage/scoring')

const {
  buildSystemPrompt,
  buildUserPrompt,
  buildMultimodalUserContent,
  buildDailySummaryUserPrompt
} = require('../src/functions/analyzeImage/prompt')

const { summarizeResults } = require('../scripts/eval-golden-set')

test('scoringRules 校验与默认回退', () => {
  const def = normalizeScoringRules(null)
  assert.deepEqual(def, DEFAULT_SCORING_RULES)

  const custom = validateScoringRules({
    facingMaxScore: 40,
    facingTarget: 8,
    facingPointsPerUnit: 5,
    goldenPositionMaxScore: 20,
    labelOrientationMaxScore: 20,
    priceTagMaxScore: 10,
    horizontalBannerMaxScore: 10
  })
  assert.equal(custom.ok, true)
  assert.equal(custom.rules.facingMaxScore, 40)

  const badSum = validateScoringRules({
    facingMaxScore: 60,
    goldenPositionMaxScore: 20,
    labelOrientationMaxScore: 10,
    priceTagMaxScore: 10,
    horizontalBannerMaxScore: 10
  })
  assert.equal(badSum.ok, false)
  assert.match(badSum.error, /100/)

  // 非法配置自动回退默认值
  assert.deepEqual(normalizeScoringRules({ facingMaxScore: 999 }), DEFAULT_SCORING_RULES)
})

test('排面计分与三档分值规范化边界值', () => {
  assert.equal(computeFacingScore(0), 0)
  assert.equal(computeFacingScore(-3), 0)
  assert.equal(computeFacingScore(1), 5)
  assert.equal(computeFacingScore(9), 45)
  assert.equal(computeFacingScore(10), 50)
  assert.equal(computeFacingScore(18), 50)

  // 三档：0 / 5 / 10
  assert.equal(snapThreeTierScore(10, 10), 10)
  assert.equal(snapThreeTierScore(8, 10), 10)
  assert.equal(snapThreeTierScore(5, 10), 5)
  assert.equal(snapThreeTierScore(3, 10), 5)
  assert.equal(snapThreeTierScore(2, 10), 0)
  assert.equal(snapThreeTierScore(0, 10), 0)
  assert.equal(snapThreeTierScore(-1, 10), 0)
  assert.equal(snapThreeTierScore('10', 10), 10)
})

test('服务端强校验：Number 转换、范围裁剪、精确重算、三档中档 medium 与 closeup/poor 防虚高控制', () => {
  // 1. 清晰全景照：7*5=35 + 20 + 8 + 5 + 0 = 68，三档中档 5/10 必须为 medium
  const normalReport = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    score: 99, // 模型瞎报的总分，必须被服务端覆盖
    scoreLevel: '卓越', // 必须被服务端覆盖
    facingMetrics: {
      ownFacingCount: '7',
      ownSkuCount: '2',
      totalShelfFacingCount: '20',
      countingConfidence: 1.5
    },
    displayCompliance: {
      facingCount: { score: 999, status: 'poor', detail: '观测事实：7面' },
      goldenPosition: { score: '25', status: 'poor', detail: '观测事实：全在黄金位' }, // 超出 20 裁剪为 20
      labelOrientation: { score: '8.4', status: 'poor', detail: '观测事实：略偏' },   // 四舍五入为 8
      priceTag: { score: '4', status: 'good', detail: '观测事实：价签破损' },          // 吸附中档 5
      horizontalBanner: { score: '-2', status: 'good', detail: '观测事实：无横签' }    // 裁剪为 0
    },
    metadata: {
      imageQuality: 'good',
      framingType: 'panorama',
      photoRoles: ['货架陈列照']
    }
  }, '{}', {})

  assert.equal(normalReport.scoringVersion, 'v2')
  assert.equal(normalReport.score, 68)
  assert.equal(normalReport.scoreLevel, '一般')
  assert.equal(normalReport.displayCompliance.facingCount.score, 35)
  assert.equal(normalReport.displayCompliance.facingCount.status, 'medium') // 35/50 = 0.7 -> medium
  assert.equal(normalReport.displayCompliance.goldenPosition.score, 20)
  assert.equal(normalReport.displayCompliance.goldenPosition.status, 'good')
  assert.equal(normalReport.displayCompliance.labelOrientation.score, 8)
  assert.equal(normalReport.displayCompliance.labelOrientation.status, 'good')
  assert.equal(normalReport.displayCompliance.priceTag.score, 5)
  assert.equal(normalReport.displayCompliance.priceTag.status, 'medium') // 5/10 = 0.5 -> medium（三档中档）
  assert.equal(normalReport.displayCompliance.horizontalBanner.score, 0)
  assert.equal(normalReport.displayCompliance.horizontalBanner.status, 'poor')
  assert.equal(normalReport.facingMetrics.ownFacingCount, 7)
  assert.equal(normalReport.facingMetrics.ownFacingShare, 35) // 7/20 = 35%
  assert.equal(normalReport.facingMetrics.countingConfidence, 1) // clamped to 1
  assert.equal(normalReport.metadata.needsReview, false)
  assert.equal(normalReport.metadata.scoreReliability, 'high')

  // 2. 模糊 + 局部特写：触发黄金位封顶（12/20）、排面占比置空防虚高、置信度封顶（<=0.5）及复核标记
  const controlledReport = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    score: 99,
    scoreLevel: '卓越',
    facingMetrics: {
      ownFacingCount: '7',
      ownSkuCount: '2',
      totalShelfFacingCount: '20',
      countingConfidence: 1.5
    },
    displayCompliance: {
      facingCount: { score: 999, status: 'poor', detail: '观测事实：7面' },
      goldenPosition: { score: '25', status: 'poor', detail: '观测事实：全在黄金位' },
      labelOrientation: { score: '8.4', status: 'poor', detail: '观测事实：略偏' },
      priceTag: { score: '4', status: 'good', detail: '观测事实：价签破损' },
      horizontalBanner: { score: '-2', status: 'good', detail: '观测事实：无横签' }
    },
    metadata: {
      imageQuality: '模糊',
      framingType: '局部特写',
      photoRoles: ['货架陈列照']
    }
  }, '{}', {})

  // 7*5=35 + 12(特写封顶) + 8 + 5 + 0 = 60
  assert.equal(controlledReport.score, 60)
  assert.equal(controlledReport.scoreLevel, '一般')
  assert.equal(controlledReport.displayCompliance.goldenPosition.score, 12)
  assert.equal(controlledReport.displayCompliance.goldenPosition.status, 'medium')
  assert.equal(controlledReport.displayCompliance.priceTag.status, 'medium')
  assert.equal(controlledReport.facingMetrics.ownFacingShare, null)
  assert.equal(controlledReport.metadata.rawOwnFacingShare, 35)
  assert.equal(controlledReport.facingMetrics.countingConfidence, 0.5)
  assert.equal(controlledReport.metadata.imageQuality, 'poor')
  assert.equal(controlledReport.metadata.framingType, 'closeup')
  assert.equal(controlledReport.metadata.needsReview, true)
  assert.equal(controlledReport.metadata.scoreReliability, 'low')
  assert.deepEqual(controlledReport.metadata.qualityFlags, ['poor_image_quality', 'closeup_framing'])
})

test('方案 B：拍了货架照但全图无我方品牌 -> 未上柜，score=null', () => {
  const report = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: false,
    score: 20, // 即使模型误给分，服务端也强制置 null
    summary: '货架中未发现我方品牌。',
    facingMetrics: { ownFacingCount: 0, totalShelfFacingCount: 30 },
    metadata: { photoRoles: ['货架陈列照'] }
  }, '{}', {})

  assert.equal(report.hasShelfPhoto, true)
  assert.equal(report.ownBrandPresent, false)
  assert.equal(report.score, null)
  assert.equal(report.scoreLevel, '未上柜')
  assert.equal(report.facingMetrics.ownFacingCount, 0)
  assert.deepEqual(report.displayCompliance, {})
})

test('无货架照（仅门头照/纯物料照）-> score=null, scoreLevel=无货架照，不误判为未上柜', () => {
  const report = validateAndNormalizeReport({
    score: 0,
    metadata: {
      photoRoles: ['门头照', '广告物料照'],
      framingType: 'non_shelf'
    }
  }, '{}', {})

  assert.equal(report.hasShelfPhoto, false)
  assert.equal(report.ownBrandPresent, null)
  assert.equal(report.score, null)
  assert.equal(report.scoreLevel, '无货架照')
  assert.equal(report.facingMetrics.ownFacingCount, null)
})

test('横签参考图筛选：分类为横签或名称/别名含横签，启用且带图，最多 3 张', () => {
  const materials = [
    { materialName: '永丰特8红底横签', category: '横签', photo: 'sg://1', isActive: true },
    { materialName: '普通灯箱', category: '灯箱', photo: 'sg://2', isActive: true },
    { materialName: '经典二锅头横签条', category: '其他', photo: 'sg://3', isActive: true },
    { materialName: '货架边条', category: '其他', aliases: ['品牌横签'], photo: 'sg://4', isActive: true },
    { materialName: '停用横签', category: '横签', photo: 'sg://5', isActive: false },
    { materialName: '无图横签', category: '横签', photo: '', isActive: true },
    { materialName: '第4张横签', category: '横签', photo: 'sg://6', isActive: true }
  ]
  const picked = selectHorizontalBannerRefs(materials, 3)
  assert.equal(picked.length, 3)
  assert.deepEqual(picked.map(m => m.photo), ['sg://1', 'sg://3', 'sg://4'])
})

test('Prompt 动态注入规则与横签参考图隔离声明', () => {
  const sys = buildSystemPrompt({
    facingMaxScore: 40,
    facingTarget: 8,
    facingPointsPerUnit: 5,
    goldenPositionMaxScore: 20,
    labelOrientationMaxScore: 20,
    priceTagMaxScore: 10,
    horizontalBannerMaxScore: 10
  })
  assert.match(sys, /40 分/)
  assert.match(sys, /≥8 个排面/)
  assert.match(sys, /未上柜/)
  assert.match(sys, /无货架照/)

  const user = buildUserPrompt(2, '\n## 产品资料', [
    { materialName: '永丰特8红底横签', visualFeatures: '红底白字' }
  ])
  assert.match(user, /前 2 张图片/)
  assert.match(user, /第 3 至第 3 张/)
  assert.match(user, /严禁将这 1 张参考图本身/)
})

test('日报确定性聚合：排除未上柜与无货架照于均分外，正确计算在架率与平均排面，绝不造 80 假分', () => {
  const inspections = [
    {
      _id: 'i1',
      storeName: '门店A',
      photoCount: 2,
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: true,
        score: 90,
        scoreLevel: '卓越',
        facingMetrics: { ownFacingCount: 10, ownSkuCount: 3, ownFacingShare: 40 },
        displayCompliance: { goldenPosition: { score: 20, maxScore: 20 } },
        summary: '表现卓越'
      }
    },
    {
      _id: 'i2',
      storeName: '门店B',
      photoCount: 1,
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: true,
        score: 70,
        scoreLevel: '良好',
        facingMetrics: { ownFacingCount: 6, ownSkuCount: 2, ownFacingShare: 20 },
        displayCompliance: { goldenPosition: { score: 12, maxScore: 20 } },
        summary: '排面偏少'
      }
    },
    {
      _id: 'i3',
      storeName: '门店C（未上柜）',
      photoCount: 1,
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: false,
        score: null,
        scoreLevel: '未上柜',
        facingMetrics: { ownFacingCount: 0, ownSkuCount: 0, ownFacingShare: 0 },
        summary: '未上柜'
      }
    },
    {
      _id: 'i4',
      storeName: '门店D（仅门头）',
      photoCount: 1,
      aiReport: {
        hasShelfPhoto: false,
        ownBrandPresent: null,
        score: null,
        scoreLevel: '无货架照',
        facingMetrics: { ownFacingCount: null, ownSkuCount: null, ownFacingShare: null },
        summary: '仅门头照'
      }
    }
  ]

  const agg = aggregateDailyMetrics(inspections)
  // 均分仅计门店A(90)与门店B(70) -> 80；排除未上柜与无货架照
  assert.equal(agg.overallScore, 80)
  assert.equal(agg.overallLevel, '优秀')
  assert.equal(agg.storeStats.totalStores, 4)
  assert.equal(agg.storeStats.scoredStoresCount, 2)
  assert.equal(agg.storeStats.shelfPhotoStores, 3)
  assert.equal(agg.storeStats.outOfStockStores, 1)
  assert.equal(agg.storeStats.noShelfPhotoStores, 1)
  // 在架率 = 2 / 3 = 66.7%（门店D无货架照不计入分母）
  assert.equal(agg.ownBrandOverview.inStockRate, 66.7)
  // 平均排面 = (10 + 6 + 0) / 3 = 5.3
  assert.equal(agg.ownBrandOverview.avgFacingCount, 5.3)

  // 全员未上柜时：overallScore 为 null，绝不造 80 假分
  const allOos = aggregateDailyMetrics([inspections[2]])
  assert.equal(allOos.overallScore, null)
  assert.equal(allOos.overallLevel, '未上柜')

  const dailyPrompt = buildDailySummaryUserPrompt(inspections, agg, '')
  assert.match(dailyPrompt, /门店A/)
  assert.match(dailyPrompt, /门店C（未上柜）/)
})

test('黄金标杆评测脚本汇总指标计算', () => {
  const summary = summarizeResults([
    {
      id: 'c1',
      expected: { hasShelfPhoto: true, ownBrandPresent: true, ownFacingCount: 8, score: 80 },
      runs: [
        { hasShelfPhoto: true, ownBrandPresent: true, ownFacingCount: 8, score: 80 },
        { hasShelfPhoto: true, ownBrandPresent: true, ownFacingCount: 7, score: 75 }
      ]
    },
    {
      id: 'c2',
      expected: { hasShelfPhoto: true, ownBrandPresent: false, ownFacingCount: 0, score: null },
      runs: [
        { hasShelfPhoto: true, ownBrandPresent: false, ownFacingCount: 0, score: null },
        { hasShelfPhoto: true, ownBrandPresent: false, ownFacingCount: 0, score: null }
      ]
    }
  ])
  assert.equal(summary.statusAccuracyPercent, 100)
  assert.equal(summary.scoreMAE, 2.5)
  assert.equal(summary.scoreMaxError, 5)
  assert.equal(summary.facingMAE, 0.25)
  assert.equal(summary.facingWithin1Percent, 100)
  assert.equal(summary.multiRunScoreMaxRange, 5)
})

test('兼容历史旧版 6 维报告提取', () => {
  const legacyReport = {
    score: 84,
    scoreLevel: '优秀',
    productIdentification: [
      { brand: '永丰', productLine: '特8', facingCount: 5 },
      { brand: '牛栏山', productLine: '陈酿', facingCount: 5 }
    ],
    displayCompliance: {
      labelOrientation: { score: 90 },
      neatness: { score: 80 }
    }
  }
  const fs = extractFacingSummary(legacyReport, new Set(['永丰']))
  assert.equal(fs.hasShelfPhoto, true)
  assert.equal(fs.ownBrandPresent, true)
  assert.equal(fs.ownFacingCount, 5)
  assert.equal(fs.ownSkuCount, 1)
  assert.equal(fs.ownFacingShare, 50)
})

test('parseError 报告不污染在架率与排面统计', () => {
  const parseErrReport = {
    scoringVersion: 'v2',
    hasShelfPhoto: true,
    ownBrandPresent: null,
    score: null,
    scoreLevel: '解析失败',
    metadata: { parseError: true }
  }
  const fs = extractFacingSummary(parseErrReport)
  assert.equal(fs.hasShelfPhoto, null)
  assert.equal(fs.ownBrandPresent, null)
  assert.equal(fs.ownFacingCount, null)

  const agg = aggregateDailyMetrics([
    { _id: 'p1', storeName: '解析失败店', photoCount: 1, aiReport: parseErrReport },
    {
      _id: 'p2',
      storeName: '未上柜店',
      photoCount: 1,
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: false,
        score: null,
        scoreLevel: '未上柜',
        facingMetrics: { ownFacingCount: 0, ownSkuCount: 0, ownFacingShare: 0 }
      }
    }
  ])
  // 解析失败店不应被误计为在架，有效货架店仅 1 家（未上柜） -> 在架率 0%
  assert.equal(agg.storeStats.shelfPhotoStores, 1)
  assert.equal(agg.storeStats.ownBrandPresentStores, 0)
  assert.equal(agg.storeStats.outOfStockStores, 1)
  assert.equal(agg.ownBrandOverview.inStockRate, 0)
})

test('同日多轮批次合并日报（mergeDailyReports）：所有指标一致重算', () => {
  const batch1 = aggregateDailyMetrics([
    {
      _id: 'b1',
      storeName: '门店1',
      photoCount: 3,
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: true,
        score: 90,
        scoreLevel: '卓越',
        facingMetrics: { ownFacingCount: 10, ownSkuCount: 2, ownFacingShare: 40 }
      }
    },
    {
      _id: 'b2',
      storeName: '门店2（未上柜）',
      photoCount: 2,
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: false,
        score: null,
        scoreLevel: '未上柜',
        facingMetrics: { ownFacingCount: 0, ownSkuCount: 0, ownFacingShare: 0 }
      }
    }
  ])
  batch1.commonIssues = [
    { rank: 1, category: '横签露出', severity: 'high', description: '缺少横签' }
  ]

  const batch2 = aggregateDailyMetrics([
    {
      _id: 'b3',
      storeName: '门店3',
      photoCount: 4,
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: true,
        score: 70,
        scoreLevel: '良好',
        facingMetrics: { ownFacingCount: 5, ownSkuCount: 1, ownFacingShare: 20 }
      }
    },
    {
      _id: 'b4',
      storeName: '门店4（无货架照）',
      photoCount: 1,
      aiReport: {
        hasShelfPhoto: false,
        ownBrandPresent: null,
        score: null,
        scoreLevel: '无货架照',
        facingMetrics: { ownFacingCount: null, ownSkuCount: null, ownFacingShare: null }
      }
    }
  ])
  batch2.commonIssues = [
    { rank: 1, category: '横签露出', severity: 'high', description: '缺少横签（批次2）' },
    { rank: 2, category: '价签规范', severity: 'medium', description: '价签遮挡' }
  ]

  const merged = mergeDailyReports(batch1, batch2)
  assert.equal(merged.overallScore, 80)
  assert.equal(merged.overallLevel, '优秀')
  assert.equal(merged.storeStats.totalStores, 4)
  assert.equal(merged.storeStats.totalPhotos, 10)
  assert.equal(merged.storeStats.scoredStoresCount, 2)
  assert.equal(merged.storeStats.shelfPhotoStores, 3)
  assert.equal(merged.storeStats.ownBrandPresentStores, 2)
  assert.equal(merged.storeStats.outOfStockStores, 1)
  assert.equal(merged.storeStats.noShelfPhotoStores, 1)
  assert.equal(merged.ownBrandOverview.totalFacingCount, 15)
  assert.equal(merged.ownBrandOverview.avgFacingCount, 5)
  assert.equal(merged.ownBrandOverview.facingSharePercent, 20)
  assert.equal(merged.ownBrandOverview.inStockRate, 66.7)
  // commonIssues 按 category 去重并连续重排 rank
  assert.equal(merged.commonIssues.length, 2)
  assert.deepEqual(merged.commonIssues.map(x => [x.rank, x.category]), [[1, '横签露出'], [2, '价签规范']])
})

function withMockedInternal(mockCollectionFn, fn) {
  const docdbPath = require.resolve('../src/docdb')
  const internalPath = require.resolve('../src/internal')
  const prevDocdb = require.cache[docdbPath]
  const prevInternal = require.cache[internalPath]

  const stubCmd = {
    in: v => ({ $in: v }),
    or: v => ({ $or: v }),
    and: (...v) => ({ $and: v }),
    gte: v => ({ $gte: v }),
    neq: v => ({ $neq: v })
  }
  require.cache[docdbPath] = {
    id: docdbPath,
    filename: docdbPath,
    loaded: true,
    exports: {
      command: stubCmd,
      collection: (...args) => mockCollectionFn(...args)
    }
  }
  delete require.cache[internalPath]

  const cleanup = () => {
    if (prevDocdb) require.cache[docdbPath] = prevDocdb
    else delete require.cache[docdbPath]
    if (prevInternal) require.cache[internalPath] = prevInternal
    else delete require.cache[internalPath]
  }

  try {
    const internalMod = require(internalPath)
    const result = fn(internalMod)
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup)
    }
    cleanup()
    return result
  } catch (err) {
    cleanup()
    throw err
  }
}

test('internal.js 辅助函数：null/parseError 不误转为 0 分，正确提取 ownFacingCount 与占比', () => {
  withMockedInternal(() => { throw new Error('unexpected db call') }, ({ _internal }) => {
    const { isParseErrorReport, extractValidScore, extractOwnFacingCount, extractSharePercent } = _internal

    assert.equal(extractValidScore(null), null)
    assert.equal(extractValidScore({ score: null, scoreLevel: '未上柜' }), null)
    assert.equal(extractValidScore({ score: undefined }), null)
    assert.equal(extractValidScore({ score: '' }), null)
    assert.equal(extractValidScore({ score: '   ' }), null)
    assert.equal(extractValidScore({ score: [] }), null)
    assert.equal(extractValidScore({ score: false }), null)
    assert.equal(extractValidScore({ score: true }), null)
    assert.equal(extractValidScore({ score: -5 }), null)
    assert.equal(extractValidScore({ score: 105 }), null)
    assert.equal(extractValidScore({ score: 0 }), 0)
    assert.equal(extractValidScore({ score: 85 }), 85)
    assert.equal(extractValidScore({ score: '72' }), 72)

    // 即使历史或脏数据给未上柜/无货架照写了 0 分或 0% 占比，也不应计入评分/无货架照占比
    assert.equal(extractValidScore({ hasShelfPhoto: true, ownBrandPresent: false, score: 0, scoreLevel: '未上柜' }), null)
    assert.equal(extractValidScore({ hasShelfPhoto: false, ownBrandPresent: null, score: 0, scoreLevel: '无货架照' }), null)
    assert.equal(extractSharePercent({ hasShelfPhoto: false, scoreLevel: '无货架照', ownBrandOverview: { facingSharePercent: 0 } }), null)

    // ownFacingCount / sharePercent 不应把空串、空白串、布尔值或空数组隐式转为 0 或 1
    assert.equal(extractOwnFacingCount({ facingMetrics: { ownFacingCount: '' } }), null)
    assert.equal(extractOwnFacingCount({ facingMetrics: { ownFacingCount: '   ' } }), null)
    assert.equal(extractOwnFacingCount({ facingMetrics: { ownFacingCount: false } }), null)
    assert.equal(extractOwnFacingCount({ facingMetrics: { ownFacingCount: true } }), null)
    assert.equal(extractOwnFacingCount({ facingMetrics: { ownFacingCount: [] } }), null)
    assert.equal(extractSharePercent({ facingMetrics: { ownFacingShare: '   ' } }), null)
    assert.equal(extractSharePercent({ facingMetrics: { ownFacingShare: [] } }), null)

    const parseErr = {
      score: 80,
      scoreLevel: '解析失败',
      facingMetrics: { ownFacingCount: 6, ownFacingShare: 30 },
      metadata: { parseError: true }
    }
    assert.equal(isParseErrorReport(parseErr), true)
    assert.equal(extractValidScore(parseErr), null)
    assert.equal(extractOwnFacingCount(parseErr), null)
    assert.equal(extractSharePercent(parseErr), null)

    const oos = {
      hasShelfPhoto: true,
      ownBrandPresent: false,
      score: null,
      scoreLevel: '未上柜',
      facingMetrics: { ownFacingCount: 0, ownFacingShare: 0 }
    }
    assert.equal(extractValidScore(oos), null)
    assert.equal(extractOwnFacingCount(oos), 0)
    assert.equal(extractSharePercent(oos), 0)

    const noShelf = {
      hasShelfPhoto: false,
      ownBrandPresent: null,
      score: null,
      scoreLevel: '无货架照',
      facingMetrics: { ownFacingCount: null, ownFacingShare: null }
    }
    assert.equal(extractValidScore(noShelf), null)
    assert.equal(extractOwnFacingCount(noShelf), null)
    assert.equal(extractSharePercent(noShelf), null)
  })
})

test('internal.js customerSummaryHandler 与 overviewHandler：排除 score=null 与 parseError，透出 ownFacingCount', async () => {
  const now = new Date()
  const customers = [
    { _id: 'cust-1', storeName: '测试烟酒店A', jxcCustomerId: 101, isActive: true },
    { _id: 'cust-2', storeName: '测试烟酒店B', jxcCustomerId: 102, isActive: true }
  ]
  const inspections = [
    {
      _id: 'ins-1',
      customerId: 'cust-1',
      storeName: '测试烟酒店A',
      userName: '张三',
      createdAt: now,
      status: 'completed',
      photoFileIDs: [],
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: true,
        score: 80,
        scoreLevel: '优秀',
        facingMetrics: { ownFacingCount: 8, ownFacingShare: 40 },
        summary: '陈列良好',
        issues: ['缺少横签']
      }
    },
    {
      _id: 'ins-2',
      customerId: 'cust-1',
      storeName: '测试烟酒店A',
      userName: '张三',
      createdAt: new Date(now.getTime() - 1000),
      status: 'completed',
      photoFileIDs: [],
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: false,
        score: null,
        scoreLevel: '未上柜',
        facingMetrics: { ownFacingCount: 0, ownFacingShare: 0 },
        summary: '未发现我方品牌'
      }
    },
    {
      _id: 'ins-3',
      customerId: 'cust-1',
      storeName: '测试烟酒店A',
      userName: '张三',
      createdAt: new Date(now.getTime() - 2000),
      status: 'completed',
      photoFileIDs: [],
      aiReport: {
        hasShelfPhoto: false,
        ownBrandPresent: null,
        score: null,
        scoreLevel: '无货架照',
        facingMetrics: { ownFacingCount: null, ownFacingShare: null },
        summary: '仅门头照'
      }
    },
    {
      _id: 'ins-4',
      customerId: 'cust-1',
      storeName: '测试烟酒店A',
      userName: '张三',
      createdAt: new Date(now.getTime() - 3000),
      status: 'completed',
      photoFileIDs: [],
      aiReport: {
        score: 60,
        scoreLevel: '解析失败',
        facingMetrics: { ownFacingCount: 5, ownFacingShare: 25 },
        summary: '解析异常',
        issues: ['解析失败假问题'],
        metadata: { parseError: true }
      }
    },
    {
      _id: 'ins-5',
      customerId: 'cust-2',
      storeName: '测试烟酒店B',
      userName: '李四',
      createdAt: now,
      status: 'completed',
      photoFileIDs: [],
      aiReport: {
        hasShelfPhoto: true,
        ownBrandPresent: false,
        score: null,
        scoreLevel: '未上柜',
        facingMetrics: { ownFacingCount: 0, ownFacingShare: 0 },
        summary: '未上柜'
      }
    }
  ]

  const makeQuery = (rows) => ({
    where() { return this },
    orderBy() { return this },
    limit() { return this },
    doc() { return { get: async () => ({ data: null }) } },
    get: async () => ({ data: rows })
  })

  let mode = 'summary'
  await withMockedInternal((name) => {
    if (mode === 'summary') {
      if (name === 'customers') return makeQuery([customers[0]])
      if (name === 'inspections') return makeQuery(inspections.filter(i => i.customerId === 'cust-1'))
      return makeQuery([])
    }
    if (name === 'customers') return makeQuery(customers)
    if (name === 'inspections') return makeQuery(inspections)
    return makeQuery([])
  }, async ({ customerSummaryHandler, overviewHandler }) => {
    // 1. customerSummaryHandler
    mode = 'summary'
    let summaryPayload = null
    const res1 = {
      status() { return this },
      json(body) { summaryPayload = body; return body }
    }
    await customerSummaryHandler({ query: { storeName: '测试烟酒店A', days: '30' } }, res1)
    assert.equal(summaryPayload.success, true)
    assert.equal(summaryPayload.summary.visitCount, 4)
    assert.equal(summaryPayload.summary.scoredCount, 1)
    assert.equal(summaryPayload.summary.avgScore, 80)
    assert.equal(summaryPayload.summary.avgOwnFacingCount, 4) // (8 + 0) / 2
    assert.equal(summaryPayload.summary.avgSharePercent, 20)  // (40 + 0) / 2
    assert.deepEqual(summaryPayload.summary.topIssues, [{ issue: '缺少横签', count: 1 }])
    assert.deepEqual(summaryPayload.recentInspections.map(r => r.score), [80, null, null, null])
    assert.deepEqual(summaryPayload.recentInspections.map(r => r.ownFacingCount), [8, 0, null, null])
    assert.deepEqual(summaryPayload.recentInspections[3].issues, [])

    // 2. overviewHandler
    mode = 'overview'
    let overviewPayload = null
    const res2 = {
      status() { return this },
      json(body) { overviewPayload = body; return body }
    }
    await overviewHandler({ query: { days: '30', lowVisitThreshold: '2' } }, res2)
    assert.equal(overviewPayload.success, true)
    const storeA = overviewPayload.storeStats.find(s => s.customerId === 'cust-1')
    const storeB = overviewPayload.storeStats.find(s => s.customerId === 'cust-2')
    assert.equal(storeA.avgScore, 80)
    assert.equal(storeA.avgOwnFacingCount, 4)
    assert.equal(storeB.avgScore, null)
    assert.equal(storeB.avgOwnFacingCount, 0)
    // 仅未上柜门店 B 不应被误判为 0 分进入 lowestScoreStores
    assert.deepEqual(overviewPayload.lowestScoreStores.map(s => s.customerId), ['cust-1'])
    const spZhang = overviewPayload.salespersonStats.find(s => s.userName === '张三')
    const spLi = overviewPayload.salespersonStats.find(s => s.userName === '李四')
    assert.equal(spZhang.avgScore, 80)
    assert.equal(spLi.avgScore, null)
  })
})

// ============================================================
// 专项回归测试：针对 7 项陈列评分与识图链路修复
// ============================================================

test('修复1：photo-grid-canvas 零裁边自适应格子与 contain 几何校验', () => {
  const prevComponent = global.Component
  global.Component = () => {}
  let layoutMod
  try {
    const compPath = require.resolve('../../miniprogram/components/photo-grid-canvas/index.js')
    delete require.cache[compPath]
    layoutMod = require(compPath)._layout
  } finally {
    global.Component = prevComponent
  }
  const { computeGridLayout, computeContainRect } = layoutMod

  // 1. 纯横拍 16:9（3 张）：格子宽 > 高，绝不硬裁成正方形
  const landscape = computeGridLayout([
    { width: 1920, height: 1080 },
    { width: 1920, height: 1080 },
    { width: 1920, height: 1080 }
  ])
  assert.equal(landscape.cols, 2)
  assert.equal(landscape.rows, 2)
  assert.ok(landscape.cellWidth > landscape.cellHeight)
  assert.ok(landscape.width <= 3600 && landscape.height <= 3600)

  // 2. 纯竖拍 3:4（6 张）：总尺寸不超过 3600px 安全上限
  const portrait6 = computeGridLayout(Array.from({ length: 6 }, () => ({ width: 3000, height: 4000 })))
  assert.equal(portrait6.cols, 2)
  assert.equal(portrait6.rows, 3)
  assert.ok(portrait6.cellHeight > portrait6.cellWidth)
  assert.ok(portrait6.width <= 3600 && portrait6.height <= 3600)

  // 3. 混合比例：computeContainRect 保证 100% 完整落在格子内，无裁切且严格保比例
  const rect = computeContainRect(1920, 1080, 10, 20, 750, 1000)
  assert.ok(rect.drawX >= 10 && rect.drawY >= 20)
  assert.ok(rect.drawX + rect.drawWidth <= 10 + 750 + 1e-6)
  assert.ok(rect.drawY + rect.drawHeight <= 20 + 1000 + 1e-6)
  assert.ok(Math.abs(rect.drawWidth / rect.drawHeight - 1920 / 1080) < 1e-6)
})

test('修复2：产品瓶身参考图筛选 + 图文交错多模态 content 隔离', () => {
  const products = [
    { brandName: '永丰', productLine: '特8', aliases: ['T8'], photos: { front: 'sg://p1', side: 'sg://p1s' }, isActive: true },
    { brandName: '永丰', productLine: '老白干', photos: { front: '', side: 'sg://p2s', back: 'sg://p2b' }, isActive: true },
    { brandName: '永丰', productLine: '下架款', photos: { front: 'sg://p3' }, isActive: false },
    { brandName: '永丰', productLine: '无图款', photos: {}, isActive: true },
    { brandName: '永丰', productLine: '重复图', photos: { front: 'sg://p1' }, isActive: true },
    { brandName: '永丰', productLine: '珍品', photos: { back: 'sg://p4b' }, isActive: true }
  ]
  const picked = selectProductRefs(products, 4)
  assert.equal(picked.length, 3)
  assert.deepEqual(picked.map(p => [p.productLine, p.slot, p.photo]), [
    ['特8', 'front', 'sg://p1'],
    ['老白干', 'side', 'sg://p2s'],
    ['珍品', 'back', 'sg://p4b']
  ])

  const userPrompt = buildUserPrompt(
    2,
    '\n## 本品牌产品资料',
    [{ materialName: '永丰红底横签', visualFeatures: '红底白字' }],
    picked.slice(0, 2)
  )
  assert.match(userPrompt, /前 2 张图片/)
  assert.match(userPrompt, /第 3 至第 4 张图片/)
  assert.match(userPrompt, /产品参考图/)
  assert.match(userPrompt, /第 5 至第 5 张/)
  assert.match(userPrompt, /严禁将这 2 张产品参考图本身/)
  assert.match(userPrompt, /严禁将这 1 张参考图本身/)

  const content = buildMultimodalUserContent({
    visitImageUrls: ['data:image/jpeg;base64,V1', 'data:image/jpeg;base64,V2'],
    productRefs: [{ brandName: '永丰', productLine: '特8', slot: 'front', url: 'data:image/jpeg;base64,P1' }],
    bannerRefs: [{ materialName: '永丰红底横签', visualFeatures: '红底白字', url: 'data:image/jpeg;base64,B1' }],
    userPrompt: '请输出 JSON'
  })

  // 验证实拍图、产品参考图、横签参考图每张图前都有独立文本标签隔离，绝不扁平裸拼
  const imageIndices = content.map((part, i) => (part.image ? i : -1)).filter(i => i !== -1)
  assert.equal(imageIndices.length, 4)
  assert.match(content[imageIndices[0] - 1].text, /【实拍图 1\/2】/)
  assert.match(content[imageIndices[1] - 1].text, /【实拍图 2\/2】/)
  assert.match(content[imageIndices[2] - 1].text, /【产品参考图 1\/1】.*非门店实拍/)
  assert.match(content[imageIndices[3] - 1].text, /【横签参考图 1\/1】.*非门店实拍/)
  assert.equal(content[content.length - 1].text, '请输出 JSON')
})

test('修复3：Prompt 字段顺序先观察后打分 + 服务端以 productIdentification 我方 SKU 累加值为权威排面口径', () => {
  const sys = buildSystemPrompt()
  const idxMeta = sys.indexOf('"metadata":')
  const idxObs = sys.indexOf('"shelfObservations":')
  const idxProd = sys.indexOf('"productIdentification":')
  const idxDc = sys.indexOf('"displayCompliance":')
  const idxFm = sys.indexOf('"facingMetrics":')
  const idxTopScore = sys.indexOf('"score": 74')
  assert.ok(idxMeta > 0 && idxMeta < idxObs && idxObs < idxProd && idxProd < idxDc && idxDc < idxFm && idxFm < idxTopScore)

  // displayCompliance 每个维度内部 detail 排在 score 之前
  const gpBlock = sys.slice(sys.indexOf('"goldenPosition":'), sys.indexOf('"labelOrientation":'))
  assert.ok(gpBlock.indexOf('"detail":') < gpBlock.indexOf('"goldenFacings":'))
  assert.ok(gpBlock.indexOf('"goldenFacings":') < gpBlock.indexOf('"score":'))

  // 顶层 ownFacingCount 与 productIdentification 我方 SKU 明细不一致时，以明细累加为准并校准占比/置信度
  const report = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    facingMetrics: {
      ownFacingCount: 11, // 顶层拍脑袋多算了 3 面
      ownSkuCount: 1,
      totalShelfFacingCount: 20,
      ownFacingShare: 55,
      countingConfidence: 0.92
    },
    productIdentification: [
      { brand: '永丰', productLine: '特8', isOwn: true, facingCount: 5 },
      { brand: '永丰', productLine: '经典二锅头', isOwn: true, facingCount: 3 },
      { brand: '牛栏山', productLine: '陈酿', isOwn: false, facingCount: 12 }
    ],
    displayCompliance: {
      facingCount: { observedFacings: 11, score: 50, detail: '共11面' },
      goldenPosition: { score: 16, detail: '黄金位良好' },
      labelOrientation: { score: 8, detail: '整齐' },
      priceTag: { score: 10, detail: '价签清晰' },
      horizontalBanner: { score: 0, detail: '无横签' }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照'] }
  }, '{}', { ownBrandNames: new Set(['永丰']) })

  assert.equal(report.facingMetrics.ownFacingCount, 8)
  assert.equal(report.facingMetrics.ownSkuCount, 2)
  assert.equal(report.facingMetrics.ownFacingShare, 40) // 8 / 20 = 40%
  assert.equal(report.displayCompliance.facingCount.observedFacings, 8)
  assert.equal(report.displayCompliance.facingCount.score, 40)
  assert.equal(report.score, 40 + 16 + 8 + 10 + 0)
  assert.ok(report.facingMetrics.countingConfidence <= 0.7)
  assert.equal(report.metadata.needsReview, true)
  assert.ok(report.metadata.qualityFlags.includes('facing_count_inconsistent'))
  assert.ok(report.metadata.consistencyAdjustments.some(s => s.includes('校准为 productIdentification')))

  // 模型声称 ownBrandPresent=false 但 productIdentification 已明确列出我方排面 -> 自动纠偏
  const contradiction = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: false,
    productIdentification: [{ brand: '永丰', productLine: '特8', isOwn: true, facingCount: 4 }],
    displayCompliance: {
      goldenPosition: { score: 10 },
      labelOrientation: { score: 8 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 0 }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照'] }
  }, '{}', { ownBrandNames: new Set(['永丰']) })
  assert.equal(contradiction.ownBrandPresent, true)
  assert.equal(contradiction.facingMetrics.ownFacingCount, 4)
  assert.equal(contradiction.score, 20 + 10 + 8 + 10 + 0)
  assert.equal(contradiction.metadata.needsReview, true)
})

test('修复4：黄金位置与正标朝向按结构化观测计数确定性锚定，抑制连续分运行漂移', () => {
  // 黄金位置 Rubric 边界与单调性（满分 20）
  assert.equal(computeGoldenPositionScoreFromFacings(0, 8, 20), 0)
  assert.equal(computeGoldenPositionScoreFromFacings(1, 10, 20), 4)  // 10% -> 偏弱档 [1..6]
  assert.equal(computeGoldenPositionScoreFromFacings(2, 10, 20), 7)  // 20% -> 一般档下沿
  assert.equal(computeGoldenPositionScoreFromFacings(4, 8, 20), 13)  // 50% -> 良好档下沿
  assert.equal(computeGoldenPositionScoreFromFacings(6, 8, 20), 16)  // 75% -> 良好档
  assert.equal(computeGoldenPositionScoreFromFacings(8, 10, 20), 18) // 80% -> 满分档下沿
  assert.equal(computeGoldenPositionScoreFromFacings(10, 10, 20), 20)
  assert.equal(computeGoldenPositionScoreFromFacings(15, 10, 20), 20) // 超出总数安全裁剪

  // 正标朝向 Rubric 边界（满分 10）
  assert.equal(computeLabelOrientationScoreFromFacings(0, 8, 10), 0)
  assert.equal(computeLabelOrientationScoreFromFacings(4, 8, 10), 4)  // 50%
  assert.equal(computeLabelOrientationScoreFromFacings(7, 8, 10), 8)  // 87.5%
  assert.equal(computeLabelOrientationScoreFromFacings(10, 10, 10), 10)

  // 即使模型猜测 score 漂移到 20 和 5，只要观测事实是 6/8 和 7/8，服务端确定性锚定为 16 和 8
  const report = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    productIdentification: [{ brand: '永丰', productLine: '特8', isOwn: true, facingCount: 8 }],
    displayCompliance: {
      goldenPosition: { detail: '8面中有6面在黄金层', goldenFacings: 6, totalOwnFacings: 8, score: 20 },
      labelOrientation: { detail: '8瓶中7瓶正标朝外', frontLabelFacings: 7, totalOwnFacings: 8, score: 5 },
      priceTag: { score: 10, detail: '清晰' },
      horizontalBanner: { score: 0, detail: '无' }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照'] }
  }, '{}', {})

  assert.equal(report.displayCompliance.goldenPosition.score, 16)
  assert.equal(report.displayCompliance.goldenPosition.goldenFacings, 6)
  assert.equal(report.displayCompliance.goldenPosition.goldenRatio, 75)
  assert.equal(report.displayCompliance.labelOrientation.score, 8)
  assert.equal(report.displayCompliance.labelOrientation.frontLabelFacings, 7)
  assert.equal(report.displayCompliance.labelOrientation.frontLabelRatio, 87.5)
  assert.equal(report.score, 40 + 16 + 8 + 10 + 0)
  assert.ok(report.metadata.consistencyAdjustments.length >= 2)
})

test('修复5：closeup / poor 独立控制与未上柜模糊图复核提醒及日报聚合透传', () => {
  // 1. 清晰局部特写：黄金位封顶 12/20，排面占比置空，置信度 <= 0.55，reliability = medium
  const closeupOnly = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    facingMetrics: { ownFacingCount: 6, totalShelfFacingCount: 6, ownFacingShare: 100, countingConfidence: 0.95 },
    displayCompliance: {
      goldenPosition: { score: 20, detail: '全在视野中央' },
      labelOrientation: { score: 10, detail: '全朝外' },
      priceTag: { score: 10, detail: '清晰' },
      horizontalBanner: { score: 0, detail: '无' }
    },
    metadata: { imageQuality: 'good', framingType: 'closeup', photoRoles: ['货架陈列照'] }
  }, '{}', {})
  assert.equal(closeupOnly.displayCompliance.goldenPosition.score, 12)
  assert.equal(closeupOnly.facingMetrics.ownFacingShare, null)
  assert.equal(closeupOnly.metadata.rawOwnFacingShare, 100)
  assert.equal(closeupOnly.facingMetrics.countingConfidence, 0.55)
  assert.equal(closeupOnly.metadata.needsReview, true)
  assert.equal(closeupOnly.metadata.scoreReliability, 'medium')

  // 2. 模糊图判未上柜：仍然标记 needsReview=true、scoreReliability=low、confidence<=0.5
  const poorOos = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: false,
    facingMetrics: { ownFacingCount: 0, totalShelfFacingCount: 20, countingConfidence: 0.9 },
    metadata: { imageQuality: 'poor', imageQualityReason: '严重过暗反光', framingType: 'panorama', photoRoles: ['货架陈列照'] }
  }, '{}', {})
  assert.equal(poorOos.score, null)
  assert.equal(poorOos.scoreLevel, '未上柜')
  assert.equal(poorOos.facingMetrics.countingConfidence, 0.5)
  assert.equal(poorOos.metadata.needsReview, true)
  assert.equal(poorOos.metadata.scoreReliability, 'low')

  // 3. 日报聚合与合并正确透传 needsReviewStores，且特写门店的 null 占比不污染大盘均占比
  const agg = aggregateDailyMetrics([
    { _id: 'r1', storeName: '特写店', photoCount: 1, aiReport: closeupOnly },
    { _id: 'r2', storeName: '模糊未上柜店', photoCount: 1, aiReport: poorOos }
  ])
  assert.equal(agg.storeStats.needsReviewStores, 2)
  assert.equal(agg.ownBrandOverview.facingSharePercent, 0) // 仅模糊未上柜店贡献 0%，特写店为 null 不拉高
  assert.equal(agg.storeRankings[0].needsReview, true)
  assert.equal(agg.storeRankings[0].scoreReliability, 'medium')
  const merged = mergeDailyReports(agg, aggregateDailyMetrics([]))
  assert.equal(merged.storeStats.needsReviewStores, 2)
})

test('修复6：analyzeImage 有界思考参数、MAX_TOKENS=4096、参考图预算分配与响应提取诊断', () => {
  const axiosStubPath = require.resolve('node:path')
  // 用临时 require 钩子隔离外部依赖 axios / cloud-shim，直接单测 analyzeImage/_internal
  const Module = require('node:module')
  const origLoad = Module._load
  const analyzePath = require.resolve('../src/functions/analyzeImage/index.js')
  const prevAnalyze = require.cache[analyzePath]
  delete require.cache[analyzePath]

  Module._load = function (request, parent, isMain) {
    if (request === 'axios') return { post: async () => ({}) }
    if (request === '../../cloud-shim') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database() {
          return {
            command: {},
            serverDate: () => new Date(),
            collection: () => ({ doc: () => ({ get: async () => ({ data: null }) }) })
          }
        }
      }
    }
    return origLoad.apply(this, arguments)
  }

  let internal
  try {
    internal = require(analyzePath)._internal
  } finally {
    Module._load = origLoad
    if (prevAnalyze) require.cache[analyzePath] = prevAnalyze
    else delete require.cache[analyzePath]
  }
  assert.ok(axiosStubPath && internal)

  // 1. Qwen3.x 混合思考模型默认开启有界思考 + max_tokens=4096
  const pDefault = internal.buildQwenRequestParameters({ model: 'qwen3.8-flash' })
  assert.equal(pDefault.max_tokens, 4096)
  assert.equal(pDefault.enable_thinking, true)
  assert.equal(pDefault.thinking_budget, 1024)
  assert.equal(pDefault.vl_high_resolution_images, undefined)

  // 2. dailySummary 显式关闭思考
  const pOff = internal.buildQwenRequestParameters({ model: 'qwen3.8-flash' }, { enableThinking: false, thinkingBudget: 0 })
  assert.equal(pOff.enable_thinking, false)
  assert.equal(pOff.thinking_budget, 0)

  // 3. 老 qwen-vl-plus 模型开启高分辨率、不传 enable_thinking
  const pVl = internal.buildQwenRequestParameters({ model: 'qwen-vl-plus' })
  assert.equal(pVl.vl_high_resolution_images, true)
  assert.equal(pVl.enable_thinking, undefined)

  // 4. 图片预算分配：9 张实拍图 + 4 产品参考图 + 3 横签参考图，上限 12 -> 优先保留 3 横签 + 0 产品，总计 12
  const alloc = internal.allocateReferenceBudget(
    9,
    [{ photo: 'p1' }, { photo: 'p2' }, { photo: 'p3' }, { photo: 'p4' }],
    [{ photo: 'b1' }, { photo: 'b2' }, { photo: 'b3' }],
    12
  )
  assert.equal(alloc.bannerRefs.length, 3)
  assert.equal(alloc.productRefs.length, 0)

  // 5. extractQwenText 区分思考模式耗尽预算与关闭失败两种报错
  assert.throws(
    () => internal.extractQwenText({ output: { choices: [{ message: { content: [], reasoning_content: 'thinking...' } }] } }, { enableThinking: true }),
    /DASHSCOPE_THINKING_BUDGET/
  )
  assert.throws(
    () => internal.extractQwenText({ output: { choices: [{ message: { content: [], reasoning_content: 'thinking...' } }] } }, { enableThinking: false }),
    /enable_thinking/
  )
  assert.equal(
    internal.extractQwenText({ output: { choices: [{ message: { content: [{ text: '{"ok":true}' }], reasoning_content: 'counted 8 bottles' } }] } }, { enableThinking: true }),
    '{"ok":true}'
  )
})

test('修复7a/7b/7c：三档中档 medium、横签与 adMaterials 双向交叉校验、排面规则三参数一致性校验', () => {
  // 7a. deriveDimensionStatus：5/10 = 0.5 -> medium
  assert.equal(deriveDimensionStatus(10, 10), 'good')
  assert.equal(deriveDimensionStatus(8, 10), 'good')
  assert.equal(deriveDimensionStatus(5, 10), 'medium')
  assert.equal(deriveDimensionStatus(4, 10), 'poor')
  assert.equal(deriveDimensionStatus(0, 10), 'poor')

  const activeMats = [
    { materialName: '永丰特8红底横签', category: '横签', isActive: true }
  ]

  // 7b-1. horizontalBanner 得 10 分但 adMaterials 漏记 -> 自动补录标准横签
  const syncUp = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    facingMetrics: { ownFacingCount: 8 },
    adMaterials: [],
    displayCompliance: {
      goldenPosition: { score: 16 },
      labelOrientation: { score: 8 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 10, detail: '下沿有清晰红底横签' }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照'] }
  }, '{}', { activeMaterials: activeMats })
  assert.equal(syncUp.displayCompliance.horizontalBanner.score, 10)
  assert.equal(syncUp.adMaterials.length, 1)
  assert.equal(syncUp.adMaterials[0].name, '永丰特8红底横签')
  assert.equal(syncUp.adMaterials[0].category, '横签')

  // 7b-2. horizontalBanner 明确打 0 分，但 adMaterials 识别到了我方横签 -> 保守校准为 5(medium) 并标复核
  const conflictBanner = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    facingMetrics: { ownFacingCount: 8 },
    adMaterials: [{ name: '永丰特8红底横签', category: '横签', isOwn: true, condition: '完好', position: '货架下沿' }],
    displayCompliance: {
      goldenPosition: { score: 16 },
      labelOrientation: { score: 8 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 0, detail: '未发现横签' }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照'] }
  }, '{}', { activeMaterials: activeMats })
  assert.equal(conflictBanner.displayCompliance.horizontalBanner.score, 5)
  assert.equal(conflictBanner.displayCompliance.horizontalBanner.status, 'medium')
  assert.equal(conflictBanner.metadata.needsReview, true)
  assert.ok(conflictBanner.metadata.qualityFlags.includes('banner_material_inconsistent'))

  // 7b-3. horizontalBanner 给满分 10 分，但 adMaterials 记载全部横签均破损/遮挡 -> 下调为中档 5(medium)
  const damagedBanner = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    facingMetrics: { ownFacingCount: 8 },
    adMaterials: [{ name: '永丰特8红底横签', category: '横签', isOwn: true, condition: '严重破损卷曲', position: '货架下沿' }],
    displayCompliance: {
      goldenPosition: { score: 16 },
      labelOrientation: { score: 8 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 10, detail: '有横签' }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照'] }
  }, '{}', { activeMaterials: activeMats })
  assert.equal(damagedBanner.displayCompliance.horizontalBanner.score, 5)
  assert.equal(damagedBanner.displayCompliance.horizontalBanner.status, 'medium')

  // 7c. validateScoringRules 拦截 facingMaxScore / facingTarget / facingPointsPerUnit 互不匹配
  const earlyFull = validateScoringRules({
    facingMaxScore: 50,
    facingTarget: 10,
    facingPointsPerUnit: 10, // 5面即满分，与 target=10 冲突
    goldenPositionMaxScore: 20,
    labelOrientationMaxScore: 10,
    priceTagMaxScore: 10,
    horizontalBannerMaxScore: 10
  })
  assert.equal(earlyFull.ok, false)
  assert.match(earlyFull.error, /不匹配/)

  const jumpScore = validateScoringRules({
    facingMaxScore: 50,
    facingTarget: 10,
    facingPointsPerUnit: 3, // 9面27分、10面跳50分
    goldenPositionMaxScore: 20,
    labelOrientationMaxScore: 10,
    priceTagMaxScore: 10,
    horizontalBannerMaxScore: 10
  })
  assert.equal(jumpScore.ok, false)

  // 循环小数 50/3 ≈ 16.67 应允许通过，且 computeFacingScore 线性无跳分
  const repeating = validateScoringRules({
    facingMaxScore: 50,
    facingTarget: 3,
    facingPointsPerUnit: 16.67,
    goldenPositionMaxScore: 20,
    labelOrientationMaxScore: 10,
    priceTagMaxScore: 10,
    horizontalBannerMaxScore: 10
  })
  assert.equal(repeating.ok, true)
  assert.equal(computeFacingScore(1, repeating.rules), 17)
  assert.equal(computeFacingScore(2, repeating.rules), 33)
  assert.equal(computeFacingScore(3, repeating.rules), 50)

  // facingMaxScore = 0 允许 perUnit = 0，拒绝 perUnit = 5
  const zeroOk = validateScoringRules({
    facingMaxScore: 0,
    facingTarget: 10,
    facingPointsPerUnit: 0,
    goldenPositionMaxScore: 40,
    labelOrientationMaxScore: 20,
    priceTagMaxScore: 20,
    horizontalBannerMaxScore: 20
  })
  assert.equal(zeroOk.ok, true)
  assert.equal(computeFacingScore(10, zeroOk.rules), 0)

  const zeroBad = validateScoringRules({
    facingMaxScore: 0,
    facingTarget: 10,
    facingPointsPerUnit: 5,
    goldenPositionMaxScore: 40,
    labelOrientationMaxScore: 20,
    priceTagMaxScore: 20,
    horizontalBannerMaxScore: 20
  })
  assert.equal(zeroBad.ok, false)

  // 7b 边界：门头/店外横签或竞品横签不应误触发货架横签分抬升
  const exteriorBanner = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    facingMetrics: { ownFacingCount: 8 },
    adMaterials: [
      { name: '永丰特8红底横签', category: '横签', isOwn: true, condition: '完好', position: '门店门头上方' },
      { name: '牛栏山横签', category: '横签', isOwn: false, condition: '完好', position: '货架中层' }
    ],
    displayCompliance: {
      goldenPosition: { score: 16 },
      labelOrientation: { score: 8 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 0, detail: '货架未贴我方横签' }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['门头照', '货架陈列照'] }
  }, '{}', { activeMaterials: activeMats })
  assert.equal(exteriorBanner.displayCompliance.horizontalBanner.score, 0)
  assert.equal(exteriorBanner.metadata.needsReview, false)
})

test('端到端集成（Mock）：analyzeImage 全链路加载产品参考图+横签参考图、图文交错发送、有界思考落库', async () => {
  const Module = require('node:module')
  const origLoad = Module._load
  const analyzePath = require.resolve('../src/functions/analyzeImage/index.js')
  const prevAnalyze = require.cache[analyzePath]
  delete require.cache[analyzePath]

  let capturedAxiosBody = null
  let updatedInspectionData = null

  const mockCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext: () => ({ OPENID: '' }), // 内部调用
    async readFilesAsDataUrls({ fileList }) {
      return {
        fileList: fileList.map(id => ({ fileID: id, tempFileURL: `data:image/jpeg;base64,MOCK_${id}` }))
      }
    },
    database() {
      return {
        command: { in: v => v, gte: v => v, inc: v => v },
        serverDate: () => new Date('2026-11-19T00:00:00Z'),
        collection(name) {
          if (name === 'inspections') {
            return {
              doc(id) {
                return {
                  get: async () => ({
                    data: {
                      _id: id,
                      _openid: 'sales_1',
                      photoFileIDs: ['sg://visit/1.jpg', 'sg://visit/2.jpg']
                    }
                  }),
                  update: async ({ data }) => {
                    updatedInspectionData = data
                    return { stats: { updated: 1 } }
                  }
                }
              }
            }
          }
          if (name === 'settings') {
            return {
              doc: () => ({
                get: async () => ({
                  data: { dashscopeApiKey: 'sk-mock-key-123456', scoringRules: DEFAULT_SCORING_RULES }
                })
              })
            }
          }
          if (name === 'products') {
            return {
              where: () => ({
                get: async () => ({
                  data: [
                    { brandName: '永丰', productLine: '特8', aliases: ['T8'], photos: { front: 'sg://prod/t8.jpg' }, isActive: true }
                  ]
                })
              })
            }
          }
          if (name === 'adMaterials') {
            return {
              where: () => ({
                get: async () => ({
                  data: [
                    { materialName: '永丰红底横签', category: '横签', visualFeatures: '红底白字', photo: 'sg://mat/banner1.jpg', isActive: true }
                  ]
                })
              })
            }
          }
          return {
            doc: () => ({ get: async () => ({ data: null }), update: async () => ({}) }),
            where: () => ({ get: async () => ({ data: [] }) })
          }
        }
      }
    }
  }

  const mockAxios = {
    async post(url, body) {
      capturedAxiosBody = body
      return {
        data: {
          request_id: 'req-e2e-1',
          output: {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  reasoning_content: '逐步盘点：实拍图2第2层永丰特8有6面，第3层2面，共8面；见红底横签。',
                  content: [
                    {
                      text: JSON.stringify({
                        metadata: { photoRoles: ['门头照', '货架陈列照'], imageQuality: 'good', framingType: 'panorama' },
                        hasShelfPhoto: true,
                        ownBrandPresent: true,
                        productIdentification: [
                          { brand: '永丰', productLine: '特8', isOwn: true, facingCount: 8 }
                        ],
                        adMaterials: [],
                        displayCompliance: {
                          facingCount: { detail: '共8面', observedFacings: 8, score: 40 },
                          goldenPosition: { detail: '6/8在黄金层', goldenFacings: 6, totalOwnFacings: 8, score: 19 },
                          labelOrientation: { detail: '7/8正标朝外', frontLabelFacings: 7, totalOwnFacings: 8, score: 10 },
                          priceTag: { detail: '价签清晰', score: 10 },
                          horizontalBanner: { detail: '下沿有红底横签', score: 10 }
                        },
                        facingMetrics: { ownFacingCount: 8, totalShelfFacingCount: 20, countingConfidence: 0.9 }
                      })
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    }
  }

  Module._load = function (request) {
    if (request === 'axios') return mockAxios
    if (request === '../../cloud-shim') return mockCloud
    return origLoad.apply(this, arguments)
  }

  let analyzeMain
  try {
    analyzeMain = require(analyzePath).main
  } finally {
    Module._load = origLoad
    if (prevAnalyze) require.cache[analyzePath] = prevAnalyze
    else delete require.cache[analyzePath]
  }

  const res = await analyzeMain({ inspectionId: 'ins-e2e-1' }, {})
  assert.equal(res.success, true)

  // 验证发送给 DashScope 的请求体：图文交错 + 产品参考图 + 横签参考图 + 有界思考 + max_tokens=4096
  assert.ok(capturedAxiosBody)
  assert.equal(capturedAxiosBody.parameters.max_tokens, 4096)
  assert.equal(capturedAxiosBody.parameters.enable_thinking, true)
  assert.equal(capturedAxiosBody.parameters.thinking_budget, 1024)
  const userContent = capturedAxiosBody.input.messages[1].content
  const imgNodes = userContent.map((p, idx) => (p.image ? { idx, url: p.image } : null)).filter(Boolean)
  assert.equal(imgNodes.length, 4) // 2 实拍 + 1 产品参考图 + 1 横签参考图
  assert.match(userContent[imgNodes[0].idx - 1].text, /【实拍图 1\/2】/)
  assert.match(userContent[imgNodes[2].idx - 1].text, /【产品参考图 1\/1】/)
  assert.match(userContent[imgNodes[3].idx - 1].text, /【横签参考图 1\/1】/)

  // 验证落库结果：黄金位(6/8->16)、正标(7/8->8)被确定性锚定，横签自动补录 adMaterials
  assert.equal(updatedInspectionData.status, 'analyzed')
  assert.equal(updatedInspectionData.aiReport.displayCompliance.goldenPosition.score, 16)
  assert.equal(updatedInspectionData.aiReport.displayCompliance.labelOrientation.score, 8)
  assert.equal(updatedInspectionData.aiReport.score, 40 + 16 + 8 + 10 + 10)
  assert.equal(updatedInspectionData.aiReport.adMaterials.length, 1)
  assert.equal(updatedInspectionData.aiReport.adMaterials[0].name, '永丰红底横签')
  assert.equal(updatedInspectionData.aiDebug.productRefCount, 1)
  assert.equal(updatedInspectionData.aiDebug.bannerRefCount, 1)
  assert.equal(updatedInspectionData.aiDebug.enableThinking, true)
  assert.equal(updatedInspectionData.aiDebug.hasReasoning, true)
})

test('settings 云函数默认 imageMode 为 quality 且拦截不匹配排面规则保存', async () => {
  const Module = require('node:module')
  const origLoad = Module._load
  const settingsPath = require.resolve('../src/functions/settings/index.js')
  const prevSettings = require.cache[settingsPath]
  delete require.cache[settingsPath]

  let savedDoc = null
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext: () => ({ OPENID: 'admin_1' }),
    database() {
      return {
        command: { in: v => v, lt: v => v },
        serverDate: () => new Date(),
        collection(name) {
          if (name === 'users') {
            return {
              where: () => ({
                get: async () => ({ data: [{ _openid: 'admin_1', role: 'admin', disabled: false }] }),
                count: async () => ({ total: 1 })
              })
            }
          }
          if (name === 'settings') {
            return {
              doc: () => ({
                get: async () => ({ data: savedDoc || {} }),
                update: async ({ data }) => { savedDoc = { ...(savedDoc || {}), ...data }; return { stats: { updated: 1 } } }
              })
            }
          }
          return { where: () => ({ count: async () => ({ total: 0 }) }) }
        }
      }
    }
  }

  Module._load = function (request) {
    if (request === '../../cloud-shim') return mockCloud
    return origLoad.apply(this, arguments)
  }

  let settingsMain
  try {
    settingsMain = require(settingsPath).main
  } finally {
    Module._load = origLoad
    if (prevSettings) require.cache[settingsPath] = prevSettings
    else delete require.cache[settingsPath]
  }

  // 未显式配置时默认返回 quality
  const get1 = await settingsMain({ action: 'get' }, {})
  assert.equal(get1.success, true)
  assert.equal(get1.settings.imageMode, 'quality')

  // 显式保存 traffic 时保留 traffic
  const saveTraffic = await settingsMain({ action: 'save', settings: { imageMode: 'traffic' } }, {})
  assert.equal(saveTraffic.success, true)
  const get2 = await settingsMain({ action: 'get' }, {})
  assert.equal(get2.settings.imageMode, 'traffic')

  // 保存不匹配的排面规则被拒绝
  const saveBadRules = await settingsMain({
    action: 'save',
    settings: {
      scoringRules: {
        facingMaxScore: 50,
        facingTarget: 10,
        facingPointsPerUnit: 8,
        goldenPositionMaxScore: 20,
        labelOrientationMaxScore: 10,
        priceTagMaxScore: 10,
        horizontalBannerMaxScore: 10
      }
    }
  }, {})
  assert.equal(saveBadRules.success, false)
  assert.match(saveBadRules.error, /不匹配/)
})

test('回归1：goldenPosition / labelOrientation 尊重 totalOwnFacings 分母防虚高 + shelfObservations 跨图去重交叉核验', () => {
  // 场景 A：productIdentification 校准后为 6 面，模型原按 12 面写了 goldenFacings=6/totalOwnFacings=12 (50%) 与 frontLabelFacings=6/totalOwnFacings=12 (50%)
  // 不得被截断成 6/6 = 100% 虚高到 20/20 和 10/10
  const rDenom = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    productIdentification: [
      { brand: '永丰', productLine: '特8', isOwn: true, facingCount: 6 }
    ],
    facingMetrics: { ownFacingCount: 6, totalShelfFacingCount: 24, countingConfidence: 0.9 },
    displayCompliance: {
      facingCount: { observedFacings: 6, score: 30 },
      goldenPosition: { goldenFacings: 6, totalOwnFacings: 12, score: 13 },
      labelOrientation: { frontLabelFacings: 6, totalOwnFacings: 12, score: 4 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 0 }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照'] }
  }, '{}', {})

  assert.equal(rDenom.displayCompliance.goldenPosition.goldenRatio, 50)
  assert.equal(rDenom.displayCompliance.goldenPosition.score, 13)
  assert.equal(rDenom.displayCompliance.goldenPosition.goldenFacings, 3)
  assert.equal(rDenom.displayCompliance.labelOrientation.frontLabelRatio, 50)
  assert.equal(rDenom.displayCompliance.labelOrientation.score, 4)
  assert.equal(rDenom.displayCompliance.labelOrientation.frontLabelFacings, 3)
  assert.ok(rDenom.metadata.consistencyAdjustments.some(x => x.includes('黄金位观测分母(12)')))
  assert.ok(rDenom.metadata.consistencyAdjustments.some(x => x.includes('正标观测分母(12)')))

  // 场景 B：shelfObservations 逐图去重净排面 = 5 + (6 - 2) = 9，但 productIdentification 漏去重报了 11（偏差 2 面）
  const rObs = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    shelfObservations: {
      photoFacings: [
        { photoIndex: 1, role: '货架陈列照', layerSummary: '左侧5面', ownFacingsInPhoto: 5, overlapWithPrevious: 0 },
        { photoIndex: 2, role: '货架陈列照', layerSummary: '右侧6面(与图1重叠2面)', ownFacingsInPhoto: 6, overlapWithPrevious: 2 }
      ],
      dedupNote: '跨图重叠2面'
    },
    productIdentification: [
      { brand: '永丰', productLine: '特8', isOwn: true, facingCount: 11 }
    ],
    facingMetrics: { ownFacingCount: 11, totalShelfFacingCount: 30, countingConfidence: 0.92 },
    displayCompliance: {
      facingCount: { observedFacings: 11, score: 50 },
      goldenPosition: { score: 16 },
      labelOrientation: { score: 8 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 0 }
    },
    metadata: { imageQuality: 'good', framingType: 'panorama', photoRoles: ['货架陈列照', '货架陈列照'] }
  }, '{}', {})

  assert.equal(rObs.shelfObservations.dedupOwnFacings, 9)
  assert.equal(rObs.shelfObservations.photoFacings[1].netFacings, 4)
  assert.equal(rObs.metadata.needsReview, true)
  assert.ok(rObs.metadata.qualityFlags.includes('observation_facing_inconsistent'))
  assert.ok(rObs.facingMetrics.countingConfidence <= 0.7)
})

test('回归2：独立核验 observedFacings 偏差、totalShelfFacingCount=0 不虚构 100% 占比、竞品/未发现横签不误抬分、photoRoles 清洗与产品 front 优先', () => {
  // 1. top diff=1 但 observedFacings diff=5，必须照常触发 needsReview；totalShelfFacingCount=0 不得虚构 100% 占比
  const rDiff = validateAndNormalizeReport({
    hasShelfPhoto: true,
    ownBrandPresent: true,
    productIdentification: [
      { brand: '永丰', productLine: '特8', isOwn: true, facingCount: 8 }
    ],
    facingMetrics: { ownFacingCount: 7, totalShelfFacingCount: 0, countingConfidence: 0.95 },
    displayCompliance: {
      facingCount: { observedFacings: 13, score: 50 },
      goldenPosition: { score: 15 },
      labelOrientation: { score: 8 },
      priceTag: { score: 10 },
      horizontalBanner: { score: 0 }
    },
    adMaterials: [
      // 未显式写 isOwn 的竞品横签，及 count:0 / condition:未发现 的误报条目，均不得误抬横签分
      { name: '竞品牛栏山横签', category: '横签', position: '货架上沿', count: 1, condition: '完好' },
      { name: '永丰红底横签', category: '横签', position: '货架上沿', count: 0, condition: '未发现' }
    ],
    metadata: {
      imageQuality: 'good',
      framingType: 'panorama',
      photoRoles: ['货架陈列照', '产品参考图(非货架)', '横签参考图']
    }
  }, '{}', {
    activeMaterials: [{ materialName: '永丰红底横签', category: '横签', isActive: true }],
    visitImageCount: 1
  })

  assert.equal(rDiff.facingMetrics.ownFacingCount, 8)
  assert.equal(rDiff.facingMetrics.totalShelfFacingCount, null)
  assert.equal(rDiff.facingMetrics.ownFacingShare, null)
  assert.equal(rDiff.metadata.needsReview, true)
  assert.ok(rDiff.metadata.qualityFlags.includes('facing_count_inconsistent'))
  assert.equal(rDiff.displayCompliance.horizontalBanner.score, 0)
  // count:0/未发现 被过滤，竞品横签被识别为 isOwn: false
  assert.equal(rDiff.adMaterials.length, 1)
  assert.equal(rDiff.adMaterials[0].isOwn, false)
  // 参考图标签从 photoRoles 中被剔除
  assert.deepEqual(rDiff.metadata.photoRoles, ['货架陈列照'])

  // 2. photoRoles 含 "非货架照" 不得误判 hasShelfPhoto=true
  const rNonShelf = validateAndNormalizeReport({
    metadata: { photoRoles: ['门头照', '非货架照'], imageQuality: 'good' }
  }, '{}', {})
  assert.equal(rNonShelf.hasShelfPhoto, false)
  assert.equal(rNonShelf.scoreLevel, '无货架照')

  // 3. selectProductRefs 全局优先 front 正面照，不被靠前的仅 back 照产品挤占名额
  const refs = selectProductRefs([
    { brandName: '永丰', productLine: '仅背面', isActive: true, photos: { back: 'sg://back1.jpg' } },
    { brandName: '永丰', productLine: '正面A', isActive: true, photos: { front: 'sg://frontA.jpg' } },
    { brandName: '永丰', productLine: '正面B', isActive: true, photos: { front: 'sg://frontB.jpg' } }
  ], 2)
  assert.equal(refs.length, 2)
  assert.deepEqual(refs.map(r => r.productLine), ['正面A', '正面B'])
  assert.deepEqual(refs.map(r => r.slot), ['front', 'front'])
})

test('回归3：analyzeWithVision 思考耗尽/截断/参数不支持自动降级重试 + parseAIResponse 剥离尾部文字', async () => {
  const Module = require('node:module')
  const origLoad = Module._load
  const analyzePath = require.resolve('../src/functions/analyzeImage/index.js')
  const prevAnalyze = require.cache[analyzePath]
  delete require.cache[analyzePath]

  const validJson = JSON.stringify({
    metadata: { photoRoles: ['货架陈列照'], imageQuality: 'good', framingType: 'panorama' },
    hasShelfPhoto: true,
    ownBrandPresent: true,
    productIdentification: [{ brand: '永丰', productLine: '特8', isOwn: true, facingCount: 8 }],
    adMaterials: [],
    displayCompliance: {
      facingCount: { observedFacings: 8, score: 40, detail: '8面' },
      goldenPosition: { goldenFacings: 6, totalOwnFacings: 8, score: 16, detail: '黄金位6/8' },
      labelOrientation: { frontLabelFacings: 8, totalOwnFacings: 8, score: 10, detail: '全正标' },
      priceTag: { score: 10, detail: '有价签' },
      horizontalBanner: { score: 0, detail: '无横签' }
    },
    facingMetrics: { ownFacingCount: 8, ownSkuCount: 1, totalShelfFacingCount: 20, countingConfidence: 0.9 },
    score: 76,
    summary: '降级重试成功'
  })

  let scenario = 'reasoning_only'
  const postedParams = []
  const mockAxios = {
    async post(url, body) {
      postedParams.push(body.parameters)
      if (scenario === 'reasoning_only' && postedParams.length === 1) {
        return {
          data: {
            output: {
              choices: [{
                finish_reason: 'length',
                message: { reasoning_content: '思考耗尽预算...', content: [] }
              }]
            }
          }
        }
      }
      if (scenario === 'truncated_json' && postedParams.length === 1) {
        return {
          data: {
            output: {
              choices: [{
                finish_reason: 'length',
                message: { reasoning_content: '思考...', content: [{ text: '{"hasShelfPhoto":true,"productIdent' }] }
              }]
            }
          }
        }
      }
      return {
        data: {
          output: {
            choices: [{
              finish_reason: 'stop',
              message: { content: [{ text: validJson + '\n以上为本次评估结果。' }] }
            }]
          }
        }
      }
    }
  }

  let savedDebug = null
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext: () => ({ OPENID: '' }),
    readFilesAsDataUrls: async ({ fileList }) => ({
      fileList: fileList.map(id => ({ fileID: id, tempFileURL: `data:image/jpeg;base64,QQ==` }))
    }),
    database() {
      return {
        command: { inc: n => n, in: v => v, gte: v => v },
        serverDate: () => new Date(),
        collection(name) {
          if (name === 'inspections') {
            return {
              doc: () => ({
                get: async () => ({ data: { _id: 'ins-fb-1', _openid: 'u1', photoFileIDs: ['sg://p1.jpg'] } }),
                update: async ({ data }) => { savedDebug = data.aiDebug; return { stats: { updated: 1 } } }
              })
            }
          }
          if (name === 'settings') {
            return { doc: () => ({ get: async () => ({ data: { dashscopeApiKey: 'sk-test' } }) }) }
          }
          return { where: () => ({ get: async () => ({ data: [] }) }) }
        }
      }
    }
  }

  Module._load = function (request) {
    if (request === '../../cloud-shim') return mockCloud
    if (request === 'axios') return mockAxios
    return origLoad.apply(this, arguments)
  }

  let mod
  try {
    mod = require(analyzePath)
  } finally {
    Module._load = origLoad
    if (prevAnalyze) require.cache[analyzePath] = prevAnalyze
    else delete require.cache[analyzePath]
  }

  // 1. parseAIResponse 能剥离尾部附加解释文字
  const parsedTrailing = mod._internal.parseAIResponse(validJson + '\n附注：完成。', {})
  assert.equal(parsedTrailing.score, 76)
  assert.ok(!(parsedTrailing.metadata && parsedTrailing.metadata.parseError))

  // 2. reasoning_only 自动降级关闭思考重试一次成功
  scenario = 'reasoning_only'
  postedParams.length = 0
  const res1 = await mod.main({ inspectionId: 'ins-fb-1' }, {})
  assert.equal(res1.success, true)
  assert.equal(postedParams.length, 2)
  assert.equal(postedParams[0].enable_thinking, true)
  assert.equal(postedParams[1].enable_thinking, false)
  assert.equal(savedDebug.thinkingFallback, 'reasoning_only')
  assert.equal(res1.report.score, 76)

  // 3. truncated_json (finish_reason='length' + parseError) 自动降级关闭思考重试一次成功
  scenario = 'truncated_json'
  postedParams.length = 0
  savedDebug = null
  const res2 = await mod.main({ inspectionId: 'ins-fb-1' }, {})
  assert.equal(res2.success, true)
  assert.equal(postedParams.length, 2)
  assert.equal(postedParams[1].enable_thinking, false)
  assert.equal(savedDebug.thinkingFallback, 'truncated_json')
  assert.equal(res2.report.score, 76)
})

test('回归4：batchAnalyze 串行推进时刷新剩余记录心跳 + eval-golden-set 参数边界解析', async () => {
  // 1. eval-golden-set.js parseArgs 正确处理预算为 0 与字符串 false/0
  const { parseArgs } = require('../scripts/eval-golden-set')
  const prevBudget = process.env.DASHSCOPE_THINKING_BUDGET
  const prevEnable = process.env.DASHSCOPE_ENABLE_THINKING
  try {
    process.env.DASHSCOPE_THINKING_BUDGET = '0'
    process.env.DASHSCOPE_ENABLE_THINKING = '0'
    const a1 = parseArgs(['node', 'eval.js'])
    assert.equal(a1.enableThinking, false)
    assert.equal(a1.thinkingBudget, 0)

    const a2 = parseArgs(['node', 'eval.js', '--thinking-budget', '512'])
    assert.equal(a2.enableThinking, true)
    assert.equal(a2.thinkingBudget, 512)
  } finally {
    if (prevBudget === undefined) delete process.env.DASHSCOPE_THINKING_BUDGET
    else process.env.DASHSCOPE_THINKING_BUDGET = prevBudget
    if (prevEnable === undefined) delete process.env.DASHSCOPE_ENABLE_THINKING
    else process.env.DASHSCOPE_ENABLE_THINKING = prevEnable
  }

  // 2. batchAnalyze 认领 3 条记录后，在第 2、3 条分析前刷新剩余 analyzing 记录的 analyzeStartedAt 心跳
  const Module = require('node:module')
  const origLoad = Module._load
  const batchPath = require.resolve('../src/functions/batchAnalyze/index.js')
  const prevBatch = require.cache[batchPath]
  delete require.cache[batchPath]

  const heartbeatUpdates = []
  let pendingCallCount = 0
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext: () => ({ OPENID: '' }),
    async callFunction({ name }) {
      if (name === 'analyzeImage') {
        return { result: { success: true } }
      }
      return { result: { success: true } }
    },
    database() {
      return {
        command: {
          in: v => ({ $in: v }),
          lt: v => ({ $lt: v }),
          inc: n => ({ $inc: n })
        },
        serverDate: () => new Date(),
        collection(name) {
          if (name === 'settings') {
            return {
              doc: () => ({
                get: async () => ({ data: { analyzeMode: 'batch', analyzeTime: '21:00', windowMinutes: 180 } }),
                update: async () => ({ stats: { updated: 1 } })
              })
            }
          }
          if (name === 'inspections') {
            return {
              where(cond) {
                return {
                  orderBy() { return this },
                  limit() { return this },
                  field() { return this },
                  async count() { return { total: 0 } },
                  async get() {
                    if (cond && cond.status === 'analyzing') return { data: [] }
                    if (cond && cond.status === 'pending') {
                      pendingCallCount += 1
                      if (pendingCallCount === 1) {
                        return { data: [{ _id: 'b1', _openid: 'u1' }] }
                      }
                      return {
                        data: [
                          { _id: 'b1', storeName: '店1', photoFileIDs: ['sg://1.jpg'], analyzeAttempts: 0 },
                          { _id: 'b2', storeName: '店2', photoFileIDs: ['sg://2.jpg'], analyzeAttempts: 0 },
                          { _id: 'b3', storeName: '店3', photoFileIDs: ['sg://3.jpg'], analyzeAttempts: 0 }
                        ]
                      }
                    }
                    return { data: [] }
                  },
                  async update({ data }) {
                    if (cond && cond.status === 'analyzing' && data && data.analyzeStartedAt) {
                      heartbeatUpdates.push(cond._id.$in)
                    }
                    return { stats: { updated: 3 } }
                  }
                }
              }
            }
          }
          return { where: () => ({ get: async () => ({ data: [] }), count: async () => ({ total: 0 }) }) }
        }
      }
    }
  }

  Module._load = function (request) {
    if (request === '../../cloud-shim') return mockCloud
    return origLoad.apply(this, arguments)
  }

  let batchMain
  try {
    batchMain = require(batchPath).main
  } finally {
    Module._load = origLoad
    if (prevBatch) require.cache[batchPath] = prevBatch
    else delete require.cache[batchPath]
  }

  const runRes = await batchMain({ action: 'runNow' }, {})
  assert.equal(runRes.success, true)
  assert.equal(runRes.succeeded, 3)
  assert.deepEqual(heartbeatUpdates, [['b2', 'b3'], ['b3']])
})

test('回归5：颈挂价签 Prompt 声明、JSON 语法错自动重试(json_parse_retry)与 eval-local 工具函数', async () => {
  // 1. Prompt 包含颈挂价签与禁止未转义英文双引号约束
  const sys = buildSystemPrompt()
  assert.match(sys, /瓶脖颈挂价签/)
  assert.match(sys, /严禁在字符串值内部直接出现未转义的英文双引号/)

  // 2. eval-local 辅助函数校验
  const evalLocal = require('../scripts/eval-local')
  const parsedArgs = evalLocal.parseArgs(['node', 'eval-local.js', '--model', 'qwen3.7-plus', '--runs', '3', '--store', 'store-02', '--no-thinking'])
  assert.equal(parsedArgs.model, 'qwen3.7-plus')
  assert.equal(parsedArgs.runs, 3)
  assert.equal(parsedArgs.store, 'store-02')
  assert.equal(parsedArgs.enableThinking, false)
  assert.equal(parsedArgs.thinkingBudget, 0)
  assert.equal(evalLocal.isHeicBuffer(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])), true)
  assert.equal(evalLocal.isHeicBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])), false)

  // 3. analyzeWithVision 首次返回 finish_reason='stop' 但含未转义引号导致 JSON 语法错 -> 自动触发 json_parse_retry 自愈
  const Module = require('node:module')
  const origLoad = Module._load
  const analyzePath = require.resolve('../src/functions/analyzeImage/index.js')
  const prevAnalyze = require.cache[analyzePath]
  delete require.cache[analyzePath]

  const capturedBodies = []
  let savedUpdate = null
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext: () => ({ OPENID: '' }),
    async readFilesAsDataUrls({ fileList }) {
      return { fileList: (fileList || []).map(id => ({ fileID: id, tempFileURL: `data:image/jpeg;base64,MOCK_${id}`, status: 0 })) }
    },
    database() {
      return {
        command: { in: v => v, gte: v => v, inc: v => v },
        serverDate: () => new Date(),
        collection(name) {
          if (name === 'settings') {
            return { doc: () => ({ get: async () => ({ data: { dashscopeApiKey: 'sk-test-json-retry' } }) }) }
          }
          if (name === 'inspections') {
            return {
              doc: () => ({
                get: async () => ({ data: { _id: 'ins-json-retry', _openid: 'u1', photoFileIDs: ['sg://inspections/u1/1.jpg'] } }),
                update: async ({ data }) => { savedUpdate = data; return { stats: { updated: 1 } } }
              })
            }
          }
          return { where: () => ({ get: async () => ({ data: [] }) }) }
        }
      }
    }
  }

  let callCount = 0
  const mockAxios = {
    async post(url, body) {
      callCount += 1
      capturedBodies.push(body)
      if (callCount === 1) {
        // 模拟 finish_reason='stop' 但字符串里带未转义英文双引号破坏 JSON 语法
        return {
          data: {
            request_id: 'req-bad-json-1',
            output: {
              choices: [{
                finish_reason: 'stop',
                message: {
                  content: [{ text: '{"metadata":{"photoRoles":["货架陈列照"]},"summary":"发现"+2元换购"横签"}' }]
                }
              }]
            }
          }
        }
      }
      return {
        data: {
          request_id: 'req-good-json-2',
          output: {
            choices: [{
              finish_reason: 'stop',
              message: {
                content: [{
                  text: JSON.stringify({
                    metadata: { photoRoles: ['货架陈列照'], imageQuality: 'good', framingType: 'panorama' },
                    hasShelfPhoto: true,
                    ownBrandPresent: true,
                    productIdentification: [{ brand: '永丰', productLine: '特8', isOwn: true, facingCount: 5 }],
                    adMaterials: [],
                    displayCompliance: {
                      facingCount: { observedFacings: 5, score: 25, detail: '5面' },
                      goldenPosition: { goldenFacings: 5, totalOwnFacings: 5, score: 20, detail: '黄金位' },
                      labelOrientation: { frontLabelFacings: 5, totalOwnFacings: 5, score: 10, detail: '朝外' },
                      priceTag: { score: 10, detail: '瓶颈挂牌价签清晰' },
                      horizontalBanner: { score: 0, detail: '无横签' }
                    },
                    facingMetrics: { ownFacingCount: 5, ownSkuCount: 1, totalShelfFacingCount: 20, countingConfidence: 0.9 },
                    score: 65,
                    summary: '自愈成功'
                  })
                }]
              }
            }]
          }
        }
      }
    }
  }

  Module._load = function (request) {
    if (request === '../../cloud-shim') return mockCloud
    if (request === 'axios') return mockAxios
    return origLoad.apply(this, arguments)
  }

  let analyzeMain
  try {
    analyzeMain = require(analyzePath).main
  } finally {
    Module._load = origLoad
    if (prevAnalyze) require.cache[analyzePath] = prevAnalyze
    else delete require.cache[analyzePath]
  }

  const res = await analyzeMain({ inspectionId: 'ins-json-retry' }, {})
  assert.equal(res.success, true)
  assert.equal(capturedBodies.length, 2)
  assert.equal(capturedBodies[0].parameters.enable_thinking, true)
  assert.equal(capturedBodies[1].parameters.enable_thinking, false)
  assert.equal(savedUpdate.status, 'analyzed')
  assert.equal(savedUpdate.aiReport.score, 65)
  assert.equal(savedUpdate.aiDebug.thinkingFallback, 'json_parse_retry')

  // 4. 广告物料防误归属：未命中物料库且无我方品牌标识或低置信(<0.7) -> 自动降为 isOwn=false
  const matReport = validateAndNormalizeReport({
    metadata: { photoRoles: ['货架陈列照'], imageQuality: 'good', framingType: 'panorama' },
    hasShelfPhoto: true,
    ownBrandPresent: true,
    productIdentification: [{ brand: '永丰', productLine: '特8', isOwn: true, facingCount: 5 }],
    adMaterials: [
      { name: '永丰+2元换购横签', category: '横签', isOwn: true, count: 1, confidence: 0.88 },
      { name: '兆丰贡口杯展示盒', category: '展示架/陈列架', isOwn: true, count: 1, confidence: 0.85 },
      { name: '永丰疑似旧海报', category: 'POP海报', isOwn: true, count: 1, confidence: 0.55 },
      { name: '永丰特8方形灯箱', category: '灯箱', isOwn: true, count: 1, confidence: 0.9 }
    ],
    displayCompliance: {
      facingCount: { observedFacings: 5, score: 25, detail: '5面' },
      goldenPosition: { goldenFacings: 5, totalOwnFacings: 5, score: 20, detail: '黄金位' },
      labelOrientation: { frontLabelFacings: 5, totalOwnFacings: 5, score: 10, detail: '朝外' },
      priceTag: { score: 10, detail: '价签清晰' },
      horizontalBanner: { score: 10, detail: '有横签' }
    }
  }, '{}', {
    activeMaterials: [{ materialName: '永丰+2元换购横签', category: '横签', isActive: true }],
    ownBrandNames: new Set(['永丰', '永丰特8'])
  })
  const byMatName = new Map(matReport.adMaterials.map(m => [m.name, m]))
  assert.equal(byMatName.get('永丰+2元换购横签').isOwn, true)
  assert.equal(byMatName.get('兆丰贡口杯展示盒').isOwn, false)
  assert.equal(byMatName.get('永丰疑似旧海报').isOwn, false)
  assert.equal(byMatName.get('永丰特8方形灯箱').isOwn, true)
  assert.match(sys, /严禁强行归属我方或脑补改名/)

  // 5. 产品 visualFeatures 透传：selectProductRefs -> buildUserPrompt -> buildMultimodalUserContent
  const prodRefs = selectProductRefs([
    {
      brandName: '永丰',
      productLine: '特8红标',
      aliases: ['红特8'],
      visualFeatures: '金色旋盖+深红瓶颈套+白底红框背标',
      photos: { front: 'sg://products/red-front.jpg' },
      isActive: true
    }
  ], 4)
  assert.equal(prodRefs.length, 1)
  assert.equal(prodRefs[0].visualFeatures, '金色旋盖+深红瓶颈套+白底红框背标')
  const upWithFeat = buildUserPrompt(1, '', [], prodRefs)
  assert.match(upWithFeat, /金色旋盖\+深红瓶颈套\+白底红框背标/)
  const mmWithFeat = buildMultimodalUserContent({
    visitImageUrls: ['data:image/jpeg;base64,V1'],
    productRefs: [{ ...prodRefs[0], url: 'data:image/jpeg;base64,P1' }],
    userPrompt: upWithFeat
  })
  assert.ok(mmWithFeat.some(p => p.text && p.text.includes('金色旋盖+深红瓶颈套+白底红框背标')))
  assert.match(sys, /侧摆\/背标朝外识别/)
})





