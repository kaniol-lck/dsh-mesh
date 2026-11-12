/**
 * Settle hook (T-452): run one local script when tasks settle.
 *
 * Design constraints from the owner decision (plan A, waker-side hook):
 * - **off by default**: an empty `command` is a complete no-op — no timers, no child processes;
 * - never blocks settlement: `notify` only records the id and (re)arms a timer;
 * - burst coalescing: settles inside the debounce window collapse into a single spawn whose
 *   `--settle-tasks` argument carries the de-duplicated ids;
 * - bounded: the child is killed after `timeoutMs`, and both the timer and the child are
 *   unref'd so a settle can never keep the host process alive;
 * - no shell: the command and its args are passed to spawn as an argv array, never interpolated
 *   into a shell string.
 */
import { spawn as defaultSpawn } from 'node:child_process'

const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 300_000

function clampTimeout(value, fallback) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return fallback
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(ms)))
}

function clampDebounce(value, fallback) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return fallback
  return Math.min(600_000, Math.floor(ms))
}

export function createSettleHook({
  command,
  args = [],
  timeoutMs = 60_000,
  debounceMs = 300_000,
  env = {},
  fileLog = () => {},
  spawnImpl = null,
} = {}) {
  const cmd = String(command ?? '').trim()
  // Off by default: nothing below runs, no timers exist, notify is inert.
  const enabled = Boolean(cmd)
  const extraArgs = (Array.isArray(args) ? args : []).map((value) => String(value)).filter((value) => value !== '')
  const timeout = clampTimeout(timeoutMs, 60_000)
  const debounce = clampDebounce(debounceMs, 300_000)
  const spawn = spawnImpl ?? defaultSpawn

  const pending = new Set()
  let timer = null
  let inflight = null

  const log = (message) => {
    try {
      fileLog(message)
    } catch {
      // logging must never break settlement
    }
  }

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  function run() {
    if (!pending.size) return null
    const ids = [...pending]
    pending.clear()
    const argv = [...extraArgs, '--settle-tasks', ids.join(',')]
    let child
    try {
      child = spawn(cmd, argv, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ...env },
      })
    } catch (error) {
      log(`settle-hook spawn failed command=${cmd}: ${error?.message ?? error}`)
      return null
    }
    try {
      child?.unref?.()
    } catch {
      // an unref failure must not fail settlement
    }
    inflight = child ?? null
    const killTimer = setTimeout(() => {
      try {
        child?.kill?.('SIGKILL')
        log(`settle-hook timed out after ${timeout}ms; killed command=${cmd} tasks=${ids.join(',')}`)
      } catch (error) {
        log(`settle-hook kill failed: ${error?.message ?? error}`)
      }
    }, timeout)
    killTimer.unref?.()
    child?.on?.('error', (error) => {
      clearTimeout(killTimer)
      log(`settle-hook failed command=${cmd}: ${error?.message ?? error}`)
    })
    child?.on?.('exit', (code, signal) => {
      clearTimeout(killTimer)
      if (inflight === child) inflight = null
      if (code !== 0) {
        log(`settle-hook failed command=${cmd} code=${code ?? 'null'} signal=${signal ?? '-'} tasks=${ids.join(',')}`)
      } else {
        log(`settle-hook ran command=${cmd} tasks=${ids.join(',')}`)
      }
    })
    return child
  }

  function notify(taskId) {
    if (!enabled) return false
    const id = String(taskId ?? '').trim()
    if (!id) return false
    pending.add(id)
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      run()
    }, debounce)
    timer.unref?.()
    return true
  }

  /** Fire immediately (tests, shutdown). Returns the child process, if anything ran. */
  function flush() {
    if (!enabled) return null
    clearTimer()
    return run()
  }

  function pendingTaskIds() {
    return [...pending]
  }

  function dispose() {
    clearTimer()
    try {
      inflight?.kill?.('SIGKILL')
    } catch {
      // best effort
    }
    inflight = null
    pending.clear()
  }

  return {
    enabled,
    notify,
    flush,
    pendingTaskIds,
    dispose,
    // Exposed for tests and diagnostics: the exact argv shape the hook will use.
    argvFor: (ids) => [...extraArgs, '--settle-tasks', [...ids].join(',')],
  }
}
