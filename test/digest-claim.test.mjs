import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLAIM_OK, CLAIM_STALL, CLAIM_WARN, claimState } from '../plugins/mesh-waker/lib/digest-claim.mjs'
import { createTaskLifecycle } from '../plugins/mesh-waker/lib/task-lifecycle.mjs'
import { createUnclaimedNotice } from '../plugins/mesh-waker/lib/unclaimed-notice.mjs'
import { buildReceipt } from '../plugins/mesh-waker/lib/receipt.mjs'

const REPO = path.join(import.meta.dirname, '..')
const ENTRY = path.join(REPO, 'plugins', 'mesh-waker', 'index.js')
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-digest-claim-${process.pid}.log`)

const REQ = 'session-claim-req'
const WORKER = 'session-claim-worker'
const WINDOW = 60_000

// ── 1. the pure policy ────────────────────────────────────────────────────────
test('claimState: inside the window there is nothing to do', () => {
  const now = 10_000_000
  assert.equal(claimState({ notifiedAt: now - 1000 }, { now, windowMs: WINDOW }), CLAIM_OK)
  assert.equal(claimState({ notifiedAt: now - WINDOW + 1 }, { now, windowMs: WINDOW }), CLAIM_OK)
})

test('claimState: past the window it warns exactly once', () => {
  const now = 10_000_000
  const row = { notifiedAt: now - WINDOW - 1 }
  assert.equal(claimState(row, { now, windowMs: WINDOW }), CLAIM_WARN)
  // A row that already warned waits for the stall threshold instead of warning again.
  assert.equal(claimState(row, { now, windowMs: WINDOW, warnedAt: now - 1000 }), CLAIM_OK)
})

test('claimState: twice the window stalls exactly once', () => {
  const now = 10_000_000
  const row = { notifiedAt: now - WINDOW * 2 - 1 }
  assert.equal(claimState(row, { now, windowMs: WINDOW, warnedAt: now - WINDOW }), CLAIM_STALL)
  assert.equal(claimState(row, { now, windowMs: WINDOW, warnedAt: now - WINDOW, stalledAt: now - 1000 }), CLAIM_OK)
})

test('claimState: settled, dismissed or never-announced rows are never watched', () => {
  const now = 10_000_000
  const old = now - WINDOW * 5
  assert.equal(claimState({ notifiedAt: old, settledAt: now - 1 }, { now, windowMs: WINDOW }), CLAIM_OK)
  assert.equal(claimState({ notifiedAt: old, claimDismissedAt: now - 1 }, { now, windowMs: WINDOW }), CLAIM_OK)
  assert.equal(claimState({ notifiedAt: null }, { now, windowMs: WINDOW }), CLAIM_OK)
  assert.equal(claimState(null, { now, windowMs: WINDOW }), CLAIM_OK)
})

// ── T-485: an ack is not a resolution ────────────────────────────────────────
test('claimState: an acked row is still watched — ack is "I saw it", not "it is done"', () => {
  const now = 10_000_000
  const base = { notifiedAt: now - WINDOW - 1, status: 'pending' }
  assert.equal(claimState(base, { now, windowMs: WINDOW }), CLAIM_WARN)
  // The worker acked right after the digest — the exact real-world sequence.
  assert.equal(claimState({ ...base, ackedAt: now - 1000, ackBy: 'worker' }, { now, windowMs: WINDOW }), CLAIM_WARN)
  // The requester's receipt ack is a different marker and does not suppress it either.
  assert.equal(claimState({ ...base, receiptAckedAt: now - 1000 }, { now, windowMs: WINDOW }), CLAIM_WARN)
  // Nor does the ack push a stalled row back: twice the window still stalls.
  assert.equal(
    claimState(
      { notifiedAt: now - WINDOW * 2 - 1, ackedAt: now - WINDOW * 2, claimWarnedAt: now - WINDOW },
      { now, windowMs: WINDOW, warnedAt: now - WINDOW },
    ),
    CLAIM_STALL,
  )
})

test('claimState: a row the worker already started is claimed, not unclaimed', () => {
  // XJ-SPAWN-01 regression: the worker opened a turn (startedAt set) and was mid-flight, yet
  // the advisory still fired because only settledAt/dismissal ended the watch. `startedAt` is
  // the opposite of `ackedAt`: it proves the task was picked up.
  const now = 10_000_000
  const base = { notifiedAt: now - WINDOW - 1, status: 'pending', startedAt: now - WINDOW }
  assert.equal(claimState(base, { now, windowMs: WINDOW }), CLAIM_OK)
  // Even well past twice the window: a started task is the stall watchdog's business, not this.
  assert.equal(
    claimState({ ...base, notifiedAt: now - WINDOW * 3 }, { now, windowMs: WINDOW }),
    CLAIM_OK,
  )
  // A settled row is still settled, and an explicit dismissal still wins.
  assert.equal(claimState({ ...base, settledAt: now - 1000 }, { now, windowMs: WINDOW }), CLAIM_OK)
  assert.equal(claimState({ ...base, claimDismissedAt: now - 1000 }, { now, windowMs: WINDOW }), CLAIM_OK)
})

// ── 2. the sweep, driven directly (no 30-minute wait) ─────────────────────────
function makeLifecycle(overrides = {}) {
  const logs = []
  const notices = []
  const patches = []
  const pendingTasks = new Map()
  const taskRows = new Map()
  const deps = {
    pendingTasks,
    taskRows,
    receiptTimers: new Set(),
    liveness: new Map(),
    assistantText: new Map(),
    turnStartedAt: new Map(),
    state: { pendingTasks: 0, lastReceipt: null, lastError: null },
    config: {
      receiptStallMs: 80,
      receiptSummaryChars: 300,
      receiptFile: 'receipts.jsonl',
      receiptMode: 'queue',
      requireNamespacedIds: false,
      startedClaimWindowMs: 60_000,
      digestClaimWarnMs: WINDOW,
      claimSweepMs: 0, // never arm the interval: the test calls the sweep itself
      coordinatorPendingTtlMs: 1_800_000,
    },
    fileLog: (message) => logs.push(String(message)),
    taskRegistry: {
      recordTaskPending: () => {},
      updateTaskRow: (taskId, patch) => {
        patches.push({ taskId, patch })
        const row = taskRows.get(taskId)
        if (row) taskRows.set(taskId, { ...row, ...patch })
        return taskRows.get(taskId) ?? null
      },
    },
    receiptFlow: {
      resolveRequester: () => ({ requester: null, sessionId: null, inferred: false }),
      deliverReceipt: async () => {},
      deliverNotice: async () => {},
    },
    setLastReceipt: (value) => {
      deps.state.lastReceipt = value
    },
    writeReceiptFile: () => true,
    receiptDirForTask: () => 'dir',
    receiptDirFor: () => 'dir',
    livenessFor: (sessionId) => {
      if (!deps.liveness.has(sessionId)) {
        deps.liveness.set(sessionId, { openTurn: null, openCalls: new Map(), openJobs: new Map(), openApprovals: new Map() })
      }
      return deps.liveness.get(sessionId)
    },
    maxTurnFor: () => 1,
    sessionCwdOf: () => 'proj',
    routeForCwds: () => ({ dir: 'dir', scope: 'ws', workspace: 'w' }),
    scopeFields: () => ({}),
    findTaskRowInFile: () => null,
    layerLabel: () => 'ws',
    taskRecordFiles: () => [],
    registerBatchTask: () => {},
    updateBatchTask: () => {},
    sendUnclaimedNotice: (taskId, task, info) => notices.push({ taskId, task, info }),
    ...overrides,
  }
  return { deps, logs, notices, patches, taskRows, pendingTasks, flow: createTaskLifecycle(deps) }
}

const staleRow = (overrides = {}) => ({
  taskId: 'T-claim-old',
  status: 'pending',
  declaredOnly: true,
  mode: 'queue',
  targetSessionId: WORKER,
  requesterSessionId: REQ,
  requester: 'claim requester',
  receiptMode: 'queue',
  notifiedAt: Date.now() - WINDOW - 1000,
  notifyCount: 1,
  ...overrides,
})

test('claim sweep: warns once and sends the dispatcher an advisory receipt without settling', async () => {
  const { flow, logs, notices, taskRows } = makeLifecycle()
  taskRows.set('T-claim-old', staleRow())
  flow.claimSweep()
  assert.match(logs.join('\n'), /WARN digest task unclaimed task=T-claim-old/)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].taskId, 'T-claim-old')
  assert.equal(notices[0].info.started, false)
  assert.ok(Number(taskRows.get('T-claim-old').claimWarnedAt) > 0)
  assert.equal(taskRows.get('T-claim-old').status, 'pending', 'the sweep must never settle a task')
  // A second sweep does not warn again.
  flow.claimSweep()
  assert.equal(notices.length, 1)
  assert.equal((logs.join('\n').match(/WARN digest task unclaimed/g) ?? []).length, 1)
})

test('claim sweep: twice the window marks the row stalled and keeps it', () => {
  const { flow, logs, taskRows, notices } = makeLifecycle()
  taskRows.set(
    'T-claim-old',
    staleRow({ notifiedAt: Date.now() - WINDOW * 3, claimWarnedAt: Date.now() - WINDOW * 2 }),
  )
  flow.claimSweep()
  assert.match(logs.join('\n'), /WARN digest task stalled task=T-claim-old/)
  assert.equal(taskRows.get('T-claim-old').status, 'stalled')
  assert.equal(taskRows.get('T-claim-old').taskId, 'T-claim-old', 'the row stays for triage')
  assert.equal(notices.length, 0, 'the stall replaces the advisory, it does not repeat it')
})

test('claim sweep: a settled digest task raises no alarm', () => {
  const { flow, logs, notices, taskRows } = makeLifecycle()
  taskRows.set('T-settled', staleRow({ taskId: 'T-settled', settledAt: Date.now() }))
  taskRows.set('T-open', staleRow({ taskId: 'T-open', status: 'started' }))
  flow.claimSweep()
  assert.equal(logs.length, 0)
  assert.equal(notices.length, 0)
})

// ── T-485 cases a–e, driven through the real sweep ──────────────────────────
test('claim sweep (a): an acked row past the window still warns and sends the advisory', () => {
  const { flow, logs, notices, taskRows } = makeLifecycle()
  taskRows.set('T-acked-old', staleRow({ taskId: 'T-acked-old', ackedAt: Date.now() - WINDOW }))
  flow.claimSweep()
  assert.match(logs.join('\n'), /WARN digest task unclaimed task=T-acked-old/)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].taskId, 'T-acked-old')
  assert.equal(taskRows.get('T-acked-old').status, 'pending', 'an ack never settles anything')
})

test('claim sweep (b): an acked row declared inside the window never warns', () => {
  const { flow, logs, notices, taskRows } = makeLifecycle()
  taskRows.set('T-acked-done', staleRow({ taskId: 'T-acked-done', ackedAt: Date.now() - WINDOW }))
  // The worker declares before the sweep runs: settledAt wins over any staleness.
  taskRows.set('T-acked-done', { ...taskRows.get('T-acked-done'), settledAt: Date.now(), status: 'settled' })
  flow.claimSweep()
  assert.equal(logs.length, 0)
  assert.equal(notices.length, 0)
})

test('claim sweep (c): an acked row past twice the window is marked stalled and kept', () => {
  const { flow, logs, notices, taskRows } = makeLifecycle()
  taskRows.set(
    'T-acked-stall',
    staleRow({
      taskId: 'T-acked-stall',
      ackedAt: Date.now() - WINDOW * 2,
      notifiedAt: Date.now() - WINDOW * 3,
      claimWarnedAt: Date.now() - WINDOW * 2,
    }),
  )
  flow.claimSweep()
  assert.match(logs.join('\n'), /WARN digest task stalled task=T-acked-stall/)
  assert.equal(taskRows.get('T-acked-stall').status, 'stalled')
  assert.equal(taskRows.get('T-acked-stall').taskId, 'T-acked-stall')
  assert.equal(notices.length, 0)
})

test('claim sweep (d): a settled row never warns even if every other marker is old', () => {
  const { flow, logs, notices, taskRows } = makeLifecycle()
  taskRows.set(
    'T-settled-old',
    staleRow({ taskId: 'T-settled-old', ackedAt: Date.now() - WINDOW * 2, settledAt: Date.now() }),
  )
  flow.claimSweep()
  assert.equal(logs.length, 0)
  assert.equal(notices.length, 0)
})

test('claim sweep (e): an explicit dismissal silences the watch, unlike an ack', () => {
  const { flow, logs, notices, taskRows } = makeLifecycle()
  taskRows.set('T-dismissed', staleRow({ taskId: 'T-dismissed', claimDismissedAt: Date.now(), claimDismissedBy: REQ }))
  taskRows.set('T-acked-only', staleRow({ taskId: 'T-acked-only', ackedAt: Date.now() - WINDOW }))
  flow.claimSweep()
  // Same clock, same age: only the marker separates the two rows.
  assert.doesNotMatch(logs.join('\n'), /task=T-dismissed/)
  assert.match(logs.join('\n'), /WARN digest task unclaimed task=T-acked-only/)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].taskId, 'T-acked-only')
})

test('claim sweep: a digest task inside the window is left alone', () => {
  const { flow, logs, notices, taskRows } = makeLifecycle()
  taskRows.set('T-fresh', staleRow({ notifiedAt: Date.now() - 1000 }))
  flow.claimSweep()
  assert.equal(logs.length, 0)
  assert.equal(notices.length, 0)
})

test('declaredOnly: a turn records startedAt but its end never settles the task', () => {
  const { flow, deps, taskRows, logs } = makeLifecycle()
  const pending = new Map()
  const target = { id: WORKER, title: 'claim worker', cwd: 'proj' }
  pending.set('T-claim-start', {
    taskId: 'T-claim-start',
    sessionId: WORKER,
    mode: 'queue',
    declaredOnly: true,
    settled: false,
    startedAt: null,
    baselineTurn: null,
    injectedAt: Date.now(),
    requesterSessionId: REQ,
  })
  deps.pendingTasks = pending
  taskRows.set('T-claim-start', { taskId: 'T-claim-start', status: 'pending', declaredOnly: true, targetSessionId: WORKER })
  flow.handleSessionEvent({ id: WORKER }, { type: 'turn/start', turn: 1 })
  flow.handleSessionEvent({ id: WORKER }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
  assert.ok(Number(taskRows.get('T-claim-start').startedAt) > 0, 'turn/start is evidence the worker began')
  // L2-20261124-03: the status field must say `started` too. Leaving it at `pending` meant
  // "was this ever picked up?" could only be answered by reading a timestamp.
  assert.equal(taskRows.get('T-claim-start').status, 'started', 'the status field must not contradict the worker')
  assert.match(logs.join('\n'), /task T-claim-start started turn=1/)
  assert.equal(pending.get('T-claim-start').settled, false)
  void target
})

// ── L2-20261124-03: `stalled` must not be a one-way door ─────────────────────
test('claim sweep: a stalled row the worker had claimed is resumed to pending', () => {
  const { flow, logs, taskRows } = makeLifecycle()
  const stalledAt = Date.now() - WINDOW
  taskRows.set(
    'T-stall-started',
    staleRow({
      taskId: 'T-stall-started',
      status: 'stalled',
      stalledAt,
      startedAt: Date.now() - WINDOW,
      claimWarnedAt: Date.now() - WINDOW * 2,
      notifiedAt: Date.now() - WINDOW * 3,
    }),
  )
  taskRows.set(
    'T-stall-acked',
    staleRow({
      taskId: 'T-stall-acked',
      status: 'stalled',
      stalledAt,
      ackedAt: Date.now() - WINDOW,
      claimWarnedAt: Date.now() - WINDOW * 2,
      notifiedAt: Date.now() - WINDOW * 3,
    }),
  )
  flow.claimSweep()
  for (const taskId of ['T-stall-started', 'T-stall-acked']) {
    const row = taskRows.get(taskId)
    assert.equal(row.status, 'pending', `${taskId} must leave stalled`)
    assert.ok(Number(row.resumedAt) > 0, `${taskId} must record resumedAt`)
    assert.equal(row.stalledAt, stalledAt, `${taskId} keeps stalledAt as history`)
  }
  assert.match(logs.join('\n'), /digest task resumed task=T-stall-started .*reason=started/)
  assert.match(logs.join('\n'), /digest task resumed task=T-stall-acked .*reason=acked/)

  // The whole point: a resumed row must not be re-stalled by the next sweep.
  const logCount = logs.length
  flow.claimSweep()
  for (const taskId of ['T-stall-started', 'T-stall-acked']) {
    assert.equal(taskRows.get(taskId).status, 'pending', `${taskId} must not be re-stalled`)
  }
  assert.doesNotMatch(logs.slice(logCount).join('\n'), /digest task resumed/, 'resuming is a one-shot')
})

test('claim sweep: a stalled row without claim evidence stays stalled', () => {
  const { flow, logs, taskRows } = makeLifecycle()
  taskRows.set(
    'T-stall-cold',
    staleRow({
      taskId: 'T-stall-cold',
      status: 'stalled',
      stalledAt: Date.now() - WINDOW,
      claimWarnedAt: Date.now() - WINDOW * 2,
      notifiedAt: Date.now() - WINDOW * 3,
    }),
  )
  flow.claimSweep()
  assert.equal(taskRows.get('T-stall-cold').status, 'stalled')
  assert.equal(taskRows.get('T-stall-cold').resumedAt ?? null, null)
  assert.doesNotMatch(logs.join('\n'), /digest task resumed/)
})

test('claim sweep: a settled stalled row is history and is never resumed', () => {
  const { flow, logs, taskRows } = makeLifecycle()
  // Shape of T-278 / T4F-20261101-11: settled long ago, still carrying the old stalled status.
  taskRows.set(
    'T-stall-history',
    staleRow({
      taskId: 'T-stall-history',
      status: 'stalled',
      stalledAt: Date.now() - WINDOW * 10,
      settledAt: Date.now() - WINDOW * 9,
      startedAt: Date.now() - WINDOW * 11,
      ackedAt: Date.now() - WINDOW * 11,
    }),
  )
  flow.claimSweep()
  const row = taskRows.get('T-stall-history')
  assert.equal(row.status, 'stalled', 'settled history must not be rewritten')
  assert.equal(row.resumedAt ?? null, null)
  assert.doesNotMatch(logs.join('\n'), /digest task resumed/)
})

// ── 3. end to end: the advisory really reaches the dispatcher ─────────────────
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function request(base, route) {
  const res = await fetch(`${base}${route}`)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 8000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return false
}

async function startHarness({ sweepMs = 500 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-digest-claim-'))
  fs.mkdirSync(path.join(tmp, 'inbox'), { recursive: true })
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const receiptFile = path.join(tmp, 'receipts.jsonl')
  const logFile = path.join(tmp, 'waker.log')
  for (const dir of [sessionsRoot, tokenDir, home]) fs.mkdirSync(dir, { recursive: true })
  const index = {}
  for (const seed of [
    { id: REQ, title: 'claim requester' },
    { id: WORKER, title: 'claim worker' },
  ]) {
    const dir = path.join(sessionsRoot, 'ws-test', seed.id)
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(log, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session/open', data: { cwd: path.join(tmp, 'inbox') } }) + '\n')))
    index[seed.id] = { mtime: fs.statSync(log).mtimeMs, title: seed.title, cwd: path.join(tmp, 'inbox') }
  }
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify(index))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, 'test-token')

  const state = { prompts: [], tools: [] }
  const previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    MESH_WAKER_SESSIONS_ROOT: process.env.MESH_WAKER_SESSIONS_ROOT,
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.MESH_WAKER_SESSIONS_ROOT = sessionsRoot
  const disposers = []
  const listeners = new Map()
  const toolsService = { register: (definition) => (state.tools.push(definition), () => {}) }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => (name === 'tools' ? toolsService : undefined),
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    commands: { register: () => () => {} },
    tools: toolsService,
    sessionController: {
      async create() {
        throw new Error('not used here')
      },
      async prompt(payload) {
        state.prompts.push(payload)
        return {}
      },
      async cancel() {},
      async rename() {},
    },
    agents: { get: () => undefined, resume: async () => {} },
    workspaceRegistry: {
      archivedSessionIds: () => new Set(),
      async archiveSession() {},
      async resolveByPath() {
        return null
      },
      async create(workspacePath) {
        return { id: 'ws-test', path: workspacePath }
      },
      async deleteKnown() {
        return false
      },
      sessionKnown() {
        return true
      },
    },
  }
  const port = await freePort()
  const { apply } = await import(pathToFileURL(ENTRY).href)
  await apply(ctx, {
    listenHost: '127.0.0.1',
    listenPort: port,
    tokenFile,
    workspacePath: path.join(tmp, 'inbox'),
    sessionCwd: path.join(tmp, 'inbox'),
    receiptFile,
    batchFile: path.join(tmp, 'batches.json'),
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
    settleHookCommand: '',
    digestDelivery: 'on',
    digestIdleDebounceMs: 300,
    receiptDigest: 'off',
    receiptMode: 'queue',
    digestClaimWarnMs: WINDOW,
    claimSweepMs: sweepMs,
    logFile,
  })
  const base = `http://127.0.0.1:${port}`
  const emit = (sessionId, type, turn, extra = {}) => {
    for (const fn of listeners.get('session/event') ?? []) fn({ id: sessionId }, { type, turn, ...extra })
  }
  const tool = (name) => state.tools.find((entry) => entry.name === name)
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  const receiptLines = () => (fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, 'utf8').split('\n').filter(Boolean) : [])
  const close = () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already closed */
      }
    }
    process.env.HOME = previousEnv.HOME
    process.env.USERPROFILE = previousEnv.USERPROFILE
    process.env.MESH_WAKER_SESSIONS_ROOT = previousEnv.MESH_WAKER_SESSIONS_ROOT
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  await sleep(80)
  return { base, state, emit, tool, close, request, log, receiptLines }
}

const dispatchTask = (h, id) =>
  h.tool('mesh_dispatch').execute({ target: 'claim worker', text: `body ${id}`, taskId: id }, { sessionId: REQ })

test('advisory notice: writes status unclaimed to receipts.jsonl and delivers through the receipt channel', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-unclaimed-'))
  fs.mkdirSync(path.join(tmp, 'inbox'), { recursive: true })
  try {
    const deliveries = []
    const notify = createUnclaimedNotice({
      buildReceipt,
      writeReceiptFile: (receipt, dir) => {
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(path.join(dir, 'receipts.jsonl'), JSON.stringify(receipt) + '\n')
        return true
      },
      dirForRow: () => tmp,
      receiptDirForTask: () => tmp,
      rowFor: () => ({ receiptMode: 'queue', notifiedAt: 1794700000000, requesterSessionId: REQ }),
      deliverNotice: async (mode, receipt, label, target) => deliveries.push({ mode, receipt, label, target }),
      fileLog: () => {},
      config: { receiptSummaryChars: 300 },
    })
    const receipt = notify('T-claim-adv', { sessionId: WORKER, requesterSessionId: REQ }, { waitedMs: 3_600_000, started: true })
    assert.equal(receipt.status, 'unclaimed')
    assert.equal(receipt.reasonKind, 'unclaimed')
    assert.equal(receipt.taskId, 'T-claim-adv')
    assert.match(String(receipt.reasonDetail), /no mesh_complete yet/)
    assert.match(String(receipt.reasonDetail), /did start a turn/)
    assert.equal(receipt.injectedAt, 1794700000000, 'the advisory dates back to the announcement')
    const written = fs.readFileSync(path.join(tmp, 'receipts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(written.length, 1)
    assert.equal(written[0].status, 'unclaimed')
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].mode, 'queue')
    assert.equal(deliveries[0].target, REQ)
    assert.equal(deliveries[0].receipt.status, 'unclaimed')
    assert.equal(deliveries[0].label, 'receipt T-claim-adv unclaimed')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('advisory notice: write/if-delivery failures are logged and never thrown into the sweep', () => {
  const logs = []
  const notify = createUnclaimedNotice({
    buildReceipt,
    writeReceiptFile: () => {
      throw new Error('disk full')
    },
    dirForRow: () => '/nope',
    receiptDirForTask: () => '/nope',
    rowFor: () => null,
    deliverNotice: () => {
      throw new Error('channel down')
    },
    fileLog: (line) => logs.push(String(line)),
    config: {},
  })
  assert.doesNotThrow(() => notify('T-claim-x', { sessionId: WORKER }, { waitedMs: 1000 }))
  assert.match(logs.join('\n'), /unclaimed receipt write failed task=T-claim-x/)
  assert.match(logs.join('\n'), /unclaimed receipt delivery failed task=T-claim-x/)
})

test(
  'advisory end to end: after the real window the plugin warns, files an unclaimed receipt and pings the dispatcher',
  { timeout: 150_000 },
  async () => {
    // The clamped floor for digestClaimWarnMs is one minute, so this is the only case that
    // waits; everything else drives the same policy through the factory clock.
    const h = await startHarness({ sweepMs: 500 })
    try {
      await dispatchTask(h, 'T-claim-e2e')
      assert.ok(
        await waitFor(() => /digest session=session-claim-worker tasks=1 ids=T-claim-e2e/.test(h.log())),
        `digest must be delivered first, log:\n${h.log()}`,
      )
      assert.ok(
        await waitFor(() => /WARN digest task unclaimed task=T-claim-e2e/.test(h.log()), 90_000, 250),
        `expected the unclaimed warning after the window, log:\n${h.log()}`,
      )
      const unclaimed = h.receiptLines().map((line) => JSON.parse(line)).find((row) => row.taskId === 'T-claim-e2e' && row.status === 'unclaimed')
      assert.ok(unclaimed, `expected an unclaimed receipt, saw: ${h.receiptLines().join('\n')}`)
      assert.match(String(unclaimed.reasonDetail), /no mesh_complete yet/)
      const row = await h.request(h.base, '/mesh/tasks/T-claim-e2e')
      assert.equal(row.json?.task?.status, 'pending', 'the advisory never settles the task')
      assert.ok(
        await waitFor(
          () => h.state.prompts.some((prompt) => prompt.sessionId === REQ && JSON.stringify(prompt.content).includes('unclaimed')),
          10_000,
        ),
        'the dispatcher should receive the advisory notice',
      )
    } finally {
      h.close()
    }
  },
)

test('advisory: an undeclared digest task stays pending until mesh_complete closes it', async () => {
  const h = await startHarness({ sweepMs: 500 })
  try {
    await dispatchTask(h, 'T-claim-slow')
    assert.ok(
      await waitFor(() => /digest session=session-claim-worker tasks=1 ids=T-claim-slow/.test(h.log())),
      `digest must be delivered first, log:\n${h.log()}`,
    )
    const row = await h.request(h.base, '/mesh/tasks/T-claim-slow')
    assert.equal(row.json?.task?.status, 'pending')
    assert.ok(Number(row.json?.task?.notifiedAt) > 0)
    assert.ok(Number(row.json?.task?.notifyCount) >= 1)
    // The window is 60s at its floor, so this boot cannot wait for the WARN: the sweep policy
    // is covered above with the factory's clock. What matters here is that nothing settles it.
    await sleep(900)
    const stillPending = await h.request(h.base, '/mesh/tasks/T-claim-slow')
    assert.equal(stillPending.json?.task?.status, 'pending', 'no sweep, watchdog or turn may settle it')
    const declared = await h.tool('mesh_complete').execute({ taskId: 'T-claim-slow', status: 'done', summary: 'ok' }, { sessionId: WORKER })
    assert.equal(declared.ok, true)
    const settled = await h.request(h.base, '/mesh/tasks/T-claim-slow')
    assert.equal(settled.json?.task?.status, 'settled')
  } finally {
    h.close()
  }
})

test('advisory: a declared digest task raises no alarm and writes no unclaimed receipt', async () => {
  const h = await startHarness({ sweepMs: 500 })
  try {
    await dispatchTask(h, 'T-claim-ok')
    await waitFor(() => /digest session=session-claim-worker tasks=1 ids=T-claim-ok/.test(h.log()))
    h.emit(WORKER, 'turn/start', 1)
    h.emit(WORKER, 'turn/end', 1, { reason: { kind: 'completed' } })
    await sleep(300)
    const row = await h.request(h.base, '/mesh/tasks/T-claim-ok')
    // L2-20261124-03: a digest task is `started` once the worker opens a turn — the status must
    // describe reality. What must NOT happen is settlement: turn/end never closes it.
    assert.equal(row.json?.task?.status, 'started', 'turn/end must not settle a digest task')
    assert.equal(row.json?.task?.settledAt ?? null, null, 'a digest task has no settlement yet')
    assert.ok(Number(row.json?.task?.startedAt) > 0, 'turn/start records startedAt')
    await h.tool('mesh_complete').execute({ taskId: 'T-claim-ok', status: 'done', summary: 'ok' }, { sessionId: WORKER })
    await sleep(900)
    assert.doesNotMatch(h.log(), /WARN digest task unclaimed task=T-claim-ok/)
    assert.doesNotMatch(h.log(), /WARN digest task stalled task=T-claim-ok/)
    assert.ok(!h.receiptLines().some((line) => JSON.parse(line).status === 'unclaimed'))
  } finally {
    h.close()
  }
})

// ── T-485: ack and dismissal are different markers on the board ─────────────
test('board markers: a worker ack leaves the watchdog armed, only the requester can dismiss it', async () => {
  const h = await startHarness({ sweepMs: 500 })
  try {
    await dispatchTask(h, 'T-marker')
    await waitFor(() => /digest session=session-claim-worker tasks=1 ids=T-marker/.test(h.log()))

    // 1. The worker acks, as the role card tells it to. That must NOT silence the watch.
    const workerAck = await h.tool('mesh_ack').execute({ ids: ['T-marker'] }, { sessionId: WORKER })
    assert.deepEqual(workerAck.acked, ['T-marker'])
    let row = await h.request(h.base, '/mesh/tasks/T-marker')
    assert.ok(Number(row.json?.task?.ackedAt) > 0, 'the worker ack is recorded')
    assert.equal(row.json?.task?.claimDismissedAt ?? null, null, 'an ack must not dismiss the watchdog')

    // 2. The worker cannot dismiss its own task — that would restore the silent hole.
    const selfDismiss = await h.tool('mesh_ack').execute({ ids: ['T-marker'], dismissClaim: true }, { sessionId: WORKER })
    assert.deepEqual(selfDismiss.skipped, [{ id: 'T-marker', reason: 'dismiss-is-requester-side' }])
    row = await h.request(h.base, '/mesh/tasks/T-marker')
    assert.equal(row.json?.task?.claimDismissedAt ?? null, null)

    // 3. The requester (dispatcher side) can dismiss explicitly, and it is recorded who did.
    const dismiss = await h.tool('mesh_ack').execute({ ids: ['T-marker'], dismissClaim: true }, { sessionId: REQ })
    assert.deepEqual(dismiss.dismissed, ['T-marker'])
    row = await h.request(h.base, '/mesh/tasks/T-marker')
    assert.ok(Number(row.json?.task?.claimDismissedAt) > 0, 'dismissal is a separate marker')
    assert.equal(row.json?.task?.claimDismissedBy, REQ)
    assert.equal(row.json?.task?.status, 'pending', 'dismissal is not a settlement either')
    assert.match(h.log(), /tasks dismiss-claim by=session-claim-req dismissed=1/)
  } finally {
    h.close()
  }
})
