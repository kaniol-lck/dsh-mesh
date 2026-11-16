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
 * @param row     task row (needs notifiedAt; settledAt or an explicit claimDismissedAt end
 *                the watch — an ack does NOT, see below)
 * @param opts.now       clock
 * @param opts.windowMs  digestClaimWarnMs
 * @param opts.warnedAt  when the advisory was sent (0/undefined = not yet)
 * @param opts.stalledAt when the row was marked stalled (0/undefined = not yet)
 */
export function claimState(row, { now = Date.now(), windowMs = 1_800_000, warnedAt = 0, stalledAt = 0 } = {}) {
  if (!row || typeof row !== 'object') return CLAIM_OK
  // T-485: an ack is "I saw it", not "it is done". The worker is REQUIRED to ack first, so
  // treating ackedAt as a resolution silenced the watchdog for exactly the window it exists
  // to watch (announced -> declared). Only a declaration (settledAt) or an explicit
  // dismissal by the requesting side ends the watch.
  if (row.settledAt || row.claimDismissedAt) return CLAIM_OK
  const notifiedAt = Number(row.notifiedAt) || 0
  if (!notifiedAt) return CLAIM_OK
  const waited = now - notifiedAt
  if (waited < windowMs) return CLAIM_OK
  if (!warnedAt) return CLAIM_WARN
  if (!stalledAt && waited >= windowMs * 2) return CLAIM_STALL
  return CLAIM_OK
}
