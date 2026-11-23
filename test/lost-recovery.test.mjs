import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = path.join(import.meta.dirname, '..')
const ENTRY = path.join(REPO, 'plugins', 'mesh-waker', 'index.js')
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-lost-recovery-${process.pid}.log`)

const REQ = 'session-lr-req'
const WORKER = 'session-lr-worker'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 6000, stepMs = 50) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return false
}

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

async function startHarness({ tasksSeed = [], receiptDigest = 'off' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-lost-recovery-'))
  fs.mkdirSync(path.join(tmp, 'inbox'), { recursive: true })
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const receiptFile = path.join(tmp, 'receipts.jsonl')
  const logFile = path.join(tmp, 'waker.log')
  for (const dir of [sessionsRoot, tokenDir, home]) fs.mkdirSync(dir, { recursive: true })
  const index = {}
  for (const seed of [
    { id: REQ, title: 'lr requester' },
    { id: WORKER, title: 'lr worker' },
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
  if (tasksSeed.length) {
    const registryDir = path.join(home, '.dsh', 'mesh-waker')
    fs.mkdirSync(registryDir, { recursive: true })
    fs.writeFileSync(path.join(registryDir, 'tasks.jsonl'), tasksSeed.map((row) => JSON.stringify(row)).join('\n') + '\n')
  }

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
    receiptDigest,
    receiptMode: 'queue',
    digestIdleDebounceMs: 500,
    logFile,
  })
  const base = `http://127.0.0.1:${port}`
  const tool = (name) => state.tools.find((entry) => entry.name === name)
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  const receiptRows = () =>
    fs.existsSync(receiptFile)
      ? fs.readFileSync(receiptFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
  const requesterPrompts = () => state.prompts.filter((prompt) => prompt.sessionId === REQ)
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
  await sleep(100)
  return { base, state, tool, close, request, log, receiptRows, requesterPrompts }
}

const lostRow = (now, overrides = {}) => ({
  taskId: 'T-lost-1',
  status: 'lost',
  targetSessionId: WORKER,
  targetTitle: 'lr worker',
  requester: REQ,
  requesterSessionId: REQ,
  receiptMode: 'queue',
  subject: 'work that finished after a restart',
  createdAt: now - 7_200_000,
  settledAt: now - 3_600_000,
  reasonKind: 'lost',
  reasonDetail: 'host restart',
  ...overrides,
})

const complete = (h, taskId, status = 'done') =>
  h.tool('mesh_complete').execute({ taskId, status, summary: 'finished after the restart' }, { sessionId: WORKER })

// ── a. a late declaration flips lost → settled and tells the dispatcher ───────
test('lost recovery: a declaration after a restart completes the row and notifies the dispatcher (T-484)', async () => {
  const now = Date.now()
  const h = await startHarness({ tasksSeed: [lostRow(now)] })
  try {
    const result = await complete(h, 'T-lost-1')
    assert.equal(result.ok, true)
    assert.equal(result.recovered, true, `expected a recovery, got ${JSON.stringify(result)}`)
    assert.equal(result.receiptStatus, 'completed')
    const row = await h.request(h.base, '/mesh/tasks/T-lost-1')
    assert.equal(row.json?.task?.status, 'settled')
    assert.equal(row.json?.task?.receiptStatus, 'completed')
    assert.ok(Number(row.json?.task?.recoveredAt) > 0, 'recoveredAt must be recorded')
    assert.ok(Number(row.json?.task?.lostAt) > 0, 'the original lost time must be preserved')
    // The dispatcher is told, in words that mean "do not resend".
    assert.ok(
      await waitFor(() => h.requesterPrompts().length > 0),
      `the dispatcher must hear the recovery, prompts=${JSON.stringify(h.requesterPrompts())}`,
    )
    const text = JSON.stringify(h.requesterPrompts()[0].content)
    assert.match(text, /无需重派/)
    const receipt = h.receiptRows().find((entry) => entry.taskId === 'T-lost-1')
    assert.equal(receipt?.status, 'completed')
    assert.equal(receipt?.source, 'declared')
    assert.match(String(receipt?.reasonDetail), /无需重派/)
    assert.match(h.log(), /recovered lost -> completed|settled lost -> completed/)
  } finally {
    h.close()
  }
})

// ── b. without a declaration the row stays lost ───────────────────────────────
test('lost recovery: a lost row with no declaration stays lost (T-484)', async () => {
  const now = Date.now()
  const h = await startHarness({ tasksSeed: [lostRow(now)] })
  try {
    await sleep(600)
    const row = await h.request(h.base, '/mesh/tasks/T-lost-1')
    assert.equal(row.json?.task?.status, 'lost')
    assert.equal(row.json?.task?.recoveredAt ?? null, null)
    assert.equal(h.receiptRows().filter((entry) => entry.taskId === 'T-lost-1').length, 0)
    assert.equal(h.requesterPrompts().length, 0)
  } finally {
    h.close()
  }
})

// ── c. a completed row stays idempotent: no downgrade, no second receipt ──────
test('lost recovery: re-declaring a completed task is still refused without a second receipt (T-484)', async () => {
  const now = Date.now()
  const h = await startHarness({
    tasksSeed: [lostRow(now, { taskId: 'T-done-1', status: 'settled', receiptStatus: 'completed', settledAt: now - 600_000 })],
  })
  try {
    const before = h.receiptRows().length
    const result = await complete(h, 'T-done-1')
    assert.equal(result.ok, true)
    assert.equal(result.alreadySettled, true)
    const row = await h.request(h.base, '/mesh/tasks/T-done-1')
    assert.equal(row.json?.task?.status, 'settled', 'a completed row must not be downgraded')
    assert.equal(h.receiptRows().length, before, 'a duplicate declaration must not write a receipt')
    assert.equal(row.json?.task?.receiptStatus, 'completed')
  } finally {
    h.close()
  }
})

// ── d. the refusal itself reaches the dispatcher as an advisory ───────────────
test('lost recovery: a refused declaration sends the dispatcher an advisory, not just a log line (T-484)', async () => {
  const now = Date.now()
  const h = await startHarness({
    tasksSeed: [lostRow(now, { taskId: 'T-done-2', status: 'settled', receiptStatus: 'completed', settledAt: now - 600_000 })],
  })
  try {
    await complete(h, 'T-done-2')
    assert.ok(
      await waitFor(() => h.requesterPrompts().length > 0),
      'the dispatcher must be told the duplicate was ignored',
    )
    const text = JSON.stringify(h.requesterPrompts()[0].content)
    assert.match(text, /RECEIPT-ADVISORY/)
    assert.match(text, /duplicate done declaration from session-lr-worker ignored/)
    assert.match(h.log(), /advisory sent: already settled/)
  } finally {
    h.close()
  }
})

// ── e. a stalled row is not lost: refusal keeps its state and advises ────────
test('lost recovery: only lost rows are recoverable; a stalled row keeps its state', async () => {
  const now = Date.now()
  const h = await startHarness({
    tasksSeed: [lostRow(now, { taskId: 'T-stalled-1', status: 'stalled', receiptStatus: null, settledAt: null, stalledAt: now - 1000 })],
  })
  try {
    const result = await complete(h, 'T-stalled-1')
    assert.equal(result.alreadySettled, true)
    const row = await h.request(h.base, '/mesh/tasks/T-stalled-1')
    assert.equal(row.json?.task?.status, 'stalled')
    assert.equal(row.json?.task?.recoveredAt ?? null, null)
    assert.ok(await waitFor(() => h.requesterPrompts().length > 0), 'the refusal is still announced')
  } finally {
    h.close()
  }
})

// ── f. an unsettled row with no in-memory task is declarable, not "already settled" ──
// T-mwtaoe4s (dogfood 2026-11-23): after a plugin reload or a crash the row is still
// pending/started/waiting-lock on disk while pendingTasks is empty. Answering
// alreadySettled:true told the worker its work was done, so it stopped and no outcome was
// ever recorded.
//
// `waiting-lock` is seeded as-is: the boot reconcile does not touch it. For `pending` and
// `started` the row carries a stale settledAt because that is exactly the shape a crashed run
// leaves behind — the reconcile only claims rows with settledAt null, and those legitimately
// become `lost` (covered above). Both shapes must be declarable.
const NO_MEMORY_ROWS = [
  { status: 'waiting-lock' },
  { status: 'pending', settledAtOffset: -1_800_000 },
  { status: 'started', settledAtOffset: -1_800_000, startedAtOffset: -3_600_000 },
]

for (const spec of NO_MEMORY_ROWS) {
  const { status } = spec
  test(`declared settle: a disk-only ${status} row is settled by mesh_complete, not refused (T-mwtaoe4s)`, async () => {
    const now = Date.now()
    const taskId = `T-${status}-1`
    const h = await startHarness({
      tasksSeed: [
        lostRow(now, {
          taskId,
          status,
          receiptStatus: null,
          reasonKind: null,
          reasonDetail: null,
          settledAt: Number.isFinite(spec.settledAtOffset) ? now + spec.settledAtOffset : null,
          ...(Number.isFinite(spec.startedAtOffset) ? { startedAt: now + spec.startedAtOffset } : {}),
        }),
      ],
    })
    try {
      const before = h.receiptRows().length
      const result = await complete(h, taskId)
      assert.equal(result.ok, true)
      assert.notEqual(result.alreadySettled, true, `a ${status} row must not be reported as already settled`)
      assert.equal(result.recovered, true)
      assert.equal(result.declaredRowStatus, status)
      assert.equal(result.receiptStatus, 'completed')
      const row = await h.request(h.base, `/mesh/tasks/${taskId}`)
      assert.equal(row.json?.task?.status, 'settled')
      assert.equal(row.json?.task?.receiptStatus, 'completed')
      assert.ok(Number(row.json?.task?.settledAt) > 0, 'settledAt must be written')
      // A non-lost row was never marked lost, so no lost/recovered timestamps are invented.
      assert.equal(row.json?.task?.recoveredAt ?? null, null, 'a non-lost row must not claim recovery')
      assert.equal(row.json?.task?.lostAt ?? null, null, 'a non-lost row must not claim a lost time')
      assert.equal(h.receiptRows().length, before + 1, 'a real settlement writes exactly one receipt')
      const receipt = h.receiptRows().find((entry) => entry.taskId === taskId)
      assert.equal(receipt?.source, 'declared')
      assert.match(h.log(), new RegExp(`settled ${status} -> completed`))
      // The dispatcher hears about it — this is a completion, not a refusal advisory.
      assert.ok(await waitFor(() => h.requesterPrompts().length > 0), 'the dispatcher must be notified')
      assert.doesNotMatch(JSON.stringify(h.requesterPrompts()[0].content), /RECEIPT-ADVISORY/)
    } finally {
      h.close()
    }
  })
}

// The lost path must keep its own wording on top of the generalized one.
test('declared settle: the lost path still says no resend is needed (T-484 preserved)', async () => {
  const now = Date.now()
  const h = await startHarness({ tasksSeed: [lostRow(now)] })
  try {
    const result = await complete(h, 'T-lost-1')
    assert.equal(result.recovered, true)
    assert.equal(result.declaredRowStatus, 'lost')
    assert.match(String(result.summary), /无需重派/)
    const row = await h.request(h.base, '/mesh/tasks/T-lost-1')
    assert.ok(Number(row.json?.task?.recoveredAt) > 0)
    assert.ok(Number(row.json?.task?.lostAt) > 0)
  } finally {
    h.close()
  }
})
