/**
 * Unread watchdog (T-486). Pure classification so the policy is testable without a hub.
 *
 * Why: a wake can be suppressed for several reasons (busy, cooldown, throttle cap) and, before
 * this, a suppressed wake left the message unread forever with nothing recording it. The
 * question this answers is the one nobody could answer: "is there mail sitting in the inbox
 * that no session was ever woken for?"
 *
 * It looks at messages only — `created_at` and `read_at` — never at titles or session names.
 */

/** Defaults: warn when unread mail is older than this. */
export const DEFAULT_UNREAD_OVERDUE_MS = 30 * 60 * 1000

/**
 * @param messages inbox rows (`{ id, created_at, read_at, conversation?, subject? }`)
 * @param opts.now          clock
 * @param opts.thresholdMs  how old an unread message must be to count as overdue
 * @returns {{ overdue: Array, count: number, oldestAgeMs: number|null }}
 */
export function classifyOverdue(messages, { now = Date.now(), thresholdMs = DEFAULT_UNREAD_OVERDUE_MS } = {}) {
  const overdue = []
  let oldestAgeMs = null
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    if (message.read_at) continue
    const createdAt = Number(message.created_at)
    if (!Number.isFinite(createdAt) || createdAt <= 0) continue
    const ageMs = now - createdAt
    if (ageMs < thresholdMs) continue
    overdue.push({
      id: message.id ?? null,
      conversation: message.conversation ?? null,
      subject: message.subject ?? null,
      ageMs,
    })
    if (oldestAgeMs === null || ageMs > oldestAgeMs) oldestAgeMs = ageMs
  }
  // Oldest first: the worst case is what the operator needs to see.
  overdue.sort((a, b) => b.ageMs - a.ageMs)
  return { overdue, count: overdue.length, oldestAgeMs }
}

/** One-line summary for logs; never throws. */
export function describeOverdue(result) {
  if (!result || !result.count) return 'none'
  const minutes = Math.round((result.oldestAgeMs ?? 0) / 60000)
  return `${result.count} unread (oldest ${minutes}m)`
}
