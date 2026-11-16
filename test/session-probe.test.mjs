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
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-session-probe-${process.pid}.log`)

const REQ = 'session-sp-req'
const WORKER = 'session-sp-worker'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function startHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-session-probe-'))
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const receiptFile = path.join(tmp, 'receipts.jsonl')
  const logFile = path.join(tmp, 'waker.log')
  for (const dir of [sessionsRoot, tokenDir, home]) fs.mkdirSync(dir, { recursive: true })
  const index = {}
  for (const seed of [
    { id: REQ, title: 'sp requester' },
    { id: WORKER, title: 'sp worker' },
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

  const state = { prompts: [], tools: [], cancels: [] }
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
      async cancel(payload) {
        state.cancels.push(payload)
      },
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
    digestDelivery: 'off',
    receiptDigest: 'off',
    receiptMode: 'queue',
    logFile,
  })
  const base = `http://127.0.0.1:${port}`
  const emit = (sessionId, type, turn, extra = {}) => {
    for (const fn of listeners.get('session/event') ?? []) fn({ id: sessionId }, { type, turn, ...extra })
  }
  const tool = (name) => state.tools.find((entry) => entry.name === name)
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  const receiptRows = () =>
    fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
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
  return { base, state, tool, close, request, log, receiptRows, emit }
}

const probe = (h, id) => h.request(h.base, `/mesh/sessions/${encodeURIComponent(id)}`)

// ── a. turnOpen is the reason this endpoint exists ───────────────────────────
test('session probe (a): turnOpen follows the turn, and only an event changes it (T-488)', async () => {
  const h = await startHarness()
  try {
    let res = await probe(h, WORKER)
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json?.session?.turnOpen, false)
    assert.equal(res.json?.session?.id, WORKER)

    h.emit(WORKER, 'turn/start', 5)
    res = await probe(h, WORKER)
    assert.equal(res.json?.session?.turnOpen, true, 'a running turn must be visible')
    assert.equal(res.json?.session?.turn, 5)
    assert.ok(Number(res.json?.session?.lastTurnStartedAt) > 0)

    h.emit(WORKER, 'turn/end', 5, { reason: { kind: 'completed' } })
    res = await probe(h, WORKER)
    assert.equal(res.json?.session?.turnOpen, false)
    assert.ok(Number(res.json?.session?.lastActivityAt) > 0)

    // Read-only: probing twice changes nothing, and never creates a ledger entry.
    const again = await probe(h, WORKER)
    assert.deepEqual(again.json?.session, res.json?.session)
  } finally {
    h.close()
  }
})

// ── b. unknown id is a 404 that says so ─────────────────────────────────────
test('session probe (b): an unknown session id returns 404 with the id in the body (T-488)', async () => {
  const h = await startHarness()
  try {
    const res = await probe(h, 'session-does-not-exist')
    assert.equal(res.status, 404)
    assert.equal(res.json?.ok, false)
    assert.match(String(res.json?.error), /session-does-not-exist/)
  } finally {
    h.close()
  }
})

// ── c. the list carries the same two fields ─────────────────────────────────
test('session probe (c): the sessions list exposes turnOpen and lastActivityAt (T-488)', async () => {
  const h = await startHarness()
  try {
    const list = await h.request(h.base, '/mesh/sessions')
    assert.equal(list.status, 200)
    const worker = list.json?.sessions.find((session) => session.id === WORKER)
    assert.ok(worker, 'the seeded worker must be listed')
    assert.equal(worker.turnOpen, false)
    assert.equal(worker.lastActivityAt, null, 'no events yet')
    assert.ok(Number(worker.last_active) > 0, 'the legacy mtime field is untouched')

    h.emit(WORKER, 'turn/start', 3)
    h.emit(WORKER, 'assistant/message', 3, { message: { content: [{ type: 'text', text: 'hi' }] } })
    const after = await h.request(h.base, '/mesh/sessions')
    const updated = after.json?.sessions.find((session) => session.id === WORKER)
    assert.equal(updated.turnOpen, true)
    assert.ok(Number(updated.lastActivityAt) > 0)
  } finally {
    h.close()
  }
})

// ── d. dryRun answers without stopping anything ─────────────────────────────
test('session probe (d): mesh_cancel({dryRun:true}) reports the open turn and leaves it running (T-488)', async () => {
  const h = await startHarness()
  try {
    const dispatch = await h.tool('mesh_dispatch').execute({ target: 'sp worker', text: 'long job', taskId: 'T-dry' }, { sessionId: REQ })
    assert.equal(dispatch.ok, true)
    h.emit(WORKER, 'turn/start', 1)

    const before = h.receiptRows().length
    const result = await h.tool('mesh_cancel').execute({ session: WORKER, dryRun: true }, { sessionId: REQ })
    assert.equal(result.dryRun, true)
    assert.equal(result.turnWasOpen, true)
    assert.equal(result.turn, 1)
    assert.equal(result.sessionLive, false, 'no agent in this harness')

    // The point of the whole task: nothing changed.
    assert.equal(h.state.cancels.length, 0, 'dryRun must not call sessionController.cancel')
    const after = await probe(h, WORKER)
    assert.equal(after.json?.session?.turnOpen, true, 'the turn is still running')
    assert.equal(h.receiptRows().length, before, 'dryRun must not write a receipt')
    const row = await h.request(h.base, '/mesh/tasks/T-dry')
    assert.ok(['pending', 'started'].includes(row.json?.task?.status), 'dryRun must not settle the task')
    assert.equal(row.json?.task?.settledAt ?? null, null, 'dryRun must not settle the task')
    assert.match(h.log(), /cancel dryRun .*turnWasOpen=true/)
  } finally {
    h.close()
  }
})

// ── e. the real cancel is unchanged ─────────────────────────────────────────
test('session probe (e): mesh_cancel without dryRun still stops the turn and settles the task (T-488)', async () => {
  const h = await startHarness()
  try {
    await h.tool('mesh_dispatch').execute({ target: 'sp worker', text: 'long job', taskId: 'T-real' }, { sessionId: REQ })
    h.emit(WORKER, 'turn/start', 1)

    const result = await h.tool('mesh_cancel').execute({ task: 'T-real', reason: 'test' }, { sessionId: REQ })
    assert.equal(result.turnWasOpen, true)
    assert.equal(result.dryRun ?? null, null, 'a real cancel does not claim to be a dry run')
    assert.equal(h.state.cancels.length, 1, 'the real cancel asks the host to stop the turn')
    const row = await h.request(h.base, '/mesh/tasks/T-real')
    assert.equal(row.json?.task?.status, 'cancelled')
    const receipt = h.receiptRows().find((entry) => entry.taskId === 'T-real')
    assert.equal(receipt?.status, 'aborted')
  } finally {
    h.close()
  }
})
