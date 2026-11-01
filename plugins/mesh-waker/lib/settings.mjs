// Config values and small pure helpers (T-292): no plugin state.

export const LOG_MAX_BYTES_DEFAULT = 2 * 1024 * 1024

export function normalizeSha(value) {
  return String(value ?? '')
    .replace(/[\s:]/g, '')
    .toLowerCase()
}

export function clampInterval(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * Next pull delay (contract section 4, items 4 and 5). Pure so tests can pin the
 * transitions: mail moved -> busy cadence, three empty polls -> idle cadence, otherwise
 * the normal cadence; consecutive failures back off 5s * 2^(n-1), capped at 5 minutes.
 */
