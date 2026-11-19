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
  normalizeImageQuality,
  normalizeFramingType,
  selectHorizontalBannerRefs,
  validateAndNormalizeReport,
  extractFacingSummary,
  aggregateDailyMetrics,
  mergeDailyReports
} = require('../src/functions/analyzeImage/scoring')

const {
  buildSystemPrompt,
  buildUserPrompt,
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

test('服务端强校验：Number 转换、范围裁剪、精确重算与 status/scoreLevel 统一派生', () => {
  const report = validateAndNormalizeReport({
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
      imageQuality: '模糊',
      framingType: '局部特写',
      photoRoles: ['货架陈列照']
    }
  }, '{}', {})

  // 7*5=35 + 20 + 8 + 5 + 0 = 68
  assert.equal(report.scoringVersion, 'v2')
  assert.equal(report.score, 68)
  assert.equal(report.scoreLevel, '一般')
  assert.equal(report.displayCompliance.facingCount.score, 35)
  assert.equal(report.displayCompliance.facingCount.status, 'medium') // 35/50 = 0.7 -> medium
  assert.equal(report.displayCompliance.goldenPosition.score, 20)
  assert.equal(report.displayCompliance.goldenPosition.status, 'good')
  assert.equal(report.displayCompliance.labelOrientation.score, 8)
  assert.equal(report.displayCompliance.labelOrientation.status, 'good')
  assert.equal(report.displayCompliance.priceTag.score, 5)
  assert.equal(report.displayCompliance.priceTag.status, 'poor') // 5/10 = 0.5 -> poor
  assert.equal(report.displayCompliance.horizontalBanner.score, 0)
  assert.equal(report.displayCompliance.horizontalBanner.status, 'poor')
  assert.equal(report.facingMetrics.ownFacingCount, 7)
  assert.equal(report.facingMetrics.ownFacingShare, 35) // 7/20 = 35%
  assert.equal(report.facingMetrics.countingConfidence, 1) // clamped to 1
  assert.equal(report.metadata.imageQuality, 'poor')
  assert.equal(report.metadata.framingType, 'closeup')
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


