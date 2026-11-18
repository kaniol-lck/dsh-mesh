// Config values and small pure helpers (T-292): no plugin state.

export const LOG_MAX_BYTES_DEFAULT = 2 * 1024 * 1024

export function normalizeSha(value) {
  return String(value ?? '')
    .replace(/[\s:]/g, '')
    .toLowerCase()
}

export function clampInterval(value, fallback, min, max) {
  // T-mwxcog4: the two unread-watchdog keys called this with three arguments, so `max` was
  // undefined and every clamp returned NaN. The watchdog never registered, the threshold
  // test was `age > NaN` (always false), and nothing anywhere said a word. A mis-wired
  // clamp is a programming error, so it fails at the call site instead of degrading quietly.
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new TypeError(`clampInterval(value, fallback, min, max) needs a finite min/max (got min=${min}, max=${max})`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * Same clamp, but 0 is a legitimate value instead of "unset" (T-mwxcog4): the unread
 * watchdog documents `0` as "disabled", which clampInterval cannot express because it maps
 * anything <= 0 to the fallback. Missing or unparseable input still falls back, so a typo
 * cannot silently switch the watchdog off.
 */
export function clampDuration(value, fallback, min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new TypeError(`clampDuration(value, fallback, min, max) needs a finite min/max (got min=${min}, max=${max})`)
  }
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * The unread-watchdog pair, resolved together so the wiring is testable without booting
 * the plugin. `watchdogMs` says how often to reconcile, `overdueMs` how old unread mail
 * must be before it counts as "nobody was woken for this".
 */
export function resolveUnreadWatchdog(config = {}) {
  return {
    unreadWatchdogMs: clampDuration(config?.unreadWatchdogMs, 300_000, 0, 3_600_000),
    unreadOverdueMs: clampDuration(config?.unreadOverdueMs, 1_800_000, 60_000, 86_400_000),
  }
}

/**
 * Next pull delay (contract section 4, items 4 and 5). Pure so tests can pin the
 * transitions: mail moved -> busy cadence, three empty polls -> idle cadence, otherwise
 * the normal cadence; consecutive failures back off 5s * 2^(n-1), capped at 5 minutes.
 */
