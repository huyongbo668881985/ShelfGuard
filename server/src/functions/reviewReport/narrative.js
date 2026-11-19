'use strict'

// ============================================================
// 人工校正后纯文本报告重写（summary / competitiveInsight / issues / suggestions）
// - 绝不传入图片、绝不改动任何已算好的分数与排面数
// - 若未配 API Key 或调用失败，保留 facts.js 已生成的确定性文案并置 narrativeStatus = 'fallback'
// ============================================================

const cloud = require('../../cloud-shim')
const {
  CORRECTION_NARRATIVE_SYSTEM_PROMPT,
  buildCorrectionNarrativeUserPrompt
} = require('../analyzeImage/prompt')
const { _internal: analyzeInternal } = require('../analyzeImage/index')

const db = cloud.database()

function parseNarrativeJson(text) {
  let jsonStr = String(text || '').trim()
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) jsonStr = jsonMatch[1].trim()
  if (!jsonStr.startsWith('{') || !jsonStr.endsWith('}')) {
    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start !== -1 && end > start) {
      jsonStr = jsonStr.slice(start, end + 1)
    }
  }
  return JSON.parse(jsonStr)
}

async function regenerateCorrectedNarrative(inspectionId, expectedRevision = null) {
  if (!inspectionId) return { ok: false, error: 'missing_inspectionId' }

  let doc
  try {
    const res = await db.collection('inspections').doc(inspectionId).get()
    doc = res && res.data
  } catch (err) {
    return { ok: false, error: err.message || 'doc_not_found' }
  }
  if (!doc || !doc.aiReport) {
    return { ok: false, error: 'report_not_found' }
  }
  if (expectedRevision !== null && doc.reviewRevision !== expectedRevision) {
    return { ok: false, skipped: true, reason: 'revision_superseded' }
  }

  let settingsDoc = null
  try {
    const sRes = await db.collection('settings').doc('global').get()
    settingsDoc = (sRes && sRes.data) || null
  } catch (_) {}

  const config = analyzeInternal.resolveRuntimeAIConfig(settingsDoc)
  const apiKey = await analyzeInternal.resolveApiKey(config, settingsDoc)

  if (!apiKey) {
    await db.collection('inspections').doc(inspectionId).update({
      data: { narrativeStatus: 'fallback' }
    }).catch(() => {})
    return { ok: true, mode: 'fallback', reason: 'no_api_key' }
  }

  try {
    const userPrompt = buildCorrectionNarrativeUserPrompt(doc.aiReport, doc.storeName || '')
    const { text } = await analyzeInternal.withHardTimeout(
      analyzeInternal.callQwen(config, apiKey, [], userPrompt, CORRECTION_NARRATIVE_SYSTEM_PROMPT, {
        enableThinking: false,
        thinkingBudget: 0,
        maxTokens: 1536
      }),
      35 * 1000,
      '校正报告文字重写超时'
    )

    const parsed = parseNarrativeJson(text)

    // 再次读取最新文档，确认在等待 AI 返回期间管理员未做新一轮修改
    const latestRes = await db.collection('inspections').doc(inspectionId).get()
    const latestDoc = latestRes && latestRes.data
    if (!latestDoc || !latestDoc.aiReport) {
      return { ok: false, error: 'latest_doc_missing' }
    }
    if (expectedRevision !== null && latestDoc.reviewRevision !== expectedRevision) {
      return { ok: false, skipped: true, reason: 'revision_superseded' }
    }

    const updatedReport = { ...latestDoc.aiReport }
    if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) {
      updatedReport.summary = parsed.summary.trim()
    }
    if (parsed && typeof parsed.competitiveInsight === 'string' && parsed.competitiveInsight.trim()) {
      updatedReport.competitiveAnalysis = {
        ...(updatedReport.competitiveAnalysis || {}),
        insight: parsed.competitiveInsight.trim()
      }
    }
    if (parsed && Array.isArray(parsed.issues) && parsed.issues.length > 0) {
      updatedReport.issues = parsed.issues
        .filter(i => i && (i.description || i.category))
        .map(i => ({
          severity: ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'medium',
          category: String(i.category || '陈列规范').trim(),
          description: String(i.description || '').trim(),
          impact: String(i.impact || '').trim()
        }))
    }
    if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
      updatedReport.suggestions = parsed.suggestions
        .filter(s => s && s.action)
        .map(s => ({
          priority: ['high', 'medium', 'low'].includes(s.priority) ? s.priority : 'medium',
          action: String(s.action || '').trim(),
          expectedEffect: String(s.expectedEffect || '').trim(),
          deadline: String(s.deadline || '当日').trim()
        }))
    }

    await db.collection('inspections').doc(inspectionId).update({
      data: {
        aiReport: updatedReport,
        narrativeStatus: 'done'
      }
    })
    return { ok: true, mode: 'ai', report: updatedReport }
  } catch (err) {
    console.warn(`[reviewReport/narrative] AI 文字重写失败(${inspectionId})，保留确定性兜底文案:`, err.message || err)
    await db.collection('inspections').doc(inspectionId).update({
      data: { narrativeStatus: 'fallback' }
    }).catch(() => {})
    return { ok: true, mode: 'fallback', error: err.message }
  }
}

module.exports = {
  regenerateCorrectedNarrative,
  parseNarrativeJson
}
