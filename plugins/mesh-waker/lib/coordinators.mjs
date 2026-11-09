/**
 * Multi-coordinator claim protocol (T-395 / B1).
 *
 * Owner 2026-11-10: explicit claim only, several coordinators may be online at once (bounded),
 * and a claim needs approval (an already-approved coordinator, or the owner token). The old
 * single `coordinator` field stays as "who is primary" for legacy tools; the truth is the
 * `coordinators[]` array here.
 */

export const COORDINATOR_STATUSES = new Set(['pending', 'approved', 'stale'])

export function isOwnerTokenValid(configTokenFile, provided, readFile) {
  if (!provided) return false
  const file = String(configTokenFile ?? '').trim()
  if (!file) return false
  let raw = ''
  try {
    raw = String(readFile(file, 'utf8')).trim()
  } catch {
    return false
  }
  if (!raw) return false
  let expected = raw
  try {
    const parsed = JSON.parse(raw)
    expected = String(parsed?.token ?? parsed?.ownerToken ?? raw).trim()
  } catch {
    expected = raw
  }
  return Boolean(expected) && String(provided) === expected
}

/** Normalize whatever the registry file holds into a clean array. */
export function normalizeCoordinators(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const sessionId = String(item.sessionId ?? '').trim()
    if (!sessionId) continue
    out.push({
      sessionId,
      ...(item.channel ? { channel: String(item.channel).slice(0, 40) } : {}),
      isPrimary: item.isPrimary === true,
      status: COORDINATOR_STATUSES.has(item.status) ? item.status : 'pending',
      claimedAt: Number.isFinite(Number(item.claimedAt)) ? Number(item.claimedAt) : null,
      leaseUntil: Number.isFinite(Number(item.leaseUntil)) ? Number(item.leaseUntil) : null,
      ...(item.approvedBy ? { approvedBy: String(item.approvedBy).slice(0, 80) } : {}),
      requestedAt: Number.isFinite(Number(item.requestedAt)) ? Number(item.requestedAt) : null,
    })
  }
  return out
}

/**
 * Expire the array in place: pending older than the TTL is dropped, an expired lease makes an
 * approved member stale (it can be claimed again). Returns true when anything changed.
 */
export function expireCoordinators(coordinators, { now, pendingTtlMs }) {
  let changed = false
  for (let index = coordinators.length - 1; index >= 0; index -= 1) {
    const member = coordinators[index]
    if (member.status === 'pending') {
      const age = now - Number(member.requestedAt ?? 0)
      if (Number.isFinite(age) && age > pendingTtlMs) {
        coordinators.splice(index, 1)
        changed = true
      }
      continue
    }
    if (member.status === 'approved' && Number.isFinite(member.leaseUntil) && member.leaseUntil < now) {
      member.status = 'stale'
      member.isPrimary = false
      changed = true
    }
  }
  if (coordinators.some((member) => member.status === 'stale')) {
    // Stale entries are kept for one cycle so callers can see why the primary changed.
    const before = coordinators.length
    for (let index = coordinators.length - 1; index >= 0; index -= 1) {
      if (coordinators[index].status === 'stale') coordinators.splice(index, 1)
    }
    if (coordinators.length !== before) changed = true
  }
  return changed
}

/** The approved member that currently leads: earliest claimedAt wins. */
export function primaryOf(coordinators) {
  const approved = coordinators.filter((member) => member.status === 'approved')
  if (!approved.length) return null
  return approved.reduce((best, member) => {
    const bestAt = Number(best.claimedAt ?? Number.MAX_SAFE_INTEGER)
    const at = Number(member.claimedAt ?? Number.MAX_SAFE_INTEGER)
    return at < bestAt ? member : best
  })
}

/**
 * Recompute isPrimary flags and keep the legacy `coordinator` field equal to the primary
 * sessionId. Returns { primary, changedLegacyCoordinator }.
 */
export function syncPrimary(entry) {
  const coordinators = entry.coordinators ?? []
  const primary = primaryOf(coordinators)
  let changedLegacy = false
  for (const member of coordinators) {
    const next = primary ? member.sessionId === primary.sessionId : false
    if (member.isPrimary !== next) member.isPrimary = next
  }
  const nextCoordinator = primary ? primary.sessionId : null
  if (nextCoordinator) {
    if (entry.coordinator !== nextCoordinator) {
      entry.coordinator = nextCoordinator
      changedLegacy = true
    }
  } else if (entry.coordinator !== undefined) {
    delete entry.coordinator
    changedLegacy = true
  }
  return { primary, changedLegacyCoordinator: changedLegacy }
}

/** Public shape for HTTP responses: no internal bookkeeping beyond these fields. */
export function coordinatorsView(coordinators) {
  return (coordinators ?? []).map((member) => ({
    sessionId: member.sessionId,
    status: member.status,
    isPrimary: member.isPrimary === true,
    ...(member.channel ? { channel: member.channel } : {}),
    claimedAt: member.claimedAt,
    leaseUntil: member.leaseUntil,
    ...(member.approvedBy ? { approvedBy: member.approvedBy } : {}),
    requestedAt: member.requestedAt,
  }))
}

export function recordAudit(fileLog, action, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
  fileLog(`coordinator audit: ${action}${parts.length ? ` ${parts.join(' ')}` : ''}`)
}
