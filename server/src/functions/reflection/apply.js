'use strict'

// ============================================================
// 定期 AI 复盘 · 第四阶段：提案采纳应用与一键撤销（Knowledge Apply & Undo）
// - applyProposal(proposal, adminContext)
// - undoKnowledgeChange(changeId, adminContext)
// ============================================================

const cloud = require('../../cloud-shim')
const { ALLOWED_REFLECTION_FIX_TYPES, MAX_LEARNED_RULE_ITEMS } = require('../analyzeImage/prompt')
const { normalizeReviewThresholds } = require('../analyzeImage/scoring')

const db = cloud.database()
const ALLOWED_SET = new Set(ALLOWED_REFLECTION_FIX_TYPES)

async function loadGlobalSettings() {
  try {
    const res = await db.collection('settings').doc('global').get()
    return (res && res.data) || {}
  } catch (_) {
    return {}
  }
}

async function saveGlobalSettingsPatch(patch = {}) {
  const cur = await loadGlobalSettings()
  const nextVersion = (Number(cur.knowledgeVersion) || 1) + 1
  const data = {
    ...patch,
    knowledgeVersion: nextVersion,
    updatedAt: db.serverDate()
  }
  try {
    await db.collection('settings').doc('global').update({ data })
  } catch (e) {
    await db.collection('settings').doc('global').set({ data })
  }
  return nextVersion
}

/**
 * 采纳并执行一条复盘提案，同时在 knowledgeChanges 集合写入包含 undoSnapshot 的审计记录
 */
async function applyProposal(proposal, adminContext = {}) {
  if (!proposal || typeof proposal !== 'object') {
    return { ok: false, error: '无效的提案对象' }
  }
  const fixType = String(proposal.fixType || '').trim()
  if (!ALLOWED_SET.has(fixType)) {
    return { ok: false, error: `不支持的修正类型: ${fixType}` }
  }

  const target = proposal.target || {}
  const payload = proposal.payload || {}
  const adminOpenid = String(adminContext.openid || '')
  const adminName = String(adminContext.adminName || '管理员')
  const reflectionId = String(adminContext.reflectionId || '')

  let undoSnapshot = {}
  let appliedEntityId = ''

  switch (fixType) {
    case 'confusable_add': {
      const competitorName = String(payload.competitorName || '').trim()
      if (!competitorName) return { ok: false, error: '缺少易混淆竞品名称' }
      const addRes = await db.collection('confusableProducts').add({
        data: {
          _openid: adminOpenid,
          competitorName,
          competitorBrand: String(payload.competitorBrand || '').trim(),
          lookalikeProductId: String(target.lookalikeProductId || '').trim(),
          lookalikeProductName: String(payload.lookalikeProductName || '').trim(),
          distinguishingFeatures: String(payload.distinguishingFeatures || '').trim(),
          photo: '',
          hitCount: Number(proposal.evidenceCount) || 1,
          source: 'reflection',
          reflectionId,
          isActive: true,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
      appliedEntityId = addRes._id
      undoSnapshot = { collection: 'confusableProducts', docId: addRes._id, mode: 'deactivate' }
      await saveGlobalSettingsPatch({})
      break
    }

    case 'confusable_update': {
      const cid = String(target.confusableId || '').trim()
      if (!cid) return { ok: false, error: '缺少 confusableId' }
      const res = await db.collection('confusableProducts').doc(cid).get()
      const doc = res && res.data
      if (!doc) return { ok: false, error: '目标易混淆竞品不存在' }
      undoSnapshot = {
        collection: 'confusableProducts',
        docId: cid,
        mode: 'restore_fields',
        fields: { distinguishingFeatures: doc.distinguishingFeatures || '' }
      }
      await db.collection('confusableProducts').doc(cid).update({
        data: {
          distinguishingFeatures: String(payload.distinguishingFeatures || '').trim(),
          updatedAt: db.serverDate()
        }
      })
      appliedEntityId = cid
      await saveGlobalSettingsPatch({})
      break
    }

    case 'confusable_retire': {
      const cid = String(target.confusableId || '').trim()
      if (!cid) return { ok: false, error: '缺少 confusableId' }
      const res = await db.collection('confusableProducts').doc(cid).get()
      const doc = res && res.data
      if (!doc) return { ok: false, error: '目标易混淆竞品不存在' }
      undoSnapshot = {
        collection: 'confusableProducts',
        docId: cid,
        mode: 'restore_fields',
        fields: { isActive: Boolean(doc.isActive !== false) }
      }
      await db.collection('confusableProducts').doc(cid).update({
        data: { isActive: false, updatedAt: db.serverDate() }
      })
      appliedEntityId = cid
      await saveGlobalSettingsPatch({})
      break
    }

    case 'product_confusion_notes': {
      const pid = String(target.productId || '').trim()
      if (!pid) return { ok: false, error: '缺少 productId' }
      const res = await db.collection('products').doc(pid).get()
      const doc = res && res.data
      if (!doc) return { ok: false, error: '目标产品不存在' }
      undoSnapshot = {
        collection: 'products',
        docId: pid,
        mode: 'restore_fields',
        fields: { confusionNotes: doc.confusionNotes || '' }
      }
      await db.collection('products').doc(pid).update({
        data: {
          confusionNotes: String(payload.confusionNotes || '').trim(),
          updatedAt: db.serverDate()
        }
      })
      appliedEntityId = pid
      await saveGlobalSettingsPatch({})
      break
    }

    case 'product_visual_features': {
      const pid = String(target.productId || '').trim()
      if (!pid) return { ok: false, error: '缺少 productId' }
      const res = await db.collection('products').doc(pid).get()
      const doc = res && res.data
      if (!doc) return { ok: false, error: '目标产品不存在' }
      undoSnapshot = {
        collection: 'products',
        docId: pid,
        mode: 'restore_fields',
        fields: { visualFeatures: doc.visualFeatures || '' }
      }
      await db.collection('products').doc(pid).update({
        data: {
          visualFeatures: String(payload.visualFeatures || '').trim(),
          updatedAt: db.serverDate()
        }
      })
      appliedEntityId = pid
      await saveGlobalSettingsPatch({})
      break
    }

    case 'ref_priority': {
      const pid = String(target.productId || '').trim()
      if (!pid) return { ok: false, error: '缺少 productId' }
      const res = await db.collection('products').doc(pid).get()
      const doc = res && res.data
      if (!doc) return { ok: false, error: '目标产品不存在' }
      undoSnapshot = {
        collection: 'products',
        docId: pid,
        mode: 'restore_fields',
        fields: { refPriority: Number(doc.refPriority) || 0 }
      }
      const nextPrio = Number.isFinite(Number(payload.refPriority))
        ? Math.round(Number(payload.refPriority))
        : ((Number(doc.refPriority) || 0) + 10)
      await db.collection('products').doc(pid).update({
        data: {
          refPriority: nextPrio,
          updatedAt: db.serverDate()
        }
      })
      appliedEntityId = pid
      await saveGlobalSettingsPatch({})
      break
    }

    case 'alias_remove': {
      const pid = String(target.productId || '').trim()
      if (!pid) return { ok: false, error: '缺少 productId' }
      const res = await db.collection('products').doc(pid).get()
      const doc = res && res.data
      if (!doc) return { ok: false, error: '目标产品不存在' }
      const prevAliases = Array.isArray(doc.aliases) ? [...doc.aliases] : []
      const nextAliases = prevAliases.filter(a => String(a).trim() !== String(payload.alias || '').trim())
      undoSnapshot = {
        collection: 'products',
        docId: pid,
        mode: 'restore_fields',
        fields: { aliases: prevAliases }
      }
      await db.collection('products').doc(pid).update({
        data: {
          aliases: nextAliases,
          updatedAt: db.serverDate()
        }
      })
      appliedEntityId = pid
      await saveGlobalSettingsPatch({})
      break
    }

    case 'material_visual_features': {
      const mid = String(target.materialId || '').trim()
      if (!mid) return { ok: false, error: '缺少 materialId' }
      const res = await db.collection('adMaterials').doc(mid).get()
      const doc = res && res.data
      if (!doc) return { ok: false, error: '目标广告物料不存在' }
      undoSnapshot = {
        collection: 'adMaterials',
        docId: mid,
        mode: 'restore_fields',
        fields: { visualFeatures: doc.visualFeatures || '' }
      }
      await db.collection('adMaterials').doc(mid).update({
        data: {
          visualFeatures: String(payload.visualFeatures || '').trim(),
          updatedAt: db.serverDate()
        }
      })
      appliedEntityId = mid
      await saveGlobalSettingsPatch({})
      break
    }

    case 'learned_rule_add': {
      const ruleText = String(payload.rule || '').trim()
      if (!ruleText) return { ok: false, error: '规则补丁内容不能为空' }
      const settingsDoc = await loadGlobalSettings()
      const prevRules = Array.isArray(settingsDoc.learnedRules) ? [...settingsDoc.learnedRules] : []
      const activeCount = prevRules.filter(r => r && r.isActive !== false).length
      if (activeCount >= MAX_LEARNED_RULE_ITEMS) {
        return { ok: false, error: `启用中的规则补丁已达上限（${MAX_LEARNED_RULE_ITEMS} 条），请先下线旧规则` }
      }
      const ruleId = `lr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const newRule = {
        id: ruleId,
        category: String(payload.category || 'general').trim(),
        rule: ruleText,
        isActive: true,
        reflectionId,
        createdAt: new Date().toISOString()
      }
      undoSnapshot = {
        collection: 'settings',
        docId: 'global',
        mode: 'restore_fields',
        fields: { learnedRules: prevRules }
      }
      await saveGlobalSettingsPatch({
        learnedRules: [newRule, ...prevRules]
      })
      appliedEntityId = ruleId
      break
    }

    case 'learned_rule_retire': {
      const rid = String(target.ruleId || '').trim()
      if (!rid) return { ok: false, error: '缺少 ruleId' }
      const settingsDoc = await loadGlobalSettings()
      const prevRules = Array.isArray(settingsDoc.learnedRules) ? [...settingsDoc.learnedRules] : []
      const nextRules = prevRules.map(r => (r && String(r.id) === rid ? { ...r, isActive: false } : r))
      undoSnapshot = {
        collection: 'settings',
        docId: 'global',
        mode: 'restore_fields',
        fields: { learnedRules: prevRules }
      }
      await saveGlobalSettingsPatch({
        learnedRules: nextRules
      })
      appliedEntityId = rid
      break
    }

    case 'threshold_adjust': {
      const settingsDoc = await loadGlobalSettings()
      const prevThresholds = normalizeReviewThresholds(settingsDoc.reviewThresholds)
      const nextThresholds = normalizeReviewThresholds(payload)
      undoSnapshot = {
        collection: 'settings',
        docId: 'global',
        mode: 'restore_fields',
        fields: { reviewThresholds: prevThresholds }
      }
      await saveGlobalSettingsPatch({
        reviewThresholds: nextThresholds
      })
      appliedEntityId = 'reviewThresholds'
      break
    }

    case 'product_ref_photo':
    case 'product_add_todo':
    case 'sales_tip':
    case 'needs_dev': {
      undoSnapshot = { mode: 'noop_todo' }
      appliedEntityId = 'todo'
      break
    }

    default:
      return { ok: false, error: `未知修正类型: ${fixType}` }
  }

  const nextSettings = await loadGlobalSettings()
  const knowledgeVersion = Number(nextSettings.knowledgeVersion) || 1

  const changeDoc = {
    reflectionId,
    proposalId: proposal.proposalId || '',
    fixType,
    summary: proposal.summary || fixType,
    target,
    payload,
    appliedEntityId,
    knowledgeVersion,
    undoSnapshot,
    undone: false,
    appliedBy: adminOpenid,
    appliedByName: adminName,
    appliedAt: new Date().toISOString()
  }

  const addChangeRes = await db.collection('knowledgeChanges').add({
    data: changeDoc
  })

  return {
    ok: true,
    changeId: addChangeRes._id,
    knowledgeVersion,
    appliedEntityId
  }
}

/**
 * 一键撤销已应用的知识库变更
 */
async function undoKnowledgeChange(changeId, adminContext = {}) {
  if (!changeId) return { ok: false, error: '缺少 changeId' }

  let changeDoc
  try {
    const res = await db.collection('knowledgeChanges').doc(changeId).get()
    changeDoc = res && res.data
  } catch (e) {
    return { ok: false, error: '变更记录不存在' }
  }
  if (!changeDoc) return { ok: false, error: '变更记录不存在' }
  if (changeDoc.undone) return { ok: false, error: '该变更已撤销，无需重复操作' }

  const snap = changeDoc.undoSnapshot || {}
  if (snap.mode === 'deactivate' && snap.collection && snap.docId) {
    await db.collection(snap.collection).doc(snap.docId).update({
      data: { isActive: false, updatedAt: db.serverDate() }
    })
    await saveGlobalSettingsPatch({})
  } else if (snap.mode === 'restore_fields' && snap.collection && snap.docId && snap.fields) {
    if (snap.collection === 'settings') {
      await saveGlobalSettingsPatch(snap.fields)
    } else {
      await db.collection(snap.collection).doc(snap.docId).update({
        data: {
          ...snap.fields,
          updatedAt: db.serverDate()
        }
      })
      await saveGlobalSettingsPatch({})
    }
  }

  await db.collection('knowledgeChanges').doc(changeId).update({
    data: {
      undone: true,
      undoneAt: new Date().toISOString(),
      undoneBy: String(adminContext.openid || ''),
      undoneByName: String(adminContext.adminName || '管理员')
    }
  })

  // 若该变更关联了某次复盘报告中的 proposal，同步将 proposal.status 更新为 'undone'
  if (changeDoc.reflectionId && changeDoc.proposalId) {
    try {
      const refRes = await db.collection('reflectionReports').doc(changeDoc.reflectionId).get()
      const refDoc = refRes && refRes.data
      if (refDoc && Array.isArray(refDoc.proposals)) {
        const nextProposals = refDoc.proposals.map(p => (
          p && p.proposalId === changeDoc.proposalId ? { ...p, status: 'undone' } : p
        ))
        await db.collection('reflectionReports').doc(changeDoc.reflectionId).update({
          data: { proposals: nextProposals }
        })
      }
    } catch (_) {}
  }

  const nextSettings = await loadGlobalSettings()
  return {
    ok: true,
    knowledgeVersion: Number(nextSettings.knowledgeVersion) || 1
  }
}

module.exports = {
  applyProposal,
  undoKnowledgeChange
}
