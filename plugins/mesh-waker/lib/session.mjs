// Session/title/thread helpers (T-292): pure functions, no plugin state.

/**
 * Where the hub's own console lives, for the settings panel's "open console" link.
 * Display value only: it carries no token and the plugin never proxies admin calls.
 * null when this install has no hub configured.
 */
export function hubConsoleUrlFor(hubUrl) {
  const base = String(hubUrl ?? '').trim().replace(/\/+$/, '')
  return base ? `${base}/console` : null
}

export const SESSION_PAGE_DEFAULT = 80

export const SESSION_PAGE_MAX = 500

/**
 * Filter + page the local session list for GET /mesh/sessions.
 * `archived`: '1' only archived, '0' only active, anything else no filter.
 * `limit` is clamped to 1..SESSION_PAGE_MAX (default 80); `offset` to >= 0.
 * `q` is a case-insensitive title substring; `cwd` is an exact match.
 */
export function paginateSessions(sessions, query = {}) {
  const rawLimit = query.limit === undefined || query.limit === null || query.limit === '' ? NaN : Number(query.limit)
  const rawOffset = query.offset === undefined || query.offset === null || query.offset === '' ? NaN : Number(query.offset)
  const limit = Number.isFinite(rawLimit) ? Math.min(SESSION_PAGE_MAX, Math.max(1, Math.trunc(rawLimit))) : SESSION_PAGE_DEFAULT
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0
  let filtered = Array.isArray(sessions) ? sessions : []
  if (query.archived === '1' || query.archived === '0') {
    const want = query.archived === '1'
    filtered = filtered.filter((session) => session.archived === want)
  }
  const cwd = typeof query.cwd === 'string' && query.cwd.trim() ? query.cwd.trim() : ''
  if (cwd) filtered = filtered.filter((session) => session.cwd === cwd)
  const needle = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
  if (needle) filtered = filtered.filter((session) => String(session.title ?? '').toLowerCase().includes(needle))
  return { total: filtered.length, limit, offset, sessions: filtered.slice(offset, offset + limit) }
}

/**
 * Thread ids group follow-up dispatches. Trimmed; max 128 UTF-8 bytes; null when empty.
 * A malformed value throws instead of silently dropping the identity.
 */
export function normalizeThread(value) {
  const thread = String(value ?? '').trim()
  if (!thread) return null
  const bytes = new TextEncoder().encode(thread)
  if (bytes.length > 128) throw new Error('thread must be at most 128 UTF-8 bytes')
  if (/[\u0000-\u001f]/.test(thread)) throw new Error('thread must not contain control characters')
  return thread
}

/**
 * One machine-readable header line prepended to an injected prompt, so the receiving session
 * knows which task/batch it is running without guessing from prose. The body after the blank
 * line stays byte-for-byte unchanged.
 */
export function withTaskHeader(text, { taskId, batchId, requester, thread, now = new Date() } = {}) {
  const pad = (value) => String(value).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  const task = taskId || '-'
  const threadLabel = thread || '-'
  const batch = batchId || '-'
  const from = requester || 'unknown'
  return `[TASK ${task} · THREAD ${threadLabel} · BATCH ${batch} · FROM ${from}] ${stamp}\n\n${text}`
}

/**
 * One definition of "this session is a coordinator": the title must END with
 * `· 协调` / `· coordinator`, optionally followed by a sequence number (`协调 2`,
 * `协调-3`, `coordinator 2`). Text that merely mentions coordination in the body does
 * not match. Both the workspace registry and requester inference must use this (T-287).
 */
export function isCoordinatorTitle(title) {
  return /·\s*(协调|coordinator)(?:\s*[-_]?\s*\d+)?\s*$/i.test(String(title ?? ''))
}
