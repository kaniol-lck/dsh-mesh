/**
 * Hub task consumer (T1 P5, T-388): pull-based, claim/heartbeat/settle.
 *
 * The hub is the only truth for cross-machine tasks; this module never creates a local copy of
 * the task body. Every network call is injected (`fetchJson`) so the whole loop is testable
 * against a fake hub, and a failing poll only logs — the next tick retries.
 */

/** Accept both snake_case (hub SQL columns) and camelCase rows. */
function taskIdOf(row) {
  return String(row?.task_id ?? row?.taskId ?? '').trim()
}

function textRefOf(row) {
  return String(row?.text_ref ?? row?.textRef ?? '').trim()
}

export function createHubTaskConsumer({
  enabled = false,
  agent,
  pollIntervalMs = 60_000,
  leaseMs = 600_000,
  fetchJson,
  deliverTask,
  fileLog = () => {},
  now = Date.now,
} = {}) {
  if (typeof fetchJson !== 'function') throw new Error('createHubTaskConsumer needs fetchJson')
  if (typeof deliverTask !== 'function') throw new Error('createHubTaskConsumer needs deliverTask')

  const agentName = () => (typeof agent === 'function' ? agent() : agent) ?? ''
  const active = new Map() // taskId -> { timers, claimedAt }
  const settled = new Set()
  let timer = null
  let running = false
  let lastPollAt = null
  // Sticky (T-392): a later successful poll must not erase the previous failure. The E2E bug
  // was invisible exactly because the next poll cleared lastError and nothing was logged.
  let lastError = null
  let lastErrorAt = null
  let lastSuccessAt = null
  let lastPollTaskCount = 0
  let stopped = false

  function recordError(message) {
    lastError = message
    lastErrorAt = now()
    fileLog(message)
  }

  function status() {
    return {
      enabled: enabled === true,
      agent: agentName() || null,
      pollIntervalMs,
      leaseMs,
      lastPollAt,
      lastError,
      lastErrorAt,
      lastSuccessAt,
      lastPollTaskCount,
      activeTaskCount: active.size,
      isRunning: running,
    }
  }

  function schedule(delay = pollIntervalMs) {
    if (timer) clearTimeout(timer)
    timer = null
    if (stopped || !enabled) return
    timer = setTimeout(() => {
      timer = null
      void pollOnce()
    }, Math.max(0, delay))
    timer.unref?.()
  }

  /** Fetch the task body without ever storing it: text_ref → blob id → text. */
  async function resolveTaskText(row) {
    const ref = textRefOf(row)
    const inline = row?.text ?? row?.body
    if (typeof inline === 'string' && inline.trim()) return inline
    if (!ref) return ''
    const hex = ref.replace(/^sha256:/, '').trim()
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`unusable text_ref "${ref}"`)
    const lookup = await fetchJson(`/api/blobs?sha256=${encodeURIComponent(hex)}`, { method: 'GET' })
    if (!lookup.ok) throw new Error(`blob lookup failed: HTTP ${lookup.status}`)
    const blobs = lookup.json?.blobs ?? lookup.json?.items ?? []
    const blob = Array.isArray(blobs) ? blobs[0] : null
    const blobId = blob?.id ?? blob?.blob_id ?? null
    if (!blobId) throw new Error(`no blob for ${ref}`)
    const got = await fetchJson(`/api/blob/${encodeURIComponent(blobId)}`, { method: 'GET' })
    if (!got.ok) throw new Error(`blob fetch failed: HTTP ${got.status}`)
    // The hub serves blobs as a raw stream (octet-stream), so the body arrives as plain text
    // (T-392). Older/fake hubs that answered JSON still work through the json fallbacks.
    const body = got.text ?? got.json?.text ?? got.json?.body ?? got.json?.blob?.text ?? null
    if (typeof body !== 'string') throw new Error(`blob ${blobId} has no text`)
    return body
  }

  function startHeartbeat(taskId) {
    const lease = active.get(taskId)
    if (!lease) return
    const beat = async () => {
      if (!active.has(taskId)) return
      try {
        const res = await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/heartbeat`, {
          method: 'POST',
          body: { lease_ms: leaseMs },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch (error) {
        // A failed beat is not fatal: the lease may still be usable, and the hub recycles it.
        fileLog(`hub task ${taskId} heartbeat failed: ${error.message}`)
      }
    }
    const interval = Math.max(1000, Math.floor(leaseMs / 2))
    const beatTimer = setInterval(() => void beat(), interval)
    beatTimer.unref?.()
    lease.timers.push(beatTimer)
  }

  function stopTimers(taskId) {
    const lease = active.get(taskId)
    if (!lease) return
    for (const item of lease.timers) clearInterval(item)
    active.delete(taskId)
  }

  async function claim(taskId) {
    const res = await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST',
      body: { lease_ms: leaseMs },
    })
    if (res.status === 409) return { claimed: false, reason: 'conflict' }
    if (!res.ok) throw new Error(`claim failed: HTTP ${res.status}`)
    return { claimed: true }
  }

  /** One pull round: list pending → claim (409 skips) → hydrate body → deliver. */
  async function pollOnce() {
    if (!enabled || running || stopped) return { polled: 0, claimed: 0 }
    running = true
    let polled = 0
    let claimed = 0
    try {
      const res = await fetchJson(`/api/tasks?agent=${encodeURIComponent(agentName())}&status=pending`, { method: 'GET' })
      if (!res.ok) throw new Error(`task list failed: HTTP ${res.status}`)
      const rows = res.json?.tasks ?? res.json?.items ?? []
      const list = Array.isArray(rows) ? rows : []
      polled = list.length
      for (const row of list) {
        const taskId = taskIdOf(row)
        if (!taskId || settled.has(taskId) || active.has(taskId)) continue
        const attempt = await claim(taskId)
        if (!attempt.claimed) {
          fileLog(`hub task ${taskId} claim skipped (${attempt.reason}); another worker owns it`)
          continue
        }
        claimed += 1
        try {
          const text = await resolveTaskText(row)
          if (!text.trim()) {
            recordError(`hub task ${taskId} has no body; leaving it claimed for the lease to recycle`)
            continue
          }
          active.set(taskId, { timers: [], claimedAt: now() })
          startHeartbeat(taskId)
          await deliverTask({ ...row, taskId, text })
        } catch (error) {
          // Delivery failure keeps the claim: the lease recycles it, never a silent drop.
          // One bad task must not stop the rest of the round (T-392).
          recordError(`hub task ${taskId} delivery failed: ${error.message}`)
        }
      }
      lastPollTaskCount = polled
      lastSuccessAt = now()
    } catch (error) {
      recordError(`tasks poll failed: ${error.message}`)
    } finally {
      running = false
      lastPollAt = now()
      schedule()
    }
    return { polled, claimed }
  }

  /** Settle exactly once: declared (mesh_complete) and observed (turn/end) race here. */
  async function settleTask(taskId, { result, summary = '', source = 'observed', artifacts = null } = {}) {
    const id = String(taskId ?? '').trim()
    if (!id || settled.has(id)) return { ok: true, skipped: true }
    settled.add(id)
    stopTimers(id)
    try {
      const res = await fetchJson(`/api/tasks/${encodeURIComponent(id)}/settle`, {
        method: 'POST',
        body: {
          result,
          source,
          summary: String(summary ?? '').slice(0, 300),
          ...(Array.isArray(artifacts) && artifacts.length ? { artifacts } : {}),
        },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      fileLog(`hub task ${id} settled ${result} source=${source}`)
      return { ok: true, result, source }
    } catch (error) {
      // Allow a later attempt (e.g. declared after a failed observed settle).
      settled.delete(id)
      recordError(`settle ${id} failed: ${error.message}`)
      return { ok: false, error: error.message }
    }
  }

  function start() {
    if (!enabled || stopped) return false
    if (!timer && !running) schedule(1200)
    return true
  }

  function stop() {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    for (const taskId of [...active.keys()]) stopTimers(taskId)
  }

  return { status, pollOnce, settleTask, start, stop }
}
