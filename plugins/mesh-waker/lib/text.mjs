// Pure text formatting helpers (T-292): extracted from index.js, no plugin state.

const TASK_SUBJECT_MAX = 120


const NON_ANSWER_PART_TYPES = new Set([
  'thinking',
  'reasoning',
  'analysis',
  'redacted_thinking',
  'tool_use',
  'tool_result',
  'tool-call',
  'tool-result',
])


export function truncateText(text, maxChars) {
  const chars = Array.from(String(text ?? ''))
  const limit = Math.max(0, Math.trunc(Number(maxChars) || 0))
  if (chars.length <= limit) return chars.join('')
  return chars.slice(0, limit).join('') + '…'
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a multi-byte character
 * (the same idea as the hub's truncateUtf8). Never emits U+FFFD.
 */
export function truncateUtf8(text, maxBytes) {
  const value = String(text ?? '')
  const bytes = new TextEncoder().encode(value)
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0))
  if (bytes.length <= limit) return value
  if (limit === 0) return ''
  // bytes[limit] is the first excluded byte; walk back over continuation bytes so the cut
  // lands on a character boundary.
  let end = limit
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end))
}

export function previewText(text, max = 80) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * The inline text of one message body: bodies above maxInlineBytes keep their head and get a
 * one-line note with the original byte count. Only the prompt text changes; the inbox keeps
 * the full message.
 */
export function inlineBodyText(body, maxBytes) {
  const value = String(body ?? '')
  const limit = Math.floor(Number(maxBytes) || 0)
  const total = new TextEncoder().encode(value).length
  if (!Number.isFinite(limit) || limit <= 0 || total <= limit) return value
  const kept = truncateUtf8(value, limit)
  return `${kept}\n…（正文已截断：原文 ${total} 字节，超过 maxInlineBytes=${limit}；完整内容请用 mesh_inbox 或 GET /api/inbox 读取）`
}

export function humanDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  const seconds = Math.round(total)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h${String(rest).padStart(2, '0')}m` : `${hours}h`
}

export function durationToMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const match = /^(\d+)(ms|s|m|h)$/i.exec(String(value).trim())
  if (!match) throw new Error(`deadline must look like 600s, 90m or 2h (got ${value})`)
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2].toLowerCase()]
}

/**
 * Readable task title from a dispatch body. Explicit `meta.subject` wins; otherwise the
 * first meaningful line is cleaned: prefer the emphasised segment (the human-written
 * title), drop wrappers like `任务（协调会话，…）：` / `【…】`, strip Markdown emphasis and
 * cut at a sentence end. Returns '' when nothing readable is left (the panel shows a
 * placeholder; the API stores no invented title).
 */
export function cleanTaskSubject(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
  const first = lines.find((line) => line.length > 0)
  if (!first) return ''
  const cleanLine = (line) => {
    let candidate = normalizeSubjectText(line)
      .replace(/^任务（[^）]{0,80}）\s*[:：]\s*/, '')
      .replace(/^任务\s*[:：]\s*/, '')
      .replace(/^【[^】]{0,80}】\s*/, '')
      .replace(/^\[[^\]]{0,80}\]\s*/, '')
    const sentenceEnd = candidate.search(/——|。/)
    if (sentenceEnd > 0) candidate = candidate.slice(0, sentenceEnd)
    const colon = candidate.search(/[:：]/)
    if (colon >= 8) candidate = candidate.slice(0, colon)
    candidate = candidate.trim()
    if (!candidate || /^[\s\p{P}\p{S}]+$/u.test(candidate)) return ''
    return candidate
  }
  // A real emphasis segment (not a one-word decorative marker) is the intended title.
  const boldMatch = first.match(/\*\*([^*]{2,})\*\*/)
  const boldTitle = boldMatch ? normalizeSubjectText(boldMatch[1]) : ''
  let candidate = ''
  if (boldTitle && Array.from(boldTitle).length >= 4 && !/^[\s\p{P}\p{S}]+$/u.test(boldTitle)) candidate = boldTitle
  if (!candidate) candidate = cleanLine(first)
  if (!candidate && boldTitle) candidate = boldTitle
  if (!candidate) {
    // First line was only markup/decoration: fall back to the next meaningful line.
    const rest = lines.filter((line) => line.length > 0).slice(1).join(' ')
    return rest ? cleanTaskSubject(rest) : ''
  }
  return Array.from(candidate).slice(0, TASK_SUBJECT_MAX).join('')
}

export function resolveTaskSubject(explicit, text) {
  const chosen = normalizeSubjectText(explicit)
  if (chosen) return Array.from(chosen).slice(0, TASK_SUBJECT_MAX).join('')
  return cleanTaskSubject(text)
}

/**
 * Plain text of one assistant message: string, {text}, or content/parts parts.
 * Only real answer text is collected: thinking/reasoning/analysis and tool blocks also carry
 * a `text` field, and treating them as the answer leaked internal reasoning into receipts
 * (T-260). No `type` but `text` is still kept for older providers; everything else is dropped.
 */
export function messageText(message) {
  if (!message) return ''
  if (typeof message === 'string') return message.trim()
  const messageType = typeof message.type === 'string' ? message.type : ''
  if (NON_ANSWER_PART_TYPES.has(messageType)) return ''
  if (typeof message.text === 'string') return message.text.trim()
  const parts = Array.isArray(message.content) ? message.content : Array.isArray(message.parts) ? message.parts : []
  return parts
    .filter((part) => {
      if (!part) return false
      const partType = typeof part.type === 'string' ? part.type : ''
      if (NON_ANSWER_PART_TYPES.has(partType)) return false
      if (partType === 'text') return true
      return partType === '' && typeof part.text === 'string'
    })
    .map((part) => String(part.text ?? ''))
    .join('\n')
    .trim()
}


function normalizeSubjectText(value) {
  return String(value ?? '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
