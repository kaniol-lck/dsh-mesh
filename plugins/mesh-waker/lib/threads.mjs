// Thread subsystem (T-318): moved verbatim out of index.js, same shape as receipt-flow.
// Every piece of plugin state arrives through `deps`; the module itself only touches the
// threads.json file and the maps it is given.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { normalizeThread } from './session.mjs'


/**
 * Thread registry + bindings (T-318). Nothing here may capture the apply() closure.
 *
 * deps:
 *   threadsFile          threads.json 路径（本机线程注册表持久化）
 *   threadRows           thread → { targetSessionId, targetTitle, lastTaskId, count, updatedAt, subscribedBy }
 *   taskRows             任务库内存索引：describeThread 用它列出线程承载过的 taskIds
 *   fileLog              写 waker 日志
 *   resolveLocalSession  按 id 解析本机会话（sessionForId；拿不到标题时返回 id）
 */
export function createThreads(deps) {
  function loadThreads() {
    try {
      const raw = JSON.parse(readFileSync(deps.threadsFile, 'utf8'))
      const entries = raw && typeof raw === 'object' && raw.threads && typeof raw.threads === 'object' ? raw.threads : raw
      for (const [thread, value] of Object.entries(entries ?? {})) {
        if (!value || typeof value !== 'object') continue
        deps.threadRows.set(String(thread), {
          targetSessionId: value.targetSessionId == null ? null : String(value.targetSessionId),
          targetTitle: value.targetTitle == null ? null : String(value.targetTitle),
          lastTaskId: value.lastTaskId == null ? null : String(value.lastTaskId),
          count: Number.isFinite(Number(value.count)) ? Number(value.count) : 0,
          updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
          // Older files predate subscribe: they were written by dispatches.
          subscribedBy: value.subscribedBy == null ? 'dispatch' : String(value.subscribedBy),
        })
      }
    } catch {
      /* first run: no threads yet */
    }
    deps.fileLog(`thread registry loaded threads=${deps.threadRows.size}`)
  }

  function saveThreads() {
    try {
      mkdirSync(dirname(deps.threadsFile), { recursive: true })
      const temp = `${deps.threadsFile}.tmp`
      const payload = Object.fromEntries([...deps.threadRows.entries()].sort(([left], [right]) => left.localeCompare(right)))
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, deps.threadsFile)
      return true
    } catch (error) {
      deps.fileLog(`thread registry write failed: ${error.message}`)
      return false
    }
  }

  /** Bind (or re-bind) a thread after a successful delivery and persist it. */
  function bindThread(thread, target, taskId, source = 'dispatch') {
    const previous = deps.threadRows.get(thread)
    const rebound = Boolean(previous && previous.targetSessionId && previous.targetSessionId !== target.id)
    deps.threadRows.set(thread, {
      targetSessionId: target.id,
      targetTitle: target.title ?? null,
      lastTaskId: taskId ?? previous?.lastTaskId ?? null,
      count: (previous?.count ?? 0) + 1,
      updatedAt: Date.now(),
      subscribedBy: previous?.subscribedBy && source === 'dispatch' ? previous.subscribedBy : source,
    })
    saveThreads()
    if (rebound) {
      deps.fileLog(`thread ${thread} rebound: ${previous.targetSessionId} -> ${target.id} (${target.title ?? 'no title'}) task=${taskId ?? '-'} by=${source}`)
    } else {
      deps.fileLog(`thread ${thread} bound to ${target.id} (${target.title ?? 'no title'}) count=${deps.threadRows.get(thread).count} task=${taskId ?? '-'} by=${source}`)
    }
  }

  /** Resolve a title for an arbitrary session id; null when it is unknown to this host. */
  function sessionForId(sessionId) {
    const id = String(sessionId ?? '').trim()
    if (!id) throw new Error('sessionId is required')
    try {
      const session = deps.resolveLocalSession({ session: id })
      return { id: session.id, title: session.title ?? null }
    } catch {
      return { id, title: null }
    }
  }

  /** The public shape of one thread, including the tasks that carried it. */
  function describeThread(thread) {
    const value = deps.threadRows.get(thread)
    if (!value) return null
    return {
      thread,
      targetSessionId: value.targetSessionId ?? null,
      targetTitle: value.targetTitle ?? null,
      count: value.count ?? 0,
      lastTaskId: value.lastTaskId ?? null,
      updatedAt: value.updatedAt ?? null,
      subscribedBy: value.subscribedBy ?? 'dispatch',
      taskIds: [...deps.taskRows.values()]
        .filter((row) => row.thread === thread)
        .sort((left, right) => Number(left.createdAt) - Number(right.createdAt))
        .map((row) => row.taskId),
    }
  }

  function listThreads({ scope = 'all', sessionId = null } = {}) {
    const wanted = scope === 'mine' ? sessionId : null
    if (scope === 'mine' && !wanted) throw new Error('scope=mine needs a session (the host did not pass one)')
    return [...deps.threadRows.keys()]
      .map((thread) => describeThread(thread))
      .filter((row) => row && (!wanted || row.targetSessionId === wanted))
      .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
  }

  /** Bind a thread to a session. Refuses to steal an existing binding from another session. */
  function subscribeThread(threadValue, session) {
    const thread = normalizeThread(threadValue)
    if (!thread) throw new Error('thread is required')
    const owner = deps.threadRows.get(thread)
    if (owner && owner.targetSessionId && owner.targetSessionId !== session.id) {
      const who = owner.targetTitle ? `${owner.targetSessionId} (${owner.targetTitle})` : owner.targetSessionId
      throw new Error(`thread "${thread}" is already bound to ${who}; only that session can release it`)
    }
    bindThread(thread, session, owner?.lastTaskId ?? null, 'self')
    return describeThread(thread)
  }

  /** Unbind a thread; only the current owner may release it. */
  function releaseThread(threadValue, sessionId) {
    const thread = normalizeThread(threadValue)
    if (!thread) throw new Error('thread is required')
    const owner = deps.threadRows.get(thread)
    if (!owner) throw new Error(`unknown thread "${thread}"`)
    if (owner.targetSessionId !== sessionId) {
      throw new Error(
        `thread "${thread}" is bound to ${owner.targetSessionId ?? '(unknown)'}${owner.targetTitle ? ` (${owner.targetTitle})` : ''}, not ${sessionId}; only the current owner can release it`,
      )
    }
    deps.threadRows.delete(thread)
    saveThreads()
    deps.fileLog(`thread ${thread} released by ${sessionId}`)
    return { thread, released: true }
  }

  return {
    loadThreads,
    saveThreads,
    bindThread,
    sessionForId,
    describeThread,
    listThreads,
    subscribeThread,
    releaseThread,
  }
}
