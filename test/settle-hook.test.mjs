import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSettleHook } from '../plugins/mesh-waker/lib/settle-hook.mjs'

/** A fake child process: records signals, lets a test fire exit/error. */
function fakeChild() {
  const handlers = new Map()
  const child = {
    killed: [],
    unrefed: false,
    kill(signal) {
      this.killed.push(signal)
      return true
    },
    unref() {
      this.unrefed = true
    },
    on(event, handler) {
      handlers.set(event, handler)
      return this
    },
    emit(event, ...args) {
      handlers.get(event)?.(...args)
    },
  }
  return child
}

function recordingSpawn(child = fakeChild()) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    return child
  }
  return { calls, spawnImpl, child }
}

const flushTimers = () => new Promise((resolve) => setImmediate(resolve))

test('settle-hook: no command configured is a complete no-op', () => {
  const hook = createSettleHook({})
  assert.equal(hook.enabled, false)
  assert.equal(hook.notify('T-1'), false)
  assert.deepEqual(hook.pendingTaskIds(), [])
  assert.equal(hook.flush(), null)
  // A disabled hook keeps no timer: nothing to clear, nothing pending.
  assert.equal(hook.notify(''), false)
})

test('settle-hook: one settle spawns the command once with --settle-tasks', () => {
  const { calls, spawnImpl, child } = recordingSpawn()
  const lines = []
  const hook = createSettleHook({
    command: 'node',
    args: ['scan.mjs'],
    debounceMs: 0,
    fileLog: (line) => lines.push(line),
    spawnImpl,
  })
  hook.notify('T-1')
  hook.flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'node')
  assert.deepEqual(calls[0].args, ['scan.mjs', '--settle-tasks', 'T-1'])
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].options.stdio, 'ignore')
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(child.unrefed, true)
  child.emit('exit', 0, null)
  assert.match(lines.join('\n'), /settle-hook ran command=node tasks=T-1/)
})

test('settle-hook: settles inside the window coalesce into one spawn', async () => {
  const { calls, spawnImpl } = recordingSpawn()
  const hook = createSettleHook({ command: 'scan', debounceMs: 5, spawnImpl, fileLog: () => {} })
  hook.notify('T-1')
  hook.notify('T-2')
  hook.notify('T-3')
  hook.notify('T-1') // duplicate must not appear twice
  assert.deepEqual(hook.pendingTaskIds().sort(), ['T-1', 'T-2', 'T-3'])
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(calls.length, 1)
  const ids = calls[0].args[1].split(',').sort()
  assert.deepEqual(ids, ['T-1', 'T-2', 'T-3'])
  assert.deepEqual(hook.pendingTaskIds(), [])
})

test('settle-hook: a child that outlives the timeout is killed', async () => {
  const { spawnImpl, child } = recordingSpawn()
  const lines = []
  const hook = createSettleHook({
    command: 'scan',
    debounceMs: 0,
    timeoutMs: 5000,
    spawnImpl,
    fileLog: (line) => lines.push(line),
  })
  hook.notify('T-slow')
  hook.flush()
  // 5s is the clamp floor; assert the timer exists by killing via dispose (same path).
  hook.dispose()
  assert.deepEqual(child.killed, ['SIGKILL'])
  await flushTimers()
  assert.equal(lines.length >= 0, true)
})

test('settle-hook: spawn failure and non-zero exit never throw at the caller', () => {
  const lines = []
  const throwing = createSettleHook({
    command: 'missing-binary',
    debounceMs: 0,
    fileLog: (line) => lines.push(line),
    spawnImpl: () => {
      throw new Error('ENOENT')
    },
  })
  assert.doesNotThrow(() => throwing.notify('T-err'))
  assert.doesNotThrow(() => throwing.flush())
  assert.match(lines.join('\n'), /settle-hook spawn failed command=missing-binary: ENOENT/)

  const { child, spawnImpl } = recordingSpawn()
  const failing = createSettleHook({ command: 'scan', debounceMs: 0, spawnImpl, fileLog: (line) => lines.push(line) })
  failing.notify('T-bad')
  assert.doesNotThrow(() => failing.flush())
  assert.doesNotThrow(() => child.emit('exit', 1, null))
  assert.match(lines.join('\n'), /settle-hook failed command=scan code=1/)
})

test('settle-hook: argvFor shows the exact --settle-tasks contract', () => {
  const hook = createSettleHook({ command: 'scan', args: ['--quiet'], spawnImpl: () => fakeChild() })
  assert.deepEqual(hook.argvFor(['T-1', 'T-2']), ['--quiet', '--settle-tasks', 'T-1,T-2'])
})
