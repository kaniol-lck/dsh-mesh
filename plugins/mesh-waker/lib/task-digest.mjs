/**
 * Task digest (T-459): when `digestDelivery: 'on'`, a dispatch does not inject the task body.
 * Instead the task waits on the board, and after a turn ends the plugin injects one short
 * digest listing the unacked task ids. Signing (ack) is a *board* marker — it never completes
 * a task and never produces a receipt.
 */

export const DIGEST_MAX_NOTIFY = 2
/** Backoff before the *next* digest: after the 1st = 10 min, after the 2nd = 30 min. */
export const DIGEST_BACKOFF_MS = [10 * 60 * 1000, 30 * 60 * 1000]

const SUBJECT_MAX_CHARS = 80

export function digestBackoffMs(notifyCount) {
  const count = Number(notifyCount) || 0
  if (count <= 0) return 0
  return DIGEST_BACKOFF_MS[Math.min(count, DIGEST_BACKOFF_MS.length) - 1]
}

/** True when this row is a digest candidate for the given session and moment. */
export function isDigestCandidate(row, { sessionId, now = Date.now() } = {}) {
  if (!row || typeof row !== 'object') return false
  if (!sessionId || row.targetSessionId !== sessionId) return false
  if (row.settledAt) return false
  if (String(row.status ?? '') !== 'pending') return false
  // T-460: only queue deliveries are digested; a steer task is injected immediately and must
  // never be listed again (rows written before the field existed default to queue).
  if (row.mode && String(row.mode) !== 'queue') return false
  if (row.ackedAt) return false
  const count = Number(row.notifyCount) || 0
  if (count >= DIGEST_MAX_NOTIFY) return false
  const lastNotified = Number(row.notifiedAt) || 0
  return now - lastNotified >= digestBackoffMs(count)
}

export function digestCandidates(rows, { sessionId, now = Date.now(), limit = 20 } = {}) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => isDigestCandidate(row, { sessionId, now }))
    .sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0))
    .slice(0, limit)
}

function oneLine(value, max = SUBJECT_MAX_CHARS) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return '(无标题)'
  return Array.from(text).slice(0, max).join('')
}

/** The exact injected text; the ids are what `mesh_ack({ids})` expects. */
export function buildDigestText(rows) {
  const list = Array.isArray(rows) ? rows : []
  const lines = list.map((row) => `- ${row.taskId} ${oneLine(row.subject ?? row.taskId)}`)
  return [
    `[TASK-DIGEST] ${list.length} 条待办（未签收）`,
    ...lines,
    "取正文并签收：mesh_tasks({include:'text'}) → mesh_ack({ids:[...]})",
  ].join('\n')
}
