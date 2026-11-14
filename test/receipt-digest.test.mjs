import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildReceiptDigestText, isReceiptDigestCandidate, receiptBackoffMs } from '../plugins/mesh-waker/lib/receipt-digest.mjs'

const REPO = path.join(import.meta.dirname, '..')
const ENTRY = path.join(REPO, 'plugins', 'mesh-waker', 'index.js')
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-receipt-digest-${process.pid}.log`)

const REQ = 'session-req'
const WORKER = 'session-worker'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Two sessions: a requester (coordinator-like) and a worker that settles tasks. */
async function startHarness({ receiptDigest = 'on', digestIdleDebounceMs = 500, receiptMode = 'queue' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-receipt-digest-'))
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const receiptFile = path.join(tmp, 'receipts.jsonl')
  fs.mkdirSync(sessionsRoot, { recursive: true })
  fs.mkdirSync(tokenDir, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const index = {}
  for (const seed of [
    { id: REQ, title: 'req coord', cwd: path.join(tmp, 'inbox') },
    { id: WORKER, title: 'worker', cwd: path.join(tmp, 'inbox') },
  ]) {
    const dir = path.join(sessionsRoot, 'ws-test', seed.id)
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(log, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session/open', data: { cwd: seed.cwd } }) + '\n')))
    index[seed.id] = { mtime: fs.statSync(log).mtimeMs, title: seed.title, cwd: seed.cwd }
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
  const sessionController = {
    async create() {
      throw new Error('not used in these cases')
    },
    async prompt(payload) {
      state.prompts.push(payload)
      return {}
    },
    async cancel() {},
    async rename() {},
  }
  const workspaceRegistry = {
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
  }
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
    sessionController,
    agents: { get: () => undefined, resume: async () => {} },
    workspaceRegistry,
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
    receiptMode,
    receiptDigest,
    digestIdleDebounceMs,
  })
  const base = `http://127.0.0.1:${port}`
  const emit = (sessionId, type, turn, extra = {}) => {
    for (const fn of listeners.get('session/event') ?? []) fn({ id: sessionId }, { type, turn, ...extra })
  }
  const tool = (name) => state.tools.find((entry) => entry.name === name)
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
  await sleep(50)
  return { base, home, state, emit, tool, close, request, receiptLines, requesterPrompts, receiptFile }
}

const dispatchTask = (h, id) =>
  // The caller's session is the requester (the host injects it); the target is the worker.
  h.tool('mesh_dispatch').execute({ target: 'worker', text: `body ${id}`, taskId: id }, { sessionId: REQ })

const completeTask = (h, id) =>
  h.tool('mesh_complete').execute({ taskId: id, status: 'done', summary: `done ${id}` }, { sessionId: WORKER })

test('receiptDigest off: receipts are injected one by one (current behaviour)', async () => {
  const h = await startHarness({ receiptDigest: 'off' })
  try {
    for (const id of ['T-r1', 'T-r2']) {
      await dispatchTask(h, id)
      await completeTask(h, id)
    }
    await sleep(100)
    const prompts = h.requesterPrompts()
    assert.equal(prompts.length, 2)
    assert.ok(prompts.every((prompt) => JSON.stringify(prompt.content).includes('[RECEIPT]')))
  } finally {
    h.close()
  }
})

test('receiptDigest on: an idle requester gets one merged notice for three receipts', async () => {
  const h = await startHarness()
  try {
    for (const id of ['T-d1', 'T-d2', 'T-d3']) {
      await dispatchTask(h, id)
      await completeTask(h, id)
    }
    assert.equal(h.requesterPrompts().length, 0)
    await sleep(900)
    const prompts = h.requesterPrompts()
    assert.equal(prompts.length, 1)
    const text = prompts[0].content[0].text
    assert.match(text, /^\[RECEIPT-DIGEST\] 3 条任务已完成（未签收）/)
    for (const id of ['T-d1', 'T-d2', 'T-d3']) assert.match(text, new RegExp(`- ${id} `))
    for (const id of ['T-d1', 'T-d2', 'T-d3']) {
      const row = await h.request(h.base, `/mesh/tasks/${id}`)
      assert.equal(row.json?.task?.receiptNotifyCount, 1)
      assert.ok(Number(row.json?.task?.receiptNotifiedAt) > 0)
    }
  } finally {
    h.close()
  }
})

test('receiptDigest on: a busy requester waits for turn/end', async () => {
  const h = await startHarness()
  try {
    h.emit(REQ, 'turn/start', 1)
    await dispatchTask(h, 'T-b1')
    await completeTask(h, 'T-b1')
    await sleep(900)
    assert.equal(h.requesterPrompts().length, 0, 'no notice while the requester is in a turn')
    h.emit(REQ, 'turn/end', 1, { reason: { kind: 'completed' } })
    await sleep(100)
    assert.equal(h.requesterPrompts().length, 1)
    assert.match(h.requesterPrompts()[0].content[0].text, /T-b1/)
  } finally {
    h.close()
  }
})

test('receiptDigest on: mesh_ack silences the reminder and produces no new receipt', async () => {
  const h = await startHarness()
  try {
    for (const id of ['T-a1', 'T-a2']) {
      await dispatchTask(h, id)
      await completeTask(h, id)
    }
    await sleep(900)
    assert.equal(h.requesterPrompts().length, 1)
    const linesBefore = h.receiptLines().length
    const ack = await h.tool('mesh_ack').execute({ ids: ['T-a1', 'T-a2'] }, { sessionId: REQ })
    assert.deepEqual(ack.acked.sort(), ['T-a1', 'T-a2'])
    await sleep(900)
    assert.equal(h.requesterPrompts().length, 1, 'no reminder after the ack')
    assert.equal(h.receiptLines().length, linesBefore, 'ack must not write a receipt')
    const listed = await h.tool('mesh_tasks').execute({}, { sessionId: REQ })
    assert.ok(!listed.tasks.some((row) => row.taskId === 'T-a1'))
  } finally {
    h.close()
  }
})

test('receiptDigest backoff: a second reminder needs the window; two notices is the cap', async () => {
  const h = await startHarness()
  try {
    await dispatchTask(h, 'T-c1')
    await completeTask(h, 'T-c1')
    await sleep(900)
    assert.equal(h.requesterPrompts().length, 1)
    // Another completion inside the 10-minute backoff: no new notice.
    await dispatchTask(h, 'T-c2')
    await completeTask(h, 'T-c2')
    await sleep(900)
    assert.equal(h.requesterPrompts().length, 1)
    assert.equal(receiptBackoffMs(1), 600000)
    assert.equal(receiptBackoffMs(2), 1800000)
    assert.equal(
      isReceiptDigestCandidate(
        { receiptDigestSessionId: 's', settledAt: 1, receiptNotifyCount: 2, receiptNotifiedAt: 1 },
        { sessionId: 's', now: 10 ** 13 },
      ),
      false,
    )
  } finally {
    h.close()
  }
})

test('mesh_tasks unacked lists a settled task whose receipt is unacked', async () => {
  const h = await startHarness()
  try {
    await dispatchTask(h, 'T-l1')
    await completeTask(h, 'T-l1')
    const listed = await h.tool('mesh_tasks').execute({}, { sessionId: REQ })
    const row = listed.tasks.find((entry) => entry.taskId === 'T-l1')
    assert.ok(row, 'the settled-but-unacked receipt must be listed')
    assert.equal(row.acked, false)
    assert.equal(row.receiptStatus, 'completed')
    assert.ok(Number(row.settledAt) > 0)
    assert.equal(listed.count, listed.tasks.length)
    assert.equal(listed.unackedCount, listed.tasks.filter((entry) => !entry.acked).length)
    await h.tool('mesh_ack').execute({ ids: ['T-l1'] }, { sessionId: REQ })
    const after = await h.tool('mesh_tasks').execute({}, { sessionId: REQ })
    assert.ok(!after.tasks.some((entry) => entry.taskId === 'T-l1'))
  } finally {
    h.close()
  }
})

test('buildReceiptDigestText contract', () => {
  const text = buildReceiptDigestText([
    { taskId: 'T-1', reasonKind: 'completed', requester: 'mesh · ops', durationMs: 22000 },
    { taskId: 'T-2', reasonKind: 'error', requester: 'mesh · ops', durationMs: 500 },
  ])
  assert.equal(
    text,
    [
      '[RECEIPT-DIGEST] 2 条任务已完成（未签收）',
      '- T-1 completed（mesh · ops）22s',
      '- T-2 error（mesh · ops）500ms',
      "明细/正文：mesh_tasks({status:'unacked'}) → 看完用 mesh_ack({ids:[...]})",
    ].join('\n'),
  )
})
