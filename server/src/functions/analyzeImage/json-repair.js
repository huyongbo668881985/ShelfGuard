'use strict'

/**
 * 从 AI 原始文本中提取 JSON 候选串（剥离 markdown 代码块与首尾解释文字）。
 */
function extractJsonCandidate(responseText) {
  let jsonStr = String(responseText || '').trim()
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim()
  }
  if (!jsonStr.startsWith('{') || !jsonStr.endsWith('}')) {
    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start !== -1 && end > start) {
      jsonStr = jsonStr.slice(start, end + 1)
    }
  }
  return jsonStr
}

function skipWs(str, pos) {
  let i = pos
  while (i < str.length && /\s/.test(str[i])) i += 1
  return i
}

/**
 * 判断 str[pos] 处是否像一个 JSON 对象键（"key": ...），用于区分真实逗号分隔与文本内逗号。
 */
function looksLikeObjectKeyAt(str, pos) {
  if (str[pos] !== '"') return false
  let i = pos + 1
  const maxScan = Math.min(str.length, pos + 120)
  while (i < maxScan) {
    const ch = str[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '\n' || ch === '\r') return false
    if (ch === '"') {
      const after = skipWs(str, i + 1)
      return str[after] === ':'
    }
    i += 1
  }
  return false
}

function isValidArrayNextChar(ch) {
  if (!ch) return false
  return ch === ']' || ch === '"' || ch === '{' || ch === '[' ||
    ch === '-' || (ch >= '0' && ch <= '9') ||
    ch === 't' || ch === 'f' || ch === 'n'
}

/**
 * 轻量修复 LLM 输出 JSON 中常见非截断语法问题：
 * 1. 字符串内部未转义的英文双引号（如 "发现"+2元换购"横签"）
 * 2. 字符串内部未转义的换行/制表/控制字符
 * 3. 对象或数组末尾多余的尾逗号
 *
 * 注意：绝不自动补全截断的括号/引号，确保真正截断的输出仍交由调用方触发 truncated_json 重试。
 */
function repairJsonString(jsonStr) {
  const str = String(jsonStr || '')
  const out = []
  const stack = []
  let i = 0

  function markValueDone() {
    const top = stack[stack.length - 1]
    if (top && (top.expect === 'value' || top.expect === 'valueOrEnd')) {
      top.expect = 'commaOrEnd'
    }
  }

  function stripTrailingComma() {
    let k = out.length - 1
    while (k >= 0 && /\s/.test(out[k])) k -= 1
    if (k >= 0 && out[k] === ',') {
      out.splice(k, 1)
    }
  }

  while (i < str.length) {
    const ch = str[i]
    const top = stack[stack.length - 1]

    if (/\s/.test(ch)) {
      out.push(ch)
      i += 1
      continue
    }

    if (ch === '{') {
      out.push(ch)
      stack.push({ type: 'object', expect: 'key' })
      i += 1
      continue
    }

    if (ch === '[') {
      out.push(ch)
      stack.push({ type: 'array', expect: 'valueOrEnd' })
      i += 1
      continue
    }

    if (ch === '}' || ch === ']') {
      stripTrailingComma()
      out.push(ch)
      stack.pop()
      markValueDone()
      i += 1
      continue
    }

    if (ch === ':') {
      out.push(ch)
      if (top && top.type === 'object' && top.expect === 'colon') {
        top.expect = 'value'
      }
      i += 1
      continue
    }

    if (ch === ',') {
      out.push(ch)
      if (top && top.type === 'object') top.expect = 'key'
      else if (top && top.type === 'array') top.expect = 'valueOrEnd'
      i += 1
      continue
    }

    if (ch === '"') {
      const isKey = Boolean(top && top.type === 'object' && top.expect === 'key')
      out.push('"')
      i += 1
      let closed = false

      while (i < str.length) {
        const sc = str[i]
        if (sc === '\\') {
          const next = str[i + 1]
          if (next === undefined) {
            out.push('\\\\')
            i += 1
            break
          }
          if ('"\\/bfnrtu'.includes(next)) {
            out.push('\\', next)
          } else {
            out.push('\\\\', next)
          }
          i += 2
          continue
        }
        if (sc === '\n') {
          out.push('\\n')
          i += 1
          continue
        }
        if (sc === '\r') {
          out.push('\\r')
          i += 1
          continue
        }
        if (sc === '\t') {
          out.push('\\t')
          i += 1
          continue
        }
        if (sc.charCodeAt(0) < 0x20) {
          i += 1
          continue
        }
        if (sc === '"') {
          const j = skipWs(str, i + 1)
          const nextCh = j < str.length ? str[j] : ''
          let isClosing = false

          if (isKey) {
            isClosing = nextCh === ':'
          } else if (!top) {
            isClosing = j >= str.length
          } else if (top.type === 'object') {
            if (nextCh === '}') {
              isClosing = true
            } else if (nextCh === ',') {
              const k = skipWs(str, j + 1)
              const afterComma = k < str.length ? str[k] : ''
              isClosing = afterComma === '}' || looksLikeObjectKeyAt(str, k)
            }
          } else if (top.type === 'array') {
            if (nextCh === ']') {
              isClosing = true
            } else if (nextCh === ',') {
              const k = skipWs(str, j + 1)
              const afterComma = k < str.length ? str[k] : ''
              isClosing = isValidArrayNextChar(afterComma)
            }
          }

          if (isClosing) {
            out.push('"')
            i += 1
            closed = true
            if (isKey && top) top.expect = 'colon'
            else markValueDone()
            break
          }

          // 字符串内部的未转义英文双引号
          out.push('\\"')
          i += 1
          continue
        }

        out.push(sc)
        i += 1
      }

      if (!closed) {
        // 未闭合字符串（截断情况），保持原样让 JSON.parse 失败
        break
      }
      continue
    }

    // 非字符串 token（数字 / true / false / null）
    out.push(ch)
    if (top && (top.expect === 'value' || top.expect === 'valueOrEnd')) {
      let end = i + 1
      while (end < str.length && !/[\s,}\]]/.test(str[end])) {
        out.push(str[end])
        end += 1
      }
      top.expect = 'commaOrEnd'
      i = end
      continue
    }
    i += 1
  }

  return out.join('')
}

/**
 * 解析 AI 返回的 JSON 文本：先直接 JSON.parse，失败时尝试本地轻量修复再解析。
 * 返回 { value, repaired }；若仍无法解析则抛出 SyntaxError。
 */
function parseJsonWithRepair(responseText) {
  const jsonStr = extractJsonCandidate(responseText)
  try {
    return { value: JSON.parse(jsonStr), repaired: false }
  } catch (origErr) {
    const repairedStr = repairJsonString(jsonStr)
    if (repairedStr && repairedStr !== jsonStr) {
      try {
        return { value: JSON.parse(repairedStr), repaired: true }
      } catch (_) {
        // 保留原始异常，避免掩盖真实语法位置
      }
    }
    throw origErr
  }
}

module.exports = {
  extractJsonCandidate,
  repairJsonString,
  parseJsonWithRepair
}
