/**
 * Claim state of a digest task (T-mwgtchp6).
 *
 * A declaredOnly task is announced by a digest and only closed by `mesh_complete`, so
 * "announced, never declared" has no natural alarm: no turn/end settlement, no stall watchdog.
 * This pure helper decides what the watchdog should do, so the policy is testable without
 * waiting for real 30-minute windows.
 */

export const CLAIM_OK = 'ok'
export const CLAIM_WARN = 'warn'
export const CLAIM_STALL = 'stall'

/**
 * @param row     task row (needs notifiedAt; settledAt/ackedAt end the watch)
 * @param opts.now       clock
 * @param opts.windowMs  digestClaimWarnMs
 * @param opts.warnedAt  when the advisory was sent (0/undefined = not yet)
 * @param opts.stalledAt when the row was marked stalled (0/undefined = not yet)
 */
export function claimState(row, { now = Date.now(), windowMs = 1_800_000, warnedAt = 0, stalledAt = 0 } = {}) {
  if (!row || typeof row !== 'object') return CLAIM_OK
  if (row.settledAt || row.ackedAt) return CLAIM_OK
  const notifiedAt = Number(row.notifiedAt) || 0
  if (!notifiedAt) return CLAIM_OK
  const waited = now - notifiedAt
  if (waited < windowMs) return CLAIM_OK
  if (!warnedAt) return CLAIM_WARN
  if (!stalledAt && waited >= windowMs * 2) return CLAIM_STALL
  return CLAIM_OK
}
