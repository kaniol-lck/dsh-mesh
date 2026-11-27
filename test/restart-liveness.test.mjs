/**
 * Restart reconciliation must not declare a task dead just because this process has no memory
 * of it (T-mwxjfvwn / DEFECT: T-MWXHO5U1).
 *
 * The real incident: T-MWXHO5U1 was marked lost at 12:30:02 with "session restarted before this
 * task finished; resend if still needed", while its session was still active at 12:35:39 and
 * alive now. The old rule treated "not in pendingTasks" as "the task is dead"; a DSH session is
 * persisted, so that inference is invalid.
 *
 * Measured premise (see the probe in the commit): at boot a persisted session reports
 * `live: false`, `turnOpen: false`, `lastActivityAt: null` — the host only reports life once the
 * session is resumed and emits an event. That is why reconciliation is two-phase: hold at boot,
 * judge after the grace window.
 */

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
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-restart-liveness-${process.pid}.log`)

const REQ = 'session-rl-req'
const WORKER = 'session-rl-worker'
const GONE = 'session-rl-gone'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll until `predicate` is truthy (T-mwxx12b8).
 *
 * The grace-window cases used a fixed `sleep(...)` sized to the window. That holds when the file
 * runs alone but not under the full suite's load, where the timer can fire later than the sleep
 * and the assertion sees the pre-recheck state — the intermittent failure the coordinator saw
 * once as 263/264. Waiting for the observable fact instead of the clock removes the race.
 */
async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) return null
    await sleep(intervalMs)
  }
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

async function request(base, route, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

/**
 * Boot the plugin against a seeded task ledger.
 *
 * `liveSessions` names the sessions the host reports as live (ctx.agents.get returns an object).
 * `activity` maps sessionId -> lastActivityAt to simulate a session that spoke after boot.
 */
async function startHarness({
  tasksSeed = [],
  liveSessions = [],
  activity = {},
  sessionIds = [REQ, WORKER],
  archivedSessions = [],
  restartGraceMs = 300,
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-restart-liveness-'))
  const inbox = path.join(tmp, 'inbox')
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const receiptFile = path.join(tmp, 'receipts.jsonl')
  const logFile = path.join(tmp, 'waker.log')
  for (const dir of [inbox, sessionsRoot, tokenDir, home]) fs.mkdirSync(dir, { recursive: true })

  const index = {}
  for (const id of sessionIds) {
    const dir = path.join(sessionsRoot, 'ws-test', id)
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(log, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session/open', data: { cwd: inbox } })}\n`)))
    index[id] = { mtime: fs.statSync(log).mtimeMs, title: id, cwd: inbox }
  }
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify(index))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, 'test-token')
  if (tasksSeed.length) {
    const registryDir = path.join(home, '.dsh', 'mesh-waker')
    fs.mkdirSync(registryDir, { recursive: true })
    fs.writeFileSync(path.join(registryDir, 'tasks.jsonl'), `${tasksSeed.map((row) => JSON.stringify(row)).join('\n')}\n`)
  }

  const live = new Set(liveSessions)
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
    agents: { get: (id) => (live.has(id) ? { id } : undefined), resume: async () => {} },
    workspaceRegistry: {
      archivedSessionIds: () => new Set(archivedSessions),
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
    workspacePath: inbox,
    sessionCwd: inbox,
    receiptFile,
    batchFile: path.join(tmp, 'batches.json'),
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
    settleHookCommand: '',
    digestDelivery: 'off',
    receiptDigest: 'off',
    receiptMode: 'queue',
    restartGraceMs,
    claimSweepMs: 500,
    logFile,
  })
  const base = `http://127.0.0.1:${port}`

  // Simulate a session that is alive and emitting: the host reports it live AND a real session
  // event lands, which is what fills the liveness ledger `lastActivityAt` is read from.
  const emitActivity = (sessionId) => {
    live.add(sessionId)
    for (const fn of listeners.get('session/event') ?? []) fn({ id: sessionId }, { type: 'turn/start', turn: 1 })
  }

  const tool = (name) => state.tools.find((entry) => entry.name === name)
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  const receiptRows = () =>
    fs.existsSync(receiptFile)
      ? fs.readFileSync(receiptFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
  const taskRow = async (taskId) => (await request(base, `/mesh/tasks/${taskId}`)).json?.task ?? null
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
  await sleep(150)
  return { base, state, tool, close, request, log, receiptRows, taskRow, emitActivity }
}

const orphanRow = (now, overrides = {}) => ({
  taskId: 'T-orphan-1',
  status: 'started',
  targetSessionId: WORKER,
  targetTitle: 'rl worker',
  requester: REQ,
  requesterSessionId: REQ,
  receiptMode: 'queue',
  subject: 'work in flight when the host restarted',
  createdAt: now - 600_000,
  startedAt: now - 590_000,
  settledAt: null,
  ...overrides,
})

// ── A. a session that comes back to life is not declared dead ────────────────
test('restart: a live session keeps its task out of `lost` and writes no lost receipt', async () => {
  const now = Date.now()
  const h = await startHarness({
    tasksSeed: [orphanRow(now)],
    // The host resumed this session: it is live, so both the boot verdict and the grace recheck
    // must leave it alone.
    liveSessions: [WORKER],
    restartGraceMs: 700,
  })
  try {
    await sleep(300)
    const row = await h.taskRow('T-orphan-1')
    assert.notEqual(row?.status, 'lost', `a live session must not be declared dead (row=${JSON.stringify(row?.status)})`)
    assert.equal(row?.status, 'pending')
    assert.ok(Number(row?.deferredAt) > 0, 'the deferral must be recorded')
    assert.equal(row?.deferredReason, 'session-alive-after-restart')
    assert.equal(row?.settledAt ?? null, null, 'no settlement timestamp on a deferred row')
    assert.match(h.log(), /restart reconciliation: deferred T-orphan-1 \(session still live\)/)

    // Past the grace window the recheck looks again: still live, so still pending.
    await sleep(1200)
    const afterGrace = await h.taskRow('T-orphan-1')
    assert.equal(afterGrace?.status, 'pending', 'the recheck must not kill a live session')
    assert.match(h.log(), /T-orphan-1 is alive after the grace window; staying pending/)
    assert.equal(
      h.receiptRows().filter((receipt) => receipt.taskId === 'T-orphan-1' && receipt.status === 'lost').length,
      0,
      'a deferred row must not produce a lost receipt',
    )
  } finally {
    h.close()
  }
})

// ── B. a session that really is gone still gets its lost receipt ─────────────
test('restart: a missing session is still marked lost and the receipt is delivered', async () => {
  const now = Date.now()
  const h = await startHarness({
    tasksSeed: [orphanRow(now, { taskId: 'T-orphan-gone', targetSessionId: GONE })],
    sessionIds: [REQ, WORKER], // GONE is deliberately absent
  })
  try {
    await sleep(400)
    const row = await h.taskRow('T-orphan-gone')
    assert.equal(row?.status, 'lost', 'a session that no longer exists is a real loss')
    assert.ok(Number(row?.settledAt) > 0)
    const lost = h.receiptRows().filter((receipt) => receipt.taskId === 'T-orphan-gone' && receipt.status === 'lost')
    assert.equal(lost.length, 1, 'the dispatcher still hears about a genuinely lost task')
    assert.equal(lost[0].reasonDetail, 'host restart')
    assert.match(h.log(), /task T-orphan-gone marked lost after restart/)
  } finally {
    h.close()
  }
})

test('restart: an archived session is still marked lost', async () => {
  const now = Date.now()
  const h = await startHarness({
    tasksSeed: [orphanRow(now, { taskId: 'T-orphan-arch', targetSessionId: WORKER })],
    liveSessions: [WORKER],
    archivedSessions: [WORKER],
  })
  try {
    await sleep(400)
    const row = await h.taskRow('T-orphan-arch')
    assert.equal(row?.status, 'lost', 'an archived session cannot finish the work')
    assert.equal(h.receiptRows().filter((receipt) => receipt.taskId === 'T-orphan-arch').length, 1)
  } finally {
    h.close()
  }
})

// ── C. a failing probe must not become a death sentence ─────────────────────
// The in-process plugin swallows filesystem errors inside discoverSessions(), so this case is
// driven at module level: what matters is receipt-flow's own reaction to a probe that fails.
test('restart: a failing session probe judges nothing and says so', async () => {
  const now = Date.now()
  const logs = []
  const rows = new Map([
    [
      'T-orphan-probe',
      {
        taskId: 'T-orphan-probe',
        status: 'started',
        targetSessionId: WORKER,
        requester: REQ,
        requesterSessionId: REQ,
        receiptMode: 'queue',
        createdAt: now - 600_000,
        startedAt: now - 590_000,
        settledAt: null,
      },
    ],
  ])
  const { createReceiptFlow } = await import(pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'lib', 'receipt-flow.mjs')).href)
  const flow = createReceiptFlow({
    state: {},
    config: { receiptTo: '', wakeSecret: '', receiptSummaryChars: 200 },
    log: { warn() {} },
    fileLog: (line) => logs.push(line),
    listLocalSessions: () => {
      throw new Error('session index unreadable')
    },
    resolveLocalSession: () => ({ id: REQ }),
    promptWithResume: async () => {},
    receiptDigest: { enabled: false },
    receiptBody: () => 'body',
    writeReceiptFile: () => {},
    dirForRow: () => '',
    updateTaskRow: (taskId, patch) => Object.assign(rows.get(taskId), patch),
    taskRows: rows,
    getLastReceipt: () => null,
    setLastReceipt: () => {},
  })
  const result = await flow.reconcileOrphanTasks()
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'probe-failed')
  const row = rows.get('T-orphan-probe')
  assert.equal(row.status, 'started', 'the row is left exactly as it was')
  assert.equal(row.settledAt, null)
  assert.equal(row.deferredAt, undefined, 'no deferral marker either: we did not judge it')
  assert.match(logs.join('\n'), /WARN restart reconciliation skipped: session probe failed \(session index unreadable\)/)
})

// ── D2. the narrowing this task asked for (T-mwxmcynk) ───────────────────────
// Driven at module level: `lastActivityAt` comes from the in-memory event ledger, which only
// ever records "now". To reproduce "the session was active 10 minutes ago" the probe itself has
// to answer with a past timestamp, so the verdict functions are exercised through stub deps.
function makeStubFlow({ sessions, rows, logs = [], receipts = [] }) {
  return import(pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'lib', 'receipt-flow.mjs')).href).then(
    ({ createReceiptFlow }) =>
      createReceiptFlow({
        state: {},
        config: { receiptTo: '', wakeSecret: '', receiptSummaryChars: 200, restartGraceMs: 300_000 },
        log: { warn() {} },
        fileLog: (line) => logs.push(line),
        listLocalSessions: () => sessions,
        resolveLocalSession: () => ({ id: REQ }),
        promptWithResume: async () => {},
        receiptDigest: { enabled: false },
        receiptBody: () => 'body',
        writeReceiptFile: (receipt) => receipts.push(receipt),
        dirForRow: () => '',
        updateTaskRow: (taskId, patch) => Object.assign(rows.get(taskId), patch),
        taskRows: rows,
        getLastReceipt: () => null,
        setLastReceipt: () => {},
      }),
  )
}

const stubRow = (now, overrides = {}) => ({
  taskId: 'T-stub',
  status: 'started',
  targetSessionId: WORKER,
  targetTitle: 'rl worker',
  requester: REQ,
  requesterSessionId: REQ,
  receiptMode: 'queue',
  createdAt: now - 7_200_000,
  startedAt: now - 7_000_000,
  settledAt: null,
  ...overrides,
})

test('restart: activity BEFORE this process started is not evidence, even if it is after createdAt', async () => {
  // The rule that was removed: `lastActivityAt > row.createdAt`. It is nearly always true, and
  // what it describes happened BEFORE the restart — exactly the evidence a restart cannot
  // distinguish from a dead task. It kept every quiet row alive forever, so the recheck path
  // was dead code and quiet rows leaked.
  const now = Date.now()
  const rows = new Map([['T-old-activity', stubRow(now, { taskId: 'T-old-activity' })]])
  const logs = []
  const receipts = []
  const flow = await makeStubFlow({
    rows,
    logs,
    receipts,
    sessions: [
      {
        id: WORKER,
        live: false,
        turnOpen: false,
        archived: false,
        // Active 10 minutes ago: AFTER createdAt (2h ago), BEFORE this process started.
        lastActivityAt: now - 600_000,
      },
    ],
  })

  const boot = await flow.reconcileOrphanTasks()
  assert.equal(rows.get('T-old-activity').status, 'pending')
  assert.equal(boot.deferred, 0, 'pre-boot activity must not be treated as "alive"')
  assert.equal(boot.held, 1, 'it is held, awaiting the grace window')
  assert.equal(rows.get('T-old-activity').deferredReason, 'awaiting-restart-grace')

  const recheck = await flow.recheckDeferredTasks()
  assert.equal(recheck.checked, 1, 'the held row is really re-examined')
  assert.equal(recheck.lost, 1, 'and judged dead once the window passes')
  assert.equal(rows.get('T-old-activity').status, 'lost')
  assert.equal(receipts.filter((receipt) => receipt.taskId === 'T-old-activity' && receipt.status === 'lost').length, 1)
})

test('restart: activity AFTER this process started is evidence and spares the row', async () => {
  // The other half of the same rule: post-boot activity is the signal a restart cannot fake.
  const now = Date.now()
  const rows = new Map([['T-new-activity', stubRow(now, { taskId: 'T-new-activity' })]])
  const receipts = []
  const flow = await makeStubFlow({
    rows,
    receipts,
    sessions: [{ id: WORKER, live: false, turnOpen: false, archived: false, lastActivityAt: Date.now() + 60_000 }],
  })
  await flow.reconcileOrphanTasks()
  assert.equal(rows.get('T-new-activity').deferredReason, 'session-alive-after-restart')
  const recheck = await flow.recheckDeferredTasks()
  assert.equal(recheck.alive, 1)
  assert.equal(rows.get('T-new-activity').status, 'pending')
  assert.equal(receipts.length, 0)
})

test('restart: a live session at the grace recheck stays pending (G)', async () => {
  const now = Date.now()
  const h = await startHarness({
    tasksSeed: [orphanRow(now, { taskId: 'T-live-g' })],
    liveSessions: [WORKER],
    restartGraceMs: 700,
  })
  try {
    await sleep(1200)
    const row = await h.taskRow('T-live-g')
    assert.equal(row?.status, 'pending', 'a live session must survive the recheck')
    assert.equal(h.receiptRows().filter((receipt) => receipt.taskId === 'T-live-g').length, 0, 'and get no receipt')
  } finally {
    h.close()
  }
})

// ── D. the grace window decides, and it is one-shot ──────────────────────────
test('restart: a quiet session is held at boot and only judged after the grace window', async () => {
  const now = Date.now()
  const h = await startHarness({ tasksSeed: [orphanRow(now, { taskId: 'T-orphan-hold' })], restartGraceMs: 700 })
  try {
    // Immediately after boot the row is held, not lost: at boot the host cannot tell.
    const early = await h.taskRow('T-orphan-hold')
    assert.equal(early?.status, 'pending', 'a quiet session is held, never judged at boot')
    assert.equal(early?.deferredReason, 'awaiting-restart-grace')
    assert.match(h.log(), /restart reconciliation: held T-orphan-hold/)

    // Wait for the recheck to rule, not for a fixed slice of wall clock.
    const judged = await waitFor(async () => {
      const row = await h.taskRow('T-orphan-hold')
      return row?.status === 'lost' ? row : null
    })
    assert.ok(judged, 'the grace recheck must judge the held row within the timeout')
    assert.match(h.log(), /grace expired for T-orphan-hold/)
    assert.equal(h.receiptRows().filter((receipt) => receipt.taskId === 'T-orphan-hold' && receipt.status === 'lost').length, 1)
  } finally {
    h.close()
  }
})

test('restart: a session that speaks during the grace window is spared', async () => {
  const now = Date.now()
  const h = await startHarness({ tasksSeed: [orphanRow(now, { taskId: 'T-orphan-spared' })], restartGraceMs: 900 })
  try {
    const early = await h.taskRow('T-orphan-spared')
    assert.equal(early?.status, 'pending')
    // The session resumes before the grace window expires.
    h.emitActivity(WORKER)
    const released = await waitFor(async () => {
      const row = await h.taskRow('T-orphan-spared')
      return row?.deferredAt === null || row?.deferredAt === undefined ? row : null
    })
    assert.ok(released, 'the recheck must clear the deferral within the timeout')
    const late = await h.taskRow('T-orphan-spared')
    assert.equal(late?.status, 'pending', 'the session came back inside the window')
    assert.match(h.log(), /is alive after the grace window; staying pending/)
    assert.equal(h.receiptRows().filter((receipt) => receipt.taskId === 'T-orphan-spared').length, 0)
  } finally {
    h.close()
  }
})

// ── E. the stalled recovery must not be undone by the claim sweep ────────────
test('restart: a deferred row is not re-stalled by the claim sweep', async () => {
  const now = Date.now()
  // Shape of the 11-25 → 11-26 regression: a row claimSweep rescued from `stalled`, carrying
  // resumedAt and an old startedAt, then held by restart reconciliation.
  const h = await startHarness({
    tasksSeed: [
      orphanRow(now, {
        taskId: 'T-resumed',
        status: 'pending',
        declaredOnly: true,
        resumedAt: now - 3_600_000,
        resumedReason: 'started-after-stall',
        startedAt: now - 7_200_000,
        notifiedAt: now - 10_800_000,
        claimWarnedAt: now - 9_000_000,
        stalledAt: now - 8_000_000,
      }),
    ],
    liveSessions: [WORKER],
    // The row is deferred at boot and re-judged at the grace window; both must keep it alive.
    restartGraceMs: 700,
  })
  try {
    // Wait for the recheck to actually release the deferral, not for a fixed number of ms: under
    // the full suite's load the timer fires later than a fixed sleep would assume.
    const released = await waitFor(async () => {
      const row = await h.taskRow('T-resumed')
      return row?.deferredAt === null || row?.deferredAt === undefined ? row : null
    })
    assert.ok(released, 'the recheck must release the deferral within the timeout')
    const row = await h.taskRow('T-resumed')
    assert.notEqual(row?.status, 'stalled', 'the claim sweep must not re-stall a claimed row')
    assert.notEqual(row?.status, 'lost', 'and restart reconciliation must not kill it either')
    assert.equal(row?.status, 'pending')
    assert.match(h.log(), /T-resumed is alive after the grace window; staying pending/)
    assert.doesNotMatch(h.log(), /digest task stalled task=T-resumed/, 'no re-stall after the resume')
  } finally {
    h.close()
  }
})

// ── F. historical false `lost` rows are only resurrected with evidence ───────
test('restart: a lost row whose session was active afterwards is resurrected', async () => {
  const now = Date.now()
  const lostAt = now - 3_600_000
  const h = await startHarness({
    tasksSeed: [
      {
        taskId: 'T-false-lost',
        status: 'lost',
        targetSessionId: WORKER,
        targetTitle: 'rl worker',
        requester: REQ,
        requesterSessionId: REQ,
        receiptMode: 'queue',
        subject: 'wrongly declared lost',
        createdAt: now - 7_200_000,
        startedAt: now - 7_000_000,
        settledAt: lostAt,
        reasonKind: 'lost',
        reasonDetail: 'host restart',
      },
    ],
    liveSessions: [WORKER],
    restartGraceMs: 700,
  })
  try {
    // It spoke after being declared dead: the verdict was provably wrong.
    h.emitActivity(WORKER)
    await sleep(1200)
    const row = await h.taskRow('T-false-lost')
    assert.equal(row?.status, 'pending', 'the false verdict is undone')
    assert.ok(Number(row?.resurrectedAt) > 0, 'the resurrection is recorded')
    assert.equal(row?.resurrectedReason, 'session-active-after-lost')
    assert.equal(row?.settledAt ?? null, null, 'it is not settled any more')
    assert.match(h.log(), /restart reconciliation: resurrected T-false-lost/)
  } finally {
    h.close()
  }
})

test('restart: a lost row with no later activity is left alone', async () => {
  const now = Date.now()
  const lostAt = now - 3_600_000
  const h = await startHarness({
    tasksSeed: [
      {
        taskId: 'T-still-lost',
        status: 'lost',
        targetSessionId: WORKER,
        targetTitle: 'rl worker',
        requester: REQ,
        requesterSessionId: REQ,
        receiptMode: 'queue',
        subject: 'genuinely lost',
        createdAt: now - 7_200_000,
        settledAt: lostAt,
        reasonKind: 'lost',
        reasonDetail: 'host restart',
      },
    ],
    liveSessions: [WORKER],
    restartGraceMs: 700,
    // No event is emitted at all: lastActivityAt stays null, i.e. the session never spoke after
    // the verdict. That is not evidence, so the row must stay lost.
  })
  try {
    await sleep(1200)
    const row = await h.taskRow('T-still-lost')
    assert.equal(row?.status, 'lost', 'no evidence means no resurrection')
    assert.equal(row?.resurrectedAt ?? null, null)
    assert.doesNotMatch(h.log(), /resurrected T-still-lost/)
  } finally {
    h.close()
  }
})

test('restart: a lost row from a non-restart reason is never resurrected', async () => {
  const now = Date.now()
  const h = await startHarness({
    tasksSeed: [
      {
        taskId: 'T-not-started-lost',
        status: 'lost',
        targetSessionId: WORKER,
        requester: REQ,
        requesterSessionId: REQ,
        receiptMode: 'queue',
        createdAt: now - 7_200_000,
        settledAt: now - 3_600_000,
        reasonKind: 'lost',
        reasonDetail: 'no turn/start within 600000ms',
      },
    ],
    liveSessions: [WORKER],
    restartGraceMs: 700,
  })
  try {
    h.emitActivity(WORKER)
    await sleep(1200)
    const row = await h.taskRow('T-not-started-lost')
    assert.equal(row?.status, 'lost', 'only `host restart` verdicts can be wrong in this way')
  } finally {
    h.close()
  }
})
