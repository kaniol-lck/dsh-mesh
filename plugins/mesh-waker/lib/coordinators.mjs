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
  const timeOrNull = (input) => {
    // `null` must stay null (a legacy member never expires); Number(null) is 0 and would look
    // like an ancient lease that claims the member is stale (T-398).
    if (input === null || input === undefined || input === '') return null
    return Number.isFinite(Number(input)) ? Number(input) : null
  }
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const sessionId = String(item.sessionId ?? '').trim()
    if (!sessionId) continue
    out.push({
      sessionId,
      ...(item.channel ? { channel: String(item.channel).slice(0, 40) } : {}),
      isPrimary: item.isPrimary === true,
      status: COORDINATOR_STATUSES.has(item.status) ? item.status : 'pending',
      claimedAt: timeOrNull(item.claimedAt),
      // T-mwmcgl07: `permanent` used to be consumed at claim time and then forgotten, so the
      // first approve after a rotation (which is the normal rotation order) put a finite
      // lease back on a member that was claimed as permanent. It is a property of the
      // member, so it has to survive a round-trip through the registry file.
      permanent: item.permanent === true,
      leaseUntil: timeOrNull(item.leaseUntil),
      ...(item.approvedBy ? { approvedBy: String(item.approvedBy).slice(0, 80) } : {}),
      requestedAt: timeOrNull(item.requestedAt),
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
 * Who legitimately receives a receipt for this workspace entry (T-mwwdyc7i)?
 *
 * Identity comes from the registry, never from a session title. A member qualifies only when it
 * is approved AND still holds a live claim: `permanent`, or a lease that has not expired. The
 * title-based inference this replaces woke a long-dead session (`session-7fa21aa4`, title
 * `mesh · 协调`) on every unattributed receipt — the exact failure `.worklog/WORKLOG.md:594`
 * recorded for `coord-scope` on 2026-11-19, four days before it recurred here.
 *
 * Returns one of:
 *   { kind: 'one',    sessionId, why }   — exactly one live primary claim
 *   { kind: 'ambiguous', candidates }    — several live primary claims, or several live claims
 *                                          with no primary: never guess
 *   { kind: 'none',   why }              — no live claim at all
 */
export function liveRequesterOf(entry, { now = Date.now() } = {}) {
  const members = Array.isArray(entry?.coordinators) ? entry.coordinators : []
  const live = members.filter(
    (member) =>
      member &&
      member.sessionId &&
      member.status === 'approved' &&
      (member.permanent === true || !Number.isFinite(member.leaseUntil) || member.leaseUntil > now),
  )
  if (!live.length) {
    // A legacy entry (only the scalar `coordinator`) is still a real registration, but it
    // carries no lease: it is only trusted when nothing else contradicts it, which the caller
    // decides by reading the session record.
    const legacy = typeof entry?.coordinator === 'string' && entry.coordinator ? entry.coordinator : null
    return legacy ? { kind: 'one', sessionId: legacy, why: 'legacy-scalar' } : { kind: 'none', why: 'no-claim' }
  }
  const primaries = live.filter((member) => member.isPrimary === true)
  if (primaries.length === 1) return { kind: 'one', sessionId: primaries[0].sessionId, why: 'primary' }
  if (primaries.length > 1) {
    return { kind: 'ambiguous', candidates: primaries.map((member) => member.sessionId), why: 'multiple-primaries' }
  }
  if (live.length === 1) return { kind: 'one', sessionId: live[0].sessionId, why: 'sole-approved' }
  return { kind: 'ambiguous', candidates: live.map((member) => member.sessionId), why: 'no-primary' }
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
    permanent: member.permanent === true,
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
