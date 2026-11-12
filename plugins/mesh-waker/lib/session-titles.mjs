import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PROJCACHE_SEGMENTS = ['storages', 'session_projcache', 'sessions']

/**
 * DSH's own storage is the title source of truth (T-429). The waker's sessions-index is a
 * creation-time snapshot: renaming a session in the DSH UI never updates it, so any title-based
 * routing that trusts the index can deliver to the wrong session. The projcache row
 * `record.rows.title.val` is what the host actually shows.
 *
 * Reads are cached per file mtime: a rename touches the file, so the next call sees it.
 */
export function createDshTitleReader({ dshBase, fileLog = null } = {}) {
  const cache = new Map()
  const fileFor = (id) => join(dshBase, ...PROJCACHE_SEGMENTS, `${id}.json`)

  return function readDshTitle(sessionId) {
    const id = String(sessionId ?? '').trim()
    if (!id || !dshBase) return null
    const file = fileFor(id)
    let mtime
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      cache.delete(id)
      return null
    }
    const hit = cache.get(id)
    if (hit && hit.mtime === mtime) return hit.title
    let title = null
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const rows = raw?.record?.rows ?? raw?.rows ?? null
      const candidate = rows?.title?.val ?? rows?.title ?? null
      if (typeof candidate === 'string' && candidate.trim()) title = candidate.trim()
    } catch (error) {
      fileLog?.(`reading dsh title for ${id} failed: ${error.message}`)
    }
    cache.set(id, { mtime, title })
    return title
  }
}

/**
 * Enrich a session list with the DSH title. `titleSource` says where the value came from and
 * `titleStale` marks an index/DSH disagreement so callers can refuse title-based routing.
 */
export function applyDshTitles(sessions, readTitle, { onStale = null } = {}) {
  const list = Array.isArray(sessions) ? sessions : []
  return list.map((session) => {
    const cachedTitle = session.title ?? null
    const dshTitle = typeof readTitle === 'function' ? readTitle(session.id) : null
    const stale = Boolean(dshTitle && cachedTitle && dshTitle !== cachedTitle)
    if (stale && typeof onStale === 'function') onStale(session.id, cachedTitle, dshTitle)
    return {
      ...session,
      title: dshTitle ?? cachedTitle,
      titleSource: dshTitle ? 'dsh' : 'cached',
      // The snapshot the index held (kept so a caller can explain the disagreement and so a
      // stale title can still be recognised when someone routes by it).
      ...(dshTitle ? { titleIndex: cachedTitle } : {}),
      ...(stale ? { titleStale: true } : {}),
    }
  })
}
