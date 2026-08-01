# ShelfGuard 微信小程序 · 上线前代码审查

> 审查范围：`cloudfunctions/`（6 个云函数）、`miniprogram/`（前端 + 组件 + utils）、`app.json`/`project.config.json`
> 结论：权限模型（越权校验、数据隔离）做得对；但**云开发上线**有几个阻断性问题要先把。

---

## 🔴 上线阻断（必须改，否则部署即失效）

### 1. 云环境 ID 还是占位符 —— `miniprogram/app.js:36`
```js
cloudEnv: 'your-env-id',   // ← 没替换
```
`wx.cloud.init({ env: this.globalData.cloudEnv })` 拿到的是字符串 `'your-env-id'`，
**所有云能力（数据库、云存储、callFunction）全会失败**。

**修复**：替换成你云开发控制台里真实的 env ID（形如 `cloud1-xxxx`）。
注意：小程序端 `wx.cloud.init` 只能传**字符串字面量**，不能传 `cloud.DYNAMIC_CURRENT_ENV`
（那是云函数服务端用的）。云函数侧已经正确用了 `cloud.DYNAMIC_CURRENT_ENV`，不用动。

---

### 2. AI 分析会一直返回「模拟报告」，且 OpenAI 国内大概率不可达 —— `cloudfunctions/analyzeImage/index.js`
```js
const CURRENT_MODEL = 'openai'
const config = AI_CONFIG[CURRENT_MODEL]
if (!config.apiKey) {
  console.warn('未配置 AI API Key，返回模拟结果')
  return generateMockReport()   // ← 没配 key 就走这里
}
```
仓库里**没有任何地方配置 `OPENAI_API_KEY` / `DASHSCOPE_API_KEY` 环境变量**，所以上线后
`analyzeImage` 永远走 `generateMockReport()` —— 也就是拍了照、付了存储、却拿到假报告。

另外：在**腾讯云函数里直接请求 `api.openai.com` 在国内网络环境基本不通**，即便配了 key 也很可能超时。

**修复（二选一 / 组合）**：
- 在云函数控制台给 `analyzeImage` 配置环境变量 `DASHSCOPE_API_KEY`，并把 `CURRENT_MODEL` 改成 `'qwen'`
  （你代码里已经预留了 qwen 分支，且注释说计划切 qwen，建议直接切）。
- 或确认 OpenAI 可达后配置 `OPENAI_API_KEY`。
- 无论哪种，记得在云函数控制台把 `analyzeImage` 的超时调到上限（见 #4）。

---

### 3. 历史记录页把 `db.command` 透传给云函数，日期/评分筛选会失效 —— `miniprogram/pages/history/history.js` + `cloudfunctions/getHistory/index.js`【高危】
`history.js` 的 `buildWhereCondition()` 把命令对象塞进 `callFunction` 的 `data`：
```js
conditions.createdAt = _.gte(ninetyDaysAgo)                 // 默认就带
conditions['aiReport.score'] = _.and(_.gte(60), _.lt(80))   // 评分筛选
conditions.createdAt = _.and(_.gte(startDate), _.gte(ninetyDaysAgo))
```
而 `getHistory` 自己就在注释里写过这个坑：
> *“db.command 经 callFunction JSON 序列化后 `_actions` 通常不存在，导致搜索条件被静默丢弃。”*

`_.or` 他们已经改成服务端拼了，但 **`_.gte` / `_.and` / `_.lt` 还是照样透传**，
同样会因为序列化丢字段而失效。后果很直接：`getHistory` 的 `where({ createdAt: <坏对象> })`
匹配不到任何记录 → **历史列表和统计（总巡检/平均分/本周）全空**。

**修复（最稳妥，和你 keyword 的改法一致：前端只传原语，服务端重建命令）**：

`history.js` 的 `buildWhereCondition()` 改成：
```js
const conditions = {}
if (this.data.filterDate) {
  const now = new Date()
  let start
  if (this.data.filterDate === 'today') start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  else if (this.data.filterDate === 'week') start = new Date(now.getTime() - 7 * 864e5)
  else if (this.data.filterDate === 'month') { start = new Date(now); start.setMonth(now.getMonth() - 1) }
  if (start) conditions.startDateISO = start.toISOString()
}
if (this.data.filterScore === 'high')  conditions.scoreMin = 80
if (this.data.filterScore === 'medium'){ conditions.scoreMin = 60; conditions.scoreMax = 79 }
if (this.data.filterScore === 'low')   conditions.scoreMax = 59
if (this.data.searchKeyword) conditions.keyword = this.data.searchKeyword
return conditions
```

`getHistory` 的 `buildBaseConditions()` 改成：
```js
let conditions = { createdAt: _.gte(ninetyDaysAgo) }
if (where && where.startDateISO) conditions.createdAt = _.gte(new Date(where.startDateISO))
if (where && where.scoreMin != null) conditions['aiReport.score'] = _.gte(where.scoreMin)
if (where && where.scoreMax != null) {
  const cur = conditions['aiReport.score']
  conditions['aiReport.score'] = cur ? _.and(cur, _.lte(where.scoreMax)) : _.lte(where.scoreMax)
}
// keyword 原有逻辑不动
```

---

## 🟠 上线前应处理（稳定性 / 性能）

### 4. `analyzeImage` 云函数超时风险 —— 150s axios vs 云函数 ~60s 上限
`axios` 的 `timeout: 150000` 超过了微信云函数默认/上限超时（通常 20s 起、上限约 60s）。
多张图 + `detail:'high'` 的视觉分析很容易超过 60s，**函数会被平台直接杀掉**，
`catch` 里把记录置为 `analyze_failed`，你前台轮询会一直停在“分析失败”。

**修复**：
- 给 `analyzeImage` 加 `config.json`：`{ "timeout": 60 }`（或控制台调到上限）。
- 把图片 `detail` 从 `'high'` 降到 `'low'`，或切到 qwen（通常更快）。
- 接受“偶发超时”——前台轮询 + `retry` 已具备，但建议给 analyze_failed 的记录加一个“重试”入口。

### 5. report 页轮询定时器可能泄漏 / loading 闪烁 —— `miniprogram/pages/report/report.js`
- `loadDetail()` 被 `startPolling` 的回调再次调用时，会重新 `setData({ loading: true })`，
  且**没有清掉旧 timer**；用户在轮询期间手动下拉刷新（`refresh()` → `loadDetail`）会和旧 timer 并存，两个定时器一起跑。
- **修复**：`loadDetail` 开头 `if (this.data.refreshTimer) clearInterval(this.data.refreshTimer)`；
  轮询完成 `loadDetail` 后不要再 `setData({ loading: true })`，或单独用一个 `polling` 状态位避免闪烁。

### 6. 前端直接写 `inspections`，`userName` 可能为空 —— `miniprogram/pages/upload/upload.js`
`createInspection` 前端直写，`userName` 来自相机页输入框；用户没填时就是空串。
管理者按 `userName` 筛选/统计时会漏掉这些记录（数据质量问题，不崩）。
**建议**：在 `createInspection` 前用 `app.globalData.userInfo.name` 兜底填 `userName`。

---

## 🟡 次要 / 代码质量

### 7. `inspection-card` 组件未被使用
`components/inspection-card/` 定义了但没有任何页面引用（`history.wxml` 是内联渲染的）。死代码，可删可留。

### 8. `canvasToTempFilePath` 时序稳健性 —— 两个 canvas 组件
`compose()` 画完立刻 `wx.canvasToTempFilePath`，部分机型 2D canvas 还没 flush 会导出空白。
**建议**：导出前 `await new Promise(r => requestAnimationFrame(r))` 兜一帧（或包一层重试）。

### 9. 文档与代码细微不一致（不影响运行）
- `DATABASE_SCHEMA.md` 的 `metadata` 有 `parseError`，但 `validateAndNormalize` 成功时不写 `parseError:false`（仅失败写 true）。
- `SYSTEM_PROMPT` 示例里 `metadata.analysisTime` 字段，schema 未收；`callQwen` 取 `response.data.output.text` 与实际 dashscope 返回结构可能不符（当前 `CURRENT_MODEL='openai'` 不触发，切 qwen 时需核对）。

---

## ✅ 云开发上线检查清单
1. [ ] `app.js:36` 替换真实 env ID（字符串）。
2. [ ] 创建 4 个集合：`inspections` / `users` / `products` / `customers`。
3. [ ] `inspections` 权限设为「仅创建者可读写」（管理者视角走 getReport/getHistory 云函数）；其余按需。
4. [ ] 给 `analyzeImage` 配置环境变量（建议 `DASHSCOPE_API_KEY`），`CURRENT_MODEL` 改 `'qwen'`。
5. [ ] 部署全部 6 个云函数（右键 → 上传并部署：云端安装依赖）。
6. [ ] `analyzeImage` 设置超时上限（config.json `timeout:60`）。
7. [ ] 修复 #3 的筛选透传问题（否则历史页空）。
8. [ ] 真机自测：拍照→水印→上传→AI 报告→历史→管理者视角。
