/**
 * Receipt digest (T-467): with `receiptDigest: 'on'` a queue-mode receipt is no longer injected
 * one by one. The receipt row is still written to receipts.jsonl unchanged; the task row is
 * marked as "receipt waiting for review" (receiptDigestSessionId) and the requester gets one
 * merged notice — idle after the debounce, or after its next turn/end.
 *
 * Ack (`mesh_ack`) writes the same board marker (ackedAt) the task digest uses, so one call
 * silences both; ack never produces a new receipt and never completes anything.
 */

export const RECEIPT_DIGEST_MAX_NOTIFY = 2
/** Backoff before the *next* reminder: after the 1st = 10 min, after the 2nd = 30 min. */
export const RECEIPT_DIGEST_BACKOFF_MS = [10 * 60 * 1000, 30 * 60 * 1000]

export function receiptBackoffMs(notifyCount) {
  const count = Number(notifyCount) || 0
  if (count <= 0) return 0
  return RECEIPT_DIGEST_BACKOFF_MS[Math.min(count, RECEIPT_DIGEST_BACKOFF_MS.length) - 1]
}

export function isReceiptDigestCandidate(row, { sessionId, now = Date.now() } = {}) {
  if (!row || typeof row !== 'object') return false
  if (!sessionId || row.receiptDigestSessionId !== sessionId) return false
  if (!row.settledAt) return false
  if (row.ackedAt) return false
  const count = Number(row.receiptNotifyCount) || 0
  if (count >= RECEIPT_DIGEST_MAX_NOTIFY) return false
  return now - Number(row.receiptNotifiedAt || 0) >= receiptBackoffMs(count)
}

export function receiptDigestCandidates(rows, { sessionId, now = Date.now(), limit = 20 } = {}) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => isReceiptDigestCandidate(row, { sessionId, now }))
    .sort((left, right) => Number(left.settledAt ?? 0) - Number(right.settledAt ?? 0))
    .slice(0, limit)
}

function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '-'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${Math.round(value / 1000)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}

/** The exact merged notice; the ids are what `mesh_ack({ids})` expects. */
export function buildReceiptDigestText(rows) {
  const list = Array.isArray(rows) ? rows : []
  const lines = list.map(
    (row) => `- ${row.taskId} ${row.receiptStatus ?? row.reasonKind ?? row.status ?? 'settled'}（${row.requester ?? '—'}）${formatDuration(row.durationMs)}`,
  )
  return [
    `[RECEIPT-DIGEST] ${list.length} 条任务已完成（未签收）`,
    ...lines,
    "明细/正文：mesh_tasks({status:'unacked'}) → 看完用 mesh_ack({ids:[...]})",
  ].join('\n')
}
