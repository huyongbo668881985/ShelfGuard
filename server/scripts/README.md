# 本地实拍图集 & 黄金标杆评测说明

本目录提供两套复用线上真实 `buildSystemPrompt`、`buildUserPrompt`、`buildMultimodalUserContent` 与 `validateAndNormalizeReport` 的本地评测脚本，**无需启动数据库或小程序，Node 20+ 即可直接运行**：

- [`eval-local.js`](./eval-local.js)：**日常本地实拍测试推荐入口**。直接读取被 `.gitignore` 忽略的 `server/data/local-eval/` 目录，自动兼容 iPhone HEIC 照片与大图缩放、自动降级重试，并把结果保存在 `server/data/local-eval/results/`（不上传 GitHub）。
- [`eval-golden-set.js`](./eval-golden-set.js)：面向固定 JSON 清单的黄金标杆回归评测脚本。

---

## 一、日常本地实拍测试（推荐：`eval-local.js`）

### 1. 准备本地素材目录（已在 `.gitignore` 中忽略）

所有私人实拍图与评测结果均放在 `server/data/local-eval/` 下，不会提交到 GitHub：

```text
server/data/local-eval/
├── info.json              # 品牌/产品线/别名、物料视觉特征及可选预期基准
├── products/              # 我方主力产品正面瓶身照（默认取前 4 张 front 照）
├── materials/             # 我方横签等广告物料参考图（默认取前 3 张横签照）
├── visits/
│   ├── store-01/          # 第 1 家门店本次拜访全部实拍照片（1~N 张）
│   ├── store-02/          # 第 2 家门店实拍照片（新增子目录会被自动扫描）
│   └── ...
└── results/               # 自动输出的评测明细 JSON（已 gitignore）
```

### 2. 配置 API Key

确保环境变量中已有 `DASHSCOPE_API_KEY`，或写入同样被 `.gitignore` 忽略的 `server/.env`：

```bash
DASHSCOPE_API_KEY=sk-xxxx
```

### 3. 运行本地评测

```bash
# 1) 本地演练：检查目录扫描、参考图挑选与图文交错组装（不消耗 API 额度）
npm --prefix server run eval:local -- --dry-run

# 2) 使用默认线上配置（qwen3.8-flash + 有界思考 2560 + max_tokens 8192）每店跑 2 轮
npm --prefix server run eval:local -- --runs 2

# 3) 切换模型对比效果（例如 qwen3.7-plus）
npm --prefix server run eval:local -- --model qwen3.7-plus --runs 2

# 4) 只快速复测某一家门店（例如 store-02）
npm --prefix server run eval:local -- --store store-02 --runs 2

# 5) 对比关闭思考模式 / 调整思考预算
npm --prefix server run eval:local -- --no-thinking --runs 2
npm --prefix server run eval:local -- --thinking-budget 512 --runs 2
```

---

## 二、固定清单黄金标杆评测（`eval-golden-set.js`）

### 1. 准备标杆数据集（建议 15–20 张实拍图）

复制 `golden-set.example.json` 为本地清单文件，填写每条样本的人工基准：

- `hasShelfPhoto`: 是否含货架照（纯门头/物料照填 `false`）
- `ownBrandPresent`: 货架中是否有我方品牌（无我方品牌填 `false`，无货架照填 `null`）
- `ownFacingCount`: 人工核对的我方正面最前排可见排面数（多图跨图去重后累加）
- `score`: 按 5 维规则人工核对的基准总分（未上柜 / 无货架照填 `null`）
- `productRefMaterials`: 可选，附带最多 4 张本地产品正面参考图路径
- `bannerRefMaterials`: 可选，附带最多 3 张本地横签参考图路径（`{ materialName, visualFeatures, imagePath }`）

### 2. 运行命令

```bash
# 无 Key 本地演练
node server/scripts/eval-golden-set.js \
  --dataset server/scripts/golden-set.example.json \
  --runs 2 \
  --dry-run

# 真实回归评测
DASHSCOPE_API_KEY=sk-xxxx node server/scripts/eval-golden-set.js \
  --dataset server/data/local-eval/golden-set.json \
  --runs 3 \
  --model qwen3.8-flash \
  --out server/data/local-eval/results/golden-result.json
```

### 3. 核心输出指标

- `statusAccuracyPercent`: 无货架照 / 未上柜 / 正常在架 分类准确率
- `scoreMAE` / `scoreRMSE` / `scoreMaxError`: 总分平均绝对误差、均方根误差、最大误差
- `facingMAE` / `facingExactMatchPercent` / `facingWithin1Percent`: 排面计数误差、精确命中率、±1 面命中率
- `multiRunScoreMeanStd` / `multiRunScoreMaxRange` / `multiRunFacingMaxRange`: 同图多次运行的分数与排面波动
