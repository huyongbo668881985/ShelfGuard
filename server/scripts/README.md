# 黄金标杆图集评测脚本使用说明

`eval-golden-set.js` 复用了线上真实的 `buildSystemPrompt`、`buildUserPrompt` 与 `validateAndNormalizeReport`，用于定期验证 Prompt 或模型升级后的评分准确度、排面计数误差及多次运行稳定性。

## 1. 准备标杆数据集（建议 15–20 张实拍图）

复制 `golden-set.example.json` 为 `golden-set.json`，将实拍照片放到同目录 `images/` 下，并为每条样本填写人工基准：

- `hasShelfPhoto`: 是否含货架照（纯门头/物料照填 `false`）
- `ownBrandPresent`: 货架中是否有我方品牌（无我方品牌填 `false`，无货架照填 `null`）
- `ownFacingCount`: 人工核对的我方正面最前排可见排面数（多图跨图去重后累加）
- `score`: 按 5 维规则人工核对的基准总分（未上柜 / 无货架照填 `null`）
- `bannerRefMaterials`: 可选，附带最多 3 张本地横签参考图路径（`{ materialName, visualFeatures, imagePath }`）

## 2. 本地演练（不调用模型 API）

```bash
node server/scripts/eval-golden-set.js \
  --dataset server/scripts/golden-set.example.json \
  --runs 2 \
  --dry-run
```

## 3. 真实回归评测（调用 DashScope）

```bash
DASHSCOPE_API_KEY=sk-xxxx node server/scripts/eval-golden-set.js \
  --dataset server/scripts/golden-set.json \
  --runs 3 \
  --model qwen3.8-flash \
  --out server/scripts/eval-result.json
```

## 4. 核心输出指标

- `statusAccuracyPercent`: 无货架照 / 未上柜 / 正常在架 分类准确率
- `scoreMAE` / `scoreRMSE` / `scoreMaxError`: 总分平均绝对误差、均方根误差、最大误差
- `facingMAE` / `facingExactMatchPercent` / `facingWithin1Percent`: 排面计数误差、精确命中率、±1 面命中率
- `multiRunScoreMeanStd` / `multiRunScoreMaxRange` / `multiRunFacingMaxRange`: 同图多次运行的分数与排面波动
