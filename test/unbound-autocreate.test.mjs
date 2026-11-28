/**
 * Unbound conversations get a session of their own (T-mwzfxyb7).
 *
 * History this file pins down:
 *  - T-426 removed auto-creation as a stopgap, because a FAILED delivery used to CLEAR the
 *    binding; the conversation then looked unbound, fell through, and spawned a fresh inbox
 *    session on every retry. 19 inbox sessions, 12 of them on one day.
 *  - That first step is fixed (a failed delivery keeps its binding and stays deferred), so
 *    owner approved restoring creation on 2026-11-28 — one session per conversation, in the
 *    inbox workspace, reused for later messages, capped per hour.
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
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-unbound-create-${process.pid}.log`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
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

/** Minimal hub: a fixed list of unread messages, plus read receipt recording. */
async function startFakeHub({ messages = [] } = {}) {
  const readIds = []
  const sent = []
  const server = net.createServer((socket) => {
    let raw = ''
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8')
      const headEnd = raw.indexOf('\r\n\r\n')
      if (headEnd < 0) return
      const head = raw.slice(0, headEnd)
      const match = /content-length:\s*(\d+)/i.exec(head)
      const length = match ? Number(match[1]) : 0
      if (raw.length < headEnd + 4 + length) return
      const body = raw.slice(headEnd + 4, headEnd + 4 + length)
      const line = head.split('\r\n')[0]
      const method = line.split(' ')[0]
      const target = line.split(' ')[1] ?? '/'
      const url = new URL(target, 'http://127.0.0.1')
      const json = (status, value) => {
        const payload = JSON.stringify(value)
        socket.write(`HTTP/1.1 ${status} OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`)
        socket.end()
      }
      socket.on('end', () => {})
      if (url.pathname === '/api/wake-secret') return json(200, { secret: 's3cret' })
      if (url.pathname === '/api/peers') return json(200, { peers: [] })
      if (url.pathname === '/api/inbox' || url.pathname === '/api/pull') {
        const unread = messages.filter((m) => !readIds.includes(m.id))
        return json(200, { messages: unread })
      }
      if (url.pathname === '/api/read') {
        try {
          const parsed = JSON.parse(body || '{}')
          for (const id of parsed.ids ?? []) readIds.push(id)
        } catch {
          /* ignore */
        }
        return json(200, { ok: true })
      }
      if (url.pathname === '/api/conversation') {
        return json(200, { messages })
      }
      if (url.pathname === '/api/send') {
        sent.push({ raw, body })
        return json(201, { ok: true, message: { id: `sent-${sent.length}` } })
      }
      return json(200, { ok: true, messages: [] })
    })
    socket.on('error', () => {})
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  return { server, url: `http://127.0.0.1:${port}`, readIds, sent, messages }
}

/**
 * Boot the plugin. `workspacePath`/`sessionCwd` default to a temp inbox; pass `null` to leave
 * them unset (the "no inbox workspace" case).
 */
async function startHarness({
  hubMessages = [],
  config = {},
  conversations = null,
  workspace = true,
  promptFails = false,
  seedSessions = [{ id: CONVERSATION_OWNER, title: 'conversation owner' }],
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-unbound-create-'))
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const inbox = path.join(tmp, 'inbox')
  const logFile = path.join(tmp, 'waker.log')
  for (const dir of [sessionsRoot, tokenDir, home, inbox]) fs.mkdirSync(dir, { recursive: true })

  const index = {}
  for (const seed of seedSessions) {
    const dir = path.join(sessionsRoot, 'ws-test', seed.id)
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(log, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session/open', data: { cwd: inbox } })}\n`)))
    index[seed.id] = { mtime: fs.statSync(log).mtimeMs, title: seed.title, cwd: inbox }
  }
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify(index))
  if (conversations) fs.writeFileSync(path.join(tokenDir, 'conversations.json'), JSON.stringify(conversations, null, 2))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, 'test-token')

  const hub = await startFakeHub({ messages: hubMessages })
  const state = { prompts: [], tools: [], created: [], renamed: [] }
  let nextCreated = 0
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
        nextCreated += 1
        const id = `session-auto-${nextCreated}`
        state.created.push({ id, cwd: inbox })
        return { sessionId: id, cwd: inbox }
      },
      async prompt(payload) {
        if (promptFails) throw new Error('the bound session rejected the prompt')
        state.prompts.push(payload)
        return {}
      },
      async cancel() {},
      async rename(payload) {
        state.renamed.push(payload)
      },
    },
    // A session this harness created counts as live, the way the host would report it. Without
    // this the T-364 rule ("an auto-bound session that is no longer live is replaced") correctly
    // kicks in, and a second message would get a replacement session instead of reusing this one.
    agents: {
      get: (id) => (state.created.some((entry) => entry.id === id) ? { id } : undefined),
      resume: async () => {},
    },
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
    hubUrl: hub.url,
    ...(workspace ? { workspacePath: inbox, sessionCwd: inbox } : {}),
    receiptFile: path.join(tmp, 'receipts.jsonl'),
    batchFile: path.join(tmp, 'batches.json'),
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
    pollIntervalMs: 300,
    pollIdleIntervalMs: 300,
    receiptMode: 'queue',
    logFile,
    ...config,
  })
  const base = `http://127.0.0.1:${port}`
  const tool = (name) => state.tools.find((entry) => entry.name === name)
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  const conversationsNow = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(tokenDir, 'conversations.json'), 'utf8'))
    } catch {
      return {}
    }
  }
  const close = () => {
    hub.server.close()
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
  return { base, state, tool, close, log, conversationsNow, hub, tmp, tokenDir, logFile }
}

const CONVERSATION_OWNER = 'session-conv-owner'

const oneMessage = (conversation, id = 'm-1') => [
  { id, sender: 'peer-b', conversation, subject: 'hello', body: 'first message of the dialogue' },
]

// ── 2. auto-create: unbound → a session of its own, in the inbox workspace ───
test('unbound: an unbounded conversation gets its own session in the inbox workspace', async () => {
  const conversation = `conv-auto-${Date.now()}`
  const h = await startHarness({ hubMessages: oneMessage(conversation) })
  try {
    const created = await waitFor(() => (h.state.created.length ? h.state.created[0] : null))
    assert.ok(created, `a session must be created, log:\n${h.log()}`)
    assert.match(h.log(), new RegExp(`conversation=${conversation} target=auto-created session=${created.id} reason=unbound`))
    // Bound to the new session, with the auto-create metadata recorded.
    const entry = await waitFor(() => {
      const all = h.conversationsNow()
      return all[conversation]?.deliverTo === created.id ? all[conversation] : null
    })
    assert.ok(entry, 'the conversation must be bound to the created session')
    assert.equal(entry.deliverToAuto?.autoCreatedBy, 'unbound')
    assert.ok(entry.deliverToAuto?.workspacePath, 'the workspace used must be recorded')
    // Title comes from the conversation, and the host was asked to set it.
    assert.deepEqual(
      h.state.renamed.map((item) => item.sessionId),
      [created.id],
    )
    // Delivered into that session, not parked.
    const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === created.id))
    assert.ok(delivered, 'the message must be delivered into the created session')
    assert.doesNotMatch(h.log(), /target=parked reason=unbound/)
  } finally {
    h.close()
  }
})

// ── 3. reuse: the same conversation never spawns a second session ────────────
test('unbound: a second message for the same conversation reuses its session', async () => {
  const conversation = `conv-reuse-${Date.now()}`
  const h = await startHarness({
    hubMessages: [{ id: 'm-a', sender: 'peer-b', conversation, body: 'one' }],
    // The per-conversation cooldown (60s by default) deliberately collapses a burst into one
    // wake, so a second message inside the window would be re-armed rather than delivered. This
    // case is about which session it lands in, not about the cooldown, so the window is disabled.
    config: { conversationCooldownMs: 1 },
  })
  try {
    const first = await waitFor(() => (h.state.created.length ? h.state.created[0] : null))
    assert.ok(first)
    await waitFor(() => h.state.prompts.some((prompt) => prompt.sessionId === first.id))
    // A second message in the same conversation arrives.
    h.hub.messages.push({ id: 'm-b', sender: 'peer-b', conversation, body: 'two' })
    const second = await waitFor(() => h.state.prompts.filter((prompt) => prompt.sessionId === first.id).length >= 2)
    assert.ok(second, `the second message must land in the same session, log:\n${h.log()}`)
    assert.equal(h.state.created.length, 1, 'no second session for the same conversation')
  } finally {
    h.close()
  }
})

// ── 4. ceiling: the cap parks instead of creating, and survives a restart ────
test('unbound: the hourly ceiling parks the next conversation and the count survives a restart', async () => {
  const conversationA = `conv-cap-a-${Date.now()}`
  const conversationB = `conv-cap-b-${Date.now()}`
  const h = await startHarness({
    hubMessages: [
      { id: 'm-cap-a', sender: 'peer-b', conversation: conversationA, body: 'a' },
      { id: 'm-cap-b', sender: 'peer-b', conversation: conversationB, body: 'b' },
    ],
    config: { unboundAutoCreateMaxPerHour: 1 },
  })
  try {
    await waitFor(() => h.state.created.length >= 1)
    const parked = await waitFor(() => /WARN unbound auto-create capped/.test(h.log()))
    assert.ok(parked, `the second conversation must hit the cap, log:\n${h.log()}`)
    assert.equal(h.state.created.length, 1, 'the cap allows exactly one creation')
    assert.match(h.log(), /target=parked reason=unbound/)
    // Persisted, so a restart does not hand out a fresh allowance.
    const ledger = JSON.parse(fs.readFileSync(path.join(h.tokenDir, 'unbound-auto-create.json'), 'utf8'))
    assert.equal(ledger.total, 1)
    assert.equal(ledger.times.length, 1)
    assert.ok(ledger.last?.conversation, 'the last created conversation is recorded')
  } finally {
    h.close()
  }
})

// ── 5. no inbox workspace → park, never guess a directory ────────────────────
test('unbound: without a configured workspace nothing is created', async () => {
  const conversation = `conv-nows-${Date.now()}`
  const h = await startHarness({ hubMessages: oneMessage(conversation), workspace: false })
  try {
    const pumped = await waitFor(() => /conversation=/.test(h.log()))
    assert.ok(pumped)
    const skipped = await waitFor(() => /WARN unbound auto-create skipped .*no workspacePath\/sessionCwd configured/.test(h.log()))
    assert.ok(skipped, `it must say why it refused, log:\n${h.log()}`)
    assert.equal(h.state.created.length, 0, 'no session without a workspace')
    assert.match(h.log(), /target=parked reason=unbound/)
  } finally {
    h.close()
  }
})

// ── 8. an upgrade must not replay the historical backlog ────────────────────
test('unbound: parked backlog from before the upgrade is not replayed at startup', async () => {
  const conversation = `conv-historic-${Date.now()}`
  const h = await startHarness({ hubMessages: [] })
  try {
    // Seed a queue row as T-490 left it, then restart the plugin over the same directory.
    fs.writeFileSync(
      path.join(h.tokenDir, 'unbound.jsonl'),
      `${JSON.stringify({ at: Date.now() - 86_400_000, conversation, sender: 'peer-b', subject: 'old', messages: [{ id: 'm-old', sender: 'peer-b', subject: 'old', createdAt: Date.now() - 86_400_000 }], note: 'parked' })}\n`,
    )
    const port = await freePort()
    const previousEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MESH_WAKER_SESSIONS_ROOT: process.env.MESH_WAKER_SESSIONS_ROOT }
    const { apply } = await import(pathToFileURL(ENTRY).href)
    const state2 = { created: [], prompts: [] }
    const toolsService = { register: () => () => {} }
    const second = await apply(
      {
        logger: { info() {}, warn() {}, error() {} },
        get: (name) => (name === 'tools' ? toolsService : undefined),
        tools: toolsService,
        effect() {},
        on: () => () => {},
        commands: { register: () => () => {} },
        sessionController: {
          async create() {
            state2.created.push('x')
            return { sessionId: `session-restart-${state2.created.length}`, cwd: h.tmp }
          },
          async prompt(payload) {
            state2.prompts.push(payload)
            return {}
          },
          async cancel() {},
          async rename() {},
        },
        agents: { get: () => undefined, resume: async () => {} },
        workspaceRegistry: {
          archivedSessionIds: () => new Set(),
          archiveSession: async () => {},
          resolveByPath: async () => null,
          create: async (p) => ({ id: 'ws-test', path: p }),
          deleteKnown: async () => false,
          sessionKnown: () => true,
        },
      },
      {
        listenHost: '127.0.0.1',
        listenPort: port,
        tokenFile: path.join(h.tokenDir, 'token'),
        hubUrl: h.hub.url,
        workspacePath: h.tmp,
        sessionCwd: h.tmp,
        receiptFile: path.join(h.tmp, 'r2.jsonl'),
        batchFile: path.join(h.tmp, 'b2.json'),
        catchUpOnStart: false,
        catchUpDelayMs: 600000,
        historySyncIntervalMs: 3600000,
        registerIntervalMs: 3600000,
        pollIntervalMs: 300,
        pollIdleIntervalMs: 300,
        logFile: h.logFile,
      },
    )
    try {
      await sleep(1200)
      assert.equal(state2.created.length, 0, 'startup must not spawn sessions for historical parked mail')
      assert.equal(state2.prompts.length, 0, 'and must not inject anything')
      const queue = fs.readFileSync(path.join(h.tokenDir, 'unbound.jsonl'), 'utf8').trim()
      assert.ok(queue.includes(conversation), 'the parked row is still there, awaiting an explicit replay')
    } finally {
      for (const dispose of Array.isArray(second) ? second : []) {
        try {
          dispose()
        } catch {
          /* closed */
        }
      }
      process.env.HOME = previousEnv.HOME
      process.env.USERPROFILE = previousEnv.USERPROFILE
      process.env.MESH_WAKER_SESSIONS_ROOT = previousEnv.MESH_WAKER_SESSIONS_ROOT
    }
  } finally {
    h.close()
  }
})

// ── mesh_rebind: the agent-side way to move a conversation (decision 3) ──────
// A session auto-created for a conversation it should not own must be able to hand it over
// itself — no human in the loop. Replay stays explicit: doing it at upgrade time would spawn
// one session per historical conversation at once, which is the T-426 session bomb.

const writeUnboundRow = (h, conversation, ids) => {
  const row = {
    at: Date.now() - 3_600_000,
    conversation,
    sender: 'peer-b',
    subject: 'old',
    messages: ids.map((id, index) => ({ id, sender: 'peer-b', subject: 'old', createdAt: Date.now() - 3_600_000 + index })),
    note: 'parked',
  }
  fs.appendFileSync(path.join(h.tokenDir, 'unbound.jsonl'), `${JSON.stringify(row)}\n`)
  return row
}

const unboundRows = (h) => {
  try {
    return fs
      .readFileSync(path.join(h.tokenDir, 'unbound.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('rebind: without `to` the conversation binds to the calling session', async () => {
  const conversation = `conv-self-${Date.now()}`
  const h = await startHarness({ hubMessages: [] })
  try {
    const rebind = await waitFor(() => h.tool('mesh_rebind'))
    assert.ok(rebind, `mesh_rebind must be registered; tools=${h.state.tools.map((entry) => entry.name).join(',')}`)
    const result = await rebind.execute({ conversation }, { sessionId: CONVERSATION_OWNER })
    assert.equal(result.ok, true)
    assert.equal(result.sessionId, CONVERSATION_OWNER)
    assert.equal(result.rebound, true)
    assert.equal(h.conversationsNow()[conversation].deliverTo, CONVERSATION_OWNER)
    // Never silent, even when there was nothing before.
    assert.match(
      h.log(),
      new RegExp(`conversation=${conversation} target=rebound session=${CONVERSATION_OWNER} reason=rebind previous=- by=${CONVERSATION_OWNER}`),
    )
  } finally {
    h.close()
  }
})

test('rebind: replay delivers the parked backlog and clears the queue', async () => {
  const conversation = `conv-replay-${Date.now()}`
  const h = await startHarness({
    hubMessages: [
      { id: 'm-parked-1', sender: 'peer-b', conversation, subject: 'old', body: 'parked body one' },
      { id: 'm-parked-2', sender: 'peer-b', conversation, subject: 'old', body: 'parked body two' },
    ],
  })
  try {
    writeUnboundRow(h, conversation, ['m-parked-1', 'm-parked-2'])
    assert.equal(unboundRows(h).length, 1)
    const rebind = await waitFor(() => h.tool('mesh_rebind'))
    const result = await rebind.execute({ conversation, replay: true }, { sessionId: CONVERSATION_OWNER })
    assert.equal(result.ok, true)
    assert.ok(result.replayed >= 1, `the backlog must be injected, got ${JSON.stringify(result)}`)
    assert.equal(result.cleared, 1, 'the queue row is consumed')
    const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === CONVERSATION_OWNER))
    assert.ok(delivered, 'the backlog lands in the rebound session')
    assert.equal(unboundRows(h).filter((row) => row.conversation === conversation).length, 0)
    assert.equal(result.pendingUnbound, 0)
    assert.match(h.log(), new RegExp(`conversation=${conversation} target=replayed session=${CONVERSATION_OWNER}`))
  } finally {
    h.close()
  }
})

test('rebind: moving a bound conversation to another session logs old→new', async () => {
  const conversation = `conv-move-${Date.now()}`
  const other = 'session-rebind-other'
  const h = await startHarness({
    hubMessages: [],
    seedSessions: [
      { id: CONVERSATION_OWNER, title: 'conversation owner' },
      { id: other, title: 'rebind other' },
    ],
  })
  try {
    const rebind = await waitFor(() => h.tool('mesh_rebind'))
    const first = await rebind.execute({ conversation }, { sessionId: CONVERSATION_OWNER })
    assert.equal(first.sessionId, CONVERSATION_OWNER)
    const moved = await rebind.execute({ conversation, to: other }, { sessionId: CONVERSATION_OWNER })
    assert.equal(moved.ok, true)
    assert.equal(moved.sessionId, other)
    assert.equal(moved.previousSessionId, CONVERSATION_OWNER, 'the old target is reported, not dropped')
    assert.equal(h.conversationsNow()[conversation].deliverTo, other)
    assert.match(
      h.log(),
      new RegExp(`conversation=${conversation} target=rebound session=${other} reason=rebind previous=${CONVERSATION_OWNER} by=${CONVERSATION_OWNER}`),
    )
    // Operator view: the auto-create counters are on /mesh/status, unchanged in shape.
    const status = await (await fetch(`${h.base}/mesh/status`)).json()
    assert.equal(typeof status.unboundAutoCreated, 'number')
    assert.equal(typeof status.unboundAutoCreatedLastHour, 'number')
    assert.ok('lastAutoCreated' in status)
    assert.equal(typeof status.unboundPending, 'number')
    assert.equal(status.tools?.rebind, true, 'the status page reports the tool as registered')
  } finally {
    h.close()
  }
})

test('rebind: an unresolvable `to` is an error and leaves the binding alone', async () => {
  const conversation = `conv-bad-to-${Date.now()}`
  const h = await startHarness({ hubMessages: [] })
  try {
    const rebind = await waitFor(() => h.tool('mesh_rebind'))
    await rebind.execute({ conversation }, { sessionId: CONVERSATION_OWNER })
    await assert.rejects(() => rebind.execute({ conversation, to: 'no such session' }, { sessionId: CONVERSATION_OWNER }), /not found/)
    assert.equal(h.conversationsNow()[conversation].deliverTo, CONVERSATION_OWNER, 'the old binding is untouched')
  } finally {
    h.close()
  }
})

test('rebind: without `to` and without a caller session it refuses instead of guessing', async () => {
  const conversation = `conv-no-caller-${Date.now()}`
  const h = await startHarness({ hubMessages: [] })
  try {
    const rebind = await waitFor(() => h.tool('mesh_rebind'))
    await assert.rejects(() => rebind.execute({ conversation }, null), /needs `to`/)
  } finally {
    h.close()
  }
})

// ── 1. premise lock: a failed delivery must NEVER clear the binding ─────────
// This is the illness T-426 was a stopgap for. The old code cleared `deliverTo` on a failed
// prompt, the conversation looked unbound, and — with auto-create back on — it would be handed
// straight to a brand new session on the next round. Every retry would spawn one. So the binding
// must survive, the mail must stay unread, and nothing may be created.
test('unbound: a failed delivery keeps its binding and creates nothing', async () => {
  const conversation = `conv-fail-${Date.now()}`
  const boundTo = 'session-bound-target'
  const h = await startHarness({
    hubMessages: [{ id: 'm-fail-1', sender: 'peer-b', conversation, body: 'must not be lost' }],
    promptFails: true,
    seedSessions: [{ id: boundTo, title: 'bound target' }],
    conversations: { [conversation]: { sessionId: boundTo, createdAt: Date.now(), wakes: 2, title: 'bound', deliverTo: boundTo } },
  })
  try {
    // The poll cadence is 300ms, but under the full suite this competes with every other
    // harness, so the default budget is too tight (passes alone, red under load). Wait for the
    // fact with a budget that fits a loaded machine rather than betting on wall-clock.
    const deferred = await waitFor(() => /target=deferred reason=delivery-failed/.test(h.log()), { timeoutMs: 30_000 })
    assert.ok(deferred, `the failure must be recorded as deferred, log:\n${h.log()}`)
    // The binding is still there — this is the whole point of the test.
    assert.equal(h.conversationsNow()[conversation]?.deliverTo, boundTo, 'a failed delivery must not clear deliverTo')
    // The mail is still unread, so a later retry can deliver it.
    assert.equal(h.hub.readIds.includes('m-fail-1'), false, 'the message must stay unread after a failed delivery')
    // And nothing was auto-created: the conversation never became "unbound".
    assert.equal(h.state.created.length, 0, 'a failed delivery must not spawn a session')
    assert.doesNotMatch(h.log(), /target=auto-created/)
    // It must not be parked either: parking is for conversations with no target at all.
    assert.equal(unboundRows(h).length, 0, 'a bound-but-failing conversation is not parked')
  } finally {
    h.close()
  }
})
