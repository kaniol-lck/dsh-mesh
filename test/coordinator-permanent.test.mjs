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
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-coord-perm-${process.pid}.log`)

const SLUG = 'coord-perm'
const LEASE_MS = 600_000

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-coord-perm-'))
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const cwd = path.join(tmp, 'Projects', SLUG, 'public')
  const logFile = path.join(tmp, 'waker.log')
  for (const dir of [sessionsRoot, tokenDir, home, cwd]) fs.mkdirSync(dir, { recursive: true })

  const sessions = [
    { id: 'session-cp-a', title: 'cp one' },
    { id: 'session-cp-b', title: 'cp two' },
    { id: 'session-cp-c', title: 'cp three' },
  ]
  const index = {}
  for (const seed of sessions) {
    const dir = path.join(sessionsRoot, 'ws-test', seed.id)
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(log, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session/open', data: { cwd } }) + '\n')))
    index[seed.id] = { mtime: fs.statSync(log).mtimeMs, title: seed.title, cwd }
  }
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify(index))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, 'test-token')

  // The workspace must exist in the registry before boot, otherwise the claim has no slug.
  const meshHome = path.join(home, '.dsh', 'mesh-waker')
  fs.mkdirSync(meshHome, { recursive: true })
  fs.writeFileSync(
    path.join(meshHome, 'workspaces.json'),
    `${JSON.stringify({ machine: 'test-machine', workspaces: { [SLUG]: { cwd } } }, null, 2)}\n`,
  )

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
    workspacePath: cwd,
    sessionCwd: cwd,
    receiptFile: path.join(tmp, 'receipts.jsonl'),
    batchFile: path.join(tmp, 'batches.json'),
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
    settleHookCommand: '',
    coordinatorLeaseMs: LEASE_MS,
    logFile,
  })
  const base = `http://127.0.0.1:${port}`
  const coordPost = (action, body) => request(base, `/mesh/coordinator/${action}`, { method: 'POST', body })
  const registry = () => JSON.parse(fs.readFileSync(path.join(meshHome, 'workspaces.json'), 'utf8'))
  const members = () => registry().workspaces?.[SLUG]?.coordinators ?? []
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
  await sleep(120)
  return { base, state, coordPost, request, registry, members, logFile, close, cwd }
}

// ── A. the rotation order: claim (pending, permanent) then approve ───────────
test('coordinator permanent (A): a permanent claim stays permanent through approve (T-mwmcgl07)', async () => {
  const h = await startHarness()
  try {
    const first = await h.coordPost('claim', { session: 'session-cp-a' })
    assert.equal(first.status, 201)
    assert.equal(first.json?.status, 'approved', 'bootstrap approves the first claim')

    // Rotation order: the new session claims while the old one is still approved, so the
    // claim lands as pending and needs an approve — exactly the path that used to re-add a lease.
    const second = await h.coordPost('claim', { session: 'session-cp-b', permanent: true })
    assert.equal(second.status, 201)
    assert.equal(second.json?.status, 'pending')
    const pendingMember = second.json?.coordinators.find((member) => member.sessionId === 'session-cp-b')
    assert.equal(pendingMember?.permanent, true, 'the claim records the intent')

    const approved = await h.coordPost('approve', { session: 'session-cp-b', slug: SLUG, by: 'session-cp-a' })
    assert.equal(approved.status, 200, approved.text)
    const member = h.members().find((entry) => entry.sessionId === 'session-cp-b')
    assert.equal(member?.status, 'approved')
    assert.equal(member?.permanent, true)
    assert.equal(member?.leaseUntil, null, 'approve must not put a finite lease back on a permanent claim')

    // D. the public view carries the flag; the legacy field still names the primary.
    const view = approved.json?.coordinators.find((entry) => entry.sessionId === 'session-cp-b')
    assert.equal(view?.permanent, true)
    assert.equal(view?.leaseUntil, null)
    assert.equal(h.registry().workspaces[SLUG].coordinator, 'session-cp-a', 'legacy coordinator is still the primary')
    assert.equal(approved.json?.primary, 'session-cp-a')
  } finally {
    h.close()
  }
})

// ── B. a non-permanent claim still gets a finite lease ─────────────────────
test('coordinator permanent (B): a non-permanent claim is approved with a finite lease (T-mwmcgl07)', async () => {
  const h = await startHarness()
  try {
    await h.coordPost('claim', { session: 'session-cp-a' })
    await h.coordPost('claim', { session: 'session-cp-c', permanent: false })
    const before = Date.now()
    const approved = await h.coordPost('approve', { session: 'session-cp-c', slug: SLUG, by: 'session-cp-a' })
    assert.equal(approved.status, 200, approved.text)
    const member = h.members().find((entry) => entry.sessionId === 'session-cp-c')
    assert.equal(member?.permanent, false)
    assert.equal(typeof member?.leaseUntil, 'number', 'a normal claim keeps its lease')
    assert.ok(member.leaseUntil >= before + LEASE_MS - 5000, `lease should be ~now+${LEASE_MS}, got ${member.leaseUntil - before}`)
    assert.ok(member.leaseUntil <= Date.now() + LEASE_MS + 5000)
  } finally {
    h.close()
  }
})

// ── heartbeat must not hand a lease to a permanent member ──────────────────
test('coordinator permanent: heartbeat keeps leaseUntil null for a permanent member (T-mwmcgl07)', async () => {
  const h = await startHarness()
  try {
    await h.coordPost('claim', { session: 'session-cp-a', permanent: true })
    const before = h.members().find((entry) => entry.sessionId === 'session-cp-a')
    assert.equal(before?.leaseUntil, null, 'bootstrap + permanent already has no lease')
    const beat = await h.coordPost('heartbeat', { session: 'session-cp-a', slug: SLUG })
    assert.equal(beat.status, 200, beat.text)
    assert.equal(beat.json?.leaseUntil, null)
    const after = h.members().find((entry) => entry.sessionId === 'session-cp-a')
    assert.equal(after?.leaseUntil, null, 'a heartbeat must not materialise a lease')
    assert.equal(after?.status, 'approved')

    // And a non-permanent member still renews.
    await h.coordPost('claim', { session: 'session-cp-b' })
    await h.coordPost('approve', { session: 'session-cp-b', slug: SLUG, by: 'session-cp-a' })
    const renewed = await h.coordPost('heartbeat', { session: 'session-cp-b', slug: SLUG })
    assert.equal(renewed.status, 200)
    assert.equal(typeof renewed.json?.leaseUntil, 'number')
  } finally {
    h.close()
  }
})
