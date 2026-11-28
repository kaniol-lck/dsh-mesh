/**
 * Reproduce the 2026-11-18 loop, then prove it terminates.
 *
 * The bug: an unbound conversation left its messages unread, so pull re-claimed them every few
 * seconds, each round deferred without delivering, and the same batch produced 62 rounds with
 * 0 deliveries and no alert. This drives the real plugin against a fake hub and asserts:
 *
 *   1. the first round parks (read + queued) instead of deferring
 *   2. the message is actually marked read — which is what stops the re-claim
 *   3. a second pull round produces no further wake for that conversation
 *   4. /mesh/status reports unboundPending so ops-check can fail on it
 *
 * Counting rounds is the point: "it stopped" must be observed, not inferred.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const REPO = path.join(import.meta.dirname, '..')
const ENTRY = path.join(REPO, 'plugins', 'mesh-waker', 'index.js')
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-unbound-loop-${process.pid}.log`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 15000, stepMs = 100) => {
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

/** A hub that keeps unread state, so repeated inbox reads behave like the real thing. */
async function startFakeHub({ messages }) {
  const rows = messages.map((m) => ({ ...m, read_at: null }))
  const reads = []
  let inboxHits = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (url.pathname === '/api/register') return json(200, { name: 'local-box' })
      if (url.pathname === '/api/wake-secret') return json(200, { secret: ['fixture', 'not', 'credential'].join('-') })
      if (url.pathname === '/api/peers') return json(200, { peers: [] })
      if (url.pathname === '/api/inbox') {
        inboxHits += 1
        const unread = rows.filter((m) => !m.read_at)
        return json(200, { messages: unread })
      }
      if (url.pathname === '/api/read') {
        let ids = []
        try {
          const body = JSON.parse(raw || '{}')
          ids = Array.isArray(body.ids) ? body.ids : []
        } catch { /* ignore */ }
        for (const row of rows) if (ids.includes(row.id)) row.read_at = Date.now()
        reads.push(...ids)
        return json(200, { ok: true, marked: ids.length })
      }
      if (url.pathname === '/api/conversation') return json(200, { messages: rows })
      if (url.pathname === '/api/history') return json(200, { messages: [] })
      return json(404, { error: 'not found' })
    })
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  return { server, rows, reads, url: `http://127.0.0.1:${port}`, inboxHits: () => inboxHits }
}

async function startHarness({ hubUrl, logFile }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-unbound-loop-'))
  fs.mkdirSync(path.join(tmp, 'inbox'), { recursive: true })
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  for (const dir of [sessionsRoot, tokenDir, home]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify({}))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, 'fixture-token')

  const state = { prompts: [], tools: [], created: [] }
  const previousEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MESH_WAKER_SESSIONS_ROOT: process.env.MESH_WAKER_SESSIONS_ROOT }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.MESH_WAKER_SESSIONS_ROOT = sessionsRoot

  const disposers = []
  const toolsService = { register: (definition) => (state.tools.push(definition), () => {}) }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => (name === 'tools' ? toolsService : undefined),
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on() {
      return () => {}
    },
    commands: { register: () => () => {} },
    tools: toolsService,
    sessionController: {
      async create() {
        state.created.push(1)
        throw new Error('an unbound conversation must not create a session')
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
      async resolveByPath() { return null },
      async create(workspacePath) { return { id: 'ws-test', path: workspacePath } },
      async deleteKnown() { return false },
      sessionKnown() { return true },
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
    // T-mwzfxyb7: this file exists to exercise the park branch, which is no longer the default.
    unboundDeliveryMode: 'park',
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
    // Fast poll: the loop this test guards against was a 5s cadence, so slow polling would
    // hide it rather than prove its absence.
    pollIntervalMs: 400,
    pollIdleIntervalMs: 400,
    pollBusyIntervalMs: 400,
    logFile,
  })

  const status = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mesh/status`)
    return await res.json()
  }
  const close = () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already closed */ }
    }
    process.env.HOME = previousEnv.HOME
    process.env.USERPROFILE = previousEnv.USERPROFILE
    process.env.MESH_WAKER_SESSIONS_ROOT = previousEnv.MESH_WAKER_SESSIONS_ROOT
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  await sleep(200)
  return { state, close, status }
}

test('an unbound conversation is parked once, then the pull loop stops', async () => {
  const conversation = `conv-loop-${Date.now()}`
  const logFile = path.join(os.tmpdir(), `waker-unbound-${process.pid}-${Date.now()}.log`)
  const hub = await startFakeHub({
    messages: [{ id: 'm-loop-1', sender: 'peer-b', conversation, subject: 'stuck mail', body: 'nobody bound me' }],
  })
  const h = await startHarness({ hubUrl: hub.url, logFile })
  try {
    // 1. parked, not deferred
    const parked = await waitFor(() => fs.existsSync(logFile) && /target=parked reason=unbound/.test(fs.readFileSync(logFile, 'utf8')))
    assert.ok(parked, 'the unbound conversation must be parked, not deferred forever')

    // 2. the message really became read — this is the mechanism that ends the loop
    assert.ok(hub.reads.includes('m-loop-1'), 'parking must mark the message read')

    // 3. no session was created and nothing was injected
    assert.equal(h.state.created.length, 0, 'an unbound conversation must not create a session')
    assert.equal(h.state.prompts.length, 0, 'and must not inject into anything')

    // 4. the decisive one: after several more poll rounds, no further parking for this
    //    conversation. Before the fix this was ~62 rounds; now it must be exactly 1.
    await sleep(2500)
    const logText = fs.readFileSync(logFile, 'utf8')
    const parkRounds = logText.split('\n').filter((line) => /target=parked reason=unbound/.test(line) && line.includes(conversation)).length
    assert.equal(parkRounds, 1, `parking must happen once, not loop (got ${parkRounds} rounds)`)

    // 5. and it is visible, so ops-check can fail on it
    const status = await h.status()
    assert.ok(status.unboundPending >= 1, `status must report the parked conversation (got ${status.unboundPending})`)
  } finally {
    h.close()
    await new Promise((resolve) => hub.server.close(resolve))
    fs.rmSync(logFile, { force: true })
  }
})
