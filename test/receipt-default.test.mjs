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
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-receipt-default-${process.pid}.log`)

const REQ = 'session-rd-req'
const WORKER = 'session-rd-worker'
const TASK_ID = 'T-mwhpo5yh'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 8000, stepMs = 50) => {
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

async function startHarness({ config = {}, tasksSeed = null, digestDelivery = 'off', receiptDigest = 'on', digestIdleDebounceMs = 500 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-receipt-default-'))
  fs.mkdirSync(path.join(tmp, 'inbox'), { recursive: true })
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const receiptFile = path.join(tmp, 'receipts.jsonl')
  const logFile = path.join(tmp, 'waker.log')
  for (const dir of [sessionsRoot, tokenDir, home]) fs.mkdirSync(dir, { recursive: true })
  const index = {}
  for (const seed of [
    { id: REQ, title: 'rd requester' },
    { id: WORKER, title: 'rd worker' },
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

  if (tasksSeed) {
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
    digestDelivery,
    receiptDigest,
    digestIdleDebounceMs,
    // T-483: the plugin-level default must be queue, so the harness does NOT preset a
    // receiptMode — only the per-case `config` object may override it.
    logFile,
    ...config,
  })
  const base = `http://127.0.0.1:${port}`
  const emit = (sessionId, type, turn, extra = {}) => {
    for (const fn of listeners.get('session/event') ?? []) fn({ id: sessionId }, { type, turn, ...extra })
  }
  const tool = (name) => state.tools.find((entry) => entry.name === name)
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  const receiptLines = () => (fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, 'utf8').split('\n').filter(Boolean) : [])
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
  await sleep(80)
  return { base, state, emit, tool, close, request, log, receiptLines, requesterPrompts }
}

// ── a. the default now notifies: no receipt argument → the dispatcher hears it ──
test('receipt default: a dispatch without a receipt argument notifies the requester (T-483)', async () => {
  // The plugin-level default (no receiptMode configured at all) decides here: since T-483
  // it is queue, so an unqualified dispatch reaches its requester. Under the old file
  // default this case produced no notification at all — that is the regression it pins.
  const h = await startHarness()
  try {
    // No receipt argument: the dispatch inherits the plugin default, and since T-483 that
    // default is queue (an explicit receipt:'file' would have to be passed per task).
    const dispatch = await h.tool('mesh_dispatch').execute({ target: 'rd worker', text: 'plain body', taskId: TASK_ID }, { sessionId: REQ })
    assert.equal(dispatch.ok, true)
    h.emit(WORKER, 'turn/start', 1)
    h.emit(WORKER, 'turn/end', 1, { reason: { kind: 'completed' } })
    assert.ok(
      await waitFor(() => h.requesterPrompts().length > 0),
      `expected a receipt notice to the dispatcher, prompts were:\n${JSON.stringify(h.requesterPrompts())}`,
    )
    assert.match(JSON.stringify(h.requesterPrompts()[0].content), new RegExp(TASK_ID))
    const row = await h.request(h.base, `/mesh/tasks/${TASK_ID}`)
    assert.equal(row.json?.task?.status, 'settled')
  } finally {
    h.close()
  }
})

// ── b. with the receipt digest enabled the default routes through the digest ──
test('receipt default + receiptDigest: an unqualified dispatch lands in the receipt digest (T-483)', async () => {
  const h = await startHarness({ config: { receiptDigest: 'on' }, receiptDigest: 'on' })
  try {
    await h.tool('mesh_dispatch').execute({ target: 'rd worker', text: 'digest body', taskId: 'T-rd-digest' }, { sessionId: REQ })
    h.emit(WORKER, 'turn/start', 1)
    h.emit(WORKER, 'turn/end', 1, { reason: { kind: 'completed' } })
    assert.ok(
      await waitFor(() => h.receiptLines().some((line) => JSON.parse(line).taskId === 'T-rd-digest')),
      'the receipt file is still written',
    )
    assert.ok(
      await waitFor(() => /receipt-digest session=session-rd-req/.test(h.log())),
      `expected the receipt-digest path, log was:\n${h.log()}`,
    )
    const row = await h.request(h.base, '/mesh/tasks/T-rd-digest')
    assert.equal(row.json?.task?.receiptDigestSessionId, REQ)
    assert.ok(
      await waitFor(() => h.requesterPrompts().some((prompt) => JSON.stringify(prompt.content).includes('[RECEIPT-DIGEST]'))),
      'the merged notice should reach the requester',
    )
  } finally {
    h.close()
  }
})

// ── c. file stays an explicit opt-in: quiet, JSONL only ───────────────────────
test('receipt file: an explicit --receipt file dispatch still notifies nobody (T-483)', async () => {
  const h = await startHarness()
  try {
    const dispatch = await h.tool('mesh_dispatch').execute(
      { target: 'rd worker', text: 'quiet body', taskId: 'T-rd-quiet', receipt: 'file' },
      { sessionId: REQ },
    )
    assert.equal(dispatch.ok, true)
    h.emit(WORKER, 'turn/start', 1)
    h.emit(WORKER, 'turn/end', 1, { reason: { kind: 'completed' } })
    assert.ok(await waitFor(() => h.receiptLines().some((line) => JSON.parse(line).taskId === 'T-rd-quiet')))
    const receipt = h.receiptLines().map((line) => JSON.parse(line)).find((row) => row.taskId === 'T-rd-quiet')
    assert.equal(receipt.receiptMode, 'file')
    assert.match(h.log(), /file only/)
    assert.equal(h.requesterPrompts().length, 0, 'file mode must not notify')
    assert.doesNotMatch(h.log(), /receipt-digest session=session-rd-req/)
  } finally {
    h.close()
  }
})

// ── d. migration: settled rows without a digest target are counted at boot ────
test('receipt migration: boot counts settled rows that never had a digest target (T-483)', async () => {
  const now = Date.now()
  const h = await startHarness({
    tasksSeed: [
      {
        taskId: 'T-mwhpo5yh',
        status: 'settled',
        targetSessionId: WORKER,
        requesterSessionId: REQ,
        settledAt: now - 1000,
        receiptMode: 'file',
        createdAt: now - 7200000,
      },
      {
        taskId: 'T-migrated',
        status: 'settled',
        targetSessionId: WORKER,
        requesterSessionId: REQ,
        settledAt: now - 1000,
        receiptMode: 'file',
        receiptDigestSessionId: REQ,
        createdAt: now - 7200000,
      },
    ],
  })
  try {
    const log = h.log()
    assert.match(log, /receipt-digest migration: 1 settled row\(s\) without a receipt-digest target/)
  } finally {
    h.close()
  }
})

// ── e. migration: orphan rows from a previous process honour a digest target ──
test('receipt migration: an orphan row with a digest target is delivered as queue, not file', async () => {
  const now = Date.now()
  const h = await startHarness({
    receiptDigest: 'off',
    tasksSeed: [
      {
        taskId: 'T-orphan-digest',
        status: 'pending',
        targetSessionId: WORKER,
        requester: REQ,
        requesterSessionId: REQ,
        receiptMode: 'file',
        receiptDigestSessionId: REQ,
        createdAt: now - 7200000,
      },
    ],
  })
  try {
    // The restart reconciliation marks the orphan lost; its receipt must go out via queue
    // because the row already had a receipt-digest target (T-483).
    assert.ok(await waitFor(() => h.receiptLines().some((line) => JSON.parse(line).taskId === 'T-orphan-digest')))
    const receipt = h.receiptLines().map((line) => JSON.parse(line)).find((row) => row.taskId === 'T-orphan-digest')
    assert.equal(receipt.status, 'lost')
    assert.equal(receipt.receiptMode, 'queue', 'a digest-target row must not be downgraded to file')
    assert.ok(
      await waitFor(() => h.requesterPrompts().some((prompt) => JSON.stringify(prompt.content).includes('T-orphan-digest'))),
      'the lost receipt must reach the dispatcher',
    )
  } finally {
    h.close()
  }
})

// ── f. the plugin default is queue, verbatim ──────────────────────────────────
test('receipt default: the plugin-level receiptMode default is queue (T-483)', async () => {
  const h = await startHarness()
  try {
    const status = await h.request(h.base, '/mesh/status')
    assert.equal(status.json?.receiptMode, 'queue')
  } finally {
    h.close()
  }
})
