/**
 * T-487 behaviour: `mesh_dispatch` is the single entry, and it routes.
 *
 * These run the real plugin against a fake hub, so the routing decision is exercised rather
 * than pattern-matched. The three cases are exactly the ones that went wrong in practice:
 *
 *   1. target = this machine's own agent id  → refuse, name the local alternative, never POST
 *   2. target = a remote agent on the hub     → hub task (blob + task + local ref row)
 *   3. target = a local session               → local injection, no hub traffic
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const REPO = path.join(import.meta.dirname, '..')
const ENTRY = path.join(REPO, 'plugins', 'mesh-waker', 'index.js')
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-dispatch-routing-${process.pid}.log`)

const SELF = 'dsh-kaniol-pc'
const REMOTE = 'hermes'
const LOCAL = 'session-rq-local'
const CALLER = 'session-rq-caller'

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

/** A hub that records what the plugin actually asked it to do. */
async function startFakeHub() {
  const calls = { blob: [], tasks: [], hubRef: [], peers: 0 }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (url.pathname === '/api/register') return json(200, { name: SELF })
      if (url.pathname === '/api/wake-secret') return json(200, { secret: 'test-secret' })
      if (url.pathname === '/api/peers') {
        calls.peers += 1
        return json(200, { peers: [{ name: SELF, host: 'local', online: true }, { name: REMOTE, host: 'nas', online: true }] })
      }
      if (url.pathname === '/api/blob') {
        calls.blob.push({ raw, name: url.searchParams.get('name') })
        return json(201, { id: 'blob-1', sha256: createHash('sha256').update(raw, 'utf8').digest('hex') })
      }
      if (url.pathname === '/api/tasks') {
        calls.tasks.push(JSON.parse(raw || '{}'))
        return json(201, { task: { task_id: JSON.parse(raw || '{}').task_id } })
      }
      if (url.pathname === '/api/receipts/hub-ref') {
        calls.hubRef.push(JSON.parse(raw || '{}'))
        return json(200, { ok: true })
      }
      if (url.pathname === '/api/inbox') return json(200, { messages: [] })
      return json(404, { error: 'not found' })
    })
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  return { server, calls, url: `http://127.0.0.1:${port}` }
}

async function startHarness({ hubUrl }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-dispatch-routing-'))
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  for (const dir of [sessionsRoot, tokenDir, home]) fs.mkdirSync(dir, { recursive: true })

  const index = {}
  for (const seed of [
    { id: LOCAL, title: 'local target session' },
    { id: CALLER, title: 'caller session' },
  ]) {
    const dir = path.join(sessionsRoot, 'ws-test', seed.id)
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(
      log,
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session/open', data: { cwd: path.join(tmp, 'inbox') } })}\n`)),
    )
    index[seed.id] = { mtime: fs.statSync(log).mtimeMs, title: seed.title, cwd: path.join(tmp, 'inbox') }
  }
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify(index))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, 'test-token')

  const state = { prompts: [], tools: [] }
  const previousEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MESH_WAKER_SESSIONS_ROOT: process.env.MESH_WAKER_SESSIONS_ROOT }
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
    hubUrl,
    workspacePath: path.join(tmp, 'inbox'),
    sessionCwd: path.join(tmp, 'inbox'),
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
    pollIntervalMs: 3600000,
  })
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
  await sleep(150)
  return { state, tool, close, sessionsRoot }
}

test('dispatch to this machine\'s own agent id refuses and points at the local route', async () => {
  const hub = await startFakeHub()
  const h = await startHarness({ hubUrl: hub.url })
  try {
    const dispatch = h.tool('mesh_dispatch')
    assert.ok(dispatch?.execute, 'mesh_dispatch must be registered')
    await assert.rejects(
      async () => await dispatch.execute({ target: SELF, text: 'try to reach myself' }),
      (error) => {
        assert.match(error.message, /own agent id/, 'the error must name the actual mistake')
        assert.match(error.message, /session id|title substring|list_local_sessions/, 'and the local alternative')
        return true
      },
    )
    assert.equal(hub.calls.tasks.length, 0, 'a self-target must never reach the hub')
    assert.equal(hub.calls.blob.length, 0, 'and must not upload a body either')
  } finally {
    h.close()
    await new Promise((resolve) => hub.server.close(resolve))
  }
})

test('dispatch to a remote agent goes over the hub: blob, task row, then the local ref row', async () => {
  const hub = await startFakeHub()
  const h = await startHarness({ hubUrl: hub.url })
  try {
    const dispatch = h.tool('mesh_dispatch')
    const result = await dispatch.execute({ target: REMOTE, text: 'remote work item', subject: 'remote task' })
    assert.equal(result.transport, 'hub', 'the result must say which transport was used')
    assert.equal(result.target, REMOTE)
    assert.equal(hub.calls.blob.length, 1, 'the body must be uploaded as a blob')
    assert.equal(hub.calls.tasks.length, 1, 'exactly one hub task row')
    const task = hub.calls.tasks[0]
    assert.equal(task.target_agent, REMOTE)
    assert.match(task.task_id, /^[A-Z][A-Z0-9]{1,11}-\d{8}-\d{1,6}$/, 'hub task ids are prefixed and dated')
    assert.match(task.text_ref, /^sha256:[0-9a-f]{64}$/)
    assert.ok(task.origin_ws, 'origin_ws is required by the hub')
    assert.equal(hub.calls.hubRef.length, 1, 'the local reference row must be recorded')
    assert.equal(hub.calls.hubRef[0].taskId, task.task_id)
    assert.equal(h.state.prompts.length, 0, 'nothing may be injected locally for a remote target')
  } finally {
    h.close()
    await new Promise((resolve) => hub.server.close(resolve))
  }
})

test('dispatch to a local session injects locally and never touches the hub', async () => {
  const hub = await startFakeHub()
  const h = await startHarness({ hubUrl: hub.url })
  try {
    const dispatch = h.tool('mesh_dispatch')
    const result = await dispatch.execute({ target: LOCAL, text: 'local work item' })
    assert.notEqual(result?.transport, 'hub', 'a local session must not go over the hub')
    assert.equal(hub.calls.tasks.length, 0, 'no hub task for a local target')
    assert.equal(hub.calls.blob.length, 0, 'and no blob upload')
    assert.equal(h.state.prompts.length, 1, 'the local session must be injected')
    assert.equal(h.state.prompts[0].sessionId, LOCAL)
  } finally {
    h.close()
    await new Promise((resolve) => hub.server.close(resolve))
  }
})
