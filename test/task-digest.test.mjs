import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildDigestText, digestBackoffMs, isDigestCandidate } from '../plugins/mesh-waker/lib/task-digest.mjs'

const REPO = path.join(import.meta.dirname, '..')
const ENTRY = path.join(REPO, 'plugins', 'mesh-waker', 'index.js')
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-digest-${process.pid}.log`)

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

/** Minimal host: one seeded session, prompt capture and session/event listeners. */
async function startHarness({ digestDelivery = 'on', seedSessions = [{ id: 'session-digest', title: 'digest worker' }] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-digest-'))
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  fs.mkdirSync(sessionsRoot, { recursive: true })
  fs.mkdirSync(tokenDir, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const index = {}
  for (const seed of seedSessions) {
    const dir = path.join(sessionsRoot, 'ws-test', seed.id)
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(log, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session/open', data: { cwd: seed.cwd ?? null } }) + '\n')))
    index[seed.id] = { mtime: fs.statSync(log).mtimeMs, title: seed.title, cwd: seed.cwd ?? null }
  }
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify(index))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, 'test-token')

  const state = { prompts: [], tools: [], created: [] }
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
    async create(request) {
      const id = `session-${randomUUID()}`
      state.created.push({ id, request })
      return { sessionId: id }
    },
    async prompt(prompt) {
      state.prompts.push(prompt)
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
    receiptFile: path.join(tmp, 'receipts.jsonl'),
    batchFile: path.join(tmp, 'batches.json'),
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
    settleHookCommand: '',
    digestDelivery,
  })
  const base = `http://127.0.0.1:${port}`
  const emit = (type, turn, extra = {}) => {
    for (const fn of listeners.get('session/event') ?? []) fn({ id: 'session-digest' }, { type, turn, ...extra })
  }
  const tool = (name) => state.tools.find((entry) => entry.name === name)
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
  return { base, home, state, emit, tool, close, request }
}

const dispatch = (h, args) => h.tool('mesh_dispatch').execute(args, { sessionId: 'session-digest' })

test('digest off: a dispatch still injects the body immediately', async () => {
  const h = await startHarness({ digestDelivery: 'off' })
  try {
    const result = await dispatch(h, { target: 'digest worker', text: 'plain body', taskId: 'T-off-1' })
    assert.equal(result.ok, true)
    assert.equal(h.state.prompts.length, 1)
    assert.match(JSON.stringify(h.state.prompts[0].content), /plain body/)
    assert.equal(result.digestQueued, undefined)
  } finally {
    h.close()
  }
})

test('digest on: a dispatch only lands on the board', async () => {
  const h = await startHarness({ digestDelivery: 'on' })
  try {
    const result = await dispatch(h, { target: 'digest worker', text: 'quiet body', taskId: 'T-on-1' })
    assert.equal(result.ok, true)
    assert.equal(result.digestQueued, true)
    assert.equal(h.state.prompts.length, 0)
    const row = await h.request(h.base, '/mesh/tasks/T-on-1')
    assert.equal(row.json?.task?.status, 'pending')
    assert.equal(row.json?.task?.ackedAt ?? null, null)
    assert.equal(row.json?.task?.notifyCount ?? 0, 0)
  } finally {
    h.close()
  }
})

test('digest on: turn/end injects exactly one digest with every unacked id', async () => {
  const h = await startHarness({ digestDelivery: 'on' })
  try {
    await dispatch(h, { target: 'digest worker', text: 'one', taskId: 'T-d1' })
    await dispatch(h, { target: 'digest worker', text: 'two', taskId: 'T-d2' })
    h.emit('turn/start', 1)
    h.emit('turn/end', 1, { reason: { kind: 'completed' } })
    await sleep(50)
    assert.equal(h.state.prompts.length, 1)
    const text = h.state.prompts[0].content[0].text
    assert.match(text, /^\[TASK-DIGEST\] 2 条待办（未签收）/)
    assert.match(text, /- T-d1 /)
    assert.match(text, /- T-d2 /)
    assert.match(text, /mesh_tasks\(\{include:'text'\}\) → mesh_ack\(\{ids:\[\.\.\.\]\}\)/)
    const row = await h.request(h.base, '/mesh/tasks/T-d1')
    assert.equal(row.json?.task?.notifyCount, 1)
    assert.ok(Number(row.json?.task?.notifiedAt) > 0)
  } finally {
    h.close()
  }
})

test('digest on: an in-flight digest suppresses a second injection', async () => {
  const h = await startHarness({ digestDelivery: 'on' })
  try {
    await dispatch(h, { target: 'digest worker', text: 'one', taskId: 'T-i1' })
    h.emit('turn/start', 1)
    h.emit('turn/end', 1, { reason: { kind: 'completed' } })
    await sleep(50)
    assert.equal(h.state.prompts.length, 1)
    // No turn/start happened: the digest turn is still "in flight".
    await dispatch(h, { target: 'digest worker', text: 'two', taskId: 'T-i2' })
    h.emit('turn/end', 2, { reason: { kind: 'completed' } })
    await sleep(50)
    assert.equal(h.state.prompts.length, 1)
  } finally {
    h.close()
  }
})

test('digest on: acks stop the digest while the tasks stay open', async () => {
  const h = await startHarness({ digestDelivery: 'on' })
  try {
    for (const id of ['T-a1', 'T-a2', 'T-a3']) await dispatch(h, { target: 'digest worker', text: id, taskId: id })
    const ack = await h.tool('mesh_ack').execute({ ids: ['T-a1', 'T-a2', 'T-a3'] }, { sessionId: 'session-digest' })
    assert.deepEqual(ack.acked.sort(), ['T-a1', 'T-a2', 'T-a3'])
    for (const id of ['T-a1', 'T-a2', 'T-a3']) {
      const row = await h.request(h.base, `/mesh/tasks/${id}`)
      assert.ok(Number(row.json?.task?.ackedAt) > 0)
      assert.equal(row.json?.task?.ackBy, 'session-digest')
    }
    h.emit('turn/start', 1)
    h.emit('turn/end', 1, { reason: { kind: 'completed' } })
    await sleep(50)
    assert.equal(h.state.prompts.length, 0)
  } finally {
    h.close()
  }
})

test('mesh_ack skips ids with a reason instead of failing the batch', async () => {
  const h = await startHarness({
    digestDelivery: 'on',
    seedSessions: [
      { id: 'session-digest', title: 'digest worker' },
      { id: 'session-other', title: 'other worker' },
    ],
  })
  try {
    await dispatch(h, { target: 'other worker', text: 'not mine', taskId: 'T-other' })
    await dispatch(h, { target: 'digest worker', text: 'mine', taskId: 'T-mine' })
    await dispatch(h, { target: 'digest worker', text: 'settled', taskId: 'T-settled' })
    await h.tool('mesh_complete').execute({ taskId: 'T-settled', status: 'done' }, { sessionId: 'session-digest' })
    await h.tool('mesh_ack').execute({ ids: ['T-mine'] }, { sessionId: 'session-digest' })
    const ack = await h.tool('mesh_ack').execute({ ids: ['T-mine', 'T-other', 'T-settled', 'T-ghost'] }, { sessionId: 'session-digest' })
    const reasons = Object.fromEntries(ack.skipped.map((item) => [item.id, item.reason]))
    assert.equal(ack.acked.length, 0)
    assert.equal(reasons['T-mine'], 'already-acked')
    assert.equal(reasons['T-other'], 'not-mine')
    assert.equal(reasons['T-settled'], 'settled')
    assert.equal(reasons['T-ghost'], 'not-found')
  } finally {
    h.close()
  }
})

test('digest backoff: one notice, then silence inside the window and after two notices', async () => {
  const h = await startHarness({ digestDelivery: 'on' })
  try {
    await dispatch(h, { target: 'digest worker', text: 'one', taskId: 'T-b1' })
    h.emit('turn/start', 1)
    h.emit('turn/end', 1, { reason: { kind: 'completed' } })
    await sleep(50)
    assert.equal(h.state.prompts.length, 1)
    // Next turn ends well inside the 10-minute backoff: no second digest.
    h.emit('turn/start', 2)
    h.emit('turn/end', 2, { reason: { kind: 'completed' } })
    await sleep(50)
    assert.equal(h.state.prompts.length, 1)
    // Policy: a row that already notified twice is never a candidate again.
    assert.equal(isDigestCandidate({ targetSessionId: 's', status: 'pending', notifyCount: 2, notifiedAt: 1 }, { sessionId: 's', now: 10 ** 13 }), false)
    assert.equal(digestBackoffMs(0), 0)
    assert.equal(digestBackoffMs(1), 600000)
    assert.equal(digestBackoffMs(2), 1800000)
  } finally {
    h.close()
  }
})

test('mesh_tasks include=text returns bodies and flags a missing one', async () => {
  const h = await startHarness({ digestDelivery: 'on' })
  try {
    await dispatch(h, { target: 'digest worker', text: 'body-one', taskId: 'T-t1' })
    await dispatch(h, { target: 'digest worker', text: 'body-two', taskId: 'T-t2' })
    const withText = await h.tool('mesh_tasks').execute({ include: 'text' }, { sessionId: 'session-digest' })
    assert.equal(withText.count, 2)
    assert.equal(withText.tasks.find((row) => row.taskId === 'T-t1').text, 'body-one')
    const sha = createHash('sha256').update('body-two').digest('hex')
    fs.rmSync(path.join(h.home, '.dsh', 'mesh-waker', 'texts', `${sha}.txt`))
    const missing = await h.tool('mesh_tasks').execute({ include: 'text' }, { sessionId: 'session-digest' })
    const row = missing.tasks.find((entry) => entry.taskId === 'T-t2')
    assert.equal(row.text, '')
    assert.equal(row.textMissing, true)
  } finally {
    h.close()
  }
})

test('an acked task still completes through mesh_complete', async () => {
  const h = await startHarness({ digestDelivery: 'on' })
  try {
    await dispatch(h, { target: 'digest worker', text: 'work', taskId: 'T-c1' })
    await h.tool('mesh_ack').execute({ ids: ['T-c1'] }, { sessionId: 'session-digest' })
    const done = await h.tool('mesh_complete').execute({ taskId: 'T-c1', status: 'done', summary: 'finished' }, { sessionId: 'session-digest' })
    assert.equal(done.ok, true)
    assert.equal(done.receiptStatus, 'completed')
    const row = await h.request(h.base, '/mesh/tasks/T-c1')
    assert.equal(row.json?.task?.status, 'settled')
    assert.ok(Number(row.json?.task?.ackedAt) > 0)
  } finally {
    h.close()
  }
})

test('mesh_tasks count and unackedCount come from the same list', async () => {
  const h = await startHarness({ digestDelivery: 'on' })
  try {
    for (const id of ['T-n1', 'T-n2', 'T-n3']) await dispatch(h, { target: 'digest worker', text: id, taskId: id })
    await h.tool('mesh_ack').execute({ ids: ['T-n2'] }, { sessionId: 'session-digest' })
    const all = await h.tool('mesh_tasks').execute({ status: 'all' }, { sessionId: 'session-digest' })
    assert.equal(all.count, all.tasks.length)
    assert.equal(all.unackedCount, all.tasks.filter((row) => !row.acked).length)
    const unacked = await h.tool('mesh_tasks').execute({}, { sessionId: 'session-digest' })
    assert.equal(unacked.count, 2)
    assert.equal(unacked.unackedCount, 2)
    assert.ok(!unacked.tasks.some((row) => row.taskId === 'T-n2'))
  } finally {
    h.close()
  }
})

test('buildDigestText contract', () => {
  const text = buildDigestText([
    { taskId: 'T-1', subject: 'first task' },
    { taskId: 'T-2', subject: 'second task' },
  ])
  assert.equal(
    text,
    [
      '[TASK-DIGEST] 2 条待办（未签收）',
      '- T-1 first task',
      '- T-2 second task',
      "取正文并签收：mesh_tasks({include:'text'}) → mesh_ack({ids:[...]})",
    ].join('\n'),
  )
})
