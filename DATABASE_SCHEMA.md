# 数据库集合设计

## 集合：inspections（巡检记录）

存储每次巡检的完整信息，包括照片、位置、AI 分析结果。

### 字段结构

```json
{
  // === 基础信息 ===
  "_id": "string",                    // 自动生成，记录唯一 ID
  "_openid": "string",                // 微信用户 openid（自动注入）
  
  // === 巡检信息 ===
  "taskName": "string",               // 任务名称，如"7月陈列检查"
  "storeName": "string",              // 门店名称，如"XX超市"
  "userName": "string",               // 业务员姓名
  "customerId": "string",             // 关联 customers 表的 _id，可能为空（手打门店名、
                                       // 没走客户库选择的情况）；走客户库选的会自动带上
  
  // === 照片信息 ===
  "photoFileIDs": ["string"],         // 云存储文件 ID 数组
  "photoCount": "number",             // 照片数量
  
  // === 位置信息 ===
  "location": {
    "latitude": "number",             // 纬度
    "longitude": "number",            // 经度
    "address": "string"               // 地址文本（可能是坐标或逆地理编码结果）
  },
  
  // === 状态管理 ===
  // 状态机（详见下方"状态流转"）：
  //   pending        待分析（提交即入队，等定时/手动批量分析领取）
  //   analyzing      分析中（analyzeImage 被调用后、出结果前）
  //   analyzed       分析成功
  //   analyze_failed 分析失败
  "status": "string",                 // 状态：pending | analyzing | analyzed | analyze_failed
  "analyzeAttempts": "number",        // 已尝试分析次数（僵尸回收 / 失败重排时用于判断是否超限）
  "analyzeStartedAt": "Date",         // 最近一次开始分析的时间（用于回收超时的僵尸记录）
  "analyzedModel": "string",          // 实际出报告的模型名（如 qwen3.7-plus），便于追溯
  "createdAt": "Date",                // 创建时间（服务器时间）
  
  // === AI 分析结果 ===
  // 注意：以下结构以 cloudfunctions/analyzeImage/index.js 中 SYSTEM_PROMPT 的实际
  // 输出为准。同一次巡检的多张照片会被合并为【一次】AI 调用、产出【一份】报告，
  // 而不是逐张分析后互相覆盖。
  "aiReport": {
    "score": "number",                // 陈列评分 0-100（整数）
    "scoreLevel": "string",           // 评分等级：卓越/优秀/良好/一般/较差/不合格
    "summary": "string",              // 分析总结文本
    "productIdentification": [        // 识别到的产品列表
      {
        "brand": "string",            // 品牌名称
        "productLine": "string",      // 产品系列
        "aromaType": "string",        // 香型
        "priceRange": "string",       // 价格带：高端/次高端/中端/大众
        "facingCount": "number",      // 排面数量
        "position": "string",         // 货架位置，如"黄金位"
        "confidence": "number"        // 识别置信度 0-1
      }
    ],
    "displayCompliance": {            // 陈列规范度各维度评分
      "labelOrientation": { "score": "number", "status": "string", "detail": "string" },
      "neatness": { "score": "number", "status": "string", "detail": "string" },
      "goldenPosition": { "score": "number", "status": "string", "detail": "string" },
      "brandConcentration": { "score": "number", "status": "string", "detail": "string" },
      "priceTagMatch": { "score": "number", "status": "string", "detail": "string" },
      "shelfFullness": { "score": "number", "status": "string", "detail": "string" }
    },
    "competitiveAnalysis": {          // 竞品分析
      "totalBrands": "number",
      "brands": [{ "brand": "string", "sharePercent": "number", "positionAdvantage": "string" }],
      "insight": "string"
    },
    "issues": [                       // 发现的问题列表
      { "severity": "string", "category": "string", "description": "string", "impact": "string" }
    ],
    "suggestions": [                  // 改进建议列表
      { "priority": "string", "action": "string", "expectedEffect": "string", "deadline": "string" }
    ],
    "metadata": {                     // 元信息
      "imageQuality": "string",
      "shelfCount": "number",
      "totalProducts": "number",
      "parseError": "boolean"         // JSON 解析是否失败（失败时其余字段为空壳兜底值）
    },
    "rawResponse": "string"           // AI 原始返回（用于调试）
  },
  "analyzedAt": "Date",               // 分析完成时间
  "analyzedFileID": "string",         // 已分析的第一个文件 ID（兼容旧字段）
  "analyzedFileIDs": ["string"],      // 本次参与合并分析的全部文件 ID
  "analyzeError": "string"            // 分析失败时的错误信息
}
```

### 索引建议

```javascript
// 按用户 + 时间倒序查询（历史记录页）
db.collection('inspections').createIndex({
  _openid: 1,
  createdAt: -1
})

// 管理者按业务员姓名 + 时间查询（历史记录页"按业务员筛选"）
db.collection('inspections').createIndex({
  userName: 1,
  createdAt: -1
})

// 按状态查询（待分析/失败记录）
db.collection('inspections').createIndex({
  status: 1,
  createdAt: -1
})
```

### 状态流转

```
pending → analyzing       (定时触发器 / 手动"立即分析"领取任务，开始分析)
analyzing → analyzed       (AI 分析成功)
analyzing → analyze_failed (AI 分析失败)
analyze_failed → pending   (管理员在"分析设置"页点"重排失败记录"重试)
pending → analyze_failed   (记录没有照片等脏数据，直接判失败，不再占用队列)
```

> 旧文档里写的 `uploaded` 状态是"提交即同步分析"时期的遗留字段，新流程已统一用 `pending`：
> 提交即入队（不原地等 AI），由 `batchAnalyze` 定时任务或管理员手动触发 `analyzeImage` 来推进。
> 即时分析模式（instant）下，`pending` 记录也会被小程序端直接领取并调用 `analyzeImage`，
> 流程同上，只是触发时机从"定时"变成了"提交后立刻"。

---

## 集合：users（用户信息）

存储用户基本信息，用于展示业务员姓名等。

### 字段结构

```json
{
  "_id": "string",                    // 自动生成
  "_openid": "string",                // 微信用户 openid

  // === 用户信息 ===
  "name": "string",                   // 用户姓名
  "role": "string",                   // 角色：sales（业务员）| manager（管理者）| admin（管理员）
                                      //   - sales：只能看自己、改自己资料、提交巡检
                                      //   - manager：可看全员记录 + 全量统计（只读视角），不能改系统设置
                                      //   - admin：改系统设置 + 管用户（角色/停用），是最高权限
  "phone": "string",                  // 手机号（可选）
  "department": "string",             // 部门（可选）

  // === 账号状态 ===
  "disabled": "boolean",              // 是否停用（由 admin 在「用户与权限管理」里置 true）。
                                      //   停用后无法提交巡检、查看记录/报告、改设置；历史数据不受影响。
  "disabledAt": "Date",               // 停用时间
  "disabledBy": "string",             // 执行停用的 admin 的 openid

  // === 提拔记录 ===
  "promotedAt": "Date",               // 被设为 admin 的时间（首管理员激活时写入）
  "promotedBy": "string",             // 提拔来源：'self-setup'（激活码自举）或提拔人的 openid

  // === 时间戳 ===
  "createdAt": "Date",                // 首次登录时间
  "updatedAt": "Date"                 // 最后更新时间
}
```

> **首管理员怎么来**：系统初始没有任何管理员。部署时在 `settings` 云函数环境变量里设
> `ADMIN_SETUP_CODE`（你自己定的字符串），再在小程序「分析设置」页用这个码把当前微信账号激活成 admin。
> 激活后系统就有了管理员，这条路永久关闭（别人无法再用激活码或"系统无管理员"的漏洞提权）。
> 后续给其他人升 manager/admin，只能由已有的 admin 在「用户与权限管理」页里操作。
>
> **巡检记录归属**：`inspections` 的 `_openid` 现在由 `submitInspection` 云函数在服务端
> 显式写入（提交时传入的 openid），不再依赖客户端直写自动注入，确保归属可信、sales 只能看自己。

### 索引建议

```javascript
// 按 openid 查询（唯一）
db.collection('users').createIndex({
  _openid: 1
}, { unique: true })
```

---

## 集合：roleChanges（角色变更审计）

每次 `users.setRole` 调整某人角色时，由 `users` 云函数自动写入一条记录，便于追溯"谁在什么时候把谁从 X 提到了 Y"。仅审计用途，不参与任何查询过滤。

### 字段结构

```json
{
  "_id": "string",                    // 自动生成
  "byOpenid": "string",               // 操作人（执行提拔/降级的 admin）openid
  "targetOpenid": "string",           // 被调整角色的用户 openid
  "from": "string",                   // 调整前角色：sales | manager | admin
  "to": "string",                     // 调整后角色：sales | manager | admin
  "at": "Date"                        // 变更发生时间
}
```

---

## 集合：products（产品库）

维护"本品牌"产品资料（品牌名、别名、产品线、正/背/侧面参考照），供 `analyzeImage` 云函数在做 AI 视觉分析时拼进 Prompt，让品牌识别有据可依，而不是完全依赖模型自己的通用知识猜测。换品牌、加产品线，只需要在小程序"产品库管理"页里维护，不用改代码。

**⚠️ 权限模型跟 `inspections` 不一样，注意别混淆**：
- `inspections` 是个人巡检记录，云函数查询必须按 `_openid` 过滤（见前文 `getHistory` 的教训）。
- `products` 是团队共享资料库，所有登录用户查询到的是**同一份**产品清单，云函数**不**按 `_openid` 过滤；`_openid` 字段只记录创建人用于审计。
- 产品库查询对登录用户开放；新增、修改、下架仅允许 `admin` 角色，服务端在 `cloudfunctions/products/index.js` 的 `add`/`update`/`remove` 分支统一校验。

### 字段结构

```json
{
  "_id": "string",                    // 自动生成
  "_openid": "string",                // 创建人（仅审计用，不做查询过滤）

  "brandName": "string",              // 品牌名称，如"XX酒业"
  "productLine": "string",            // 产品线/系列名（可选），如"经典系列"
  "aliases": ["string"],              // 别名/简称列表，AI 识别时用于名称归一化匹配

  "photos": {                         // 参考照片（均为 fileID，可选）
    "front": "string",
    "back": "string",
    "side": "string"
  },

  "isActive": "boolean",              // 是否参与 AI 识别与统计；下架用软删除（置为 false），
                                       // 不物理删除，避免历史巡检报告失去可追溯的品牌资料依据
  "createdAt": "Date",
  "updatedAt": "Date"
}
```

### 使用方式

`analyzeImage` 云函数在每次分析前会查询 `isActive: true` 的产品，拼成一段"本品牌产品资料"文本追加进 AI 的 user prompt（纯文本方式，不消耗图片 token）。如果后续发现某个小众品牌模型识别不准，可以考虑把参考照片也作为 few-shot 图片一起传给模型，但那样每次分析请求都会多出好几张图，token/调用成本会明显上升，建议先用文本方式跑一段时间看效果，需要再加。

---

## 集合：customers（客户/门店资料）

业务员维护自己的客户资料（门店名、地址、联系人、电话、位置坐标），供拍照时直接选，不用每次手打门店名，也是"就近排序"功能的数据来源。

**⚠️ 权限模型跟 `products` 正好相反，注意别混淆**：
- `products` 是团队共享资料库，所有登录用户看到同一份，云函数**不**按 `_openid` 过滤。
- `customers` 是业务员**私有**资源，云函数**必须**强制按 `_openid` 过滤，业务员之间互相看不到对方的客户列表。openid 永远从服务端 `wxContext` 取，不信任客户端传的任何身份声明——这条是 `getHistory` 那次数据泄露漏洞学到的教训，`customers` 从设计第一天就按对的方式做，具体校验逻辑见 `cloudfunctions/customers/index.js` 顶部注释。

### 字段结构

```json
{
  "_id": "string",                    // 自动生成
  "_openid": "string",                // 创建人 = 所属业务员，查询过滤的依据

  "storeName": "string",              // 门店名称（必填）
  "address": "string",                // 地址（可选，纯文本，不参与距离计算）
  "contactName": "string",            // 联系人（可选）
  "contactPhone": "string",           // 联系电话（可选）

  "location": {                       // 门店坐标（可选，但不填就不会出现在"就近排序"里）
    "latitude": "number",
    "longitude": "number"
  },

  "isActive": "boolean",              // 软删除标记，删除时置为 false，保留历史巡检记录的可追溯性
  "createdAt": "Date",
  "updatedAt": "Date"
}
```

### 使用方式

相机页"选择客户"时，前端会带上当前定位坐标查询 `customers` 云函数的 `list` 动作（已经是按 `_openid` 过滤过的自己的客户），拿到列表后用 Haversine 公式在前端算直线距离并排序——业务员的客户一般就几十个，前端算完全够用，不需要后端做地理索引。选中后会把 `storeName`/`address` 回填到水印信息里，客户的 `_id` 也会跟着这次巡检一起存进 `inspections.customerId` 字段，方便以后"按客户查历史"。

---

## 云存储目录结构

```
cloud://env-id.xxx/
└── inspections/                      # 巡检照片目录
    ├── 2026/                         # 按年归档（可选）
    │   ├── 07/                       # 按月归档
    │   │   ├── 1690000000000-0-abc123.jpg
    │   │   └── 1690000000001-1-def456.jpg
    │   └── ...
    └── ...
```

文件命名规则：`{timestamp}-{index}-{random}.jpg`

---

---

## 集合：settings（系统配置）

全局唯一的配置文档，固定 `_id = 'global'`，全系统共用一份。由 `settings` 云函数读写，前端「分析设置」页调用。

API Key（`dashscopeApiKey`）明文只存在这里、只在 `analyzeImage` 云函数服务端读取，前端只读掩码、绝不拿到明文。

### 字段结构

```json
{
  "_id": "global",                    // 固定值，全系统唯一一份配置

  // === 分析调度 ===
  "analyzeMode": "string",            // 'batch' = 每日集中分析（默认）；'instant' = 提交即分析（退回旧流程）
  "analyzeTime": "string",            // 集中分析开始时间，北京时间 HH:mm，默认 '21:00'
  "windowMinutes": "number",          // 从开始时间起允许跑多久（分钟），默认 180
  "batchSize": "number",              // 每次定时触发最多处理几条，默认 2（云函数 60s 超时限制下建议 ≤3）

  // === API Key ===
  "dashscopeApiKey": "string",        // 通义千问 DashScope API Key（明文，仅服务端可读）

  // === 运行记录（batchAnalyze 每次实干后回写）===
  "lastRunAt": "Date",                // 最近一次实际运行时间
  "lastRunTriggeredBy": "string",     // 'timer' | 'manual'
  "lastRunSummary": {                 // 最近一次的运行统计
    "processed": "number",
    "succeeded": "number",
    "failed": "number",
    "reclaimed": "number",
    "remaining": "number"
  },

  "updatedAt": "Date",
  "updatedBy": "string"               // 最近一次修改者的 openid
}
```

### 读写权限（重要）

- **读（get）**：任何登录用户都能读，但 `dashscopeApiKey` 只返回掩码（`sk-xxxx****xxxx`），明文不出服务端。停用账号读也会被拒。
- **写（save / retryFailed）**：仅 `admin` 角色。
- **首管理员激活（activateAdmin）**：一次性，凭云函数环境变量 `ADMIN_SETUP_CODE`，把当前用户升为 admin。
  激活后系统已有管理员，这条路关闭；若已存在任何 admin/manager，激活直接被拒（不再有"系统无管理员则任何人可写"的自举漏洞）。
- **manager 不能改设置**：`manager` 只拥有"看全员 + 全量统计"的只读视角，`admin` 才拥有改设置 + 管用户的权限。

### 使用方式

- `analyzeImage` 在环境变量 `DASHSCOPE_API_KEY` 没配时，会到这里读 `dashscopeApiKey` 作为兜底。
- `batchAnalyze` 每次醒来先读这里的 `analyzeMode` / `analyzeTime` / `windowMinutes` / `batchSize` 决定要不要干活、干多久。
- 没有这个文档时，所有读写都退回 `DEFAULT_SETTINGS` 默认值，不阻断主流程。

### 部署注意

`settings` 集合**必须先在云开发控制台手动创建**。若未创建，首次保存会报 `-502005 database collection not exists`。创建空集合后即可正常读写。

---

## 查询示例

### 查询当前用户 90 天内的巡检记录

```javascript
const ninetyDaysAgo = new Date()
ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

const res = await db.collection('inspections')
  .where({
    _openid: openid,
    createdAt: _.gte(ninetyDaysAgo)
  })
  .orderBy('createdAt', 'desc')
  .skip(0)
  .limit(20)
  .get()
```

### 查询待分析的记录

```javascript
const res = await db.collection('inspections')
  .where({
    status: 'pending'
  })
  .get()
```

### 统计当前用户的巡检次数

```javascript
const countRes = await db.collection('inspections')
  .where({
    _openid: openid
  })
  .count()
```
