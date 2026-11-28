/**
 * Role projection + session relay (T-mwzvjvwz).
 *
 * Owner's decision was "方案 2": no third file. `team.json` (repo side, rotate-session is the only
 * writer) already maps role → session, and `workspaces.json` (machine side, waker is the only
 * writer) already maps workspace → sessions. A `roles.json` would have been a third copy of the
 * same fact, racing on the same file from several workspaces, and would have made a repo script
 * write into ~/.dsh — privilege it should not have.
 *
 * So rotate-session ANNOUNCES the mapping over loopback and waker stores it inside the workspace
 * entry it already owns. The trade-off is recorded in the todo: a projection can go stale, only a
 * repo-side gate can notice (sourceUpdatedAt), and CI cannot see it at all.
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

const LIVE_OLD = 'session-role-old'
const LIVE_NEW = 'session-role-new'
const DEAD = 'session-role-dead'
const CONVERSATION_OWNER = 'session-conv-owner'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
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

/**
 * Boot the plugin with a seeded workspaces.json so the role routes have something to talk to.
 * `liveSessions` decides what `ctx.agents.get` answers — that is what "a session resolves" means
 * to the plugin, and it is the only input that should matter.
 */
async function startHarness({
  hubMessages = [],
  config = {},
  workspacesSeed = null,
  conversations = null,
  promptFails = false,
  liveSessions = [CONVERSATION_OWNER],
  seedSessions = null,
  loopbackOnly = true,
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-roles-'))
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const inbox = path.join(tmp, 'inbox')
  const logFile = path.join(tmp, 'waker.log')
  for (const dir of [sessionsRoot, tokenDir, home, inbox, path.join(inbox, 'other')]) fs.mkdirSync(dir, { recursive: true })

  const seeds = seedSessions ?? [{ id: CONVERSATION_OWNER, title: 'conversation owner' }]
  const index = {}
  for (const seed of seeds) {
    const dir = path.join(sessionsRoot, 'ws-test', seed.id)
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(log, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session/open', data: { cwd: inbox } })}\n`)))
    index[seed.id] = { mtime: fs.statSync(log).mtimeMs, title: seed.title, cwd: inbox }
  }
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify(index))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, 'test-token')

  // The machine-level registry lives next to the token, under ~/.dsh/mesh-waker.
  const meshHome = path.join(home, '.dsh', 'mesh-waker')
  fs.mkdirSync(meshHome, { recursive: true })
  /**
   * Write the registry AFTER boot: convergence would otherwise overwrite it. Paths are absolute
   * temp dirs, so the seeded entries point at directories that really exist (a missing cwd gets
   * pruned).
   */
  const writeSeed = () => {
    if (!workspacesSeed) return
    const seeded = JSON.parse(JSON.stringify(workspacesSeed))
    for (const entry of Object.values(seeded.workspaces ?? {})) {
      entry.cwd = resolveSeedPath(entry.cwd, { inbox })
      if (entry.workers) {
        for (const worker of Object.values(entry.workers)) {
          worker.cwd = resolveSeedPath(worker.cwd, { inbox })
        }
      }
    }
    fs.writeFileSync(path.join(meshHome, 'workspaces.json'), `${JSON.stringify(seeded, null, 2)}\n`)
  }
  if (conversations) {
    fs.writeFileSync(path.join(tokenDir, 'conversations.json'), JSON.stringify(conversations, null, 2))
  }

  const readIds = []
  const server = net.createServer((socket) => {
    let raw = ''
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8')
      const headEnd = raw.indexOf('\r\n\r\n')
      if (headEnd < 0) return
      const head = raw.slice(0, headEnd)
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0)
      if (raw.length < headEnd + 4 + length) return
      const body = raw.slice(headEnd + 4, headEnd + 4 + length)
      const target = head.split('\r\n')[0].split(' ')[1] ?? '/'
      const url = new URL(target, 'http://127.0.0.1')
      const json = (status, value) => {
        const payload = JSON.stringify(value)
        socket.write(`HTTP/1.1 ${status} OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`)
        socket.end()
      }
      if (url.pathname === '/api/wake-secret') return json(200, { secret: 's3cret' })
      if (url.pathname === '/api/peers') return json(200, { peers: [] })
      if (url.pathname === '/api/inbox' || url.pathname === '/api/pull') return json(200, { messages: hubMessages.filter((m) => !readIds.includes(m.id)) })
      if (url.pathname === '/api/read') {
        try {
          const parsed = JSON.parse(body || '{}')
          for (const id of parsed.ids ?? []) readIds.push(id)
        } catch {
          /* ignore */
        }
        return json(200, { ok: true })
      }
      if (url.pathname === '/api/conversation') return json(200, { messages: hubMessages })
      return json(200, { ok: true, messages: [] })
    })
    socket.on('error', () => {})
  })
  const hubPort = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

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
  const toolsService = { register: (definition) => (state.tools.push(definition), () => {}) }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => (name === 'tools' ? toolsService : undefined),
    tools: toolsService,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on: () => () => {},
    commands: { register: () => () => {} },
    sessionController: {
      async create() {
        const id = `session-role-auto-${state.created.length + 1}`
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
        state.renamed = state.renamed ?? []
        state.renamed.push(payload)
      },
    },
    // Liveness is the ONLY thing that decides "does this role resolve".
    agents: {
      get: (id) => (liveSessions.includes(id) ? { id } : undefined),
      resume: async () => {},
    },
    workspaceRegistry: {
      archivedSessionIds: () => new Set(),
      archiveSession: async () => {},
      resolveByPath: async () => null,
      create: async (p) => ({ id: 'ws-test', path: p }),
      deleteKnown: async () => false,
      sessionKnown: () => true,
    },
  }
  const port = await freePort()
  const { apply } = await import(pathToFileURL(ENTRY).href)
  // A listener failure is otherwise invisible: every fetch then throws ECONNREFUSED and the
  // assertion messages talk about roleSessions instead of "the plugin never listened".
  const probeListener = async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mesh/status`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) return
        throw new Error(`status ${res.status}`)
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(`the plugin never answered on port ${port}: ${error.message}`)
        }
        await sleep(100)
      }
    }
  }
  await apply(ctx, {
    listenHost: '127.0.0.1',
    listenPort: port,
    tokenFile,
    hubUrl: `http://127.0.0.1:${hubPort}`,
    workspacePath: inbox,
    sessionCwd: inbox,
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
  await probeListener()
  writeSeed()
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
  const unboundRows = () => {
    try {
      return fs
        .readFileSync(path.join(tokenDir, 'unbound.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const workspacesRaw = () => JSON.parse(fs.readFileSync(path.join(meshHome, 'workspaces.json'), 'utf8'))
  const close = () => {
    server.close()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* closed */
      }
    }
    process.env.HOME = previousEnv.HOME
    process.env.USERPROFILE = previousEnv.USERPROFILE
    process.env.MESH_WAKER_SESSIONS_ROOT = previousEnv.MESH_WAKER_SESSIONS_ROOT
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return {
    base,
    state,
    tool,
    close,
    log,
    conversationsNow,
    unboundRows,
    workspacesRaw,
    meshHome,
    tmp,
    inbox,
    tokenDir,
    hub: { messages: hubMessages, readIds },
  }
}

/**
 * The seed carries PLATFORM-NEUTRAL placeholders, never `path.join` output (T-mwzyzhan).
 *
 * The bug this fixes: the seed used `path.join(inbox, 'other')`, which is `\seed\inbox\other` on
 * Windows and `/seed/inbox/other` on Linux, while the substitution compared against the POSIX
 * literal. On Windows the comparison therefore never matched, the rewrite silently did not happen,
 * and the "byte-identical" test passed for the wrong reason — CI on Linux then went red because
 * the rewrite DID happen there and the expectation was the untouched seed.
 *
 * Rule: a fixture that is compared as a constant must not depend on the platform's path rules. The
 * placeholder is a literal string; only the substitution step is allowed to call `path.join`, and
 * it does so on the remainder only.
 */
const SEED_ROOT = '/seed/inbox'

/**
 * Resolve a seed placeholder against the real inbox directory.
 *
 * Pure and injectable (`joinFn`) so the same logic can be exercised under POSIX and Windows path
 * rules on either host — that is the cross-platform evidence this task asks for, and it is real
 * logic rather than a comment claiming portability. Prefix match, not equality: the seed may nest
 * arbitrarily deep under the root.
 */
function resolveSeedPath(value, { root = SEED_ROOT, inbox, joinFn = path.join } = {}) {
  if (typeof value !== 'string') return value
  if (value !== root && !value.startsWith(`${root}/`) && !value.startsWith(`${root}\\`)) return value
  const rest = value.slice(root.length).replace(/^[\\/]+/, '')
  return rest ? joinFn(inbox, rest) : inbox
}

/** A workspaces.json with two workspaces and every field that must survive a push untouched. */
const seedRegistry = () => ({
  machine: 'test-machine',
  workspaces: {
    'ws-alpha': {
      cwd: SEED_ROOT,
      coordinator: LIVE_OLD,
      roles: ['l1', 'waker', 'hub'],
      rolesUnrecognized: ['mystery-role'],
      workers: { waker: { sessionId: LIVE_OLD, cwd: SEED_ROOT, scopes: ['a', 'b'], updatedAt: 1795000000000 } },
      coordinators: [{ sessionId: LIVE_OLD, isPrimary: true, status: 'approved', claimedAt: 1795000000000, leaseUntil: null, approvedBy: 'test', requestedAt: 0 }],
      slug: 'ws-alpha',
    },
    'ws-beta': {
      cwd: `${SEED_ROOT}/other`,
      coordinator: LIVE_OLD,
      roles: ['l2'],
      slug: 'ws-beta',
    },
  },
})

// ── 1. the push endpoint: happy path, and the three refusals ─────────────────
test('roles: a push is stored on the workspace entry and answers 200', async () => {
  const h = await startHarness({ workspacesSeed: seedRegistry(), liveSessions: [LIVE_NEW, CONVERSATION_OWNER] })
  try {
    const res = await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: 'ws-alpha',
        roleSessions: { waker: { sessionId: LIVE_NEW, since: 1795000001000 } },
        sourceUpdatedAt: '1795000002000',
        pushedBy: 'session-rotate',
        reason: 'rotation',
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.workspace, 'ws-alpha')
    assert.equal(body.roles, 1)
    assert.equal(body.sourceUpdatedAt, '1795000002000')

    const raw = h.workspacesRaw()
    const entry = raw.workspaces['ws-alpha']
    assert.equal(entry.roleSessions.waker.sessionId, LIVE_NEW)
    assert.equal(entry.roleSessions.waker.since, 1795000001000)
    assert.ok(entry.roleSessions.waker.pushedAt > 0)
    assert.equal(entry.roleProjection.source, 'team.json')
    assert.equal(entry.roleProjection.sourceUpdatedAt, '1795000002000')
    assert.equal(entry.roleProjection.pushedBy, 'session-rotate')
    assert.deepEqual(entry.roleProjection.unresolved, [])

    // GET reads it back in the documented shape.
    const read = await (await fetch(`${h.base}/mesh/roles?workspace=ws-alpha`)).json()
    assert.equal(read.ok, true)
    assert.equal(read.workspace, 'ws-alpha')
    assert.equal(read.roleSessions.waker.sessionId, LIVE_NEW)
    assert.equal(read.roleProjection.sourceUpdatedAt, '1795000002000')
  } finally {
    h.close()
  }
})

test('roles: an unknown workspace is 409 and nothing is invented', async () => {
  const h = await startHarness({ workspacesSeed: seedRegistry() })
  try {
    const before = fs.readFileSync(path.join(h.meshHome, 'workspaces.json'), 'utf8')
    const res = await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'ws-typo', roleSessions: { waker: { sessionId: LIVE_NEW } } }),
    })
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /unknown workspace/)
    // The file is untouched: no phantom entry, not even a reshuffled key order.
    assert.equal(fs.readFileSync(path.join(h.meshHome, 'workspaces.json'), 'utf8'), before)
  } finally {
    h.close()
  }
})

test('roles: a malformed body is 400 and names the reason', async () => {
  const h = await startHarness({ workspacesSeed: seedRegistry() })
  try {
    const cases = [
      [{ roleSessions: { waker: { sessionId: LIVE_NEW } } }, /workspace is required/],
      [{ workspace: 'ws-alpha' }, /roleSessions/],
      [{ workspace: 'ws-alpha', roleSessions: { waker: {} } }, /roleSessions/],
      [{ workspace: 'ws-alpha', roleSessions: 'nope' }, /roleSessions/],
    ]
    for (const [body, pattern] of cases) {
      const res = await fetch(`${h.base}/mesh/roles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}: ${await res.clone().text()}`)
      assert.match((await res.json()).error, pattern)
    }
    // The GET side, on the one case the contract pins: an unknown slug is 404, never a 200 with
    // an empty projection (that would read as "this workspace has no roles" rather than
    // "no such workspace").
    assert.equal((await fetch(`${h.base}/mesh/roles?workspace=nope`)).status, 404)
  } finally {
    h.close()
  }
})

// ── 2. unresolved is recorded, not rejected ─────────────────────────────────
test('roles: a session this machine cannot see is accepted but flagged unresolved', async () => {
  const h = await startHarness({
    workspacesSeed: seedRegistry(),
    // Neither of these is live, so both must land in `unresolved`.
    liveSessions: [CONVERSATION_OWNER],
  })
  try {
    const res = await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: 'ws-alpha',
        roleSessions: { waker: { sessionId: 'session-ghost-1' }, l1: { sessionId: 'session-ghost-2' } },
        sourceUpdatedAt: '1795000003000',
        pushedBy: 'session-rotate',
      }),
    })
    assert.equal(res.status, 200, 'an unreachable session must not be rejected: the claim is still a fact')
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.deepEqual([...body.unresolved].sort(), ['session-ghost-1', 'session-ghost-2'])
    assert.match(h.log(), /WARN role projection ws-alpha: 2 session\(s\) unresolved/)

    const stored = h.workspacesRaw().workspaces['ws-alpha'].roleProjection
    assert.equal(stored.unresolved.length, 2)

    const status = await (await fetch(`${h.base}/mesh/status`)).json()
    assert.equal(status.roleProjection.unresolved, 2, '/mesh/status must surface the count for the gate')
    assert.equal(status.roleProjection.roles, 2)
    assert.equal(status.roleProjection.sourceUpdatedAt, '1795000003000')
  } finally {
    h.close()
  }
})

// ── 3. nothing else on the entry moves ─────────────────────────────────────
test('roles: a push leaves every other field of the entry byte-identical', async () => {
  const h = await startHarness({ workspacesSeed: seedRegistry() })
  try {
    const before = h.workspacesRaw().workspaces['ws-alpha']
    // Snapshot the untouched neighbour BEFORE the push. Building the expectation from the seed
    // constant instead is what made this test pass on Windows and fail on Linux (T-mwzyzhan).
    const beforeBeta = h.workspacesRaw().workspaces['ws-beta']
    // Guard against the silent-rewrite failure that produced the false green: the substitution
    // must actually have happened, or this whole test is comparing placeholders.
    assert.equal(beforeBeta.cwd, path.join(h.inbox, 'other'), 'the seed placeholder must be resolved to the real temp dir')
    assert.notEqual(beforeBeta.cwd, '/seed/inbox/other', 'and must not be left as the literal placeholder')
    await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: 'ws-alpha',
        roleSessions: { waker: { sessionId: CONVERSATION_OWNER } },
        sourceUpdatedAt: '1795000004000',
      }),
    })
    const after = h.workspacesRaw().workspaces['ws-alpha']

    // Compare the serialized form of everything the push must not touch.
    for (const field of ['cwd', 'coordinator', 'workers', 'coordinators', 'roles', 'rolesUnrecognized', 'slug']) {
      assert.deepEqual(after[field], before[field], `field "${field}" must be untouched`)
      assert.equal(JSON.stringify(after[field]), JSON.stringify(before[field]), `field "${field}" must be byte-identical`)
    }
    // The other workspace was not involved at all. Compare it against WHAT IT WAS BEFORE THE PUSH,
    // not against the seed constant: the seed carries placeholders that the harness substitutes
    // with real temp directories, so the constant is never the on-disk value (T-mwzyzhan). Reading
    // it back before the push makes this assertion platform-independent by construction.
    assert.deepEqual(h.workspacesRaw().workspaces['ws-beta'], beforeBeta)
    assert.equal(
      JSON.stringify(h.workspacesRaw().workspaces['ws-beta']),
      JSON.stringify(beforeBeta),
      'ws-beta must be byte-identical',
    )
    // Only these two keys were added.
    const added = Object.keys(after).filter((key) => !(key in before)).sort()
    assert.deepEqual(added, ['roleProjection', 'roleSessions'])
  } finally {
    h.close()
  }
})

// ── 4. relay: a dead target follows the role to its current holder ──────────
test('roles: a dead delivery target relays to the role holder and counts a handoff', async () => {
  const conversation = `conv-relay-${Date.now()}`
  const h = await startHarness({
    workspacesSeed: seedRegistry(),
    hubMessages: [{ id: 'm-relay-1', sender: 'peer-b', conversation, body: 'relay me' }],
    conversations: {
      [conversation]: {
        sessionId: DEAD,
        createdAt: Date.now(),
        wakes: 1,
        title: 'relay',
        deliverTo: DEAD,
        deliverRole: 'waker',
      },
    },
    liveSessions: [LIVE_NEW, CONVERSATION_OWNER],
  })
  try {
    // Seed the projection with the live holder.
    await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'ws-alpha', roleSessions: { waker: { sessionId: LIVE_NEW } }, sourceUpdatedAt: 1795000005000 }),
    })
    const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === LIVE_NEW))
    assert.ok(delivered, `the relayed message must reach the new holder, log:\n${h.log()}`)
    assert.match(h.log(), new RegExp(`conversation=${conversation} rebound old=${DEAD} new=${LIVE_NEW} by role=waker`))
    // The conversation now points at the new holder, so the next message needs no lookup.
    assert.equal(h.conversationsNow()[conversation].deliverTo, LIVE_NEW)
    const status = await (await fetch(`${h.base}/mesh/status`)).json()
    assert.ok(status.roleHandoffs >= 1, `roleHandoffs must count it, got ${status.roleHandoffs}`)
    assert.equal(status.lastRoleHandoff?.to, LIVE_NEW)
    assert.equal(status.lastRoleHandoff?.role, 'waker')
    // Nothing landed in an inbox and nothing was parked.
    assert.equal(h.state.created.length, 0)
    assert.equal(h.unboundRows().length, 0)
  } finally {
    h.close()
  }
})

// ── 5. relay negative: unresolvable role parks, never falls back ────────────
test('roles: an unresolvable role parks the mail instead of using an inbox', async () => {
  const conversation = `conv-relay-dead-${Date.now()}`
  const h = await startHarness({
    workspacesSeed: seedRegistry(),
    hubMessages: [{ id: 'm-relay-dead-1', sender: 'peer-b', conversation, body: 'nowhere to go' }],
    conversations: {
      [conversation]: { sessionId: null, createdAt: Date.now(), wakes: 0, title: 'relay dead', deliverTo: DEAD, deliverRole: 'waker' },
    },
    // The projection will point at a session that is NOT live.
    liveSessions: [CONVERSATION_OWNER],
  })
  try {
    await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'ws-alpha', roleSessions: { waker: { sessionId: 'session-gone' } }, sourceUpdatedAt: 1795000006000 }),
    })
    const parked = await waitFor(() => /target=parked reason=role-unresolved/.test(h.log()))
    assert.ok(parked, `it must park with a role-specific reason, log:\n${h.log()}`)
    // The three things it must NOT do.
    assert.equal(h.state.created.length, 0, 'must not auto-create an inbox session')
    assert.equal(h.state.prompts.length, 0, 'must not deliver anywhere')
    assert.equal(h.conversationsNow()[conversation].deliverTo, DEAD, 'must not rebind to a dead id')
    // And the mail is queued, not lost.
    assert.equal(h.unboundRows().filter((row) => row.conversation === conversation).length, 1)
    const status = await (await fetch(`${h.base}/mesh/status`)).json()
    assert.equal(status.lastDeferredReason, 'role-unresolved')
    assert.equal(status.roleHandoffs, 0)
  } finally {
    h.close()
  }
})

// ── 6. conversations without a role behave exactly as before ───────────────
test('roles: a conversation with no deliverRole still uses the unbound path', async () => {
  const conversation = `conv-no-role-${Date.now()}`
  const h = await startHarness({
    workspacesSeed: seedRegistry(),
    hubMessages: [{ id: 'm-no-role-1', sender: 'peer-b', conversation, body: 'plain unbound' }],
  })
  try {
    const created = await waitFor(() => (h.state.created.length ? h.state.created[0] : null))
    assert.ok(created, 'auto-create is still the default for a plain unbound conversation')
    assert.match(h.log(), /target=auto-created/)
    assert.doesNotMatch(h.log(), /role=/)
    const status = await (await fetch(`${h.base}/mesh/status`)).json()
    assert.equal(status.roleHandoffs, 0)
  } finally {
    h.close()
  }
})

// ── 7. two concurrent pushes for different workspaces both survive ─────────
test('roles: two concurrent pushes for different workspaces both land', async () => {
  const h = await startHarness({ workspacesSeed: seedRegistry() })
  try {
    const [alpha, beta] = await Promise.all([
      fetch(`${h.base}/mesh/roles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: 'ws-alpha', roleSessions: { waker: { sessionId: CONVERSATION_OWNER } }, sourceUpdatedAt: 111 }),
      }),
      fetch(`${h.base}/mesh/roles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: 'ws-beta', roleSessions: { l2: { sessionId: LIVE_NEW } }, sourceUpdatedAt: 222 }),
      }),
    ])
    assert.equal(alpha.status, 200)
    assert.equal(beta.status, 200)
    const raw = h.workspacesRaw()
    // Neither update was lost to the other.
    assert.equal(raw.workspaces['ws-alpha'].roleSessions.waker.sessionId, CONVERSATION_OWNER)
    assert.equal(raw.workspaces['ws-alpha'].roleProjection.sourceUpdatedAt, '111')
    assert.equal(raw.workspaces['ws-beta'].roleSessions.l2.sessionId, LIVE_NEW)
    assert.equal(raw.workspaces['ws-beta'].roleProjection.sourceUpdatedAt, '222')
  } finally {
    h.close()
  }
})

// ── mesh_rebind carries the role, and status always has the fields ─────────
test('roles: mesh_rebind can attach a deliverRole and status always reports the field', async () => {
  const conversation = `conv-bind-role-${Date.now()}`
  const h = await startHarness({ workspacesSeed: seedRegistry() })
  try {
    const rebind = await waitFor(() => h.tool('mesh_rebind'))
    const bound = await rebind.execute({ conversation, deliverRole: 'waker' }, { sessionId: CONVERSATION_OWNER })
    assert.equal(bound.ok, true)
    assert.equal(bound.deliverRole, 'waker')
    assert.equal(h.conversationsNow()[conversation].deliverRole, 'waker')

    // Clearing it with an empty string removes the role rather than storing "".
    const cleared = await rebind.execute({ conversation, deliverRole: '' }, { sessionId: CONVERSATION_OWNER })
    assert.equal(cleared.deliverRole, null)
    assert.equal(h.conversationsNow()[conversation].deliverRole, undefined)

    // With no projection pushed at all, status still carries all five fields (all zero/null).
    const status = await (await fetch(`${h.base}/mesh/status`)).json()
    assert.ok('roleProjection' in status, 'the field must exist even with no projection')
    assert.equal(status.roleProjection.sourceUpdatedAt, null)
    assert.equal(status.roleProjection.pushedAt, 0)
    assert.equal(status.roleProjection.roles, 0)
    assert.equal(status.roleProjection.unresolved, 0)
    assert.equal(typeof status.roleHandoffs, 'number')
  } finally {
    h.close()
  }
})

// ── T-mwzwrgg5: `sourceUpdatedAt` is an opaque STRING, never a number ────────
// The bug this pins: team.json.updatedAt is a human-readable date ("2026-11-19"), the contract
// never said whether the field was a timestamp or that date, and this side coerced it with
// Number() — which is NaN for a date — so every real push stored 0. The repo-side gate compared
// "0" with "2026-11-19" and could never agree. The type is now pinned here, and the reverse
// assertion below is what makes a future Number() regression impossible to miss.

test('roles: sourceUpdatedAt round-trips a DATE STRING unchanged and is never coerced to 0', async () => {
  const h = await startHarness({ workspacesSeed: seedRegistry(), liveSessions: [LIVE_NEW, CONVERSATION_OWNER] })
  try {
    // Exactly what rotate-session sends: team.json.updatedAt ?? null.
    const sent = '2026-11-19'
    const res = await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'ws-alpha', roleSessions: { waker: { sessionId: LIVE_NEW, since: 1763000000000 } }, sourceUpdatedAt: sent, pushedBy: 'session-rotate' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    // The echo is the string itself — the reverse assertion: 0 or "0" would fail here.
    assert.equal(body.sourceUpdatedAt, sent)
    assert.notEqual(body.sourceUpdatedAt, 0)
    assert.notEqual(body.sourceUpdatedAt, '0')

    // On disk: same string, not a number.
    const stored = h.workspacesRaw().workspaces['ws-alpha'].roleProjection.sourceUpdatedAt
    assert.equal(stored, sent)
    assert.equal(typeof stored, 'string')

    // GET returns it unchanged.
    const read = await (await fetch(`${h.base}/mesh/roles?workspace=ws-alpha`)).json()
    assert.equal(read.roleProjection.sourceUpdatedAt, sent)
    assert.equal(typeof read.roleProjection.sourceUpdatedAt, 'string')

    // /mesh/status returns it unchanged too — this is the value the gate compares.
    const status = await (await fetch(`${h.base}/mesh/status`)).json()
    assert.equal(status.roleProjection.sourceUpdatedAt, sent)
    assert.equal(typeof status.roleProjection.sourceUpdatedAt, 'string')

    // And `since` (a real millisecond number) survived as a number, unchanged.
    assert.equal(read.roleSessions.waker.since, 1763000000000)
    assert.equal(typeof read.roleSessions.waker.since, 'number')
  } finally {
    h.close()
  }
})

test('roles: an absent or null sourceUpdatedAt is stored as null, never 0 or "null"', async () => {
  const h = await startHarness({ workspacesSeed: seedRegistry(), liveSessions: [LIVE_NEW, CONVERSATION_OWNER] })
  try {
    // Case 1: explicit null.
    const nullPush = await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'ws-alpha', roleSessions: { waker: { sessionId: LIVE_NEW } }, sourceUpdatedAt: null }),
    })
    assert.equal(nullPush.status, 200)
    assert.equal((await nullPush.json()).sourceUpdatedAt, null)
    const storedNull = h.workspacesRaw().workspaces['ws-alpha'].roleProjection.sourceUpdatedAt
    assert.equal(storedNull, null, 'null must not become 0')
    assert.notEqual(storedNull, 'null', 'and must not become the string "null"')
    assert.equal(typeof storedNull, 'object', 'null is typeof object in JS; a string here would be a bug')

    // Case 2: field omitted entirely.
    const omitted = await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'ws-alpha', roleSessions: { waker: { sessionId: LIVE_NEW } } }),
    })
    assert.equal(omitted.status, 200)
    assert.equal((await omitted.json()).sourceUpdatedAt, null)
    assert.equal(h.workspacesRaw().workspaces['ws-alpha'].roleProjection.sourceUpdatedAt, null)

    // Case 3: empty string is treated as absent rather than stored as "".
    const blank = await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'ws-alpha', roleSessions: { waker: { sessionId: LIVE_NEW } }, sourceUpdatedAt: '   ' }),
    })
    assert.equal((await blank.json()).sourceUpdatedAt, null)
    assert.equal(h.workspacesRaw().workspaces['ws-alpha'].roleProjection.sourceUpdatedAt, null)

    // GET and status agree.
    const read = await (await fetch(`${h.base}/mesh/roles?workspace=ws-alpha`)).json()
    assert.equal(read.roleProjection.sourceUpdatedAt, null)
    const status = await (await fetch(`${h.base}/mesh/status`)).json()
    assert.equal(status.roleProjection.sourceUpdatedAt, null)
  } finally {
    h.close()
  }
})

test('roles: a numeric sourceUpdatedAt is preserved losslessly as its string form', async () => {
  // A numeric caller is not rejected, but it goes through the same string path, so what comes back
  // compares equal to what was sent once both sides stringify — which is what the gate does.
  const h = await startHarness({ workspacesSeed: seedRegistry(), liveSessions: [LIVE_NEW, CONVERSATION_OWNER] })
  try {
    const sent = 1795000002001
    const res = await fetch(`${h.base}/mesh/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'ws-alpha', roleSessions: { waker: { sessionId: LIVE_NEW } }, sourceUpdatedAt: sent }),
    })
    assert.equal((await res.json()).sourceUpdatedAt, String(sent))
    const read = await (await fetch(`${h.base}/mesh/roles?workspace=ws-alpha`)).json()
    assert.equal(String(read.roleProjection.sourceUpdatedAt), String(sent))
  } finally {
    h.close()
  }
})

// ── the fixture must not depend on platform path rules (T-mwzyzhan) ─────────
// CI runs on Linux; the local machine is Windows. The bug was a fixture that built its constant
// with path.join, so the same seed had a different string on each platform and the substitution
// (which compared against a POSIX literal) fired on one and not the other. These two tests pin the
// property directly, and they do it by running the SAME resolver under both path rule sets — real
// evidence rather than a comment claiming portability.

test('roles: the seed placeholder is one literal string on every platform', () => {
  // No path.join anywhere in the seed: the constant is identical on Windows and Linux.
  const seed = seedRegistry()
  assert.equal(seed.workspaces['ws-alpha'].cwd, '/seed/inbox')
  assert.equal(seed.workspaces['ws-beta'].cwd, '/seed/inbox/other')
  assert.equal(seed.workspaces['ws-alpha'].workers.waker.cwd, '/seed/inbox')

  // Demonstrate the old failure mode explicitly, so a future edit that reintroduces path.join
  // into the seed is recognisable: the two platforms disagree, which is what made the test
  // platform-dependent.
  assert.notEqual(
    path.posix.join(SEED_ROOT, 'other'),
    path.win32.join(SEED_ROOT, 'other'),
    'this inequality is why the seed must not use path.join',
  )
})

test('roles: the placeholder resolves correctly under both POSIX and Windows path rules', () => {
  const posixInbox = '/tmp/waker-roles-abc/inbox'
  const winInbox = 'C:\\Users\\x\\AppData\\Local\\Temp\\waker-roles-abc\\inbox'

  // POSIX rules (what CI does).
  assert.equal(resolveSeedPath('/seed/inbox/other', { inbox: posixInbox, joinFn: path.posix.join }), '/tmp/waker-roles-abc/inbox/other')
  assert.equal(resolveSeedPath('/seed/inbox', { inbox: posixInbox, joinFn: path.posix.join }), posixInbox)

  // Windows rules (what this machine does).
  assert.equal(
    resolveSeedPath('/seed/inbox/other', { inbox: winInbox, joinFn: path.win32.join }),
    path.win32.join(winInbox, 'other'),
  )
  assert.equal(resolveSeedPath('/seed/inbox', { inbox: winInbox, joinFn: path.win32.join }), winInbox)

  // Both must have actually substituted — the silent no-op is the failure that produced the
  // Windows false green.
  for (const [inbox, joinFn] of [
    [posixInbox, path.posix.join],
    [winInbox, path.win32.join],
  ]) {
    const resolved = resolveSeedPath('/seed/inbox/other', { inbox, joinFn })
    assert.notEqual(resolved, '/seed/inbox/other', 'the rewrite must happen')
    assert.ok(resolved.includes('other'), 'and must keep the tail segment')
    assert.ok(!resolved.includes('/seed/'), 'and must drop the placeholder root')
  }

  // An unrelated absolute path is left alone, and non-strings pass through untouched.
  assert.equal(resolveSeedPath('/somewhere/else', { inbox: posixInbox, joinFn: path.posix.join }), '/somewhere/else')
  assert.equal(resolveSeedPath(null, { inbox: posixInbox }), null)
})

// ── reproduce the CI failure and show the new assertion cannot have it ──────
// No Linux box here (WSL is present but has no node, and installing one is a tool decision that is
// not mine to make), so this simulates the CI environment with the real path.posix implementation
// and the real seed/resolver. It asserts BOTH halves: the old expectation style fails under POSIX
// rules, and the new one (compare against the pre-push snapshot) does not.
test('roles: the old seed-constant expectation fails under POSIX rules, the new one cannot', () => {
  const posixInbox = '/tmp/waker-roles-tmrYZx/inbox'
  const joinFn = path.posix.join

  // The harness's substitution, as it really runs, under Linux path rules.
  const resolved = JSON.parse(JSON.stringify(seedRegistry()))
  for (const entry of Object.values(resolved.workspaces)) {
    entry.cwd = resolveSeedPath(entry.cwd, { inbox: posixInbox, joinFn })
    for (const worker of Object.values(entry.workers ?? {})) {
      worker.cwd = resolveSeedPath(worker.cwd, { inbox: posixInbox, joinFn })
    }
  }

  // ws-beta now points at the real temp dir, exactly as CI reported it.
  assert.equal(resolved.workspaces['ws-beta'].cwd, '/tmp/waker-roles-tmrYZx/inbox/other')

  // The OLD expectation (compare the on-disk entry with the seed constant) is wrong under POSIX
  // rules — this is the CI failure reproduced.
  const oldExpectation = seedRegistry().workspaces['ws-beta']
  assert.notDeepEqual(resolved.workspaces['ws-beta'], oldExpectation, 'the seed constant is not the on-disk value')

  // The NEW expectation compares against the pre-push snapshot, which IS the on-disk value. A push
  // only touches roleSessions/roleProjection on its own workspace, so the neighbour is unchanged
  // and the comparison holds on every platform.
  const beforeBeta = JSON.parse(JSON.stringify(resolved.workspaces['ws-beta']))
  const afterPush = JSON.parse(JSON.stringify(resolved.workspaces['ws-beta']))
  assert.deepEqual(afterPush, beforeBeta)
  assert.equal(JSON.stringify(afterPush), JSON.stringify(beforeBeta))

  // And the same two assertions under Windows rules, to show the outcome does not depend on the
  // platform: old fails, new holds.
  const winInbox = 'C:\\Users\\x\\AppData\\Local\\Temp\\waker-roles-tmrYZx\\inbox'
  const winResolved = JSON.parse(JSON.stringify(seedRegistry()))
  for (const entry of Object.values(winResolved.workspaces)) {
    entry.cwd = resolveSeedPath(entry.cwd, { inbox: winInbox, joinFn: path.win32.join })
    for (const worker of Object.values(entry.workers ?? {})) {
      worker.cwd = resolveSeedPath(worker.cwd, { inbox: winInbox, joinFn: path.win32.join })
    }
  }
  assert.notDeepEqual(winResolved.workspaces['ws-beta'], seedRegistry().workspaces['ws-beta'])
  const winBefore = JSON.parse(JSON.stringify(winResolved.workspaces['ws-beta']))
  assert.deepEqual(JSON.parse(JSON.stringify(winResolved.workspaces['ws-beta'])), winBefore)
})
