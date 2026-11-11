/**
 * Advisory workspace locks (T-418).
 *
 * A lock serialises tasks that change the same git worktree: a dispatcher takes the workspace
 * lock, and other dispatches to that workspace queue instead of racing. It is advisory by
 * design — reads are never blocked — and it lives only in memory: a lock is a courtesy between
 * live sessions, and a crashed/restarted process must not leave a stale one behind.
 */

const MIN_TTL_MS = 10_000
const MAX_TTL_MS = 3_600_000

function clampedTtl(value, fallback) {
  const ttl = Number(value ?? fallback)
  if (!Number.isFinite(ttl) || ttl <= 0) return fallback
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(ttl)))
}

export function createWorkspaceLocks({ config, fileLog, resolveWorkspace, now = Date.now } = {}) {
  const locks = new Map()

  const log = (message) => {
    try {
      fileLog?.(message)
    } catch {
      // logging must never break locking
    }
  }

  const resolve = (workspace) => {
    const result = resolveWorkspace?.(workspace) ?? { ok: false, candidates: [] }
    if (!result?.ok) {
      const error = new Error(
        `unknown workspace ${JSON.stringify(String(workspace ?? ''))}; known workspaces: ${(result?.candidates ?? []).join(', ') || '(none registered)'}`,
      )
      error.httpStatus = 404
      throw error
    }
    return result.workspace
  }

  const expired = (lock) => Boolean(lock) && Number(lock.expiresAt) <= now()

  const dropExpired = () => {
    const removed = []
    for (const [workspace, lock] of [...locks]) {
      if (!expired(lock)) continue
      locks.delete(workspace)
      removed.push(lock)
      log(`workspace lock expired workspace=${workspace} owner=${lock.ownerSessionId} acquiredAt=${new Date(lock.acquiredAt).toISOString()}`)
    }
    return removed
  }

  const lockOf = (workspace) => {
    dropExpired()
    return locks.get(workspace) ?? null
  }

  function acquire({ workspace, ownerSessionId, ownerLabel = null, reason = null, ttlMs } = {}) {
    const slug = resolve(workspace)
    const holder = lockOf(slug)
    if (holder && holder.ownerSessionId !== ownerSessionId) {
      const error = new Error(
        `workspace ${slug} is locked by ${holder.ownerSessionId}${holder.ownerLabel ? ` (${holder.ownerLabel})` : ''} until ${new Date(holder.expiresAt).toISOString()}`,
      )
      error.httpStatus = 409
      error.holder = holder
      throw error
    }
    const ttl = clampedTtl(ttlMs, config?.workspaceLockTtlMs ?? 600_000)
    const at = now()
    if (holder) {
      // Same owner: renewal keeps the original acquisition time for observability.
      holder.expiresAt = at + ttl
      if (reason !== null) holder.reason = reason
      if (ownerLabel !== null) holder.ownerLabel = ownerLabel
      log(`workspace lock renewed workspace=${slug} owner=${ownerSessionId} expiresAt=${new Date(holder.expiresAt).toISOString()}`)
      return { lock: { ...holder }, renewed: true }
    }
    const lock = {
      workspace: slug,
      ownerSessionId,
      ownerLabel,
      reason,
      acquiredAt: at,
      expiresAt: at + ttl,
    }
    locks.set(slug, lock)
    log(`workspace lock acquired workspace=${slug} owner=${ownerSessionId} ttlMs=${ttl} expiresAt=${new Date(lock.expiresAt).toISOString()}${reason ? ` reason=${reason}` : ''}`)
    return { lock: { ...lock }, renewed: false }
  }

  function release({ workspace, ownerSessionId } = {}) {
    const slug = resolve(workspace)
    dropExpired()
    const holder = locks.get(slug)
    if (!holder) return { workspace: slug, released: false, lock: null }
    if (holder.ownerSessionId !== ownerSessionId) {
      const error = new Error(
        `workspace ${slug} is locked by ${holder.ownerSessionId}${holder.ownerLabel ? ` (${holder.ownerLabel})` : ''}; only the owner may release it`,
      )
      error.httpStatus = 409
      error.holder = holder
      throw error
    }
    locks.delete(slug)
    log(`workspace lock released workspace=${slug} owner=${ownerSessionId}`)
    return { workspace: slug, released: true, lock: { ...holder } }
  }

  function lockFor(workspace) {
    try {
      return lockOf(resolve(workspace))
    } catch {
      return null
    }
  }

  function list() {
    dropExpired()
    return [...locks.values()].map((lock) => ({ ...lock }))
  }

  /** Called once per process start: locks never survive a restart, so the table must be empty. */
  function clearAtStart() {
    const count = locks.size
    locks.clear()
    log(`workspace locks: cleared on start (in-memory only, ${count} entries dropped)`)
  }

  return { acquire, release, lockFor, list, expire: dropExpired, clearAtStart, count: () => locks.size }
}
