// Endpoint acceptance for the waker's local-session features and the 0.5.0 activation
// matrix (standalone / bootstrap / pull). Every case boots a real listener on a random
// port with the same handlers the plugin registers at runtime. Sessions, conversations,
// the token file and settings live in throwaway temp directories: these tests must never
// list, prompt or delete the real sessions of the machine that runs them.
//
//   node test/waker-endpoints.test.js

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { zstdCompressSync } = require('node:zlib')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')

const REPO = path.join(__dirname, '..')
const ENTRY = path.join(REPO, 'plugins', 'mesh-waker', 'index.js')

// Every harness writes plugin logs; point them away from the live gateway's own file.
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), 'waker-endpoints-test.log')
const TEST_LOG = process.env.MESH_WAKER_LOG

const results = []
// A stray rejection used to kill the process before the summary line, which looked like a
// random exit=1. Surface it as a failure instead of a silent crash (T-272).
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION', reason && reason.stack ? reason.stack : reason)
  process.exitCode = 1
})
function report(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`)
}

/**
 * A port for the harness listener. Port 0 lets the OS pick from its dynamic range, and on
 * this machine that range starts at 1024 (Windows default is 49152): the port handed to a
 * listener can collide with an outbound connection's local port, and Windows SO_REUSEADDR
 * then lets the bind succeed while connections are refused or reset (T-299: the plugin
 * logged "listening" while every probe failed). Prefer a high range no OS hands to clients,
 * and retry when a candidate is taken.
 */
async function freePort() {
  const attempt = (port) =>
    new Promise((resolvePort, reject) => {
      const probe = net.createServer()
      probe.on('error', reject)
      probe.listen(port, '127.0.0.1', () => {
        const { port: actual } = probe.address()
        probe.close(() => resolvePort(actual))
      })
    })
  for (let index = 0; index < 20; index += 1) {
    const candidate = 20000 + Math.floor(Math.random() * 12000)
    try {
      return await attempt(candidate)
    } catch {
      /* taken: try another candidate */
    }
  }
  return await attempt(0)
}

async function request(base, route, { method = 'GET', body, timeoutMs } = {}) {
  let response
  try {
    response = await fetch(`${base}${route}`, {
      method,
      headers: { connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
  } catch (error) {
    // undici's "fetch failed" hides the errno in error.cause; name it here so a flaky case
    // reports ECONNREFUSED / ECONNRESET / ETIMEDOUT instead of the useless wrapper (T-299).
    throw new Error(`request ${method} ${route} failed: ${describeProbeError(error)}`)
  }
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body: the assertion only needs the status */
  }
  return { status: response.status, json, text }
}

/**
 * Name the failure instead of swallowing it (T-299). ECONNREFUSED means nothing is listening
 * (bind failed or another socket owns the port); ETIMEDOUT means the listener exists but the
 * handler never answered; ECONNRESET means it accepted and then dropped the connection. The
 * three have different causes, so the boot error must say which. undici hides the real errno
 * in error.cause (often an AggregateError), so walk the chain instead of printing the wrapper.
 */
function probeErrorChain(error) {
  const codes = []
  const messages = []
  let current = error
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current.code) codes.push(String(current.code))
    if (current.errno && String(current.errno) !== String(current.code)) codes.push(String(current.errno))
    if (current.message) messages.push(String(current.message))
    const next = Array.isArray(current.errors) && current.errors.length ? current.errors[0] : current.cause
    current = next
  }
  return { codes, messages }
}

function describeProbeError(error) {
  const { codes, messages } = probeErrorChain(error)
  const joined = messages.join(' ')
  const name = error?.name ?? 'error'
  if (codes.includes('ECONNREFUSED') || /ECONNREFUSED/.test(joined)) return 'ECONNREFUSED (nothing is listening on the port)'
  if (codes.includes('ETIMEDOUT') || name === 'TimeoutError' || /timed out|timeout/i.test(joined)) {
    return 'ETIMEDOUT (the listener accepted the request but answered nothing within 1000ms)'
  }
  if (codes.includes('ECONNRESET') || /ECONNRESET/.test(joined)) return 'ECONNRESET (the connection was accepted and then reset)'
  return `${codes.join('/') || name}: ${messages[0] ?? String(error)}`
}

function seedSession(sessionsRoot, { id, title, workspace = 'ws-test', mtime = null }) {
  const dir = path.join(sessionsRoot, workspace, id)
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(log, '')
  if (mtime) {
    const at = new Date(mtime)
    fs.utimesSync(log, at, at)
  }
  return { id, title, workspace, log, mtime: fs.statSync(log).mtimeMs }
}

/**
 * Start the plugin on a random port with isolated state. `seedSessions` are written before
 * the plugin boots so the session-title cache is warm and no zstd log parsing is needed.
 *
 * Defaults to standalone (no hubUrl): the local endpoints are what these cases exercise,
 * and standalone boots must not touch the network. Pass `config` to boot a hub-mode
 * install (bootstrap / pull) and `writeToken: false` to start with no stored token.
 */
async function startHarness({ seedSessions = [], conversations = null, config = {}, writeToken = true, batches = null, archivedIds = [], toolsDelayCalls = 0, tasksSeed = null, prepareHome = null, tmpRoot = null } = {}) {
  const ownsTmp = !tmpRoot
  const tmp = tmpRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'waker-endpoints-'))
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  fs.mkdirSync(sessionsRoot, { recursive: true })
  fs.mkdirSync(tokenDir, { recursive: true })
  fs.mkdirSync(home, { recursive: true })

  const seeded = seedSessions.map((seed) => ({ ...seedSession(sessionsRoot, seed), cwd: seed.cwd ?? null }))
  const sessionIndex = {}
  // Seed cwd when the case needs workspace-scoped behaviour (e.g. requester inference).
  for (const seed of seeded) sessionIndex[seed.id] = { mtime: seed.mtime, title: seed.title, cwd: seed.cwd }
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify(sessionIndex))
  const tokenFile = path.join(tokenDir, 'token')
  if (writeToken) fs.writeFileSync(tokenFile, 'test' + '-token')
  const conversationsPath = path.join(tokenDir, 'conversations.json')
  if (conversations) fs.writeFileSync(conversationsPath, JSON.stringify(conversations, null, 2))
  const batchesPath = path.join(tmp, 'batches.json')
  if (batches) fs.writeFileSync(batchesPath, JSON.stringify({ savedAt: Date.now(), batches }, null, 2))
  // Pre-seed the task registry under the throwaway HOME so retention/compaction can be tested.
  if (Array.isArray(tasksSeed)) {
    const registryDir = path.join(home, '.dsh', 'mesh-waker')
    fs.mkdirSync(registryDir, { recursive: true })
    fs.writeFileSync(path.join(registryDir, 'tasks.jsonl'), tasksSeed.map((row) => JSON.stringify(row)).join('\n') + (tasksSeed.length ? '\n' : ''))
  }

  const state = {
    prompts: [],
    cancels: [],
    archived: [],
    registry: [],
    created: [],
    archiveError: null,
    agents: new Map(),
    workspace: null,
    workspacePath: null,
    tools: [],
  }

  const sessionController = {
    async create(request) {
      const id = `session-${randomUUID()}`
      const workspace = request.workspaceId ? `ws-${request.workspaceId}` : 'ws-default'
      const dir = path.join(sessionsRoot, workspace, id)
      fs.mkdirSync(dir, { recursive: true })
      const log = path.join(dir, 'session.v4.jsonl.zstd')
      // Mirror the host: a new session log carries the cwd, which the identity lookup reads
      // back (T-394). An empty log would make a created session unidentifiable.
      const meta = { type: 'session/open', data: { cwd: request.cwd ?? request.workspacePath ?? null } }
      fs.writeFileSync(log, zstdCompressSync(Buffer.from(JSON.stringify(meta) + '\n')))
      state.created.push({ id, request, log })
      return { sessionId: id }
    },
    async rename() {},
    async prompt(request) {
      state.prompts.push(request)
      return {}
    },
    async cancel(request) {
      state.cancels.push(request.sessionId)
    },
  }

  const agents = {
    get: (id) => state.agents.get(id),
    resume: async () => {},
  }

  const workspaceRegistry = {
    archivedSessionIds: () => new Set(archivedIds),
    async archiveSession(id) {
      state.archived.push(id)
      if (state.archiveError) throw new Error(state.archiveError)
    },
    async resolveByPath(workspacePath) {
      return state.workspace && state.workspace.path === workspacePath ? state.workspace : null
    },
    async create(workspacePath, title) {
      state.workspace = { id: `ws-${randomUUID().slice(0, 8)}`, path: workspacePath, title }
      return state.workspace
    },
    async deleteKnown(id) {
      state.registry.push(['deleteKnown', id])
      return false
    },
  }

  const previousEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    MESH_WAKER_SESSIONS_ROOT: process.env.MESH_WAKER_SESSIONS_ROOT,
  }
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.MESH_WAKER_SESSIONS_ROOT = sessionsRoot
  if (typeof prepareHome === 'function') prepareHome(home)

  const { apply } = await import(pathToFileURL(ENTRY).href)
  const port = await freePort()
  const disposers = []
  const listeners = new Map()
  let toolsGetCalls = 0
  const toolsService = {
    register: (definition) => {
      state.tools.push(definition)
      return () => {}
    },
  }
  const pluginLog = []
  const ctx = {
    // The plugin reports listener failures through ctx.logger (EADDRINUSE and friends).
    // A no-op logger made those vanish and the readiness loop could only say "never
    // answered"; keep the tail so the boot error names the real cause (T-299).
    logger: {
      info(message) {
        if (pluginLog.length > 50) pluginLog.shift()
        pluginLog.push(`info: ${message}`)
      },
      warn(message) {
        if (pluginLog.length > 50) pluginLog.shift()
        pluginLog.push(`warn: ${message}`)
      },
      error(message) {
        if (pluginLog.length > 50) pluginLog.shift()
        pluginLog.push(`error: ${message}`)
      },
    },
    // Hosts expose services through ctx.get; toolsDelayCalls simulates the host's tools
    // service arriving after the plugin's first turns (the 2026-10-31 registration race).
    // With a delay configured, ctx.tools stays undefined so only the get() path can succeed.
    get: (name) => {
      if (name === 'tools') {
        toolsGetCalls += 1
        return toolsGetCalls > toolsDelayCalls ? toolsService : undefined
      }
      return undefined
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {
        const list = listeners.get(name) ?? []
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
      }
    },
    commands: { register: () => () => {} },
    tools: toolsDelayCalls > 0 ? undefined : toolsService,
    sessionController,
    agents,
    workspaceRegistry,
  }
  // Any request that does not target this harness's own listener is "external": a
  // standalone boot must make zero of them (contract section 3).
  const external = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    const target = String(url)
    if (!target.startsWith(`http://127.0.0.1:${port}`)) external.push(target)
    return realFetch(url, init)
  }
  const merged = {
    listenHost: '127.0.0.1',
    listenPort: port,
    tokenFile,
    workspacePath: path.join(tmp, 'inbox'),
    sessionCwd: path.join(tmp, 'inbox'),
    receiptFile: path.join(tmp, 'receipts.jsonl'),
    batchFile: batchesPath,
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
    ...config,
  }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key]
  }
  // A boot that fails must not leak the listener, timers or the temp HOME: the failure
  // injection case below relies on this, and a flaky boot should not poison later cases.
  const cleanupBoot = () => {
    if (globalThis.fetch !== realFetch) globalThis.fetch = realFetch
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already closed */
      }
    }
    try {
      if (ownsTmp) fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* temp cleanup is best effort */
    }
  }
  let applyError = null
  try {
    await apply(ctx, merged)
  } catch (error) {
    applyError = new Error(`the plugin apply() failed during boot: ${error?.message ?? error}`)
  } finally {
    // HOME/USERPROFILE come back after apply, but the sessions root must stay: the plugin
    // reads it per call (T-365 origin scan), and restoring it would point discovery at the
    // real ~/.dsh/sessions of the machine running the suite.
    for (const key of Object.keys(previousEnv)) {
      if (key === 'MESH_WAKER_SESSIONS_ROOT') continue
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
  }
  if (applyError) {
    cleanupBoot()
    throw applyError
  }

  const base = `http://127.0.0.1:${port}`
  const startedAt = Date.now()
  const deadline = startedAt + 5000
  let attempts = 0
  let ready = false
  let lastProblem = 'no probe completed'
  while (Date.now() < deadline && !ready) {
    // EADDRINUSE / EACCES arrive on the plugin's server object and are logged; waiting the
    // full budget for a listener that already failed only hides the reason (T-299).
    const listenerError = pluginLog.find((line) => /listener error/i.test(line))
    if (listenerError) {
      cleanupBoot()
      throw new Error(`the test listener failed to start: ${listenerError}`)
    }
    attempts += 1
    try {
      const probe = await request(base, '/mesh/status', { timeoutMs: 1000 })
      if (probe.status === 200) ready = true
      else lastProblem = `HTTP ${probe.status}: ${String(probe.text ?? '').slice(0, 120)}`
    } catch (error) {
      lastProblem = describeProbeError(error)
    }
    if (!ready) await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  if (!ready) {
    const pluginTail = pluginLog.slice(-3).join(' | ')
    cleanupBoot()
    throw new Error(
      `the test listener never answered /mesh/status (last error: ${lastProblem}; after ${attempts} attempts in ${Date.now() - startedAt}ms${pluginTail ? `; plugin log: ${pluginTail}` : ''})`,
    )
  }

  return {
    base,
    state,
    seeded,
    home,
    sessionsRoot,
    tokenDir,
    tokenFile,
    conversationsPath,
    receiptsPath: path.join(tmp, 'receipts.jsonl'),
    batchesPath,
    external,
    emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args)
    },
    async callApproval(request, next) {
      const listener = (listeners.get('approval/request') ?? [])[0]
      if (!listener) throw new Error('the plugin did not register an approval/request listener')
      return await listener(request, next ?? (async () => 'unavailable'))
    },
    close() {
      if (globalThis.fetch !== realFetch) globalThis.fetch = realFetch
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already closed */
        }
      }
      try {
        if (ownsTmp) fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* temp cleanup is best effort */
      }
    },
  }
}

/**
 * Minimal hub for bootstrap + pull: /api/bootstrap, /api/enroll, /api/inbox, /api/read,
 * /api/conversations, /api/peers. Messages stay unread until /api/read, like the real hub.
 */
async function startFakeHub({ token = 'tok-' + 'selftest', messages = [], sendDelayMs = 0, sendStatus = 201, onSend = null, failTaskStatus = 0 } = {}) {
  const requests = []
  const readIds = []
  const sends = []
  // Cross-machine tasks (T-388/T-389): rows live here, bodies in `blobs` keyed by sha256.
  const tasks = []
  const blobs = new Map()
  const taskClaims = []
  const taskHeartbeats = []
  const taskSettles = []
  const blobUploads = []
  const taskCreates = []
  let unread = messages.map((message) => ({ ...message }))
  // Every message ever seen in this fake hub (read or not): /api/conversation serves the
  // history for /mesh/bind backfill, exactly like the real hub (T-426).
  const allMessages = messages.map((message) => ({ ...message }))
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake-hub')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body = {}
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {}
      } catch {
        body = {}
      }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (url.pathname === '/api/bootstrap') {
        return send(200, {
          service: 'dsh-mesh',
          version: '0.7.15',
          protocol: 1,
          tls: null,
          endpoints: { mcp: '/mcp', api: '/api', inbox: '/api/inbox', enroll: '/api/enroll' },
          enroll: { code_ttl_ms: 600000, device_flow: true },
          wake: { modes: ['pull', 'push'], min_poll_interval_ms: 5000 },
        })
      }
      if (url.pathname === '/api/enroll') {
        if (body.code !== 'JOIN-123') return send(401, { error: 'invalid or expired enrollment code' })
        return send(201, { name: body.name ?? 'dsh-test', token })
      }
      if (url.pathname === '/api/inbox') return send(200, { messages: unread })
      if (url.pathname === '/api/conversation') {
        const wanted = url.searchParams.get('conversation') ?? ''
        return send(200, { messages: allMessages.filter((message) => message.conversation === wanted) })
      }
      if (url.pathname === '/api/send') {
        sends.push(body)
        if (typeof onSend === 'function') onSend(body)
        const respond = () =>
          send(
            sendStatus,
            sendStatus >= 200 && sendStatus < 300
              ? { id: 'm-sent-' + sends.length, silent: body.silent === true, conversation: body.conversation }
              : { error: 'send failed' },
          )
        if (sendDelayMs > 0) return setTimeout(respond, sendDelayMs)
        return respond()
      }
      if (url.pathname === '/api/read') {
        const ids = new Set((body.ids ?? []).map(String))
        for (const id of ids) readIds.push(id)
        unread = unread.filter((message) => !ids.has(String(message.id)))
        return send(200, { ok: true })
      }
      if (url.pathname === '/api/conversations') return send(200, { conversations: [] })
      if (url.pathname === '/api/peers') return send(200, { peers: [] })
      if (url.pathname === '/api/register') return send(202, { name: 'dsh-test' })
      // ---- T-389 upload side (what the waker proxy forwards to the real hub) ----
      if (url.pathname === '/api/blob' && req.method === 'POST') {
        const raw = Buffer.concat(chunks)
        const sha = require('node:crypto').createHash('sha256').update(raw).digest('hex')
        const name = url.searchParams.get('name') ?? 'blob.bin'
        const expected = url.searchParams.get('sha256') ?? ''
        if (expected && expected !== sha) return send(400, { error: 'sha256 mismatch', expected, actual: sha })
        blobUploads.push({ name, sha256: sha, bytes: raw.length, text: raw.toString('utf8') })
        blobs.set(sha, raw.toString('utf8'))
        return send(201, { id: `blob-${sha.slice(0, 8)}`, name, bytes: raw.length, sha256: sha })
      }
      if (url.pathname === '/api/tasks' && req.method === 'POST') {
        taskCreates.push(body)
        if (failTaskStatus) return send(failTaskStatus, { error: 'hub exploded' })
        if (!/^[A-Z][A-Z0-9]{1,11}-\d{8}-\d{1,6}$/.test(String(body.task_id ?? ''))) return send(400, { error: 'task_id must be <PREFIX>-<YYYYMMDD>-<SEQ>' })
        if (tasks.some((row) => row.task_id === body.task_id)) return send(409, { error: 'task already exists' })
        const row = { ...body, status: 'pending', claim_agent: null, lease_until: null }
        tasks.push(row)
        return send(201, { task: row })
      }
      // ---- T-388 hub task contract (fake, per .worklog/docs-internal/t1-hub-tasks.md) ----
      if (url.pathname === '/api/tasks' && req.method === 'GET') {
        const agent = url.searchParams.get('agent') ?? ''
        const status = url.searchParams.get('status') ?? 'pending'
        return send(200, {
          ok: true,
          tasks: tasks.filter((row) => row.target_agent === agent && row.status === status),
        })
      }
      if (url.pathname === '/api/blobs' && req.method === 'GET') {
        const sha = url.searchParams.get('sha256') ?? ''
        const text = blobs.get(sha)
        return send(200, { ok: true, blobs: text === undefined ? [] : [{ id: `blob-${sha.slice(0, 8)}`, sha256: sha, bytes: Buffer.byteLength(text) }] })
      }
      if (url.pathname.startsWith('/api/blob/') && req.method === 'GET') {
        const id = url.pathname.slice('/api/blob/'.length)
        for (const [sha, text] of blobs) {
          if (`blob-${sha.slice(0, 8)}` === id) {
            // Mirror the real hub (T-392): blobs are served as the raw file stream, NOT JSON.
            res.writeHead(200, { 'content-type': 'application/octet-stream' })
            res.end(text)
            return
          }
        }
        return send(404, { ok: false, error: 'no such blob' })
      }
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(claim|heartbeat|settle)$/)
      if (taskMatch) {
        const [, taskId, action] = taskMatch
        const row = tasks.find((task) => task.task_id === taskId)
        if (!row) return send(404, { ok: false, error: 'no such task' })
        if (action === 'claim') {
          taskClaims.push({ taskId, body })
          if (row.status !== 'pending') return send(409, { ok: false, error: 'task is not pending' })
          if (row.claim_agent) return send(409, { ok: false, error: 'already claimed' })
          row.status = 'claimed'
          row.claim_agent = body.agent ?? 'dsh-test'
          row.lease_until = Date.now() + Number(body.lease_ms ?? 600000)
          return send(200, { ok: true, task: { ...row } })
        }
        if (action === 'heartbeat') {
          taskHeartbeats.push({ taskId, body })
          if (row.status !== 'claimed') return send(409, { ok: false, error: 'not claimed' })
          row.lease_until = Date.now() + Number(body.lease_ms ?? 600000)
          return send(200, { ok: true, lease_until: row.lease_until })
        }
        // Mirror the real hub (T-399): settle validates `status` and `source`, and rejects a
        // body that only carries `result` — that mismatch is what the fake used to hide.
        const SETTLE_STATUSES = new Set(['completed', 'error', 'lost', 'partial'])
        const settleStatus = String(body.status ?? '')
        const settleSource = body.source === undefined ? 'declared' : String(body.source)
        if (!SETTLE_STATUSES.has(settleStatus)) {
          return send(400, { error: 'status must be completed|error|lost|partial' })
        }
        if (!['observed', 'declared'].includes(settleSource)) {
          return send(400, { error: 'source must be observed|declared' })
        }
        taskSettles.push({ taskId, body: { ...body, status: settleStatus, source: settleSource } })
        if (row.status === 'settled') return send(200, { ok: true, receipt: row.receipt ?? null, idempotent: true })
        row.status = 'settled'
        row.receipt = { task_id: taskId, status: settleStatus, source: settleSource, summary: body.summary ?? '' }
        return send(200, { ok: true, receipt: row.receipt })
      }
      return send(404, { error: 'not found' })
    })
  })
  // Same high-range rule as the harness listener: port 0 comes from the OS dynamic range,
  // where an outbound connection can hold the same port and Windows SO_REUSEADDR then lets
  // the bind succeed while requests are refused/reset (T-299).
  const port = await freePort()
  await new Promise((resolveListen) => server.listen(port, '127.0.0.1', resolveListen))
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    push(message) {
      unread.push({ ...message })
      allMessages.push({ ...message })
    },
    get readIds() {
      return readIds
    },
    get sends() {
      return sends
    },
    get unread() {
      return unread
    },
    /** Register a hub task row and its body (T-388): text is stored under its sha256. */
    addTask(row, text = '') {
      const sha = require('node:crypto').createHash('sha256').update(String(text)).digest('hex')
      if (text) blobs.set(sha, String(text))
      const task = {
        task_id: row.task_id,
        origin_agent: row.origin_agent ?? 'mesh-a',
        target_agent: row.target_agent ?? 'dsh-test',
        intent: row.intent ?? 'auto',
        target_session: row.target_session ?? null,
        target_ws: row.target_ws ?? null,
        subject: row.subject ?? 'task',
        requester: row.requester ?? 'mesh · 协调',
        thread: row.thread ?? null,
        batch_id: row.batch_id ?? null,
        status: 'pending',
        claim_agent: null,
        lease_until: null,
        text_ref: `sha256:${sha}`,
      }
      tasks.push(task)
      return task
    },
    get tasks() {
      return tasks
    },
    get taskClaims() {
      return taskClaims
    },
    get taskHeartbeats() {
      return taskHeartbeats
    },
    get taskSettles() {
      return taskSettles
    },
    get taskListRequests() {
      return requests.filter((entry) => entry.path === '/api/tasks' && entry.method === 'GET')
    },
    get blobUploads() {
      return blobUploads
    },
    get taskCreates() {
      return taskCreates
    },
    close: () =>
      new Promise((resolveClose) => {
        server.close(resolveClose)
        server.closeAllConnections?.()
      }),
  }
}

async function waitFor(check, timeoutMs = 10000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, stepMs))
  }
  return null
}

/**
 * Read conversations.json only after it exists and parses (T-419). The plugin writes the map
 * while/after delivering the wake prompt, so a fast prompt arrival on a slow CI runner can
 * precede the write; reading immediately produced a flaky ENOENT (CI run 43064663673).
 */
async function readConversationsWhenReady(h, timeoutMs = 5000) {
  const parsed = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(h.conversationsPath, 'utf8'))
    } catch {
      return null
    }
  }, timeoutMs)
  if (parsed) return parsed
  throw new Error(
    `conversations.json was not readable within ${timeoutMs}ms: path=${h.conversationsPath} prompts=${h.state.prompts.length} created=${h.state.created.length}`,
  )
}

/** Evaluate client.js in a VM (no React) and return its opt-in test helpers. */
function loadClientHelpers() {
  const source = fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'client.js'), 'utf8')
  let helpers = null
  const sandbox = {
    console,
    document: { currentScript: null },
    window: {
      __DSH_BOOT__: { entries: [] },
      __ModuleLoader__: { load: () => {} },
    },
    __meshWakerTestHook: (value) => {
      helpers = value
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return helpers
}

/** Boot a hub-mode harness with the approval bridge enabled and wait until it is armed. */
async function startApprovalHarness(boot, fake, overrides = {}, extra = {}) {
  const h = await boot({
    config: {
      hubUrl: fake.url,
      ...extra,
      approvalBridge: {
        enabled: true,
        to: 'peer-owner',
        allowFrom: ['peer-owner'],
        timeoutSeconds: 5,
        pollMs: 250,
        ...overrides,
      },
    },
  })
  await waitFor(async () => {
    const status = await request(h.base, '/mesh/status')
    return status.json?.mode && status.json.mode !== 'standalone' ? status.json : null
  }, 8000)
  return h
}

/** Boot a hub-mode harness with the question bridge enabled, armed and tool-registered. */
async function startQuestionHarness(boot, fake, overrides = {}, extra = {}) {
  const h = await boot({
    config: {
      hubUrl: fake.url,
      ...extra,
      questionBridge: {
        enabled: true,
        to: 'peer-owner',
        allowFrom: ['peer-owner'],
        timeoutSeconds: 5,
        pollMs: 250,
        ...overrides,
      },
    },
  })
  await waitFor(async () => {
    const status = await request(h.base, '/mesh/status')
    return status.json?.mode && status.json.mode !== 'standalone' ? status.json : null
  }, 8000)
  await waitFor(() => h.state.tools.find((tool) => tool.name === 'mesh_ask'), 8000)
  return h
}

function meshAskTool(h) {
  const tool = h.state.tools.find((entry) => entry.name === 'mesh_ask')
  if (!tool) throw new Error('mesh_ask was not registered')
  return tool
}


const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function readReceipts(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function runCase(name, fn) {
  let harness = null
  try {
    await fn((options) => startHarness(options).then((started) => (harness = started)))
  } catch (error) {
    report(name, false, error.message)
  } finally {
    if (harness) harness.close()
  }
}

async function main() {
  // 1. inject must refuse an ambiguous title instead of guessing a target.
  await runCase('inject refuses an ambiguous title', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-dup-a', title: 'dup title' },
        { id: 'session-dup-b', title: 'dup title' },
      ],
    })
    const res = await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'dup title', text: 'hello' } })
    const ok = res.status === 400 && res.json?.ok === false && /多个/.test(res.json?.error ?? '') && h.state.prompts.length === 0
    report('inject refuses an ambiguous title', ok, `status=${res.status} prompts=${h.state.prompts.length} error=${res.json?.error ?? '-'}`)
  })

  // 2. create with cwd resolves/creates the workspace and reports both identities.
  await runCase('create with cwd binds a workspace', async (boot) => {
    const h = await boot()
    const cwd = path.join(h.sessionsRoot, '..', 'project')
    fs.mkdirSync(cwd, { recursive: true })
    const res = await request(h.base, '/mesh/sessions/create', {
      method: 'POST',
      body: { title: 'worker', cwd, prompt: '' },
    })
    const ok =
      res.status === 201 &&
      res.json?.ok === true &&
      res.json?.workspacePath === cwd &&
      typeof res.json?.workspaceId === 'string' &&
      res.json.workspaceId.length > 0 &&
      h.state.created.length === 1 &&
      fs.existsSync(h.state.created[0].log)
    const detail = `status=${res.status} workspaceId=${res.json?.workspaceId ?? '-'} workspacePath=${res.json?.workspacePath ?? '-'} created=${h.state.created.length}`
    report('create with cwd binds a workspace', ok, detail)
  })

  // 3. archive of a session without a workspace must surface an error, not a 500.
  await runCase('archive without workspace is a 4xx, not 500', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-orphan', title: 'orphan' }] })
    h.state.archiveError = 'workspace/session-active: no workspace for session-orphan'
    const res = await request(h.base, '/mesh/sessions/archive', { method: 'POST', body: { session: 'session-orphan' } })
    const ok = res.status !== 500 && res.status >= 400 && res.json?.ok === false
    report('archive without workspace is a 4xx, not 500', ok, `status=${res.status} error=${res.json?.error ?? '-'}`)
  })

  // 4. delete of an unknown id must fail loudly: the old endpoint answered 200/ok:true.
  await runCase('delete of an unknown session is 4xx', async (boot) => {
    const h = await boot()
    const res = await request(h.base, '/mesh/sessions/delete', { method: 'POST', body: { session: 'session-does-not-exist' } })
    const ok = res.status === 404 && res.json?.ok === false && /找不到会话|not found/.test(res.json?.error ?? '')
    report('delete of an unknown session is 4xx', ok, `status=${res.status} ok=${res.json?.ok} error=${res.json?.error ?? '-'}`)
  })

  // 5. delete stops a live session, drops its conversations bindings, then removes the log.
  await runCase('delete stops the session, drops bindings, removes the log', async (boot) => {
    const h = await boot()
    const created = await request(h.base, '/mesh/sessions/create', { method: 'POST', body: { title: 'temp worker', prompt: '' } })
    const id = created.json?.sessionId
    if (!id) throw new Error(`create failed: ${created.status} ${created.text}`)
    // Simulate a live agent whose dispose hook the delete path must call.
    h.state.agents.set(id, {
      dispose: () => h.state.agents.delete(id),
    })
    const bound = await request(h.base, '/mesh/bind', { method: 'POST', body: { conversation: 'conv/delete-test', sessionId: id, deliver: true } })
    if (bound.json?.deliverTo !== id) throw new Error(`bind failed: ${bound.status} ${bound.text}`)

    const deleted = await request(h.base, '/mesh/sessions/delete', { method: 'POST', body: { session: id } })
    const listed = await request(h.base, '/mesh/sessions')
    const ids = (listed.json?.sessions ?? []).map((session) => session.id)
    const conversationsText = JSON.stringify(await readConversationsWhenReady(h))
    const ok =
      deleted.status === 200 &&
      deleted.json?.ok === true &&
      deleted.json?.method === 'session-directory' &&
      !ids.includes(id) &&
      h.state.agents.get(id) === undefined &&
      !conversationsText.includes(id) &&
      h.state.cancels.includes(id)
    const detail = `status=${deleted.status} sessions_has_id=${ids.includes(id)} agents_get=${String(h.state.agents.get(id))} conversations_has_id=${conversationsText.includes(id)} bindingsDropped=${deleted.json?.bindingsDropped}`
    report('delete stops the session, drops bindings, removes the log', ok, detail)
  })

  // 6. a live session that cannot be stopped must be refused instead of half-deleted.
  await runCase('delete refuses a live session it cannot stop', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-stuck', title: 'stuck' }] })
    h.state.agents.set('session-stuck', {})
    const res = await request(h.base, '/mesh/sessions/delete', { method: 'POST', body: { session: 'session-stuck' } })
    const listed = await request(h.base, '/mesh/sessions')
    const ids = (listed.json?.sessions ?? []).map((session) => session.id)
    const ok = res.status === 409 && res.json?.ok === false && ids.includes('session-stuck')
    report('delete refuses a live session it cannot stop', ok, `status=${res.status} stillListed=${ids.includes('session-stuck')} error=${res.json?.error ?? '-'}`)
  })

  // 7. delete addresses a session by its exact title (same lookup as inject/archive).
  await runCase('delete accepts an exact title', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-titled', title: 'exact title' }] })
    const deleted = await request(h.base, '/mesh/sessions/delete', { method: 'POST', body: { title: 'exact title' } })
    const listed = await request(h.base, '/mesh/sessions')
    const ids = (listed.json?.sessions ?? []).map((session) => session.id)
    const ok = deleted.status === 200 && deleted.json?.ok === true && deleted.json?.sessionId === 'session-titled' && !ids.includes('session-titled')
    report('delete accepts an exact title', ok, `status=${deleted.status} sessionId=${deleted.json?.sessionId ?? '-'} stillListed=${ids.includes('session-titled')}`)
  })

  // 8. An ambiguous title is refused (400 + candidates) and nothing is deleted.
  await runCase('delete refuses an ambiguous title without deleting', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-dup-x', title: 'dup title' },
        { id: 'session-dup-y', title: 'dup title' },
      ],
    })
    const res = await request(h.base, '/mesh/sessions/delete', { method: 'POST', body: { title: 'dup title' } })
    const listed = await request(h.base, '/mesh/sessions')
    const ids = (listed.json?.sessions ?? []).map((session) => session.id)
    const candidates = /多个/.test(res.json?.error ?? '')
    const survivors = ids.filter((id) => id === 'session-dup-x' || id === 'session-dup-y').length
    const ok = res.status === 400 && res.json?.ok === false && candidates && survivors === 2
    report('delete refuses an ambiguous title without deleting', ok, `status=${res.status} candidates=${candidates} survivors=${survivors}`)
  })


  await runCase('standalone boots without a hub and stays offline', async (boot) => {
    const h = await boot()
    const status = await request(h.base, '/mesh/status')
    const sessions = await request(h.base, '/mesh/sessions')
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
    const ok = status.json?.mode === 'standalone' && sessions.status === 200 && h.external.length === 0
    report(
      'standalone boots without a hub and stays offline',
      ok,
      `mode=${status.json?.mode} sessions=${sessions.status} externalRequests=${h.external.length}`,
    )
  })

  // 8. hubUrl without token and without joinCode: local-only plus an explicit lastError.
  await runCase('hubUrl without credentials reports lastError instead of exiting', async (boot) => {
    const h = await boot({ writeToken: false, config: { hubUrl: 'http://127.0.0.1:1' } })
    const status = await request(h.base, '/mesh/status')
    const sessions = await request(h.base, '/mesh/sessions')
    const ok = status.json?.mode === 'standalone' && /missing token/.test(status.json?.lastError ?? '') && sessions.status === 200
    report(
      'hubUrl without credentials reports lastError instead of exiting',
      ok,
      `mode=${status.json?.mode} lastError=${status.json?.lastError ?? '-'} sessions=${sessions.status}`,
    )
  })

  // 9. A pinned caSha256 that does not match caFile refuses hub use (local endpoints stay up).
  await runCase('caSha256 mismatch refuses hub use', async (boot) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-ca-'))
    const caFile = path.join(tmp, 'ca.pem')
    fs.writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nnot-the-pinned-one\n-----END CERTIFICATE-----\n')
    try {
      const h = await boot({
        config: { hubUrl: 'http://127.0.0.1:1', caFile, caSha256: '0'.repeat(64) },
      })
      const status = await request(h.base, '/mesh/status')
      const sessions = await request(h.base, '/mesh/sessions')
      const error = status.json?.lastError ?? ''
      const ok = status.json?.mode === 'standalone' && /CA rejected/.test(error) && /mismatch/.test(error) && sessions.status === 200
      report('caSha256 mismatch refuses hub use', ok, `mode=${status.json?.mode} lastError=${error || '-'} sessions=${sessions.status}`)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // 10. joinCode bootstrap: token written to tokenFile, then the pull loop drains the inbox.
  await runCase('joinCode bootstraps a token and pull drains the inbox', async (boot) => {
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-pull-1', sender: 'hermes', conversation: 'conv/pull', subject: 'pull test', body: 'a message that only the pull loop can fetch' }],
    })
    let h = null
    try {
      h = await boot({
        writeToken: false,
        // T-426: an unbound conversation is deferred now, so this case binds it first — the
        // point here is that the pull loop drains a *bound* conversation.
        seedSessions: [{ id: 'session-pull-target', title: 'pull target' }],
        conversations: { 'conv/pull': { sessionId: null, createdAt: 1, wakes: 0, title: null, deliverTo: 'session-pull-target' } },
        config: { hubUrl: fake.url, joinCode: 'JOIN-123' },
      })
      const booted = await waitFor(async () => {
        const status = await request(h.base, '/mesh/status')
        return status.json?.mode && status.json.mode !== 'standalone' ? status.json : null
      }, 8000)
      const tokenText = fs.existsSync(h.tokenFile) ? fs.readFileSync(h.tokenFile, 'utf8') : ''
      const pulled = await waitFor(async () => {
        const status = await request(h.base, '/mesh/status')
        return status.json?.lastPullAt ? status.json : null
      }, 10000)
      const claimed = fake.requests.some((entry) => entry.path === '/api/inbox' && entry.query.claim === '1' && entry.query.claim_ttl_ms === '300000')
      const readBack = fake.requests.some((entry) => entry.path === '/api/read')
      const logText = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8') : ''
      const fingerprintsOnly = logText.includes('token fp=') && !logText.includes('tok-' + 'selftest')
      const ok =
        Boolean(booted) &&
        tokenText === 'tok-' + 'selftest' &&
        Boolean(pulled) &&
        claimed &&
        readBack &&
        h.state.prompts.length > 0 &&
        fingerprintsOnly
      report(
        'joinCode bootstraps a token and pull drains the inbox',
        ok,
        `mode=${booted?.mode ?? '-'} tokenWritten=${tokenText.length > 0} claimed=${claimed} readBack=${readBack} prompts=${h.state.prompts.length} logFpOnly=${fingerprintsOnly}`,
      )
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // 11. Adaptive pull cadence (pure function): busy / idle / base / exponential backoff.
  await runCase('pull cadence adapts and backs off', async () => {
    const { nextPollDelayMs } = await import(pathToFileURL(ENTRY).href)
    const config = { pollIntervalMs: 30000, pollBusyIntervalMs: 5000, pollIdleIntervalMs: 60000 }
    const checked = {
      busy: nextPollDelayMs({ moved: 1, emptyPolls: 0, failures: 0, config }) === 5000,
      idle: nextPollDelayMs({ moved: 0, emptyPolls: 3, failures: 0, config }) === 60000,
      base: nextPollDelayMs({ moved: 0, emptyPolls: 1, failures: 0, config }) === 30000,
      backoff1: nextPollDelayMs({ failures: 1, config }) === 5000,
      backoff3: nextPollDelayMs({ failures: 3, config }) === 20000,
      backoffCap: nextPollDelayMs({ failures: 20, config }) === 300000,
    }
    report('pull cadence adapts and backs off', Object.values(checked).every(Boolean), JSON.stringify(checked))
  })

  // 15. task receipts: a completed turn settles once with a code-point-safe summary.
  await runCase('receipt: completed turn writes one truncated receipt', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-receipt', title: 'receipt target' }], config: { receiptSummaryChars: 20 } })
    const injected = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'receipt target', text: 'do the thing', meta: { taskId: 'T-completed' } },
    })
    const pendingStatus = await request(h.base, '/mesh/status')
    h.emit('session/event', { id: 'session-receipt' }, { type: 'turn/start', turn: 7 })
    h.emit('session/event', { id: 'session-receipt' }, { type: 'assistant/message', turn: 7, message: { content: [{ type: 'text', text: 'x'.repeat(40) }] } })
    h.emit('session/event', { id: 'session-receipt' }, { type: 'turn/end', turn: 7, reason: { kind: 'completed' } })
    const settled = await waitFor(() => readReceipts(h.receiptsPath).find((receipt) => receipt.taskId === 'T-completed'), 4000)
    const receipt = settled
    const ok =
      injected.json?.taskId === 'T-completed' &&
      pendingStatus.json?.pendingTasks === 1 &&
      Boolean(receipt) &&
      receipt.status === 'completed' &&
      receipt.reasonKind === 'completed' &&
      receipt.turn === 7 &&
      receipt.summary === 'x'.repeat(20) + '…' &&
      receipt.receiptMode === 'file' &&
      receipt.durationMs >= 0
    report(
      'receipt: completed turn writes one truncated receipt',
      ok,
      `taskId=${injected.json?.taskId ?? '-'} pending=${pendingStatus.json?.pendingTasks ?? '-'} status=${receipt?.status ?? '-'} summaryLen=${Array.from(receipt?.summary ?? '').length} turn=${receipt?.turn ?? '-'}`,
    )
  })

  // 16. a taskId settles exactly once; later turn/end events in the same session add nothing.
  await runCase('receipt: one taskId settles once', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-once', title: 'once target' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'once target', text: 'settle me', meta: { taskId: 'T-once' } } })
    h.emit('session/event', { id: 'session-once' }, { type: 'turn/start', turn: 3 })
    h.emit('session/event', { id: 'session-once' }, { type: 'turn/end', turn: 3, reason: { kind: 'completed' } })
    await waitFor(() => readReceipts(h.receiptsPath).filter((receipt) => receipt.taskId === 'T-once').length === 1, 4000)
    h.emit('session/event', { id: 'session-once' }, { type: 'turn/end', turn: 4, reason: { kind: 'completed' } })
    await sleep(250)
    const rows = readReceipts(h.receiptsPath).filter((receipt) => receipt.taskId === 'T-once')
    const status = await request(h.base, '/mesh/status')
    const ok = rows.length === 1 && status.json?.pendingTasks === 0 && status.json?.lastReceipt?.taskId === 'T-once'
    report('receipt: one taskId settles once', ok, `rows=${rows.length} pending=${status.json?.pendingTasks} last=${status.json?.lastReceipt?.status ?? '-'}`)
  })

  // 17. error turns keep the LLM failure code in reasonDetail.
  await runCase('receipt: error turn records the failure code', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-error', title: 'error target' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'error target', text: 'fail me', meta: { taskId: 'T-error' } } })
    h.emit('session/event', { id: 'session-error' }, { type: 'turn/start', turn: 2 })
    h.emit('session/event', { id: 'session-error' }, { type: 'turn/end', turn: 2, reason: { kind: 'error', error: { code: 'provider_error' } } })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-error'), 4000)
    const ok = Boolean(receipt) && receipt.status === 'error' && receipt.reasonDetail === 'provider_error' && receipt.turn === 2
    report('receipt: error turn records the failure code', ok, `status=${receipt?.status ?? '-'} detail=${receipt?.reasonDetail ?? '-'} turn=${receipt?.turn ?? '-'}`)
  })

  // 18. no turn/start inside receiptStallMs -> not-started receipt, pending cleared.
  await runCase('receipt: stalled task becomes not-started', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-stall', title: 'stall target' }], config: { receiptStallMs: 1000 } })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'stall target', text: 'never starts', meta: { taskId: 'T-stall' } } })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-stall'), 4000)
    const status = await request(h.base, '/mesh/status')
    const ok =
      Boolean(receipt) &&
      receipt.status === 'not-started' &&
      receipt.reasonKind === 'not-started' &&
      /receiptStallMs|1000ms/.test(receipt.reasonDetail ?? '') &&
      // 0.7.31: the miss is advisory — the task stays dormant so a late turn can resume it.
      status.json?.pendingTasks === 1
    report('receipt: stalled task becomes not-started', ok, `status=${receipt?.status ?? '-'} detail=${receipt?.reasonDetail ?? '-'} pending=${status.json?.pendingTasks}`)
  })

  // 19-22. liveness derivation is a pure function: approval > job > tool > stalled.
  await runCase('liveness: waiting-approval names the tool and minutes', async () => {
    const { deriveLivenessState } = await import(pathToFileURL(ENTRY).href)
    const now = Date.now()
    const derived = deriveLivenessState(
      {
        openTurn: 3,
        lastEventAt: now,
        lastTurnStartAt: now,
        openCalls: new Map(),
        openJobs: new Map(),
        openApprovals: new Map([['a1', { toolName: 'bash', askedAt: now - 120000 }]]),
      },
      { hasPending: true, now, stallQuietMs: 300000 },
    )
    const ok = derived.state === 'waiting-approval' && /bash/.test(derived.detail) && /2m/.test(derived.detail)
    report('liveness: waiting-approval names the tool and minutes', ok, `${derived.state} · ${derived.detail}`)
  })

  await runCase('liveness: waiting-job names the job and minutes', async () => {
    const { deriveLivenessState } = await import(pathToFileURL(ENTRY).href)
    const now = Date.now()
    const derived = deriveLivenessState(
      {
        openTurn: 2,
        lastEventAt: now,
        lastTurnStartAt: now,
        openCalls: new Map(),
        openJobs: new Map([['job-7', { startedAt: now - 60000 }]]),
        openApprovals: new Map(),
      },
      { hasPending: true, now, stallQuietMs: 300000 },
    )
    const ok = derived.state === 'waiting-job' && /job-7/.test(derived.detail) && /1m/.test(derived.detail)
    report('liveness: waiting-job names the job and minutes', ok, `${derived.state} · ${derived.detail}`)
  })

  await runCase('liveness: waiting-tool names the tool and minutes', async () => {
    const { deriveLivenessState } = await import(pathToFileURL(ENTRY).href)
    const now = Date.now()
    const derived = deriveLivenessState(
      {
        openTurn: 2,
        lastEventAt: now,
        lastTurnStartAt: now,
        openCalls: new Map([['c1', { name: 'read_file', startedAt: now - 180000 }]]),
        openJobs: new Map(),
        openApprovals: new Map(),
      },
      { hasPending: true, now, stallQuietMs: 300000 },
    )
    const ok = derived.state === 'waiting-tool' && /read_file/.test(derived.detail) && /3m/.test(derived.detail)
    report('liveness: waiting-tool names the tool and minutes', ok, `${derived.state} · ${derived.detail}`)
  })

  await runCase('liveness: quiet open turn becomes stalled', async () => {
    const { deriveLivenessState } = await import(pathToFileURL(ENTRY).href)
    const now = Date.now()
    const derived = deriveLivenessState(
      {
        openTurn: 4,
        lastEventAt: now - 400000,
        lastTurnStartAt: now - 500000,
        openCalls: new Map(),
        openJobs: new Map(),
        openApprovals: new Map(),
      },
      { hasPending: true, now, stallQuietMs: 300000 },
    )
    const ok = derived.state === 'stalled' && /quiet/.test(derived.detail)
    report('liveness: quiet open turn becomes stalled', ok, `${derived.state} · ${derived.detail}`)
  })

  // 23. batch: every task settles -> exactly one aggregate receipt.
  await runCase('batch: all tasks settle into one aggregate receipt', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-batch', title: 'batch target' }] })
    const injectA = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'batch target', text: 'task a', meta: { taskId: 'T-a', batchId: 'B-1' } },
    })
    h.emit('session/event', { id: 'session-batch' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-batch' }, { type: 'assistant/message', turn: 1, message: { content: [{ type: 'text', text: 'a done' }] } })
    h.emit('session/event', { id: 'session-batch' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const injectB = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'batch target', text: 'task b', meta: { taskId: 'T-b', batchId: 'B-1' } },
    })
    h.emit('session/event', { id: 'session-batch' }, { type: 'turn/start', turn: 2 })
    h.emit('session/event', { id: 'session-batch' }, { type: 'turn/end', turn: 2, reason: { kind: 'completed' } })
    const aggregate = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.kind === 'batch' && row.batchId === 'B-1'), 5000)
    const perTask = readReceipts(h.receiptsPath).filter((row) => !row.kind && ['T-a', 'T-b'].includes(row.taskId))
    const after = await request(h.base, '/mesh/batches')
    const ok =
      injectA.json?.batchId === 'B-1' &&
      injectB.json?.batchId === 'B-1' &&
      Boolean(aggregate) &&
      aggregate.done === 2 &&
      aggregate.total === 2 &&
      perTask.length === 2 &&
      (after.json?.batches ?? []).length === 0 &&
      h.state.prompts.length === 2
    report('batch: all tasks settle into one aggregate receipt', ok, `done=${aggregate?.done}/${aggregate?.total} perTask=${perTask.length} batchesLeft=${(after.json?.batches ?? []).length} prompts=${h.state.prompts.length}`)
  })

  // 24. deadline with an unfinished task -> partial aggregate carrying its liveness.
  await runCase('batch: deadline produces a partial aggregate', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-deadline', title: 'deadline target' }], config: { batchDeadlineMs: 1000 } })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'deadline target', text: 'slow task', meta: { taskId: 'T-slow', batchId: 'B-dl' } },
    })
    const aggregate = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.kind === 'batch' && row.batchId === 'B-dl'), 6000)
    const task = aggregate?.tasks?.[0]
    const ok = Boolean(aggregate) && aggregate.done === 0 && aggregate.total === 1 && task?.status === 'not-started' && /no turn\/start/.test(task?.detail ?? '')
    report('batch: deadline produces a partial aggregate', ok, `done=${aggregate?.done}/${aggregate?.total} taskStatus=${task?.status ?? '-'} detail=${task?.detail ?? '-'}`)
  })

  // 25. stalled member raises exactly one alert, without settling the task.
  await runCase('batch: stalled member alerts once and is not settled', async (boot) => {
    const h = await boot({
      seedSessions: [{ id: 'session-hang', title: 'hang target' }],
      config: { waitLongMs: 500, stallQuietMs: 300, alertMode: 'file', batchDeadlineMs: 60000 },
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'hang target', text: 'hang task', meta: { taskId: 'T-hang', batchId: 'B-hang' } },
    })
    h.emit('session/event', { id: 'session-hang' }, { type: 'turn/start', turn: 1 })
    const first = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.kind === 'batch-alert' && row.taskId === 'T-hang'), 6000)
    await sleep(1800)
    const alerts = readReceipts(h.receiptsPath).filter((row) => row.kind === 'batch-alert' && row.taskId === 'T-hang')
    const stillOpen = (await request(h.base, '/mesh/batches')).json?.batches ?? []
    const ok = Boolean(first) && first.state === 'stalled' && alerts.length === 1 && stillOpen.length === 1
    report('batch: stalled member alerts once and is not settled', ok, `alerts=${alerts.length} state=${first?.state ?? '-'} openBatches=${stillOpen.length}`)
  })

  // 26. restored batch with an open task is reported as lost (the restart killed the turn).
  await runCase('batch: restored open task settles as lost', async (boot) => {
    const started = Date.now() - 5000
    const seededBatches = {
      'B-lost': {
        createdAt: started,
        deadlineAt: started + 3600000,
        barrierMode: 'file',
        alertMode: 'file',
        alerted: [],
        tasks: { 'T-lost': { sessionId: 'session-lost', status: 'pending', settledAt: null, durationMs: null, summary: '' } },
      },
    }
    const h = await boot({ seedSessions: [{ id: 'session-lost', title: 'lost target' }], batches: seededBatches })
    const aggregate = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.kind === 'batch' && row.batchId === 'B-lost'), 6000)
    const task = aggregate?.tasks?.[0]
    const ok = Boolean(aggregate) && aggregate.done === 1 && aggregate.total === 1 && task?.status === 'lost'
    report('batch: restored open task settles as lost', ok, `done=${aggregate?.done}/${aggregate?.total} taskStatus=${task?.status ?? '-'}`)
  })

  // 27. DELETE /mesh/batches/<id> cancels: no aggregate after the turn ends.
  await runCase('batch: DELETE cancels and suppresses the aggregate', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-cancel', title: 'cancel target' }] })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'cancel target', text: 'cancel task', meta: { taskId: 'T-cancel', batchId: 'B-cancel' } },
    })
    const list = await request(h.base, '/mesh/batches')
    const detail = await request(h.base, '/mesh/batches/B-cancel')
    const cancelled = await request(h.base, '/mesh/batches/B-cancel', { method: 'DELETE' })
    h.emit('session/event', { id: 'session-cancel' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-cancel' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    await sleep(300)
    const aggregates = readReceipts(h.receiptsPath).filter((row) => row.kind === 'batch' && row.batchId === 'B-cancel')
    const ok =
      (list.json?.batches ?? []).length === 1 &&
      detail.json?.ok === true &&
      detail.json?.total === 1 &&
      cancelled.status === 200 &&
      cancelled.json?.cancelled === true &&
      aggregates.length === 0
    report('batch: DELETE cancels and suppresses the aggregate', ok, `listed=${(list.json?.batches ?? []).length} detailTotal=${detail.json?.total ?? '-'} delete=${cancelled.status} aggregates=${aggregates.length}`)
  })

  // 28-32. Real DSH envelope shape: {type, seq, time, data}; fields live under `data`.
  await runCase('envelope: turn/end data settles with the real turn number', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-env', title: 'env target' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'env target', text: 'envelope task', meta: { taskId: 'T-env' } } })
    h.emit('session/event', { id: 'session-env' }, { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } })
    h.emit('session/event', { id: 'session-env' }, { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-env'), 4000)
    const ok = receipt?.turn === 1 && receipt?.status === 'completed'
    report('envelope: turn/end data settles with the real turn number', ok, `turn=${receipt?.turn ?? '-'} status=${receipt?.status ?? '-'}`)
  })

  await runCase('envelope: assistant/message data yields the summary', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-env-msg', title: 'env msg target' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'env msg target', text: 'summary task', meta: { taskId: 'T-env-msg' } } })
    h.emit('session/event', { id: 'session-env-msg' }, { type: 'turn/start', data: { turn: 1 } })
    h.emit('session/event', { id: 'session-env-msg' }, {
      type: 'assistant/message',
      seq: 3,
      time: 0,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } },
    })
    h.emit('session/event', { id: 'session-env-msg' }, { type: 'turn/end', seq: 4, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-env-msg'), 4000)
    const ok = receipt?.summary === 'OK' && receipt?.turn === 1
    report('envelope: assistant/message data yields the summary', ok, `summary=${JSON.stringify(receipt?.summary ?? '')} turn=${receipt?.turn ?? '-'}`)
  })

  await runCase('envelope: tool/call data reaches waiting-tool', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-tool', title: 'tool target' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'tool target', text: 'tool task', meta: { taskId: 'T-tool', batchId: 'B-tool' } } })
    h.emit('session/event', { id: 'session-tool' }, { type: 'turn/start', data: { turn: 1 } })
    h.emit('session/event', { id: 'session-tool' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash' } })
    const detail = await request(h.base, '/mesh/batches/B-tool')
    const task = detail.json?.tasks?.[0]
    const ok = detail.json?.ok === true && task?.status === 'waiting-tool' && /bash/.test(task?.detail ?? '')
    report('envelope: tool/call data reaches waiting-tool', ok, `status=${task?.status ?? '-'} detail=${task?.detail ?? '-'}`)
  })

  await runCase('envelope: approval/asked data reaches waiting-approval', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-appr', title: 'appr target' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'appr target', text: 'approval task', meta: { taskId: 'T-appr', batchId: 'B-appr' } } })
    h.emit('session/event', { id: 'session-appr' }, { type: 'turn/start', data: { turn: 2 } })
    h.emit('session/event', { id: 'session-appr' }, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'needs approval' } })
    const detail = await request(h.base, '/mesh/batches/B-appr')
    const task = detail.json?.tasks?.[0]
    const ok = detail.json?.ok === true && task?.status === 'waiting-approval' && /bash/.test(task?.detail ?? '')
    report('envelope: approval/asked data reaches waiting-approval', ok, `status=${task?.status ?? '-'} detail=${task?.detail ?? '-'}`)
  })

  await runCase('envelope: job/registered data reaches waiting-job', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-job', title: 'job target' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'job target', text: 'job task', meta: { taskId: 'T-job', batchId: 'B-job' } } })
    h.emit('session/event', { id: 'session-job' }, { type: 'turn/start', data: { turn: 1 } })
    h.emit('session/event', { id: 'session-job' }, { type: 'job/registered', data: { jobId: 'job-9' } })
    const detail = await request(h.base, '/mesh/batches/B-job')
    const task = detail.json?.tasks?.[0]
    const ok = detail.json?.ok === true && task?.status === 'waiting-job' && /job-9/.test(task?.detail ?? '')
    report('envelope: job/registered data reaches waiting-job', ok, `status=${task?.status ?? '-'} detail=${task?.detail ?? '-'}`)
  })

  // 33-36. Title resolution prefers live sessions; archived history is a fallback only.
  await runCase('title resolution prefers the live namesake over archived history', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-live', title: 'mesh · 协调' },
        { id: 'session-old-a', title: 'mesh · 协调' },
        { id: 'session-old-b', title: 'mesh · 协调' },
      ],
      archivedIds: ['session-old-a', 'session-old-b'],
    })
    const res = await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'mesh · 协调', text: 'hello live' } })
    const ok = res.status === 200 && res.json?.sessionId === 'session-live' && h.state.prompts.length === 1
    report('title resolution prefers the live namesake over archived history', ok, `status=${res.status} sessionId=${res.json?.sessionId ?? '-'} prompts=${h.state.prompts.length}`)
  })

  await runCase('title resolution falls back to a unique archived session', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-arch', title: 'archived only' }], archivedIds: ['session-arch'] })
    const res = await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'archived only', text: 'hello archived' } })
    const ok = res.status === 200 && res.json?.sessionId === 'session-arch'
    report('title resolution falls back to a unique archived session', ok, `status=${res.status} sessionId=${res.json?.sessionId ?? '-'}`)
  })

  await runCase('title resolution still refuses two live namesakes, with the archived hint', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-live-1', title: 'dup live' },
        { id: 'session-live-2', title: 'dup live' },
        { id: 'session-old', title: 'dup live' },
      ],
      archivedIds: ['session-old'],
    })
    const res = await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'dup live', text: 'nope' } })
    const ok = res.status === 400 && /多个/.test(res.json?.error ?? '') && /archived/.test(res.json?.error ?? '') && h.state.prompts.length === 0
    report('title resolution still refuses two live namesakes, with the archived hint', ok, `status=${res.status} hint=${/archived/.test(res.json?.error ?? '')}`)
  })

  await runCase('GET /mesh/sessions?live=1 lists only non-archived sessions', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-keep', title: 'keep' },
        { id: 'session-drop', title: 'drop' },
      ],
      archivedIds: ['session-drop'],
    })
    const filtered = await request(h.base, '/mesh/sessions?live=1')
    const all = await request(h.base, '/mesh/sessions')
    const filteredIds = (filtered.json?.sessions ?? []).map((session) => session.id)
    const allIds = (all.json?.sessions ?? []).map((session) => session.id)
    const ok = filteredIds.join(',') === 'session-keep' && allIds.length === 2
    report('GET /mesh/sessions?live=1 lists only non-archived sessions', ok, `live=${JSON.stringify(filteredIds)} all=${allIds.length}`)
  })

  // 37-41. mesh_dispatch tool + dsh-mesh-dispatch CLI (offline, no real HTTP).
  await runCase('mesh_dispatch: tool metadata and schema', async () => {
    const { MESH_DISPATCH_TOOL } = await import(pathToFileURL(ENTRY).href)
    const params = MESH_DISPATCH_TOOL.parameters
    const ok =
      MESH_DISPATCH_TOOL.name === 'mesh_dispatch' &&
      params.target?.required !== true &&
      params.text?.required === true &&
      params.thread?.type === 'string' &&
      MESH_DISPATCH_TOOL.required.join(',') === 'text' &&
      /batchId/.test(MESH_DISPATCH_TOOL.description) &&
      /thread/.test(MESH_DISPATCH_TOOL.description) &&
      /不要轮询|do NOT poll/i.test(MESH_DISPATCH_TOOL.description)
    report('mesh_dispatch: tool metadata and schema', ok, `name=${MESH_DISPATCH_TOOL.name} required=${MESH_DISPATCH_TOOL.required.join(',')}`)
  })

  await runCase('mesh_dispatch: createIfMissing=false reports the option name', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-only', title: 'only one' }] })
    await waitFor(() => h.state.tools.length > 0, 5000)
    let message = ''
    try {
      await h.state.tools[0].execute({ target: 'nobody here', text: 'hello' })
    } catch (error) {
      message = error.message
    }
    const ok = /createIfMissing/.test(message) && /list_local_sessions/.test(message)
    report('mesh_dispatch: createIfMissing=false reports the option name', ok, `message=${message.slice(0, 100)}`)
  })

  await runCase('mesh_dispatch: createIfMissing=true creates the session and injects', async (boot) => {
    const wsPath = path.join(os.tmpdir(), 'Projects', 'create-missing-ws')
    const h = await boot({})
    await waitFor(() => h.state.tools.length > 0, 5000)
    const result = await h.state.tools[0].execute({ target: 'brand new worker', text: 'bootstrap it', createIfMissing: true, workspacePath: wsPath })
    const ok =
      result.ok === true &&
      result.created === true &&
      Boolean(result.sessionId) &&
      result.workspacePath === wsPath &&
      h.state.created.length === 1 &&
      h.state.prompts.length === 1
    report('mesh_dispatch: createIfMissing=true creates the session and injects', ok, `created=${result.created} session=${result.sessionId} workspacePath=${result.workspacePath ?? '-'} createCalls=${h.state.created.length} prompts=${h.state.prompts.length}`)
  })

  // T-402: createIfMissing used to place every new session in the inbox workspace.
  await runCase('mesh_dispatch: createIfMissing inherits the caller workspace', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'caller-repo', 'public')
    const h = await boot({ seedSessions: [{ id: 'session-caller-ws', title: 'caller', cwd }] })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const result = await h.state.tools[0].execute({ target: 'inherited worker', text: 'do it', createIfMissing: true }, { sessionId: 'session-caller-ws' })
    const request = h.state.created[0]?.request ?? {}
    const ok =
      result.created === true &&
      result.workspacePath === cwd &&
      request.workspaceId === h.state.workspace?.id &&
      h.state.workspace?.path === cwd
    report('mesh_dispatch: createIfMissing inherits the caller workspace', ok, `workspacePath=${result.workspacePath ?? '-'} createdAt=${h.state.workspace?.path ?? '-'} byId=${Boolean(request.workspaceId)}`)
  })

  await runCase('mesh_dispatch: createIfMissing honours an explicit workspacePath', async (boot) => {
    const wsPath = path.join(os.tmpdir(), 'Projects', 'explicit-ws')
    const h = await boot({})
    await waitFor(() => h.state.tools.length > 0, 5000)
    const result = await h.state.tools[0].execute({ target: 'explicit worker', text: 'do it', createIfMissing: true, workspacePath: wsPath })
    const request = h.state.created[0]?.request ?? {}
    const ok =
      result.created === true &&
      result.workspacePath === wsPath &&
      h.state.workspace?.path === wsPath &&
      request.workspaceId === h.state.workspace?.id
    report('mesh_dispatch: createIfMissing honours an explicit workspacePath', ok, `workspacePath=${result.workspacePath ?? '-'} workspace=${result.workspace ?? '-'}`)
  })

  await runCase('mesh_dispatch: a cross-workspace create is refused with options', async (boot) => {
    const callerCwd = path.join(os.tmpdir(), 'Projects', 'xiajiang')
    const otherCwd = path.join(os.tmpdir(), 'Projects', 'other-repo')
    const h = await boot({
      seedSessions: [
        { id: 'session-caller-x', title: 'caller', cwd: callerCwd },
        { id: 'session-other-y', title: 'other worker', cwd: otherCwd },
      ],
    })
    await waitFor(() => h.state.tools.length > 0, 5000)
    let error = null
    try {
      await h.state.tools[0].execute({ target: 'cross worker', text: 'do it', createIfMissing: true, workspacePath: otherCwd }, { sessionId: 'session-caller-x' })
    } catch (caught) {
      error = caught
    }
    const message = String(error?.message ?? '')
    const ok =
      h.state.created.length === 0 &&
      message.includes(callerCwd) &&
      message.includes(otherCwd) &&
      message.includes('xiajiang') &&
      message.includes('other-repo') &&
      message.includes('target:') &&
      /inherit/.test(message)
    report('mesh_dispatch: a cross-workspace create is refused with options', ok, `created=${h.state.created.length} bothPaths=${message.includes(callerCwd) && message.includes(otherCwd)} options=${/target:/.test(message) && /inherit/.test(message)}`)
  })

  await runCase('mesh_dispatch: createIfMissing without a caller workspace is refused', async (boot) => {
    const h = await boot({})
    await waitFor(() => h.state.tools.length > 0, 5000)
    let error = null
    try {
      await h.state.tools[0].execute({ target: 'nowhere worker', text: 'do it', createIfMissing: true })
    } catch (caught) {
      error = caught
    }
    const message = String(error?.message ?? '')
    const ok = h.state.created.length === 0 && /workspacePath/.test(message) && /target:/.test(message)
    report('mesh_dispatch: createIfMissing without a caller workspace is refused', ok, `created=${h.state.created.length} mentionsWorkspacePath=${/workspacePath/.test(message)}`)
  })

  await runCase('mesh_dispatch: the cross-workspace id warning names a real prefix', async (boot) => {
    const callerCwd = path.join(os.tmpdir(), 'Projects', 'xiajiang')
    const targetCwd = path.join(os.tmpdir(), 'Projects', 'other-repo')
    const h = await boot({
      seedSessions: [
        { id: 'session-warn-caller', title: 'caller', cwd: callerCwd },
        { id: 'session-warn-target', title: 'remote worker', cwd: targetCwd },
      ],
    })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const result = await h.state.tools[0].execute({ target: 'session-warn-target', text: 'do it', taskId: 'T-bare-2' }, { sessionId: 'session-warn-caller' })
    const warning = String(result.warning ?? '')
    const ok = warning.includes('other-repo/T-bare-2') && warning.includes('<PREFIX>-<YYYYMMDD>-<SEQ>') && !warning.includes('dsh-mesh/T-123')
    report('mesh_dispatch: the cross-workspace id warning names a real prefix', ok, `warning=${warning.slice(0, 120)}`)
  })

  await runCase('mesh_dispatch: taskId auto-generates and explicit ids pass through', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-disp', title: 'dispatch target' }] })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const auto = await h.state.tools[0].execute({ target: 'dispatch target', text: 'a' })
    const explicit = await h.state.tools[0].execute({ target: 'dispatch target', text: 'b', taskId: 'T-explicit-1' })
    const ok = /^T-[0-9a-z]+$/.test(auto.taskId) && explicit.taskId === 'T-explicit-1'
    report('mesh_dispatch: taskId auto-generates and explicit ids pass through', ok, `auto=${auto.taskId} explicit=${explicit.taskId}`)
  })

  await runCase('CLI: parses deadline/task flags and refuses unknown args', async () => {
    const { parseArgs, durationMs } = await import(
      pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'bin', 'dispatch.mjs')).href
    )
    const parsed = parseArgs(['--target', 'mesh · hub', '--text', 'hi', '--deadline', '30m', '--task', '--batch', 'B-1', '--mode', 'steer'])
    let unknown = ''
    try {
      parseArgs(['--target', 'x', '--text', 'y', '--bogus'])
    } catch (error) {
      unknown = error.message
    }
    const ok =
      parsed.deadlineMs === 1800000 &&
      parsed.task === '' &&
      parsed.batch === 'B-1' &&
      parsed.mode === 'steer' &&
      durationMs('600s') === 600000 &&
      /unknown argument: --bogus/.test(unknown) &&
      /Usage/.test(unknown)
    report('CLI: parses deadline/task flags and refuses unknown args', ok, `deadline=${parsed.deadlineMs} task=${JSON.stringify(parsed.task)} usage=${/Usage/.test(unknown)}`)
  })

  // 230-235. bin CLI parity (T-296): --thread reaches the body top level like the tool,
  // a bad id never touches the network, --dry-run prints the plan, --help documents it.
  const cliUrl = pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'bin', 'dispatch.mjs')).href
  const noFetch = async () => {
    throw new Error('no fetch expected')
  }

  await runCase('CLI: --thread is parsed and kept at the body top level', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--target', 'mesh · hub', '--text', 'hi', '--thread', 'TH-1'])
    const plan = await run({ ...options, dryRun: true }, noFetch)
    const ok = options.thread === 'TH-1' && plan.dryRun === true && plan.payload?.thread === 'TH-1' && plan.payload?.meta === undefined
    report('CLI: --thread is parsed and kept at the body top level', ok, `thread=${options.thread ?? '-'} payloadThread=${plan.payload?.thread ?? '-'}`)
  })

  await runCase('CLI: a thread over 128 bytes is rejected before any request', async () => {
    const { parseArgs } = await import(cliUrl)
    let message = ''
    try {
      parseArgs(['--target', 'x', '--text', 'hi', '--thread', 'T'.repeat(129)])
    } catch (error) {
      message = error.message
    }
    const ok = /invalid --thread/.test(message) && /128 UTF-8 bytes/.test(message) && /Usage/.test(message)
    report('CLI: a thread over 128 bytes is rejected before any request', ok, `error=${message.split('\n')[0]}`)
  })

  await runCase('CLI: without --thread the body keeps no thread field', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--target', 'mesh · hub', '--text', 'hi'])
    const plan = await run({ ...options, dryRun: true }, noFetch)
    const ok = !('thread' in (plan.payload ?? {})) && plan.payload?.session === 'mesh · hub'
    report('CLI: without --thread the body keeps no thread field', ok, `keys=${Object.keys(plan.payload ?? {}).join(',')}`)
  })

  await runCase('CLI: --thread alone omits session and title', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--text', 'hi', '--thread', 'TH-2'])
    const plan = await run({ ...options, dryRun: true }, noFetch)
    const payload = plan.payload ?? {}
    const ok = options.target === undefined && !('session' in payload) && !('title' in payload) && payload.thread === 'TH-2'
    report('CLI: --thread alone omits session and title', ok, `keys=${Object.keys(payload).join(',')}`)
  })

  await runCase('CLI: --dry-run sends nothing and reports the thread', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--thread', 'TH-1', '--text', 'hi', '--dry-run'])
    let calls = 0
    const plan = await run(options, async () => {
      calls += 1
      throw new Error('no fetch expected')
    })
    const ok = options.dryRun === true && calls === 0 && plan.payload?.thread === 'TH-1'
    report('CLI: --dry-run sends nothing and reports the thread', ok, `calls=${calls} thread=${plan.payload?.thread ?? '-'}`)
  })

  await runCase('CLI: --help documents --thread without side effects', async () => {
    const { parseArgs, USAGE } = await import(cliUrl)
    const options = parseArgs(['--help'])
    const ok = options.help === true && /--thread/.test(USAGE) && /--dry-run/.test(USAGE) && /omit --target/.test(USAGE)
    report('CLI: --help documents --thread without side effects', ok, `help=${options.help} threadDoc=${/--thread/.test(USAGE)}`)
  })

  // 236-240. bin CLI parity (T-298): --requester names the receipt target at the body top
  // level (where /mesh/inject reads it), stays absent when omitted, and coexists with thread.
  await runCase('CLI: --requester is sent at the body top level', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--target', 'mesh · hub', '--text', 'hi', '--requester', 'session-req'])
    const originalFetch = globalThis.fetch
    let body = null
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, sessionId: 'session-hub', taskId: 'T-x', mode: 'queue', created: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    let result
    try {
      result = await run(options)
    } finally {
      globalThis.fetch = originalFetch
    }
    const ok = body?.requester === 'session-req' && body?.meta?.requester === undefined && result?.sessionId === 'session-hub'
    report('CLI: --requester is sent at the body top level', ok, `bodyRequester=${body?.requester ?? '-'} metaRequester=${body?.meta?.requester ?? '-'}`)
  })

  await runCase('CLI: --requester accepts a title verbatim', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--target', 'mesh · hub', '--text', 'hi', '--requester', 'mesh · 协调 2'])
    const plan = await run({ ...options, dryRun: true }, noFetch)
    const ok = plan.payload?.requester === 'mesh · 协调 2'
    report('CLI: --requester accepts a title verbatim', ok, `requester=${plan.payload?.requester ?? '-'}`)
  })

  await runCase('CLI: without --requester or DSH_SESSION_ID the body keeps no requester field', async () => {
    const { parseArgs, run } = await import(cliUrl)
    // T-415: the CLI now defaults the requester from DSH_SESSION_ID, so this legacy guarantee
    // is about "neither the flag nor the environment names a session".
    const saved = process.env.DSH_SESSION_ID
    delete process.env.DSH_SESSION_ID
    try {
      const options = parseArgs(['--target', 'mesh · hub', '--text', 'hi'])
      const plan = await run({ ...options, dryRun: true }, noFetch)
      const ok = !('requester' in (plan.payload ?? {}))
      report('CLI: without --requester or DSH_SESSION_ID the body keeps no requester field', ok, `keys=${Object.keys(plan.payload ?? {}).join(',')}`)
    } finally {
      if (saved !== undefined) process.env.DSH_SESSION_ID = saved
    }
  })

  await runCase('CLI: --requester and --thread coexist', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--text', 'hi', '--thread', 'TH-1', '--requester', 'session-req'])
    const plan = await run({ ...options, dryRun: true }, noFetch)
    const payload = plan.payload ?? {}
    const ok = payload.requester === 'session-req' && payload.thread === 'TH-1' && !('session' in payload)
    report('CLI: --requester and --thread coexist', ok, `requester=${payload.requester ?? '-'} thread=${payload.thread ?? '-'} keys=${Object.keys(payload).join(',')}`)
  })

  await runCase('CLI: --help explains the requester default', async () => {
    const { parseArgs, USAGE } = await import(cliUrl)
    const options = parseArgs(['--help'])
    const ok = options.help === true && /--requester/.test(USAGE) && /receiptTo/.test(USAGE) && /file mode only writes receipts\.jsonl/.test(USAGE)
    report('CLI: --help explains the requester default', ok, `help=${options.help} requesterDoc=${/--requester/.test(USAGE)} defaultDoc=${/receiptTo/.test(USAGE)}`)
  })

  // T-355: --coordinator addresses a workspace's coordinator (owner named the flag; it means
  // "the coordinator of that workspace", not "the whole workspace"). A missing coordinator or
  // a vanished session is an addressing error (exit 2), never a guess.
  const fakeRegistryFetch = (workspaces, sessions) => async (url) => {
    const target = String(url)
    if (target.endsWith('/mesh/workspaces')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, workspaces }) }
    }
    if (target.includes('/mesh/sessions')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, sessions }) }
    }
    throw new Error(`unexpected request ${target}`)
  }

  await runCase('CLI: --coordinator resolves the coordinator and records routedTo', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--coordinator', 'dsh-mesh', '--text', 'hi', '--dry-run'])
    const fetchStub = fakeRegistryFetch(
      { 'dsh-mesh': { cwd: path.join('virtual', 'projects', 'dsh-mesh'), coordinator: 'session-coord-1', roles: ['waker'] } },
      [{ id: 'session-coord-1', title: 'mesh · 协调' }],
    )
    const result = await run(options, fetchStub)
    const ok =
      result.dryRun === true &&
      result.routedTo === 'workspace:dsh-mesh' &&
      result.payload.session === 'session-coord-1' &&
      result.payload.title === 'session-coord-1' &&
      result.resolvedCoordinator.coordinator === 'session-coord-1'
    report('CLI: --coordinator resolves the coordinator and records routedTo', ok, `target=${result.payload.session} routedTo=${result.routedTo}`)
  })

  await runCase('CLI: --coordinator on a workspace without a coordinator exits 2', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--coordinator', 'dshwork', '--text', 'hi', '--dry-run'])
    const fetchStub = fakeRegistryFetch({ dshwork: { cwd: path.join('virtual', 'dshwork'), roles: [] } }, [])
    let error = null
    try {
      await run(options, fetchStub)
    } catch (caught) {
      error = caught
    }
    const ok = error?.exitCode === 2 && /没有协调会话/.test(error.message)
    report('CLI: --coordinator on a workspace without a coordinator exits 2', ok, `exit=${error?.exitCode ?? '-'} msg=${(error?.message ?? '').slice(0, 40)}`)
  })

  await runCase('CLI: --coordinator with an unknown slug exits 2', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--coordinator', 'no-such-workspace', '--text', 'hi', '--dry-run'])
    const fetchStub = fakeRegistryFetch({ 'dsh-mesh': { coordinator: 'session-coord-1' } }, [{ id: 'session-coord-1' }])
    let error = null
    try {
      await run(options, fetchStub)
    } catch (caught) {
      error = caught
    }
    const ok = error?.exitCode === 2 && /不在本机注册表/.test(error.message) && /已登记：dsh-mesh/.test(error.message)
    report('CLI: --coordinator with an unknown slug exits 2', ok, `exit=${error?.exitCode ?? '-'} msg=${(error?.message ?? '').slice(0, 40)}`)
  })

  await runCase('CLI: --coordinator with an archived coordinator session exits 2', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--coordinator', 'dsh-mesh', '--text', 'hi', '--dry-run'])
    const fetchStub = fakeRegistryFetch({ 'dsh-mesh': { coordinator: 'session-gone' } }, [{ id: 'session-other' }])
    let error = null
    try {
      await run(options, fetchStub)
    } catch (caught) {
      error = caught
    }
    const ok = error?.exitCode === 2 && /不在这台机器的会话里/.test(error.message) && /\/mesh\/workspaces/.test(error.message)
    report('CLI: --coordinator with an archived coordinator session exits 2', ok, `exit=${error?.exitCode ?? '-'}`)
  })

  await runCase('CLI: --coordinator refuses to be combined with --target', async () => {
    const { parseArgs } = await import(cliUrl)
    let message = ''
    try {
      parseArgs(['--coordinator', 'dsh-mesh', '--target', 'x', '--text', 'hi'])
    } catch (error) {
      message = error.message
    }
    const ok = /cannot be combined with --target or --thread/.test(message)
    report('CLI: --coordinator refuses to be combined with --target', ok, `msg=${message.split('\n')[0].slice(0, 60)}`)
  })

  await runCase('CLI: --help documents only --coordinator (not --workspace)', async () => {
    const { USAGE } = await import(cliUrl)
    const ok = /--coordinator <slug>/.test(USAGE) && /equivalent to/.test(USAGE) && !/--workspace/.test(USAGE)
    report('CLI: --help documents only --coordinator (not --workspace)', ok, `coordinatorDoc=${/--coordinator/.test(USAGE)} workspaceDoc=${/--workspace/.test(USAGE)}`)
  })

  // T-372: --role addresses the worker registered for that role in the workspace that owns
  // the current directory. Missing or stale workers are addressing errors with candidates.
  await runCase('CLI: --role resolves the workspace worker', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--role', 'docs', '--text', 'hi', '--dry-run'])
    const cwd = process.cwd()
    const fetchStub = fakeRegistryFetch(
      { 'dsh-mesh': { cwd, workers: { docs: { sessionId: 'session-docs-1', stale: false } } } },
      [{ id: 'session-docs-1', title: 'dsh-mesh · docs' }],
    )
    const result = await run(options, fetchStub)
    const ok =
      result.dryRun === true &&
      result.payload.session === 'session-docs-1' &&
      result.routedTo === 'role:dsh-mesh/docs' &&
      result.resolvedRole.sessionId === 'session-docs-1'
    report('CLI: --role resolves the workspace worker', ok, `target=${result.payload.session} routedTo=${result.routedTo}`)
  })

  await runCase('CLI: --role on an archived worker exits 2 with candidates', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--role', 'docs', '--text', 'hi', '--dry-run'])
    const cwd = process.cwd()
    const fetchStub = fakeRegistryFetch(
      { 'dsh-mesh': { cwd, workers: { docs: { sessionId: 'session-docs-old', archived: true } } } },
      [
        { id: 'session-docs-old', title: 'dsh-mesh · docs', archived: true },
        { id: 'session-docs-new', title: 'dsh-mesh · docs', archived: false },
      ],
    )
    let error = null
    try {
      await run(options, fetchStub)
    } catch (caught) {
      error = caught
    }
    const ok = error?.exitCode === 2 && /已归档/.test(error.message) && /session-docs-new/.test(error.message) && !/Assertion failed/.test(error.message)
    report('CLI: --role on an archived worker exits 2 with candidates', ok, `exit=${error?.exitCode ?? '-'} candidates=${/session-docs-new/.test(error?.message ?? '')}`)
  })

  // T-374: a dormant worker (exists, not archived, just not loaded) is deliverable — the wake
  // path loads it. Only missing/archived is an addressing error.
  await runCase('CLI: --role resolves a dormant worker with a wake warning', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--role', 'waker', '--text', 'hi', '--dry-run'])
    const cwd = process.cwd()
    const fetchStub = fakeRegistryFetch(
      { 'dsh-mesh': { cwd, workers: { waker: { sessionId: 'session-waker-dormant', dormant: true, stale: false } } } },
      [{ id: 'session-waker-dormant', title: 'dsh-mesh · waker', archived: false, live: false }],
    )
    const result = await run(options, fetchStub)
    const ok = result.dryRun === true && result.payload.session === 'session-waker-dormant' && result.resolvedRole?.dormant === true
    report('CLI: --role resolves a dormant worker with a wake warning', ok, `target=${result.payload.session} dormant=${result.resolvedRole?.dormant ?? '-'}`)
  })

  // T-374: the CLI must exit cleanly through a real process — a process.exit() after fetch
  // trips libuv (UV_HANDLE_CLOSING assertion) and the script gets a crash code instead of 2.
  const startRegistryStub = (workspaces, sessions) =>
    new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        res.writeHead(200, { 'content-type': 'application/json' })
        if (url.pathname === '/mesh/workspaces') res.end(JSON.stringify({ ok: true, workspaces }))
        else if (url.pathname === '/mesh/sessions') res.end(JSON.stringify({ ok: true, sessions }))
        else res.end('{}')
      })
      server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
    })

  // Async spawn: spawnSync would block this process's event loop, so the registry stub above
  // could never answer the child and every case would look like a connection failure.
  const runCliProcess = (args, options = {}) =>
    new Promise((resolve) => {
      const { spawn } = require('node:child_process')
      const env = options.env ? { ...process.env, ...options.env } : process.env
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('close', (code) => resolve({ status: code, stdout, stderr }))
    })

  await runCase('CLI process: a dormant worker exits 0 with a wake warning', async () => {
    const cwd = process.cwd()
    const stub = await startRegistryStub(
      { 'dsh-mesh': { cwd, workers: { waker: { sessionId: 'session-waker-dormant', dormant: true } } } },
      [{ id: 'session-waker-dormant', title: 'dsh-mesh · waker', archived: false, live: false }],
    )
    try {
      const cliPath = path.join(REPO, 'plugins', 'mesh-waker', 'bin', 'dispatch.mjs')
      const run = await runCliProcess([cliPath, '--role', 'waker', '--text', 'hi', '--dry-run', '--waker', stub.url])
      const ok = run.status === 0 && /stale=true/.test(run.stdout) && /will wake/.test(run.stderr) && !/Assertion failed/.test(run.stderr)
      report('CLI process: a dormant worker exits 0 with a wake warning', ok, `status=${run.status} staleDoc=${/stale=true/.test(run.stdout)} wake=${/will wake/.test(run.stderr)}`)
    } finally {
      stub.server.close()
    }
  })

  await runCase('CLI process: an archived worker exits 2 without a libuv assertion', async () => {
    const cwd = process.cwd()
    const stub = await startRegistryStub(
      { 'dsh-mesh': { cwd, workers: { docs: { sessionId: 'session-docs-old', archived: true } } } },
      [{ id: 'session-docs-old', title: 'dsh-mesh · docs', archived: true }],
    )
    try {
      const cliPath = path.join(REPO, 'plugins', 'mesh-waker', 'bin', 'dispatch.mjs')
      const run = await runCliProcess([cliPath, '--role', 'docs', '--text', 'hi', '--dry-run', '--waker', stub.url])
      const ok = run.status === 2 && /已归档/.test(run.stderr) && /archived/.test(run.stderr) && !/Assertion failed/.test(run.stderr)
      report('CLI process: an archived worker exits 2 without a libuv assertion', ok, `status=${run.status} archivedDoc=${/archived/.test(run.stderr)} assertion=${/Assertion failed/.test(run.stderr)}`)
    } finally {
      stub.server.close()
    }
  })

  await runCase('CLI: --role on a missing role exits 2 and lists registered roles', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--role', 'ops', '--text', 'hi', '--dry-run'])
    const cwd = process.cwd()
    const fetchStub = fakeRegistryFetch(
      { 'dsh-mesh': { cwd, workers: { docs: { sessionId: 'session-docs-1', stale: false } } } },
      [],
    )
    let error = null
    try {
      await run(options, fetchStub)
    } catch (caught) {
      error = caught
    }
    const ok = error?.exitCode === 2 && /没有 "ops" worker/.test(error.message) && /已登记角色：docs/.test(error.message)
    report('CLI: --role on a missing role exits 2 and lists registered roles', ok, `exit=${error?.exitCode ?? '-'} listed=${/已登记角色：docs/.test(error?.message ?? '')}`)
  })

  await runCase('task record: routedTo is persisted and visible in the task API', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-routed', title: 'routed target' }] })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { session: 'session-routed', text: 'routed task', routedTo: 'workspace:dsh-mesh', meta: { taskId: 'T-ROUTED-1' } },
    })
    const snapshot = await request(h.base, '/mesh/tasks/T-ROUTED-1')
    const ok = snapshot.json?.task?.routedTo === 'workspace:dsh-mesh'
    report('task record: routedTo is persisted and visible in the task API', ok, `routedTo=${snapshot.json?.task?.routedTo ?? '-'}`)
  })

  await runCase('receipt: the batch aggregate names each member workspace and flags failures', async () => {
    const { buildBatchReceipt } = await import(pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'lib', 'receipt.mjs')).href)
    const { record, body } = buildBatchReceipt({
      batchId: 'B-t355',
      tasks: [
        { taskId: 'T-ok', status: 'completed', workspace: 'dsh-mesh', settled: true },
        { taskId: 'T-bad', status: 'error', workspace: 'util4freesub', settled: true, detail: 'exit 2' },
      ],
    })
    const ok =
      body.includes('dsh-mesh') &&
      body.includes('util4freesub') &&
      /util4freesub\s+← 失败/.test(body) &&
      record.tasks.length === 2 &&
      record.tasks.every((task) => typeof task.workspace === 'string')
    report('receipt: the batch aggregate names each member workspace and flags failures', ok, `body=${JSON.stringify(body.split('\n')[1])}`)
  })

  // 42-44. Regression: injection during a running turn must not settle on that turn's end.
  await runCase('task receipt: queue injection during a running turn waits for the next turn', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-running', title: 'running target' }] })
    h.emit('session/event', { id: 'session-running' }, { type: 'turn/start', data: { turn: 5 } })
    const injected = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'running target', text: 'T-130 work', meta: { taskId: 'T-queue' } },
    })
    h.emit('session/event', { id: 'session-running' }, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await sleep(400)
    const premature = readReceipts(h.receiptsPath).filter((row) => row.taskId === 'T-queue')
    h.emit('session/event', { id: 'session-running' }, { type: 'turn/start', data: { turn: 6 } })
    h.emit('session/event', { id: 'session-running' }, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-queue'), 4000)
    const ok =
      injected.status === 200 &&
      premature.length === 0 &&
      receipt?.turn === 6 &&
      receipt?.settledTurn === 6 &&
      receipt?.baselineTurn === 5 &&
      receipt?.injectedDuringTurn === true
    report('task receipt: queue injection during a running turn waits for the next turn', ok, `premature=${premature.length} turn=${receipt?.turn ?? '-'} baseline=${receipt?.baselineTurn ?? '-'} during=${receipt?.injectedDuringTurn ?? '-'}`)
  })

  await runCase('task receipt: steer injection settles on the running turn', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-steer', title: 'steer target' }] })
    h.emit('session/event', { id: 'session-steer' }, { type: 'turn/start', data: { turn: 5 } })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'steer target', text: 'inserted into turn 5', mode: 'steer', meta: { taskId: 'T-steer' } },
    })
    h.emit('session/event', { id: 'session-steer' }, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-steer'), 4000)
    const ok = receipt?.turn === 5 && receipt?.baselineTurn === 5 && receipt?.injectedDuringTurn === true
    report('task receipt: steer injection settles on the running turn', ok, `turn=${receipt?.turn ?? '-'} baseline=${receipt?.baselineTurn ?? '-'} during=${receipt?.injectedDuringTurn ?? '-'}`)
  })

  await runCase('task receipt: no turn history still settles on the first turn/end', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-fresh', title: 'fresh target' }] })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'fresh target', text: 'fresh work', meta: { taskId: 'T-fresh' } },
    })
    h.emit('session/event', { id: 'session-fresh' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-fresh'), 4000)
    const ok = receipt?.turn === 1 && receipt?.baselineTurn === null && receipt?.injectedDuringTurn === false
    report('task receipt: no turn history still settles on the first turn/end', ok, `turn=${receipt?.turn ?? '-'} baseline=${receipt?.baselineTurn ?? '-'} during=${receipt?.injectedDuringTurn ?? '-'}`)
  })

  // T-364: the origin scan reads a session log's tool calls to learn who sent a message.
  await runCase('origin scan: the session log names the sender of a conversation', async () => {
    const { findOutboundSession, readLogTail } = await import(
      pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'lib', 'origin-scan.mjs')).href
    )
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-scan-'))
    try {
      const log = path.join(dir, 'session.v4.jsonl.zstd')
      const first = JSON.stringify({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }) + '\n'
      const second =
        JSON.stringify({
          type: 'tool/call',
          seq: 2,
          time: 2,
          data: { turn: 1, step: 1, callId: 'c1', name: 'mesh_send', arguments: JSON.stringify({ to: 'peer-b', conversation: 'conv/reply', body: 'hi' }) },
        }) + '\n'
      fs.writeFileSync(log, Buffer.concat([zstdCompressSync(Buffer.from(first)), zstdCompressSync(Buffer.from(second))]))
      const sessions = [{ id: 'session-A', workspace: 'ws', log, mtime: Date.now() }]
      const hit = findOutboundSession({ sessions, conversation: 'conv/reply' })
      const text = readLogTail(log)
      const ok =
        hit?.sessionId === 'session-A' &&
        hit?.tool === 'mesh_send' &&
        text.includes('"tool/call"') &&
        text.includes('conv/reply') &&
        findOutboundSession({ sessions, conversation: 'conv/other' }) === null &&
        findOutboundSession({ sessions, conversation: 'conv/reply', toolNames: ['mesh_ask'] }) === null &&
        findOutboundSession({ sessions, conversation: 'conv/reply', sinceMs: Date.now() + 60_000 }) === null
      report('origin scan: the session log names the sender of a conversation', ok, `hit=${hit?.sessionId ?? '-'} tool=${hit?.tool ?? '-'}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // T-365: the host logs MCP tools as mcp__<server>__<tool>, so the bare default name never
  // matched and the routing was dead by default. These cases use the real logged name.
  await runCase('origin scan: the MCP-prefixed name matches and a look-alike does not', async () => {
    const { findOutboundSession, toolNameMatches } = await import(
      pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'lib', 'origin-scan.mjs')).href
    )
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-scan-mcp-'))
    try {
      const write = (name, conversation) => {
        const log = path.join(dir, `${name.replace(/[^\w]/g, '_')}.zstd`)
        const line =
          JSON.stringify({ type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: 'c1', name, arguments: JSON.stringify({ to: 'peer-b', conversation }) } }) + '\n'
        fs.writeFileSync(log, zstdCompressSync(Buffer.from(line)))
        return { id: 'session-' + name, workspace: 'ws', log, mtime: Date.now() }
      }
      const prefixed = write('mcp__mesh__mesh_send', 'conv/prefixed')
      const bare = write('mesh_send', 'conv/bare')
      const evil = write('mesh_send_evil', 'conv/evil')
      const other = write('mcp__other__mesh_send', 'conv/other')
      const hitPrefixed = findOutboundSession({ sessions: [prefixed], conversation: 'conv/prefixed' })
      const hitBare = findOutboundSession({ sessions: [bare], conversation: 'conv/bare' })
      const missEvil = findOutboundSession({ sessions: [evil], conversation: 'conv/evil' })
      const hitOtherServer = findOutboundSession({ sessions: [other], conversation: 'conv/other' })
      const ok =
        toolNameMatches('mcp__mesh__mesh_send', 'mesh_send') === true &&
        toolNameMatches('mesh_send', 'mesh_send') === true &&
        toolNameMatches('mesh_send_evil', 'mesh_send') === false &&
        hitPrefixed?.sessionId === 'session-mcp__mesh__mesh_send' &&
        hitBare?.sessionId === 'session-mesh_send' &&
        missEvil === null &&
        hitOtherServer !== null
      report('origin scan: the MCP-prefixed name matches and a look-alike does not', ok, `prefixed=${hitPrefixed?.sessionId ?? '-'} bare=${hitBare?.sessionId ?? '-'} evil=${missEvil ? 'MATCHED' : 'miss'}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // T-366: every forwarding session also logs a send, so "first match" picked the wrong one.
  // The origin is the session that sent FIRST; entries without a timestamp never win.
  await runCase('origin scan: the earliest sender wins regardless of enumeration order', async () => {
    const { findOutboundSession } = await import(pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'lib', 'origin-scan.mjs')).href)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-scan-order-'))
    try {
      const write = (id, at, conversation) => {
        const log = path.join(dir, id + '.zstd')
        const event = {
          type: 'tool/call',
          seq: 1,
          ...(at === undefined ? {} : { time: at }),
          data: { name: 'mcp__mesh__mesh_send', arguments: JSON.stringify({ conversation }) },
        }
        fs.writeFileSync(log, zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n')))
        return { id, workspace: 'ws', log, mtime: Date.now() }
      }
      const late = write('session-c-late', 3000, 'conv/order')
      const early = write('session-a-early', 1000, 'conv/order')
      const middle = write('session-b-middle', 2000, 'conv/order')
      const noTime = write('session-0-missing-time', undefined, 'conv/order')
      // Reverse of the time order, with the timestamp-less candidate first.
      const hit = findOutboundSession({ sessions: [noTime, late, middle, early], conversation: 'conv/order' })
      const tieHigh = write('session-zzz', 5000, 'conv/tie')
      const tieLow = write('session-aaa', 5000, 'conv/tie')
      const tieHit = findOutboundSession({ sessions: [tieHigh, tieLow], conversation: 'conv/tie' })
      const ok = hit?.sessionId === 'session-a-early' && hit.at === 1000 && tieHit?.sessionId === 'session-aaa'
      report('origin scan: the earliest sender wins regardless of enumeration order', ok, `hit=${hit?.sessionId ?? '-'} at=${hit?.at ?? '-'} tie=${tieHit?.sessionId ?? '-'}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // T-365 end-to-end: a real plugin boot, a real session log with the host's tool name, and a
  // pulled reply — the conversation must bind to the origin session instead of the inbox.
  const e2eOriginLog = (h, sessionId, conversation, toolName = 'mcp__mesh__mesh_send') => {
    const log = path.join(h.sessionsRoot, 'ws-test', sessionId, 'session.v4.jsonl.zstd')
    const line =
      JSON.stringify({ type: 'tool/call', seq: 9, time: Date.now(), data: { turn: 1, step: 1, callId: 'c9', name: toolName, arguments: JSON.stringify({ to: 'peer-b', conversation, body: 'outbound' }) } }) + '\n'
    fs.writeFileSync(log, zstdCompressSync(Buffer.from(line)))
  }

  await runCase('origin routing: a reply is delivered to the live origin session', async (boot) => {
    const conversation = `test-reply-live-${Date.now()}`
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-e2e-live', sender: 'peer-b', conversation, reply_to: 'm-out-live', subject: 're', body: 'a reply' }],
    })
    let h = null
    try {
      h = await boot({
        seedSessions: [{ id: 'session-e2e-origin', title: 'origin session' }],
        config: { hubUrl: fake.url, pollIntervalMs: 5000, pollBusyIntervalMs: 1000, pollIdleIntervalMs: 5000 },
      })
      h.state.agents.set('session-e2e-origin', {})
      e2eOriginLog(h, 'session-e2e-origin', conversation)
      const delivered = await waitFor(() => (h.state.prompts.length ? h.state.prompts[0] : null), 15000)
      const conversations = await readConversationsWhenReady(h)
      const entry = conversations[conversation] ?? {}
      const ok = delivered?.sessionId === 'session-e2e-origin' && entry.deliverTo === 'session-e2e-origin'
      report('origin routing: a reply is delivered to the live origin session', ok, `deliverTo=${entry.deliverTo ?? '-'} prompt=${delivered?.sessionId ?? '-'}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('origin routing: a dead origin is replaced in its workspace', async (boot) => {
    const conversation = `test-reply-dead-${Date.now()}`
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-e2e-dead', sender: 'peer-b', conversation, reply_to: 'm-out-dead', subject: 're', body: 'a reply' }],
    })
    let h = null
    try {
      h = await boot({
        seedSessions: [{ id: 'session-e2e-gone', title: 'gone origin' }],
        config: { hubUrl: fake.url, pollIntervalMs: 5000, pollBusyIntervalMs: 1000, pollIdleIntervalMs: 5000 },
      })
      // Not live: the auto-bound session must be replaced, not used.
      e2eOriginLog(h, 'session-e2e-gone', conversation)
      const delivered = await waitFor(() => (h.state.prompts.length ? h.state.prompts[0] : null), 15000)
      const conversations = await readConversationsWhenReady(h)
      const entry = conversations[conversation] ?? {}
      const replacement = h.state.created.find((item) => item.id === delivered?.sessionId)
      const ok =
        Boolean(replacement) &&
        entry.deliverTo === delivered.sessionId &&
        entry.deliverTo !== 'session-e2e-gone'
      report('origin routing: a dead origin is replaced in its workspace', ok, `deliverTo=${entry.deliverTo ?? '-'} created=${h.state.created.length}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // T-426: an unbound conversation must not get an inbox session, and its messages stay
  // unread so a human can bind it (/mesh.bind).
  await runCase('origin routing: an unresolvable reply is deferred, not consumed by an inbox session', async (boot) => {
    const conversation = `test-reply-unknown-${Date.now()}`
    const logFile = path.join(os.tmpdir(), `waker-defer-${process.pid}-${Date.now()}.log`)
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-e2e-unknown', sender: 'peer-b', conversation, reply_to: 'm-out-unknown', subject: 're', body: 'a reply' }],
    })
    let h = null
    try {
      h = await boot({ config: { logFile, hubUrl: fake.url, pollIntervalMs: 5000, pollBusyIntervalMs: 1000, pollIdleIntervalMs: 5000 } })
      const decision = await waitFor(() => {
        if (!fs.existsSync(logFile)) return null
        const text = fs.readFileSync(logFile, 'utf8')
        return /target=deferred reason=unbound/.test(text) ? text : null
      }, 15000)
      const logText = decision ?? ''
      const ok =
        /conversation=\S+ target=deferred reason=unbound messages=1/.test(logText) &&
        h.state.created.length === 0 &&
        h.state.prompts.length === 0 &&
        !fake.readIds.includes('m-e2e-unknown')
      report(
        'origin routing: an unresolvable reply is deferred, not consumed by an inbox session',
        ok,
        `deferred=${/reason=unbound/.test(logText)} created=${h.state.created.length} prompts=${h.state.prompts.length} read=${fake.readIds.length}`,
      )
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // 45-49. Topic routing: labels resolve locally; ids/titles never leave the machine.
  await runCase('topics: a label delivers to the session matching the title', async (boot) => {
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-topic-1', sender: 'peer-a', conversation: 'ops/x', subject: 'ops', body: 'restart the frontend' }],
    })
    let h = null
    try {
      h = await boot({
        seedSessions: [
          { id: 'session-topic-a', title: 'web 运维' },
          { id: 'session-topic-b', title: 'other project' },
        ],
        config: {
          hubUrl: fake.url,
          pollIntervalMs: 5000,
          pollBusyIntervalMs: 1000,
          pollIdleIntervalMs: 5000,
          topics: [{ label: 'ops/x', titlePattern: 'web 运维' }],
        },
      })
      const delivered = await waitFor(() => (h.state.prompts.length ? h.state.prompts[0] : null), 15000)
      const ok = delivered?.sessionId === 'session-topic-a' && h.state.prompts.every((prompt) => prompt.sessionId === 'session-topic-a')
      report('topics: a label delivers to the session matching the title', ok, `session=${delivered?.sessionId ?? '-'} prompts=${h.state.prompts.length}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('topics: archived session is rebound to the recreated namesake', async (boot) => {
    const archived = ['session-topic-old']
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-rebind-1', sender: 'peer-a', conversation: 'ops/rb', body: 'first' }],
    })
    let h = null
    try {
      h = await boot({
        seedSessions: [
          { id: 'session-topic-live', title: 'rebind 运维' },
          { id: 'session-topic-old', title: 'rebind 运维' },
        ],
        archivedIds: archived,
        config: {
          hubUrl: fake.url,
          pollIntervalMs: 5000,
          pollBusyIntervalMs: 1000,
          pollIdleIntervalMs: 5000,
          topics: [{ label: 'ops/rb', titlePattern: 'rebind 运维' }],
        },
      })
      const first = await waitFor(() => (h.state.prompts.length ? h.state.prompts[0] : null), 15000)
      archived.push('session-topic-live')
      archived.splice(archived.indexOf('session-topic-old'), 1)
      fake.push({ id: 'm-rebind-2', sender: 'peer-a', conversation: 'ops/rb', body: 'second' })
      const second = await waitFor(() => (h.state.prompts.length >= 2 ? h.state.prompts[1] : null), 15000)
      const ok = first?.sessionId === 'session-topic-live' && second?.sessionId === 'session-topic-old'
      report('topics: archived session is rebound to the recreated namesake', ok, `first=${first?.sessionId ?? '-'} second=${second?.sessionId ?? '-'}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('topics: allowFrom denies a foreign sender without consuming the message', async (boot) => {
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-deny-1', sender: 'peer-b', conversation: 'ops/secure', body: 'should not run' }],
    })
    const logStart = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').length : 0
    let h = null
    try {
      h = await boot({
        seedSessions: [{ id: 'session-topic-sec', title: 'secure 运维' }],
        config: {
          hubUrl: fake.url,
          pollIntervalMs: 5000,
          pollBusyIntervalMs: 1000,
          pollIdleIntervalMs: 5000,
          topics: [{ label: 'ops/secure', titlePattern: 'secure 运维', allowFrom: ['peer-a'] }],
        },
      })
      // Two polls: the denial is re-evaluated, and it must still not read/inject.
      await waitFor(() => fake.requests.filter((entry) => entry.path === '/api/inbox').length >= 2, 15000)
      await sleep(500)
      const logText = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').slice(logStart) : ''
      const deniedLines = logText.split(/\r?\n/).filter((line) => /topic denied label=ops\/secure peer=peer-b/.test(line))
      const ok =
        h.state.prompts.length === 0 &&
        fake.unread.length === 1 &&
        fake.readIds.length === 0 &&
        deniedLines.length === 1
      report(
        'topics: allowFrom denies a foreign sender without consuming the message',
        ok,
        `prompts=${h.state.prompts.length} unread=${fake.unread.length} read_at=null(${fake.readIds.length === 0}) deniedLines=${deniedLines.length}`,
      )
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('topics: duplicate label keeps only the first definition', async (boot) => {
    const h = await boot({
      config: {
        topics: [
          { label: 'ops/dup', titlePattern: 'first 运维' },
          { label: 'ops/dup', titlePattern: 'second 运维' },
        ],
      },
    })
    const status = await request(h.base, '/mesh/status')
    const listed = status.json?.topics ?? []
    const ok = listed.length === 1 && listed[0]?.label === 'ops/dup'
    report('topics: duplicate label keeps only the first definition', ok, `topics=${JSON.stringify(listed)}`)
  })

  await runCase('topics: invalid label is ignored at startup', async (boot) => {
    const h = await boot({ config: { topics: [{ label: 'Ops X', titlePattern: 'web 运维' }] } })
    const status = await request(h.base, '/mesh/status')
    const listed = status.json?.topics ?? []
    const ok = Array.isArray(listed) && listed.length === 0
    report('topics: invalid label is ignored at startup', ok, `topics=${JSON.stringify(listed)}`)
  })

  await runCase('topics: status exposes labels only, never ids or titles', async (boot) => {
    const h = await boot({
      seedSessions: [{ id: 'session-topic-leak', title: 'leak 运维' }],
      config: { topics: [{ label: 'ops/leak', titlePattern: 'leak 运维' }] },
    })
    const status = await request(h.base, '/mesh/status')
    const payload = JSON.stringify(status.json?.topics ?? [])
    const ok = /"label":"ops\/leak"/.test(payload) && !payload.includes('session-') && !payload.includes('leak 运维')
    report('topics: status exposes labels only, never ids or titles', ok, `topics=${payload}`)
  })

  // 50-56. Remote approval bridge (approval/request answerer).
  const approvalRequest = { agent: { id: 'session-topic-a' }, toolName: 'bash', callId: 'call-12345678', reason: 'run a dangerous command' }

  await runCase('approval bridge: disabled delegates to next()', async (boot) => {
    const h = await boot({})
    let nextCalls = 0
    const outcome = await h.callApproval(approvalRequest, async () => {
      nextCalls += 1
      return 'unavailable'
    })
    const ok = nextCalls === 1 && outcome === 'unavailable'
    report('approval bridge: disabled delegates to next()', ok, `nextCalls=${nextCalls} outcome=${outcome}`)
  })

  await runCase('approval bridge: approve reply returns allowed-once', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startApprovalHarness(boot, fake, { diag: true })
      const pending = h.callApproval(approvalRequest)
      await waitFor(() => fake.sends.length > 0, 8000)
      const notice = fake.sends[0]
      fake.push({ id: 'm-appr-ok', sender: 'peer-owner', conversation: notice.conversation, body: 'approve' })
      const outcome = await pending
      const ok = outcome === 'allowed-once' && notice.silent === true && /^approval\//.test(notice.conversation) && /approve/.test(notice.body)
      report('approval bridge: approve reply returns allowed-once', ok, `outcome=${outcome} silent=${notice.silent} conversation=${notice.conversation}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('approval bridge: deny reply returns rejected', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startApprovalHarness(boot, fake)
      const pending = h.callApproval(approvalRequest)
      await waitFor(() => fake.sends.length > 0, 8000)
      fake.push({ id: 'm-appr-deny', sender: 'peer-owner', conversation: fake.sends[0].conversation, body: 'deny' })
      const outcome = await pending
      report('approval bridge: deny reply returns rejected', outcome === 'rejected', `outcome=${outcome}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('approval bridge: timeout delegates to next() without deciding', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startApprovalHarness(boot, fake, { timeoutSeconds: 1, pollMs: 250 })
      let nextCalls = 0
      const outcome = await h.callApproval(approvalRequest, async () => {
        nextCalls += 1
        return 'unavailable'
      })
      const ok = nextCalls === 1 && outcome === 'unavailable' && outcome !== 'allowed-once' && outcome !== 'rejected'
      report('approval bridge: timeout delegates to next() without deciding', ok, `nextCalls=${nextCalls} outcome=${outcome}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('approval bridge: sender outside allowFrom is ignored', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startApprovalHarness(boot, fake, { timeoutSeconds: 1, pollMs: 250 })
      const logStart = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').length : 0
      let nextCalls = 0
      const pending = h.callApproval(approvalRequest, async () => {
        nextCalls += 1
        return 'unavailable'
      })
      await waitFor(() => fake.sends.length > 0, 8000)
      fake.push({ id: 'm-appr-intruder', sender: 'peer-intruder', conversation: fake.sends[0].conversation, body: 'approve' })
      const outcome = await pending
      const logText = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').slice(logStart) : ''
      const ok = outcome === 'unavailable' && nextCalls === 1 && /approval ignored/.test(logText)
      report('approval bridge: sender outside allowFrom is ignored', ok, `outcome=${outcome} nextCalls=${nextCalls} ignoredLog=${/approval ignored/.test(logText)}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('approval bridge: conflicting words fail closed', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startApprovalHarness(boot, fake)
      const pending = h.callApproval(approvalRequest)
      await waitFor(() => fake.sends.length > 0, 8000)
      fake.push({ id: 'm-appr-mix', sender: 'peer-owner', conversation: fake.sends[0].conversation, body: 'approve? no — deny' })
      const outcome = await pending
      report('approval bridge: conflicting words fail closed', outcome === 'rejected', `outcome=${outcome}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('approval bridge: approval traffic never reaches a session', async (boot) => {
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-appr-traffic', sender: 'peer-owner', conversation: 'approval/abcdef12', body: 'approve' }],
    })
    let h = null
    try {
      const logStart = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').length : 0
      h = await boot({
        config: {
          hubUrl: fake.url,
          pollIntervalMs: 5000,
          pollBusyIntervalMs: 1000,
          pollIdleIntervalMs: 5000,
          approvalBridge: { enabled: true, to: 'peer-owner', allowFrom: ['peer-owner'], timeoutSeconds: 5, pollMs: 250 },
        },
      })
      await waitFor(() => fake.requests.some((entry) => entry.path === '/api/inbox'), 15000)
      await sleep(1500)
      const logText = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').slice(logStart) : ''
      const ok =
        h.state.prompts.length === 0 &&
        h.state.created.length === 0 &&
        fake.unread.length === 0 &&
        /approval traffic consumed/.test(logText)
      report('approval bridge: approval traffic never reaches a session', ok, `prompts=${h.state.prompts.length} created=${h.state.created.length} unread=${fake.unread.length} consumed=${/approval traffic consumed/.test(logText)}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // 57-63. mesh_ask: ask a human through the inbox (coordination, not a security gate).
  await runCase('mesh_ask: tool metadata documents that it is not a security gate', async () => {
    const { MESH_ASK_TOOL } = await import(pathToFileURL(ENTRY).href)
    const ok =
      MESH_ASK_TOOL.name === 'mesh_ask' &&
      MESH_ASK_TOOL.parameters?.question?.required === true &&
      MESH_ASK_TOOL.required.join(',') === 'question' &&
      /NOT a security gate/.test(MESH_ASK_TOOL.description)
    report('mesh_ask: tool metadata documents that it is not a security gate', ok, `name=${MESH_ASK_TOOL.name} required=${MESH_ASK_TOOL.required.join(',')}`)
  })

  await runCase('mesh_ask: silent message and numbered reply maps to the option text', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake)
      const pending = meshAskTool(h).execute({ question: 'Ship it?', options: ['yes, ship', 'no, wait'] })
      await waitFor(() => fake.sends.length > 0, 8000)
      const notice = fake.sends[0]
      fake.push({ id: 'm-ask-2', sender: 'peer-owner', conversation: notice.conversation, body: '2' })
      const result = await pending
      const ok = result.status === 'answered' && result.answer === 'no, wait' && notice.silent === true && /^question\//.test(notice.conversation)
      report('mesh_ask: silent message and numbered reply maps to the option text', ok, `status=${result.status} answer=${JSON.stringify(result.answer)} silent=${notice.silent} conv=${notice.conversation}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('mesh_ask: free-text reply is returned verbatim', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake)
      const pending = meshAskTool(h).execute({ question: 'When should we ship?' })
      await waitFor(() => fake.sends.length > 0, 8000)
      fake.push({ id: 'm-ask-text', sender: 'peer-owner', conversation: fake.sends[0].conversation, body: '  ship it later  ' })
      const result = await pending
      const ok = result.status === 'answered' && result.answer === 'ship it later'
      report('mesh_ask: free-text reply is returned verbatim', ok, `status=${result.status} answer=${JSON.stringify(result.answer)}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('mesh_ask: timeout is unanswered and picks no option', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake, { timeoutSeconds: 1 })
      const result = await meshAskTool(h).execute({ question: 'Continue?', options: ['yes', 'no'] })
      const ok = result.status === 'unanswered' && result.answer === undefined && result.timeoutSeconds === 1 && Boolean(result.questionId)
      report('mesh_ask: timeout is unanswered and picks no option', ok, `status=${result.status} answer=${JSON.stringify(result.answer)} timeout=${result.timeoutSeconds}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // T-342: the notice subject used to be the literal 'question', so every conversation in the
  // inbox list had the same unreadable title. It is now derived from the question itself.
  const askSubject = async (boot, question) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake)
      const pending = meshAskTool(h).execute({ question })
      await waitFor(() => fake.sends.length > 0, 8000)
      const notice = fake.sends[0]
      fake.push({ id: 'm-subj-' + Date.now(), sender: 'peer-owner', conversation: notice.conversation, body: 'ok' })
      await pending
      return notice.subject
    } finally {
      if (h) h.close()
      await fake.close()
    }
  }

  await runCase('mesh_ask: subject is derived from the question first line', async (boot) => {
    const subject = await askSubject(boot, 'Ship it?')
    report('mesh_ask: subject is derived from the question first line', subject === 'Ship it?', `subject=${JSON.stringify(subject)}`)
  })

  await runCase('mesh_ask: a long CJK question is truncated with an ellipsis, never half a character', async (boot) => {
    const long = '请确认是否需要把这个非常长的提问标题截断到五十个字符以内并且保证中文不会被截成半个字，这句话故意超过五十个字符'
    const subject = await askSubject(boot, long)
    const ok = Array.from(subject).length <= 51 && subject.endsWith('…') && !subject.includes('\uFFFD') && subject.startsWith('请确认')
    report('mesh_ask: a long CJK question is truncated with an ellipsis, never half a character', ok, `subject=${JSON.stringify(subject)} chars=${Array.from(subject).length}`)
  })

  await runCase('mesh_ask: an empty question falls back to the historical subject', async () => {
    const { questionSubject } = await import(pathToFileURL(ENTRY).href)
    const ok = questionSubject('   ') === 'question' && questionSubject('') === 'question' && questionSubject(null) === 'question'
    report('mesh_ask: an empty question falls back to the historical subject', ok, `blank=${JSON.stringify(questionSubject('   '))}`)
  })

  await runCase('mesh_ask: a multi-line question yields a single-line subject', async (boot) => {
    const subject = await askSubject(boot, 'Deploy today?\nsecond line\nthird line')
    const ok = subject === 'Deploy today?' && !/[\r\n]/.test(subject)
    report('mesh_ask: a multi-line question yields a single-line subject', ok, `subject=${JSON.stringify(subject)}`)
  })

  await runCase('mesh_ask: reply from outside allowFrom is ignored, then unanswered', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake, { timeoutSeconds: 1 })
      const logStart = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').length : 0
      const pending = meshAskTool(h).execute({ question: 'Deploy now?', options: ['yes', 'no'] })
      await waitFor(() => fake.sends.length > 0, 8000)
      fake.push({ id: 'm-ask-intruder', sender: 'peer-intruder', conversation: fake.sends[0].conversation, body: '1' })
      const result = await pending
      const logText = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').slice(logStart) : ''
      const ok = result.status === 'unanswered' && /question ignored/.test(logText)
      report('mesh_ask: reply from outside allowFrom is ignored, then unanswered', ok, `status=${result.status} ignoredLog=${/question ignored/.test(logText)}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('mesh_ask: question traffic never reaches a session', async (boot) => {
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-ask-traffic', sender: 'peer-owner', conversation: 'question/abcdef12', body: '1' }],
    })
    let h = null
    try {
      const logStart = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').length : 0
      h = await boot({
        config: {
          hubUrl: fake.url,
          pollIntervalMs: 5000,
          pollBusyIntervalMs: 1000,
          pollIdleIntervalMs: 5000,
          questionBridge: { enabled: true, to: 'peer-owner', allowFrom: ['peer-owner'], timeoutSeconds: 5, pollMs: 250 },
        },
      })
      await waitFor(() => fake.requests.some((entry) => entry.path === '/api/inbox'), 15000)
      const readLog = () => (fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').slice(logStart) : '')
      // Consumption happens on the first pull that sees the question group. Tool-registration
      // retries (0.7.8) can delay start-up past a fixed sleep, so poll the log instead of
      // sleeping 1500ms: the assertion is about the outcome, not about elapsed time.
      await waitFor(() => /question traffic consumed/.test(readLog()), 8000)
      const logText = readLog()
      const ok =
        h.state.prompts.length === 0 &&
        h.state.created.length === 0 &&
        fake.unread.length === 0 &&
        /question traffic consumed/.test(logText)
      report('mesh_ask: question traffic never reaches a session', ok, `prompts=${h.state.prompts.length} created=${h.state.created.length} unread=${fake.unread.length} consumed=${/question traffic consumed/.test(logText)}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('mesh_ask: absent user-questions seam keeps the plugin and tool available', async (boot) => {
    const logStart = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').length : 0
    const h = await boot({})
    await waitFor(() => h.state.tools.find((tool) => tool.name === 'mesh_ask'), 8000)
    const logText = fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, 'utf8').slice(logStart) : ''
    const ok = Boolean(meshAskTool(h)) && /user-questions seam absent; mesh_ask only/.test(logText)
    report('mesh_ask: absent user-questions seam keeps the plugin and tool available', ok, `tools=${h.state.tools.map((tool) => tool.name).join(',')} seamAbsentLog=${/seam absent/.test(logText)}`)
  })

  await runCase('mesh_ask: our own question notice is not treated as the answer', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake, { timeoutSeconds: 3 })
      const pending = meshAskTool(h).execute({ question: '今晚继续还是收工？', options: ['继续', '收工'] })
      await waitFor(() => fake.sends.length > 0, 8000)
      const notice = fake.sends[0]
      // The notice lands in our own inbox when to === self; it must never count as an answer.
      fake.push({ id: 'm-sent-1', sender: 'peer-owner', conversation: notice.conversation, body: notice.body, created_at: Date.now() })
      const early = await Promise.race([
        pending.then((value) => ({ resolved: true, value })),
        sleep(800).then(() => ({ resolved: false })),
      ])
      fake.push({ id: 'm-real-answer', sender: 'peer-owner', conversation: notice.conversation, body: '2', created_at: Date.now() + 1000 })
      const result = await pending
      const ok = early.resolved === false && result.status === 'answered' && result.answer === '收工' && result.by === 'peer-owner'
      report('mesh_ask: our own question notice is not treated as the answer', ok, `earlyAnswered=${early.resolved} status=${result.status} answer=${JSON.stringify(result.answer)}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('mesh_ask: a reply written before the ask is ignored', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake, { timeoutSeconds: 1 })
      const pending = meshAskTool(h).execute({ question: '现在发版吗？', options: ['发', '不发'] })
      await waitFor(() => fake.sends.length > 0, 8000)
      fake.push({
        id: 'm-old-answer',
        sender: 'peer-owner',
        conversation: fake.sends[0].conversation,
        body: '1',
        created_at: Date.now() - 60000,
      })
      const result = await pending
      const ok = result.status === 'unanswered' && result.answer === undefined
      report('mesh_ask: a reply written before the ask is ignored', ok, `status=${result.status} answer=${JSON.stringify(result.answer)}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('mesh_ask: only our own notice until timeout stays unanswered', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake, { timeoutSeconds: 1 })
      const pending = meshAskTool(h).execute({ question: '继续吗？', options: ['继续', '停'] })
      await waitFor(() => fake.sends.length > 0, 8000)
      const notice = fake.sends[0]
      fake.push({ id: 'm-sent-1', sender: 'peer-owner', conversation: notice.conversation, body: notice.body, created_at: Date.now() })
      const result = await pending
      const ok = result.status === 'unanswered' && result.answer === undefined
      report('mesh_ask: only our own notice until timeout stays unanswered', ok, `status=${result.status} answer=${JSON.stringify(result.answer)}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // 67-70. /mesh/status surfaces what is waiting for the operator.
  await runCase('status: pendingQuestions lists the active question and clears after the answer', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake, { timeoutSeconds: 5 })
      const pending = meshAskTool(h).execute({ question: '今晚继续\n还是收工？', options: ['继续', '收工'] })
      await waitFor(() => fake.sends.length > 0, 8000)
      const during = await request(h.base, '/mesh/status')
      const listed = during.json?.pendingQuestions ?? []
      const entry = listed[0] ?? {}
      const previewLength = Array.from(entry.preview ?? '').length
      const okDuring =
        listed.length === 1 &&
        /^question\//.test(entry.conversation ?? '') &&
        typeof entry.preview === 'string' &&
        !/\n/.test(entry.preview) &&
        previewLength <= 80 &&
        Array.isArray(entry.options) &&
        entry.options.join(',') === '继续,收工' &&
        Number.isFinite(entry.askedAt) &&
        Number.isFinite(entry.expiresAt)
      fake.push({ id: 'm-status-answer', sender: 'peer-owner', conversation: entry.conversation, body: '1' })
      const result = await pending
      const after = await request(h.base, '/mesh/status')
      const okAfter = result.status === 'answered' && (after.json?.pendingQuestions ?? []).length === 0
      report('status: pendingQuestions lists the active question and clears after the answer', okDuring && okAfter, `during=${listed.length} preview=${JSON.stringify(entry.preview)} cleared=${(after.json?.pendingQuestions ?? []).length}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('status: pending arrays exist and are empty by default', async (boot) => {
    const h = await boot({})
    const status = await request(h.base, '/mesh/status')
    const ok =
      Array.isArray(status.json?.pendingQuestions) &&
      status.json.pendingQuestions.length === 0 &&
      Array.isArray(status.json?.pendingApprovals) &&
      status.json.pendingApprovals.length === 0
    report('status: pending arrays exist and are empty by default', ok, `pendingQuestions=${JSON.stringify(status.json?.pendingQuestions)} pendingApprovals=${JSON.stringify(status.json?.pendingApprovals)}`)
  })

  await runCase('status: pendingApprovals lists the active approval request', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await startApprovalHarness(boot, fake)
      const pending = h.callApproval({ agent: { id: 'session-x' }, toolName: 'bash', callId: 'call-abcdef12', reason: 'rm -rf a very dangerous directory' })
      await waitFor(() => fake.sends.length > 0, 8000)
      const during = await request(h.base, '/mesh/status')
      const listed = during.json?.pendingApprovals ?? []
      const entry = listed[0] ?? {}
      const okDuring =
        listed.length === 1 &&
        /^approval\//.test(entry.conversation ?? '') &&
        entry.toolName === 'bash' &&
        /bash/.test(entry.preview ?? '') &&
        Array.from(entry.preview ?? '').length <= 80
      fake.push({ id: 'm-status-deny', sender: 'peer-owner', conversation: entry.conversation, body: 'deny' })
      const outcome = await pending
      const after = await request(h.base, '/mesh/status')
      const okAfter = outcome === 'rejected' && (after.json?.pendingApprovals ?? []).length === 0
      report('status: pendingApprovals lists the active approval request', okDuring && okAfter, `during=${listed.length} tool=${entry.toolName ?? '-'} cleared=${(after.json?.pendingApprovals ?? []).length}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('status: preview is truncated to 80 characters', async () => {
    const { previewText } = await import(pathToFileURL(ENTRY).href)
    const long = 'x'.repeat(200)
    const preview = previewText(`line one\nline two ${long}`)
    const ok = Array.from(preview).length === 80 && !/\n/.test(preview)
    report('status: preview is truncated to 80 characters', ok, `len=${Array.from(preview).length} newline=${/\n/.test(preview)}`)
  })

  // 71-74. The bridge conversation is reserved before the notice is sent, so a pull tick
  // that sees the message immediately cannot claim it or create a session.
  await runCase('mesh_ask: reserves the conversation before /api/send so pull cannot claim it', async (boot) => {
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      sendDelayMs: 1200,
      onSend: (body) => {
        fake.push({ id: 'm-question-own', sender: 'peer-owner', conversation: body.conversation, body: body.body, created_at: Date.now() })
      },
    })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake, {}, { pollIntervalMs: 5000, pollBusyIntervalMs: 1000, pollIdleIntervalMs: 5000 })
      const pending = meshAskTool(h).execute({ question: '继续吗？', options: ['继续', '收工'] })
      // Same as the approval bridge: wait for the reservation instead of a fixed 1.5s sample.
      const during = await waitFor(async () => {
        const status = await request(h.base, '/mesh/status')
        return (status.json?.pendingQuestions ?? []).length === 1 ? status : null
      }, 3000)
      const listed = during?.json?.pendingQuestions ?? []
      const reservedDuringSend = listed.length === 1
      const untouched = !fake.readIds.includes('m-question-own') && h.state.created.length === 0 && h.state.prompts.length === 0
      fake.push({ id: 'm-question-reply', sender: 'peer-owner', conversation: listed[0]?.conversation ?? '', body: '1', created_at: Date.now() + 1000 })
      const result = await pending
      const ok = reservedDuringSend && untouched && result.status === 'answered' && result.answer === '继续'
      report('mesh_ask: reserves the conversation before /api/send so pull cannot claim it', ok, `reservedDuringSend=${reservedDuringSend} claimedByPull=${fake.readIds.includes('m-question-own')} created=${h.state.created.length} prompts=${h.state.prompts.length} status=${result.status}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('mesh_ask: a failed send rolls the reservation back', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest', sendStatus: 500 })
    let h = null
    try {
      h = await startQuestionHarness(boot, fake)
      let error = ''
      try {
        await meshAskTool(h).execute({ question: '会失败吗？' })
      } catch (caught) {
        error = caught.message
      }
      const status = await request(h.base, '/mesh/status')
      const ok = /HTTP 500/.test(error) && (status.json?.pendingQuestions ?? []).length === 0
      report('mesh_ask: a failed send rolls the reservation back', ok, `error=${JSON.stringify(error)} pendingQuestions=${(status.json?.pendingQuestions ?? []).length}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('approval bridge: reserves the conversation before /api/send', async (boot) => {
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      sendDelayMs: 1200,
      onSend: (body) => {
        fake.push({ id: 'm-approval-own', sender: 'peer-owner', conversation: body.conversation, body: 'approve', created_at: Date.now() })
      },
    })
    let h = null
    try {
      h = await startApprovalHarness(boot, fake)
      const pending = h.callApproval({ agent: { id: 'session-x' }, toolName: 'bash', callId: 'call-abcdef12', reason: 'danger' })
      // Poll for the reservation instead of sampling once at 400ms: the bridge registers it
      // synchronously, but a slow send must not turn a correct implementation into a flake.
      const during = await waitFor(async () => {
        const status = await request(h.base, '/mesh/status')
        return (status.json?.pendingApprovals ?? []).length === 1 ? status : null
      }, 3000)
      const reservedDuringSend = Boolean(during)
      const outcome = await pending
      const ok = reservedDuringSend && outcome === 'allowed-once'
      report('approval bridge: reserves the conversation before /api/send', ok, `reservedDuringSend=${reservedDuringSend} outcome=${outcome}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('approval bridge: a failed send rolls the reservation back', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest', sendStatus: 500 })
    let h = null
    try {
      h = await startApprovalHarness(boot, fake)
      const outcome = await h.callApproval({ agent: { id: 'session-x' }, toolName: 'bash', callId: 'call-abcdef12', reason: 'danger' })
      const status = await request(h.base, '/mesh/status')
      const ok = outcome === 'unavailable' && (status.json?.pendingApprovals ?? []).length === 0
      report('approval bridge: a failed send rolls the reservation back', ok, `outcome=${outcome} pendingApprovals=${(status.json?.pendingApprovals ?? []).length}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // 75-79. /mesh/sessions pagination and filters (no more hard 80 cap).
  await runCase('sessions: default page reports total/limit/offset', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-page-a', title: 'alpha one' },
        { id: 'session-page-b', title: 'beta two' },
        { id: 'session-page-c', title: 'gamma three' },
      ],
    })
    const listed = await request(h.base, '/mesh/sessions')
    const body = listed.json ?? {}
    const ok = body.ok === true && body.total === 3 && body.limit === 80 && body.offset === 0 && body.sessions.length === 3
    report('sessions: default page reports total/limit/offset', ok, `total=${body.total} limit=${body.limit} offset=${body.offset} sessions=${body.sessions?.length}`)
  })

  await runCase('sessions: limit/offset returns the requested window', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-win-a', title: 'first' },
        { id: 'session-win-b', title: 'second' },
        { id: 'session-win-c', title: 'third' },
      ],
    })
    const full = await request(h.base, '/mesh/sessions')
    const windowed = await request(h.base, '/mesh/sessions?limit=1&offset=1')
    const expected = full.json?.sessions?.[1]?.id
    const ok = windowed.json?.total === 3 && windowed.json?.limit === 1 && windowed.json?.offset === 1 && windowed.json?.sessions?.length === 1 && windowed.json.sessions[0].id === expected
    report('sessions: limit/offset returns the requested window', ok, `expected=${expected ?? '-'} got=${windowed.json?.sessions?.[0]?.id ?? '-'} limit=${windowed.json?.limit} offset=${windowed.json?.offset}`)
  })

  await runCase('sessions: archived filter selects only archived sessions', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-arch-live', title: 'live one' },
        { id: 'session-arch-old', title: 'archived one' },
      ],
      archivedIds: ['session-arch-old'],
    })
    const archived = await request(h.base, '/mesh/sessions?archived=1')
    const active = await request(h.base, '/mesh/sessions?archived=0')
    const ok =
      archived.json?.total === 1 &&
      archived.json?.sessions?.[0]?.id === 'session-arch-old' &&
      active.json?.total === 1 &&
      active.json?.sessions?.[0]?.id === 'session-arch-live'
    report('sessions: archived filter selects only archived sessions', ok, `archived=${archived.json?.total} active=${active.json?.total}`)
  })

  await runCase('sessions: q filters by title substring, case-insensitively', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-q-a', title: 'Alpha One' },
        { id: 'session-q-b', title: 'beta two' },
      ],
    })
    const matched = await request(h.base, '/mesh/sessions?q=alp')
    const ok = matched.json?.total === 1 && matched.json?.sessions?.[0]?.id === 'session-q-a'
    report('sessions: q filters by title substring, case-insensitively', ok, `total=${matched.json?.total} id=${matched.json?.sessions?.[0]?.id ?? '-'}`)
  })

  await runCase('sessions: limit is clamped to 1..500', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-clamp-a', title: 'one' }] })
    const low = await request(h.base, '/mesh/sessions?limit=0')
    const high = await request(h.base, '/mesh/sessions?limit=999')
    const ok = low.json?.limit === 1 && low.json?.sessions?.length === 1 && high.json?.limit === 500
    report('sessions: limit is clamped to 1..500', ok, `lowLimit=${low.json?.limit} highLimit=${high.json?.limit}`)
  })

  // 80-82. Dedicated log file with size-based rotation.
  await runCase('logging: logFile config receives lines and status reports size', async (boot) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-log-'))
    const logFile = path.join(tmp, 'waker.log')
    let h = null
    try {
      h = await boot({ seedSessions: [{ id: 'session-log-a', title: 'log target' }], config: { logFile } })
      await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'log target', text: 'write a log line' } })
      await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('injected'), 5000)
      const status = await request(h.base, '/mesh/status')
      const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0
      const ok = fs.existsSync(logFile) && size > 0 && status.json?.logFile === logFile && status.json?.logBytes === size
      report('logging: logFile config receives lines and status reports size', ok, `exists=${fs.existsSync(logFile)} bytes=${status.json?.logBytes} statusFile=${status.json?.logFile}`)
    } finally {
      if (h) h.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  await runCase('logging: exceeding logMaxBytes rotates to .1 and starts empty', async (boot) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-log-'))
    const logFile = path.join(tmp, 'waker.log')
    fs.writeFileSync(logFile, 'x'.repeat(3000))
    let h = null
    try {
      h = await boot({
        seedSessions: [{ id: 'session-log-rot', title: 'rotate target' }],
        config: { logFile, logMaxBytes: 1024 },
      })
      await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'rotate target', text: 'trigger rotation' } })
      await waitFor(() => fs.existsSync(`${logFile}.1`), 5000)
      const rotatedSize = fs.existsSync(`${logFile}.1`) ? fs.statSync(`${logFile}.1`).size : 0
      const current = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
      // Extra startup lines mean more than one rotation can happen; what must hold is that a
      // rotated copy exists, the current file starts fresh and the injected line is in it.
      const ok = rotatedSize > 0 && current.includes('injected') && Buffer.byteLength(current) < 1024
      report('logging: exceeding logMaxBytes rotates to .1 and starts empty', ok, `rotatedBytes=${rotatedSize} currentBytes=${Buffer.byteLength(current)} currentHasLine=${current.includes('injected')}`)
    } finally {
      if (h) h.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  await runCase('logging: status exposes logFile and logBytes fields', async (boot) => {
    const h = await boot({})
    const status = await request(h.base, '/mesh/status')
    const ok = typeof status.json?.logFile === 'string' && status.json.logFile.length > 0 && typeof status.json?.logBytes === 'number'
    report('logging: status exposes logFile and logBytes fields', ok, `logFile=${status.json?.logFile} logBytes=${status.json?.logBytes}`)
  })

  // 83-85. Archived sessions had a UI exit until T-332 removed the local-session list; the
  // archive action and its row formatter were deleted with it, so their cases went too.

  await runCase('sessions: deleting an archived session clears its id from the archive view', async (boot) => {
    const h = await boot({
      seedSessions: [{ id: 'session-arch-del', title: 'to delete' }],
      archivedIds: ['session-arch-del'],
    })
    const before = await request(h.base, '/mesh/sessions?archived=1')
    const deleted = await request(h.base, '/mesh/sessions/delete', { method: 'POST', body: { session: 'session-arch-del' } })
    // Re-seed the same id: the host archive set still contains it, so only the local
    // tombstone can keep it out of the archived view.
    seedSession(h.sessionsRoot, { id: 'session-arch-del', title: 'to delete' })
    const afterArchived = await request(h.base, '/mesh/sessions?archived=1')
    const afterAll = await request(h.base, '/mesh/sessions')
    const listed = (afterAll.json?.sessions ?? []).find((session) => session.id === 'session-arch-del')
    const ok = before.json?.total === 1 && deleted.status === 200 && afterArchived.json?.total === 0 && listed?.archived === false
    report('sessions: deleting an archived session clears its id from the archive view', ok, `before=${before.json?.total} deleted=${deleted.status} afterArchived=${afterArchived.json?.total} listedArchived=${listed?.archived}`)
  })

  // 86-90. Receipt routing: the dispatcher (requester) gets its own receipts; receiptTo is
  // only the fallback so a second workspace no longer receives another one's receipts.
  const receiptConfig = { receiptTo: 'receipt holder', receiptMode: 'queue' }
  const receiptSeeds = [
    { id: 'session-worker', title: 'worker' },
    { id: 'session-orch', title: 'orchestrator' },
    { id: 'session-holder', title: 'receipt holder' },
  ]

  await runCase('receipt: a requester receives the receipt instead of receiptTo', async (boot) => {
    const h = await boot({ seedSessions: receiptSeeds, config: receiptConfig })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'do it', meta: { taskId: 'T-requester', requester: 'orchestrator' } },
    })
    h.emit('session/event', { id: 'session-worker' }, { type: 'turn/start', turn: 2 })
    h.emit('session/event', { id: 'session-worker' }, { type: 'turn/end', turn: 2, reason: { kind: 'completed' } })
    const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === 'session-orch'), 4000)
    const status = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/status')
      return snapshot.json?.lastReceipt?.deliveredTo === 'session-orch' ? snapshot : null
    }, 4000)
    const holderPrompts = h.state.prompts.filter((prompt) => prompt.sessionId === 'session-holder').length
    const snapshot = status ?? (await request(h.base, '/mesh/status'))
    const ok = Boolean(delivered) && holderPrompts === 0 && snapshot.json?.lastReceipt?.deliveredTo === 'session-orch'
    report('receipt: a requester receives the receipt instead of receiptTo', ok, `deliveredTo=${snapshot.json?.lastReceipt?.deliveredTo ?? '-'} holderPrompts=${holderPrompts} orchPrompts=${h.state.prompts.filter((p) => p.sessionId === 'session-orch').length}`)
  })

  await runCase('receipt: an unresolved requester falls back to receiptTo and says so', async (boot) => {
    const h = await boot({ seedSessions: receiptSeeds, config: receiptConfig })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'do it', meta: { taskId: 'T-ghost', requester: 'ghost session' } },
    })
    const pending = await request(h.base, '/mesh/status')
    h.emit('session/event', { id: 'session-worker' }, { type: 'turn/start', turn: 3 })
    h.emit('session/event', { id: 'session-worker' }, { type: 'turn/end', turn: 3, reason: { kind: 'completed' } })
    const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === 'session-holder'), 4000)
    const status = await request(h.base, '/mesh/status')
    const listed = pending.json?.pendingTaskList?.find((row) => row.taskId === 'T-ghost')
    const ok =
      Boolean(delivered) &&
      listed?.requester === 'ghost session' &&
      listed?.requesterSessionId === null &&
      /requester not resolved/.test(status.json?.lastError ?? '')
    report('receipt: an unresolved requester falls back to receiptTo and says so', ok, `deliveredTo=${status.json?.lastReceipt?.deliveredTo ?? '-'} lastError=${JSON.stringify(status.json?.lastError ?? '')}`)
  })

  await runCase('receipt: without a requester the receiptTo fallback still works', async (boot) => {
    const h = await boot({ seedSessions: receiptSeeds, config: receiptConfig })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'do it', meta: { taskId: 'T-fallback' } },
    })
    h.emit('session/event', { id: 'session-worker' }, { type: 'turn/start', turn: 4 })
    h.emit('session/event', { id: 'session-worker' }, { type: 'turn/end', turn: 4, reason: { kind: 'completed' } })
    const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === 'session-holder'), 4000)
    const status = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/status')
      return snapshot.json?.lastReceipt?.deliveredTo === 'session-holder' ? snapshot : null
    }, 4000)
    const ok = Boolean(delivered) && status.json?.lastReceipt?.deliveredTo === 'session-holder'
    report('receipt: without a requester the receiptTo fallback still works', ok, `deliveredTo=${status.json?.lastReceipt?.deliveredTo ?? '-'}`)
  })

  await runCase('receipt: batch aggregate goes to the batch requester', async (boot) => {
    const h = await boot({ seedSessions: receiptSeeds, config: receiptConfig })
    for (const target of ['worker', 'orchestrator']) {
      await request(h.base, '/mesh/inject', {
        method: 'POST',
        body: {
          title: target,
          text: `batch work on ${target}`,
          meta: { taskId: `T-batch-${target}`, batchId: 'B-requester', requester: 'orchestrator' },
        },
      })
    }
    for (const target of ['session-worker', 'session-orch']) {
      h.emit('session/event', { id: target }, { type: 'turn/start', turn: 5 })
      h.emit('session/event', { id: target }, { type: 'turn/end', turn: 5, reason: { kind: 'completed' } })
    }
    const promptHasBatch = (prompt) => (prompt.content ?? []).some((part) => /BATCH/.test(part.text ?? ''))
    const delivered = await waitFor(
      () => h.state.prompts.find((prompt) => prompt.sessionId === 'session-orch' && promptHasBatch(prompt)),
      6000,
    )
    const status = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/status')
      return snapshot.json?.lastReceipt?.deliveredTo === 'session-orch' ? snapshot : null
    }, 4000)
    const holderPrompts = h.state.prompts.filter((prompt) => prompt.sessionId === 'session-holder').length
    const ok = Boolean(delivered) && holderPrompts === 0 && status.json?.lastReceipt?.deliveredTo === 'session-orch'
    report('receipt: batch aggregate goes to the batch requester', ok, `batchPrompts=${h.state.prompts.filter(promptHasBatch).length} holderPrompts=${holderPrompts} deliveredTo=${status.json?.lastReceipt?.deliveredTo ?? '-'}`)
  })

  await runCase('receipt: the tool handler uses the caller session when the host passes it', async (boot) => {
    const h = await boot({ seedSessions: receiptSeeds, config: receiptConfig })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'worker', text: 'from a tool call', taskId: 'T-caller' }, { sessionId: 'session-orch' })
    const status = await request(h.base, '/mesh/status')
    const listed = status.json?.pendingTaskList?.find((row) => row.taskId === 'T-caller')
    const ok = listed?.requesterSessionId === 'session-orch'
    report('receipt: the tool handler uses the caller session when the host passes it', ok, `requesterSessionId=${listed?.requesterSessionId ?? '-'}`)
  })

  // 91-93. Tool registration must retry a not-yet-ready host service, and failures must be
  // visible in /mesh/status instead of vanishing into log.warn.
  await runCase('tools: registration retries until the host tools service appears', async (boot) => {
    const h = await boot({ toolsDelayCalls: 3 })
    const status = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/status')
      return snapshot.json?.tools?.dispatch === true && snapshot.json?.tools?.ask === true ? snapshot : null
    }, 8000)
    const names = h.state.tools.map((tool) => tool.name)
    const ok = Boolean(status) && names.includes('mesh_dispatch') && names.includes('mesh_ask')
    report('tools: registration retries until the host tools service appears', ok, `tools=${JSON.stringify(status?.json?.tools)} registered=${names.join(',')}`)
  })

  await runCase('tools: a permanently missing tools service is reported, not thrown', async (boot) => {
    const h = await boot({ toolsDelayCalls: 999 })
    const status = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/status')
      return snapshot.json?.tools?.dispatch === false && snapshot.json?.toolsError ? snapshot : null
    }, 8000)
    const alive = await request(h.base, '/mesh/sessions')
    const ok =
      Boolean(status) &&
      status.json?.tools?.dispatch === false &&
      status.json?.tools?.ask === false &&
      /host exposes no tools service/.test(status.json?.toolsError ?? '') &&
      alive.status === 200
    report('tools: a permanently missing tools service is reported, not thrown', ok, `tools=${JSON.stringify(status?.json?.tools)} toolsError=${JSON.stringify(status?.json?.toolsError ?? '')} health=${alive.status}`)
  })

  await runCase('tools: both tools report registered on a normal host', async (boot) => {
    const h = await boot({})
    const status = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/status')
      return snapshot.json?.tools?.dispatch === true ? snapshot : null
    }, 8000)
    const ok = status.json?.tools?.dispatch === true && status.json?.tools?.ask === true && status.json?.toolsError === null
    report('tools: both tools report registered on a normal host', ok, `tools=${JSON.stringify(status?.json?.tools)} toolsError=${JSON.stringify(status?.json?.toolsError)}`)
  })

  // 94-97. maxInlineBytes is real (safe truncation + note), and seams/limits are observable.
  await runCase('inline: a body over maxInlineBytes is truncated without U+FFFD', async () => {
    const { inlineBodyText, truncateUtf8 } = await import(pathToFileURL(ENTRY).href)
    const body = '中'.repeat(3000) // 9000 UTF-8 bytes
    const inline = inlineBodyText(body, 4096)
    const kept = inline.split('\n…（正文已截断')[0]
    const keptBytes = Buffer.byteLength(kept, 'utf8')
    const ok =
      inline !== body &&
      !inline.includes('\uFFFD') &&
      keptBytes <= 4096 &&
      /正文已截断：原文 9000 字节/.test(inline) &&
      /maxInlineBytes=4096/.test(inline) &&
      truncateUtf8('a'.repeat(4095) + '中', 4096) === 'a'.repeat(4095) &&
      !truncateUtf8('a'.repeat(4095) + '中', 4096).includes('\uFFFD')
    report('inline: a body over maxInlineBytes is truncated without U+FFFD', ok, `inputBytes=9000 keptBytes=${keptBytes} hasFFFD=${inline.includes('\uFFFD')} marker=${/原文 9000 字节/.test(inline)}`)
  })

  await runCase('inline: short bodies stay byte-identical', async () => {
    const { inlineBodyText } = await import(pathToFileURL(ENTRY).href)
    const short = 'hello 你好'
    const ok = inlineBodyText(short, 4096) === short && inlineBodyText('', 4096) === ''
    report('inline: short bodies stay byte-identical', ok, `same=${inlineBodyText(short, 4096) === short}`)
  })

  await runCase('status: limits and seams report the defaults', async (boot) => {
    const h = await boot({})
    const status = await request(h.base, '/mesh/status')
    const ok = status.json?.limits?.maxInlineBytes === 4096 && status.json?.seams?.approval === 'disabled' && status.json?.seams?.questions === 'absent'
    report('status: limits and seams report the defaults', ok, `limits=${JSON.stringify(status.json?.limits)} seams=${JSON.stringify(status.json?.seams)}`)
  })

  await runCase('status: seams report an attached approval bridge', async (boot) => {
    const h = await boot({ config: { approvalBridge: { enabled: true, to: 'peer-owner', allowFrom: ['peer-owner'] } } })
    const status = await request(h.base, '/mesh/status')
    const ok = status.json?.seams?.approval === 'attached' && status.json?.seams?.questions === 'absent'
    report('status: seams report an attached approval bridge', ok, `seams=${JSON.stringify(status.json?.seams)}`)
  })

  // 98-99. T-220: two tasks injected while the same turn runs must not share one receipt.
  await runCase('receipt: a second task injected in the same turn waits for its own turn', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-same-turn', title: 'same turn target' }] })
    h.emit('session/event', { id: 'session-same-turn' }, { type: 'turn/start', turn: 41 })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'same turn target', text: 'task A', meta: { taskId: 'T-same-A' } },
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'same turn target', text: 'task B', meta: { taskId: 'T-same-B' } },
    })
    const pending = await request(h.base, '/mesh/status')
    const rows = pending.json?.pendingTaskList ?? []
    const rowA = rows.find((row) => row.taskId === 'T-same-A')
    const rowB = rows.find((row) => row.taskId === 'T-same-B')
    h.emit('session/event', { id: 'session-same-turn' }, { type: 'assistant/message', turn: 42, message: { content: [{ type: 'text', text: 'turn 42 did task A' }] } })
    h.emit('session/event', { id: 'session-same-turn' }, { type: 'turn/end', turn: 42, reason: { kind: 'completed' } })
    const settledA = await waitFor(() => readReceipts(h.receiptsPath).find((receipt) => receipt.taskId === 'T-same-A'), 4000)
    await sleep(300)
    const afterFirst = await request(h.base, '/mesh/status')
    const bAfterFirst = readReceipts(h.receiptsPath).find((receipt) => receipt.taskId === 'T-same-B')
    const stillPending = (afterFirst.json?.pendingTaskList ?? []).find((row) => row.taskId === 'T-same-B')
    h.emit('session/event', { id: 'session-same-turn' }, { type: 'turn/start', turn: 43 })
    h.emit('session/event', { id: 'session-same-turn' }, { type: 'assistant/message', turn: 43, message: { content: [{ type: 'text', text: 'turn 43 did task B' }] } })
    h.emit('session/event', { id: 'session-same-turn' }, { type: 'turn/end', turn: 43, reason: { kind: 'completed' } })
    const settledB = await waitFor(() => readReceipts(h.receiptsPath).find((receipt) => receipt.taskId === 'T-same-B'), 4000)
    const ok =
      rowA?.injectedAtTurn === 41 &&
      rowA?.sameTurnInjected === false &&
      rowA?.baselineTurn === 41 &&
      rowB?.injectedAtTurn === 41 &&
      rowB?.sameTurnInjected === true &&
      rowB?.baselineTurn === 42 &&
      settledA?.turn === 42 &&
      bAfterFirst === undefined &&
      stillPending?.injectedAtTurn === 41 &&
      settledB?.turn === 43
    report('receipt: a second task injected in the same turn waits for its own turn', ok, `A(turn=${settledA?.turn ?? '-'} baseline=41) B-after-42=${bAfterFirst ? 'SETTLED' : 'pending'} B-final-turn=${settledB?.turn ?? '-'} pendingB=${stillPending?.taskId ?? '-'}`)
  })

  await runCase('receipt: a task injected between turns settles on the next turn', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-between', title: 'between turns' }] })
    h.emit('session/event', { id: 'session-between' }, { type: 'turn/start', turn: 5 })
    h.emit('session/event', { id: 'session-between' }, { type: 'turn/end', turn: 5, reason: { kind: 'completed' } })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'between turns', text: 'after the turn', meta: { taskId: 'T-between' } },
    })
    const pending = await request(h.base, '/mesh/status')
    const row = (pending.json?.pendingTaskList ?? []).find((entry) => entry.taskId === 'T-between')
    h.emit('session/event', { id: 'session-between' }, { type: 'turn/start', turn: 6 })
    h.emit('session/event', { id: 'session-between' }, { type: 'turn/end', turn: 6, reason: { kind: 'completed' } })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((entry) => entry.taskId === 'T-between'), 4000)
    const ok = row?.injectedAtTurn === null && row?.sameTurnInjected === false && row?.baselineTurn === 5 && receipt?.turn === 6
    report('receipt: a task injected between turns settles on the next turn', ok, `injectedAtTurn=${row?.injectedAtTurn ?? '-'} baseline=${row?.baselineTurn ?? '-'} settledTurn=${receipt?.turn ?? '-'}`)
  })

  // 100-102. Injections carry a one-line [TASK …] header; the body itself stays verbatim.
  const promptText = (prompt) => (prompt.content ?? []).map((part) => part.text ?? '').join('')

  await runCase('inject: a [TASK …] header names the task and keeps the body verbatim', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-hdr', title: 'header target' }] })
    const original = '第一行原文\n第二行原文 与 ≤64 KiB 无关'
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: {
        title: 'header target',
        text: original,
        meta: { taskId: 'T-hdr', batchId: 'B-hdr' },
        requester: 'worker',
      },
    })
    const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === 'session-hdr'), 4000)
    const text = promptText(delivered ?? {})
    const header = '[TASK T-hdr · THREAD - · BATCH B-hdr · FROM worker] '
    const ok =
      text.startsWith(header) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}\n\n/.test(text.slice(header.length)) &&
      text.endsWith(original) &&
      text.slice(text.length - original.length) === original
    report('inject: a [TASK …] header names the task and keeps the body verbatim', ok, `firstLine=${JSON.stringify(text.split('\n')[0])} verbatim=${text.endsWith(original)}`)
  })

  await runCase('inject: injectHeader=false delivers the body byte-identically', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-nohdr', title: 'no header' }], config: { injectHeader: false } })
    const original = '逐字原文\n第二行也不变'
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'no header', text: original, meta: { taskId: 'T-nohdr', batchId: 'B-nohdr' } },
    })
    const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === 'session-nohdr'), 4000)
    const text = promptText(delivered ?? {})
    const ok = text === original
    report('inject: injectHeader=false delivers the body byte-identically', ok, `identical=${text === original} head=${JSON.stringify(text.slice(0, 30))}`)
  })

  await runCase('inject: batch members share BATCH but get their own TASK header', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-batchhdr', title: 'batch header' }] })
    for (const taskId of ['T-batch-1', 'T-batch-2']) {
      await request(h.base, '/mesh/inject', {
        method: 'POST',
        body: { title: 'batch header', text: `body of ${taskId}`, meta: { taskId, batchId: 'B-shared' } },
      })
    }
    await waitFor(() => h.state.prompts.filter((prompt) => prompt.sessionId === 'session-batchhdr').length === 2, 4000)
    const lines = h.state.prompts
      .filter((prompt) => prompt.sessionId === 'session-batchhdr')
      .map((prompt) => promptText(prompt).split('\n')[0])
    const ok = lines.length === 2 && /^\[TASK T-batch-1 · THREAD - · BATCH B-shared · FROM unknown\]/.test(lines[0]) && /^\[TASK T-batch-2 · THREAD - · BATCH B-shared · FROM unknown\]/.test(lines[1])
    report('inject: batch members share BATCH but get their own TASK header', ok, `headers=${JSON.stringify(lines)}`)
  })

  // 103-108. Layer-1 task registry: persistence, settlement, cancellation, long bodies,
  // retention compaction, filters/pagination.
  const seededTask = (taskId, patch = {}) => ({
    taskId,
    batchId: null,
    requester: null,
    targetSessionId: 'session-seed',
    targetTitle: 'seed target',
    subject: `subject of ${taskId}`,
    textBytes: 10,
    createdAt: Date.now() - 60 * 1000,
    deadlineMs: null,
    status: 'pending',
    settledAt: null,
    durationMs: null,
    receiptRef: null,
    refs: [],
    text: 'body',
    ...patch,
  })

  await runCase('tasks: a dispatched task is listed as pending with a subject', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-taskreg', title: 'task target' }] })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'task target', text: '第一行摘要行\n第二行细节', meta: { taskId: 'T-reg-1', batchId: 'B-reg' } },
    })
    const listed = await request(h.base, '/mesh/tasks')
    const row = (listed.json?.tasks ?? []).find((task) => task.taskId === 'T-reg-1')
    const ok =
      listed.json?.total === 1 &&
      row?.status === 'pending' &&
      row?.subject === '第一行摘要行' &&
      row?.targetSessionId === 'session-taskreg' &&
      row?.batchId === 'B-reg' &&
      row?.text === undefined &&
      typeof row?.textRef === 'string' &&
      row?.hasTextFile === true
    report('tasks: a dispatched task is listed as pending with a subject', ok, `total=${listed.json?.total} status=${row?.status ?? '-'} subject=${JSON.stringify(row?.subject ?? '')} hasBodyInList=${row?.text !== undefined}`)
  })

  await runCase('tasks: settlement records settledAt, durationMs and the receipt summary', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-tasksettle', title: 'settle target' }] })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'settle target', text: 'settle me', meta: { taskId: 'T-reg-2' } },
    })
    h.emit('session/event', { id: 'session-tasksettle' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-tasksettle' }, { type: 'assistant/message', turn: 1, message: { content: [{ type: 'text', text: 'done body' }] } })
    h.emit('session/event', { id: 'session-tasksettle' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const detail = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-reg-2')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const task = detail?.json?.task ?? {}
    const ok = task.status === 'settled' && Number.isFinite(task.settledAt) && task.settledAt > 0 && Number.isFinite(task.durationMs) && task.durationMs >= 0 && task.receiptRef !== null
    report('tasks: settlement records settledAt, durationMs and the receipt summary', ok, `status=${task.status ?? '-'} settledAt=${task.settledAt ?? '-'} durationMs=${task.durationMs ?? '-'} summary=${JSON.stringify(task.receiptSummary ?? '')}`)
  })

  await runCase('tasks: DELETE cancels a pending task but refuses a settled one', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-taskdel', title: 'delete target' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'delete target', text: 'cancel me', meta: { taskId: 'T-reg-cancel' } } })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'delete target', text: 'keep me', meta: { taskId: 'T-reg-keep' } } })
    const cancelled = await request(h.base, '/mesh/tasks/T-reg-cancel', { method: 'DELETE' })
    const cancelledDetail = await request(h.base, '/mesh/tasks/T-reg-cancel')
    h.emit('session/event', { id: 'session-taskdel' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-taskdel' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-reg-keep')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const refused = await request(h.base, '/mesh/tasks/T-reg-keep', { method: 'DELETE' })
    const ok = cancelled.status === 200 && cancelledDetail.json?.task?.status === 'cancelled' && refused.status === 409 && refused.json?.ok === false
    report('tasks: DELETE cancels a pending task but refuses a settled one', ok, `cancel=${cancelled.status} status=${cancelledDetail.json?.task?.status ?? '-'} settledDelete=${refused.status}`)
  })

  await runCase('tasks: a body over 8 KiB goes to tasks/<id>.md and is returned by the detail API', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-taskbig', title: 'big target' }] })
    const big = '长'.repeat(3000) // 9000 UTF-8 bytes
    await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'big target', text: big, meta: { taskId: 'T-reg-big' } } })
    const listed = await request(h.base, '/mesh/tasks')
    const row = (listed.json?.tasks ?? []).find((task) => task.taskId === 'T-reg-big')
    const detail = await request(h.base, '/mesh/tasks/T-reg-big')
    const ok = row?.hasTextFile === true && row?.text === undefined && detail.json?.task?.text === big && detail.json?.task?.textBytes === 9000
    report('tasks: a body over 8 KiB goes to tasks/<id>.md and is returned by the detail API', ok, `hasTextFile=${row?.hasTextFile} textBytes=${detail.json?.task?.textBytes ?? '-'} exactBody=${detail.json?.task?.text === big}`)
  })

  await runCase('tasks: retention drops rows older than tasksRetentionDays at startup', async (boot) => {
    const now = Date.now()
    const h = await boot({
      tasksSeed: [
        seededTask('T-old', { createdAt: now - 40 * 24 * 60 * 60 * 1000, status: 'settled', settledAt: now - 40 * 24 * 60 * 60 * 1000 }),
        seededTask('T-fresh', { createdAt: now - 60 * 1000 }),
      ],
    })
    const listed = await request(h.base, '/mesh/tasks')
    const ids = (listed.json?.tasks ?? []).map((task) => task.taskId)
    const ok = listed.json?.total === 1 && ids.includes('T-fresh') && !ids.includes('T-old')
    report('tasks: retention drops rows older than tasksRetentionDays at startup', ok, `total=${listed.json?.total} ids=${ids.join(',')}`)
  })

  await runCase('tasks: list filters by status/session and pages with total', async (boot) => {
    const now = Date.now()
    const h = await boot({
      tasksSeed: [
        // A pre-existing 'lost' row (not pending/started) must survive startup reconciliation.
        seededTask('T-a', { status: 'lost', targetSessionId: 'session-a', createdAt: now - 3000, settledAt: now - 2500 }),
        seededTask('T-b', { status: 'settled', targetSessionId: 'session-b', createdAt: now - 2000, settledAt: now - 1000, durationMs: 1000 }),
        seededTask('T-c', { status: 'settled', targetSessionId: 'session-b', createdAt: now - 1000, settledAt: now - 500, durationMs: 500 }),
      ],
    })
    const byStatus = await request(h.base, '/mesh/tasks?status=lost')
    const bySession = await request(h.base, '/mesh/tasks?session=session-b')
    const page = await request(h.base, '/mesh/tasks?limit=1&offset=1')
    const ok =
      byStatus.json?.total === 1 &&
      byStatus.json?.tasks?.[0]?.taskId === 'T-a' &&
      bySession.json?.total === 2 &&
      page.json?.total === 3 &&
      page.json?.limit === 1 &&
      page.json?.offset === 1 &&
      page.json?.tasks?.length === 1 &&
      page.json?.tasks?.[0]?.taskId === 'T-b'
    report('tasks: list filters by status/session and pages with total', ok, `pending=${byStatus.json?.total} sessionB=${bySession.json?.total} pageTotal=${page.json?.total} pageId=${page.json?.tasks?.[0]?.taskId ?? '-'}`)
  })

  await runCase('tasks: a task whose turn never starts becomes stalled', async (boot) => {
    const h = await boot({
      seedSessions: [{ id: 'session-stall', title: 'stall target' }],
      config: { receiptStallMs: 1000 },
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'stall target', text: 'never starts', meta: { taskId: 'T-reg-stall' } },
    })
    const detail = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-reg-stall')
      return snapshot.json?.task?.status === 'stalled' ? snapshot : null
    }, 6000)
    const receipt = readReceipts(h.receiptsPath).find((entry) => entry.taskId === 'T-reg-stall')
    const task = detail?.json?.task ?? {}
    const ok = task.status === 'stalled' && receipt?.status === 'not-started' && Number.isFinite(task.settledAt)
    report('tasks: a task whose turn never starts becomes stalled', ok, `status=${task.status ?? '-'} receipt=${receipt?.status ?? '-'} settledAt=${task.settledAt ?? '-'}`)
  })

  // 110-112. Task state machine: pending -> started -> settled, and the no-start race.
  await runCase('tasks: turn/start marks a pending task as started', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-started', title: 'start target' }] })
    h.emit('session/event', { id: 'session-started' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-started' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'start target', text: 'run me', meta: { taskId: 'T-started' } },
    })
    const pending = await request(h.base, '/mesh/tasks/T-started')
    h.emit('session/event', { id: 'session-started' }, { type: 'turn/start', turn: 2 })
    const started = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-started')
      return snapshot.json?.task?.status === 'started' ? snapshot : null
    }, 4000)
    const task = started?.json?.task ?? {}
    const ok = pending.json?.task?.status === 'pending' && task.status === 'started' && Number.isFinite(task.startedAt) && task.startedAt > 0
    report('tasks: turn/start marks a pending task as started', ok, `before=${pending.json?.task?.status ?? '-'} after=${task.status ?? '-'} startedAt=${task.startedAt ?? '-'}`)
  })

  await runCase('tasks: a started task settles with durationMs measured from startedAt', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-startdur', title: 'duration target' }] })
    h.emit('session/event', { id: 'session-startdur' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-startdur' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'duration target', text: 'time me', meta: { taskId: 'T-startdur' } },
    })
    h.emit('session/event', { id: 'session-startdur' }, { type: 'turn/start', turn: 2 })
    await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-startdur')
      return snapshot.json?.task?.status === 'started' ? snapshot : null
    }, 4000)
    h.emit('session/event', { id: 'session-startdur' }, { type: 'turn/end', turn: 2, reason: { kind: 'completed' } })
    const settled = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-startdur')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const task = settled?.json?.task ?? {}
    const ok =
      task.status === 'settled' &&
      Number.isFinite(task.startedAt) &&
      Number.isFinite(task.settledAt) &&
      task.durationMs === task.settledAt - task.startedAt
    report('tasks: a started task settles with durationMs measured from startedAt', ok, `startedAt=${task.startedAt ?? '-'} settledAt=${task.settledAt ?? '-'} durationMs=${task.durationMs ?? '-'} equalsDelta=${task.durationMs === task.settledAt - task.startedAt}`)
  })

  await runCase('tasks: turn/end without a start settles without inventing startedAt', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-nostart', title: 'race target' }] })
    h.emit('session/event', { id: 'session-nostart' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-nostart' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'race target', text: 'race me', meta: { taskId: 'T-nostart' } },
    })
    h.emit('session/event', { id: 'session-nostart' }, { type: 'turn/end', turn: 2, reason: { kind: 'completed' } })
    const settled = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-nostart')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const task = settled?.json?.task ?? {}
    const alive = await request(h.base, '/mesh/status')
    const ok =
      task.status === 'settled' &&
      task.startedAt === null &&
      Number.isFinite(task.durationMs) &&
      task.durationMs >= 0 &&
      alive.status === 200
    report('tasks: turn/end without a start settles without inventing startedAt', ok, `status=${task.status ?? '-'} startedAt=${task.startedAt === null ? 'null' : task.startedAt} durationMs=${task.durationMs ?? '-'} alive=${alive.status}`)
  })

  // 113-117. Readable task titles: explicit meta.subject wins; inferred subjects are cleaned.
  await runCase('tasks: the subject cleaner prefers the emphasised title and drops wrappers', async () => {
    const { cleanTaskSubject } = await import(pathToFileURL(ENTRY).href)
    const sample = '任务（协调会话，**设置页第 1 步：信息架构 + 让它真能改**）：把设置页按功能章节聚合，并把现有可写项做成可编辑控件。'
    const cleaned = cleanTaskSubject(sample)
    const plain = cleanTaskSubject('修复 waker 的 mesh_ask 超时')
    const ok = cleaned === '设置页第 1 步：信息架构 + 让它真能改' && plain === '修复 waker 的 mesh_ask 超时'
    report('tasks: the subject cleaner prefers the emphasised title and drops wrappers', ok, `cleaned=${JSON.stringify(cleaned)} plain=${JSON.stringify(plain)}`)
  })

  await runCase('tasks: the subject cleaner strips markdown and falls back to later lines', async () => {
    const { cleanTaskSubject } = await import(pathToFileURL(ENTRY).href)
    const marked = cleanTaskSubject('**修复** 回执路由')
    const fallback = cleanTaskSubject('\n\n---\n第二行才是标题')
    const empty = cleanTaskSubject('***\n---')
    const ok = marked === '修复 回执路由' && fallback === '第二行才是标题' && empty === ''
    report('tasks: the subject cleaner strips markdown and falls back to later lines', ok, `marked=${JSON.stringify(marked)} fallback=${JSON.stringify(fallback)} empty=${JSON.stringify(empty)}`)
  })

  await runCase('tasks: an explicit subject wins, is trimmed and capped at 120 chars', async () => {
    const { resolveTaskSubject } = await import(pathToFileURL(ENTRY).href)
    const explicit = resolveTaskSubject('  我的标题  ', '正文第一行不应生效')
    const long = resolveTaskSubject('长'.repeat(200), 'x')
    const ok = explicit === '我的标题' && Array.from(long).length === 120
    report('tasks: an explicit subject wins, is trimmed and capped at 120 chars', ok, `explicit=${JSON.stringify(explicit)} longLen=${Array.from(long).length}`)
  })

  await runCase('tasks: meta.subject is stored and listed as the task subject', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-subject', title: 'subject target' }] })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: {
        title: 'subject target',
        text: '任务（协调会话，**正文里的假标题**）：正文说明',
        meta: { taskId: 'T-subject-explicit', subject: '  真正可读的任务标题  ' },
      },
    })
    const listed = await request(h.base, '/mesh/tasks')
    const row = (listed.json?.tasks ?? []).find((task) => task.taskId === 'T-subject-explicit')
    const ok = row?.subject === '真正可读的任务标题'
    report('tasks: meta.subject is stored and listed as the task subject', ok, `subject=${JSON.stringify(row?.subject ?? '')}`)
  })

  await runCase('tasks: without meta.subject the stored subject is the cleaned first line', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-subject2', title: 'subject target 2' }] })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: {
        title: 'subject target 2',
        text: '任务（协调会话，**清理后的标题**）：正文说明\n第二行细节',
        meta: { taskId: 'T-subject-inferred' },
      },
    })
    const listed = await request(h.base, '/mesh/tasks')
    const row = (listed.json?.tasks ?? []).find((task) => task.taskId === 'T-subject-inferred')
    const ok = row?.subject === '清理后的标题'
    report('tasks: without meta.subject the stored subject is the cleaned first line', ok, `subject=${JSON.stringify(row?.subject ?? '')}`)
  })

  // 118-120. Task panel pure helpers: duration/stamp formatting and batch grouping.
  await runCase('client: formatDuration renders human durations', async () => {
    const helpers = loadClientHelpers()
    const samples = {
      '340': helpers.formatDuration(340),
      '728962': helpers.formatDuration(728962),
      '3700000': helpers.formatDuration(3700000),
      'null': helpers.formatDuration(null),
      '12000': helpers.formatDuration(12000),
    }
    const ok =
      samples['340'] === '340毫秒' &&
      samples['728962'] === '12分09秒' &&
      samples['3700000'] === '1小时01分' &&
      samples['null'] === '-' &&
      samples['12000'] === '12.0秒'
    report('client: formatDuration renders human durations', ok, `samples=${JSON.stringify(samples)}`)
  })

  await runCase('client: formatStamp renders local MM-DD HH:mm:ss', async () => {
    const helpers = loadClientHelpers()
    const stamp = helpers.formatStamp('2026-10-31T20:07:16+08:00')
    const invalid = helpers.formatStamp('not a date')
    const ok = /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp) && invalid === '-'
    report('client: formatStamp renders local MM-DD HH:mm:ss', ok, `stamp=${stamp} invalid=${JSON.stringify(invalid)}`)
  })

  await runCase('client: groupTasksByBatch groups by batch, keeps ungrouped last and sorts inside', async () => {
    const helpers = loadClientHelpers()
    const tasks = [
      { taskId: 'T-u1', batchId: null, createdAt: 10, status: 'pending', durationMs: null },
      { taskId: 'T-b2', batchId: 'B-late', createdAt: 30, status: 'settled', durationMs: 2000 },
      { taskId: 'T-b1', batchId: 'B-late', createdAt: 20, status: 'settled', durationMs: 1000 },
      { taskId: 'T-a1', batchId: 'B-early', createdAt: 40, status: 'started', durationMs: null },
    ]
    const groups = helpers.groupTasksByBatch(tasks)
    const late = groups.find((group) => group.batchId === 'B-late')
    const ungrouped = groups[groups.length - 1]
    const ok =
      groups.length === 3 &&
      late.tasks.map((task) => task.taskId).join(',') === 'T-b1,T-b2' &&
      late.done === 2 &&
      late.total === 2 &&
      late.durationMs === 3000 &&
      late.label === 'B-late' &&
      ungrouped.batchId === null &&
      ungrouped.label === '未分组' &&
      ungrouped.tasks[0].taskId === 'T-u1'
    report('client: groupTasksByBatch groups by batch, keeps ungrouped last and sorts inside', ok, `groups=${groups.map((group) => group.label + ':' + group.total).join(',')} lateDuration=${late?.durationMs}`)
  })

  await runCase('client: the plugin declares uiWorkspace so the open-session button can navigate', async () => {
    const source = fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'client.js'), 'utf8')
    const ok = /inject:\s*\[[^\]]*'uiWorkspace'/.test(source) && source.includes("hostCtx?.uiWorkspace") && source.includes('复制任务标记')
    report('client: the plugin declares uiWorkspace so the open-session button can navigate', ok, `declared=${/inject:\s*\[[^\]]*'uiWorkspace'/.test(source)} handler=${source.includes('hostCtx?.uiWorkspace')}`)
  })

  await runCase('client: package.json injects the ui-workspace client package', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'package.json'), 'utf8'))
    const inject = pkg?.dsh?.client?.inject ?? []
    const ok = inject.includes('@deepseek-ai/dsh-client-ui-workspace') && inject.includes('@deepseek-ai/dsh-client-ui-settings-plugins')
    report('client: package.json injects the ui-workspace client package', ok, `inject=${inject.join(',')}`)
  })

  // T-340: the owner removed the "jump to the task panel" affordances — the sidebar tabs are
  // the only entry now, so no UI code may call layout.selectPanel.
  await runCase('client: the sidebar never jumps away through layout.selectPanel', async () => {
    const source = fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'client.js'), 'utf8')
    const ok =
      !/requestTasksPanel\(/.test(source) &&
      !/selectPanel\('mesh-inbox'\)/.test(source) &&
      /function MeshTasksPanel\(\)/.test(source) &&
      /const bindHere = /.test(source) &&
      /const openAllMail = /.test(source)
    report('client: the sidebar never jumps away through layout.selectPanel', ok, `requests=${/requestTasksPanel\(/.test(source)} selectPanel=${/selectPanel\('mesh-inbox'\)/.test(source)}`)
  })

  // T-341: conversation and task lists share one row component; rows must not grow a
  // permanent border again (that is what made every entry look like a card).
  await runCase('client: list rows share one component without a permanent border', async () => {
    const source = fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'client.js'), 'utf8')
    const rowUses = (source.match(/ui\.listRow\(/g) ?? []).length
    const ok =
      /listRow\(\{ title, meta, selected = false/.test(source) &&
      rowUses >= 3 &&
      !/borderBottom: '1px solid rgba\(127,127,127,0\.14\)'/.test(source) &&
      !/pickerRowStyle/.test(source)
    report('client: list rows share one component without a permanent border', ok, `rowUses=${rowUses} pickerStyle=${/pickerRowStyle/.test(source)}`)
  })

  await runCase('client: a second right-side tab embeds the task list', async () => {
    const source = fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'client.js'), 'utf8')
    const ok =
      /id: 'mesh-tasks'/.test(source) &&
      /kind: 'mesh-tasks'/.test(source) &&
      /title: \(\) => '派活任务'/.test(source) &&
      /function MeshTasksPanel\(\)/.test(source) &&
      /async function fetchTaskRows\(/.test(source) &&
      // the sidebar tab must not jump: its panel never calls selectPanel
      !/function MeshTasksPanel[\s\S]{0,4000}?selectPanel\(/.test(source)
    report('client: a second right-side tab embeds the task list', ok, `tab=${/id: 'mesh-tasks'/.test(source)} sharedFetch=${/async function fetchTaskRows\(/.test(source)}`)
  })

  // T-337: the left/right switches used to be crossed — registerRight() also pushed a
  // `sidebar.panellist` (left) registration into rightDisposers, so toggling the right switch
  // changed the LEFT sidebar. This drives real apply() in a VM and counts per-slot registrations.
  await runCase('client: the right switch never touches left-sidebar registrations', async () => {
    const source = fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'client.js'), 'utf8')
    const runApply = async (statusConfig) => {
      let definition = null
      const registrations = []
      const noop = () => {}
      const fakeReact = {
        createElement: () => null,
        useState: (value) => [typeof value === 'function' ? value() : value, noop],
        useEffect: noop,
        useCallback: (fn) => fn,
        useRef: () => ({ current: null }),
        useMemo: (fn) => fn(),
      }
      const slots = {
        register(def) {
          const entry = { slot: def.name, id: def.id ?? def.key ?? '', disposed: false }
          registrations.push(entry)
          return () => {
            entry.disposed = true
          }
        },
        inject(name, cb) {
          const disposeInner = cb()
          return () => {
            if (typeof disposeInner === 'function') disposeInner()
          }
        },
      }
      const sandbox = {
        console: { info: noop, warn: noop, log: noop },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: noop,
        fetch: async () => ({ ok: true, json: async () => ({ ok: true, config: statusConfig }) }),
        navigator: { clipboard: { writeText: async () => {} } },
        window: {
          __ModuleLoader__: {
            load: (value) => {
              definition = value
            },
          },
          __DSH_BOOT__: { entries: [{ id: 'dsh-mesh-waker', url: 'http://host/client.js' }] },
          document: { currentScript: { src: 'http://host/client.js' } },
          addEventListener: noop,
          removeEventListener: noop,
          requestAnimationFrame: () => 0,
          cancelAnimationFrame: noop,
        },
        document: { currentScript: null, addEventListener: noop, removeEventListener: noop },
      }
      sandbox.globalThis = sandbox
      vm.runInNewContext(source, sandbox, { filename: 'client.js' })
      const module = definition.factory((name) => {
        if (name === 'react') return fakeReact
        throw new Error('unknown module ' + name)
      })
      const ctx = {
        slots,
        inject: (deps, cb) => {
          cb({ get: (name) => (name === 'sidebarRightTabs' ? { register: () => noop } : undefined) })
          return noop
        },
        effect: () => noop,
      }
      module.apply(ctx)
      await new Promise((resolve) => setTimeout(resolve, 40))
      return (slot) => registrations.filter((entry) => entry.slot === slot && !entry.disposed).length
    }

    const both = await runApply({ sidebarLeft: true, sidebarRight: true })
    const rightOff = await runApply({ sidebarLeft: true, sidebarRight: false })
    const leftOff = await runApply({ sidebarLeft: false, sidebarRight: true })
    const ok =
      both('sidebar.panellist') === 1 &&
      both('sidebar.right.pane.tab') === 2 &&
      rightOff('sidebar.panellist') === 1 &&
      rightOff('sidebar.right.pane.tab') === 0 &&
      leftOff('sidebar.panellist') === 0 &&
      leftOff('sidebar.right.pane.tab') === 2
    report(
      'client: the right switch never touches left-sidebar registrations',
      ok,
      `both=${both('sidebar.panellist')}/${both('sidebar.right.pane.tab')} rightOff=${rightOff('sidebar.panellist')}/${rightOff('sidebar.right.pane.tab')} leftOff=${leftOff('sidebar.panellist')}/${leftOff('sidebar.right.pane.tab')} (panellist/rightTab)`,
    )
  })

  // 124-125. Host schema subset guard (T-236): type arrays silently block registration.
  await runCase('tools: both output schemas pass the host JSON Schema subset', async () => {
    const { DISPATCH_OUTPUT, ASK_OUTPUT, THREAD_OUTPUT, COMPLETE_OUTPUT, CANCEL_OUTPUT, validateToolSchema } = await import(pathToFileURL(ENTRY).href)
    const dispatch = validateToolSchema(DISPATCH_OUTPUT)
    const ask = validateToolSchema(ASK_OUTPUT)
    const thread = validateToolSchema(THREAD_OUTPUT)
    const complete = validateToolSchema(COMPLETE_OUTPUT)
    const cancel = validateToolSchema(CANCEL_OUTPUT)
    const schemas = { dispatch: dispatch.ok, ask: ask.ok, thread: thread.ok, complete: complete.ok, cancel: cancel.ok }
    const ok = Object.values(schemas).every(Boolean)
    report(
      'tools: both output schemas pass the host JSON Schema subset',
      ok,
      `dispatch=${dispatch.ok ? 'ok' : dispatch.issues.join('; ')} ask=${ask.ok ? 'ok' : ask.issues.join('; ')} thread=${thread.ok ? 'ok' : thread.issues.join('; ')} complete=${complete.ok ? 'ok' : complete.issues.join('; ')} cancel=${cancel.ok ? 'ok' : cancel.issues.join('; ')}`,
    )
  })

  // T-408: the host validates a tool's returned value against its output schema. A null under
  // `type: string` throws ToolOutputError *after* the side effect (the turn already stopped).
  const validateHostSubset = (schema, value) => {
    const issues = []
    const walk = (node, val, at) => {
      if (!node || typeof node !== 'object') return
      if (node.oneOf) {
        let matched = false
        for (const child of node.oneOf) {
          const mark = issues.length
          walk(child, val, at)
          const branchIssues = issues.length - mark
          issues.length = mark
          if (branchIssues === 0) {
            matched = true
            break
          }
        }
        if (!matched) issues.push(`${at} matches no oneOf branch`)
        return
      }
      if (node.type === 'object') {
        if (!val || typeof val !== 'object' || Array.isArray(val)) {
          issues.push(`${at} must be object`)
          return
        }
        for (const key of node.required ?? []) if (!(key in val)) issues.push(`${at}.${key} is required`)
        for (const [key, child] of Object.entries(node.properties ?? {})) if (key in val) walk(child, val[key], `${at}.${key}`)
        return
      }
      if (node.type === 'array') {
        if (!Array.isArray(val)) issues.push(`${at} must be array`)
        else if (node.items) val.forEach((item, index) => walk(node.items, item, `${at}[${index}]`))
        return
      }
      if (node.type === 'string' && typeof val !== 'string') issues.push(`${at} must be string`)
      if (node.type === 'number' && typeof val !== 'number') issues.push(`${at} must be number`)
      if (node.type === 'boolean' && typeof val !== 'boolean') issues.push(`${at} must be boolean`)
      if (node.type === 'null' && val !== null) issues.push(`${at} must be null`)
    }
    walk(schema, value, 'value')
    return issues
  }

  await runCase('tools: runtime outputs satisfy their declared schemas (no null under string)', async (boot) => {
    const h = await boot({ config: { cancelWaitMs: 150 }, seedSessions: [{ id: 'session-out-a', title: 'out a' }, { id: 'session-out-b', title: 'out b' }] })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const { DISPATCH_OUTPUT, CANCEL_OUTPUT } = await import(pathToFileURL(ENTRY).href)
    const dispatchTool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    const dispatch = await dispatchTool.execute({ target: 'session-out-a', text: 'no task id' }, { sessionId: 'session-out-b' })
    h.emit('session/event', { id: 'session-out-b' }, { type: 'turn/start', turn: 1 })
    const cancelTool = h.state.tools.find((entry) => entry.name === 'mesh_cancel')
    const cancelled = await cancelTool.execute({ session: 'session-out-b' }, { sessionId: 'session-out-a' })
    const dispatchIssues = validateHostSubset(DISPATCH_OUTPUT.schema, dispatch)
    const cancelIssues = validateHostSubset(CANCEL_OUTPUT.schema, cancelled)
    const ok =
      dispatchIssues.length === 0 &&
      cancelIssues.length === 0 &&
      (cancelled.taskId === undefined || typeof cancelled.taskId === 'string') &&
      (cancelled.taskStatus === undefined || typeof cancelled.taskStatus === 'string')
    report('tools: runtime outputs satisfy their declared schemas (no null under string)', ok, `dispatchIssues=${dispatchIssues.length} cancelIssues=${cancelIssues.length} cancelTaskId=${typeof cancelled.taskId} cancelTaskStatus=${typeof cancelled.taskStatus}`)
  })

  await runCase('tools: validateToolSchema rejects a type array with the host wording', async () => {
    const { validateToolSchema } = await import(pathToFileURL(ENTRY).href)
    const bad = {
      schema: {
        type: 'object',
        properties: {
          title: { type: ['string', 'null'] },
          extra: { anyOf: [{ type: 'string' }] },
        },
      },
    }
    const result = validateToolSchema(bad)
    const text = result.issues.join('; ')
    const ok =
      result.ok === false &&
      /type arrays are not supported/.test(text) &&
      /anyOf is not supported/.test(text)
    report('tools: validateToolSchema rejects a type array with the host wording', ok, `ok=${result.ok} issues=${JSON.stringify(result.issues)}`)
  })

  // 126-130. Thread identity (0.7.21): follow-ups resolve their target from the binding.
  const threadSeeds = [{ id: 'session-ops', title: 'mesh · ops' }, { id: 'session-other', title: 'mesh · other' }]
  const readTaskRows = (h) => {
    const home = path.join(h.home, '.dsh', 'mesh-waker')
    const files = []
    const add = (file) => {
      if (fs.existsSync(file)) files.push(file)
    }
    add(path.join(home, 'tasks.jsonl'))
    add(path.join(home, 'local', 'tasks.jsonl'))
    try {
      for (const name of fs.readdirSync(path.join(home, 'ws'))) add(path.join(home, 'ws', name, 'tasks.jsonl'))
    } catch {
      /* no ws dir yet */
    }
    return files.flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line)),
    )
  }
  const readThreadsFile = (h) => JSON.parse(fs.readFileSync(path.join(h.home, '.dsh', 'mesh-waker', 'threads.json'), 'utf8'))
  // The default log target rotates at 2 MiB and the suite writes more than that, so these
  // cases pin their own logFile and read the rotated copy together with the current one.
  const threadLog = (file) => {
    let text = ''
    try {
      text += fs.readFileSync(`${file}.1`, 'utf8')
    } catch {
      /* no rotation yet */
    }
    return text + fs.readFileSync(file, 'utf8')
  }

  await runCase('threads: a follow-up without target resolves from the thread binding', async (boot) => {
    const threadLogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-thread-log-')), 'waker.log')
    const h = await boot({ seedSessions: threadSeeds, config: { logFile: threadLogFile } })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'mesh · ops', text: 'thread first task', thread: 'TH-1', taskId: 'T-TH-1' }, { sessionId: 'session-coord' })
    await tool.execute({ thread: 'TH-1', text: 'thread follow-up', taskId: 'T-TH-2' }, { sessionId: 'session-coord' })
    const prompts = h.state.prompts.filter((prompt) => prompt.sessionId === 'session-ops')
    const rows = readTaskRows(h)
    const first = rows.find((row) => row.taskId === 'T-TH-1')
    const second = rows.find((row) => row.taskId === 'T-TH-2')
    const log = threadLog(threadLogFile)
    const ok =
      prompts.length === 2 &&
      first?.thread === 'TH-1' &&
      second?.thread === 'TH-1' &&
      first?.targetSessionId === 'session-ops' &&
      second?.targetSessionId === 'session-ops' &&
      first?.requester === 'session-coord' &&
      second?.requester === 'session-coord' &&
      /-> session-ops \(mesh · ops\) task=T-TH-2 thread=TH-1/.test(log) &&
      /via-thread/.test(log)
    report(
      'threads: a follow-up without target resolves from the thread binding',
      ok,
      `prompts=${prompts.length} thread1=${first?.thread} thread2=${second?.thread} log=${(log.match(/task=T-TH-2[^\n]*/) ?? ['-'])[0]}`,
    )
  })

  await runCase('threads: an unknown thread fails loudly and never delivers', async (boot) => {
    const threadLogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-thread-log-')), 'waker.log')
    const h = await boot({ seedSessions: threadSeeds, config: { logFile: threadLogFile } })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    // Bind one known thread first so the error has a list to name.
    await tool.execute({ target: 'mesh · ops', text: 'known thread', thread: 'TH-KNOWN', taskId: 'T-TH-KNOWN' }, { sessionId: 'session-coord' })
    let message = ''
    try {
      await tool.execute({ thread: 'TH-NOT-EXIST', text: 'must not be delivered', taskId: 'T-TH-BAD' }, { sessionId: 'session-coord' })
    } catch (error) {
      message = String(error && error.message ? error.message : error)
    }
    const log = threadLog(threadLogFile)
    const delivered = h.state.prompts.some((prompt) => JSON.stringify(prompt).includes('must not be delivered'))
    const ok =
      /unknown thread "TH-NOT-EXIST"/.test(message) &&
      /known threads: TH-KNOWN/.test(message) &&
      h.state.prompts.length === 1 &&
      delivered === false &&
      !/T-TH-BAD/.test(log)
    report('threads: an unknown thread fails loudly and never delivers', ok, `error=${JSON.stringify(message)} prompts=${h.state.prompts.length}`)
  })

  await runCase('threads: a dispatch without thread keeps the legacy null thread field', async (boot) => {
    const threadLogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-thread-log-')), 'waker.log')
    const h = await boot({ seedSessions: threadSeeds, config: { logFile: threadLogFile } })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'mesh · ops', text: 'legacy dispatch', taskId: 'T-plain' }, { sessionId: 'session-coord' })
    const row = readTaskRows(h).find((entry) => entry.taskId === 'T-plain')
    let threadsExist = true
    try {
      readThreadsFile(h)
    } catch {
      threadsExist = false
    }
    const ok = row?.thread === null && row?.subject?.length > 0 && !threadsExist
    report('threads: a dispatch without thread keeps the legacy null thread field', ok, `thread=${String(row?.thread)} threadsFile=${threadsExist}`)
  })

  await runCase('threads: an explicit target re-binds the thread and logs it', async (boot) => {
    const threadLogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-thread-log-')), 'waker.log')
    const h = await boot({ seedSessions: threadSeeds, config: { logFile: threadLogFile } })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'mesh · ops', text: 'bind to ops', thread: 'TH-2', taskId: 'T-TH-3' }, { sessionId: 'session-coord' })
    await tool.execute({ target: 'mesh · other', text: 'rebind to other', thread: 'TH-2', taskId: 'T-TH-4' }, { sessionId: 'session-coord' })
    const binding = readThreadsFile(h)['TH-2']
    const log = threadLog(threadLogFile)
    const rebindLine = (log.match(/thread TH-2 rebound:[^\n]*/) ?? ['-'])[0]
    const ok =
      binding?.targetSessionId === 'session-other' &&
      binding?.targetTitle === 'mesh · other' &&
      binding?.count === 2 &&
      binding?.lastTaskId === 'T-TH-4' &&
      /thread TH-2 rebound: session-ops -> session-other/.test(log)
    report('threads: an explicit target re-binds the thread and logs it', ok, `target=${binding?.targetSessionId ?? '-'} count=${binding?.count ?? '-'} log=${rebindLine}`)
  })

  await runCase('threads: /mesh/threads lists bindings with their task ids', async (boot) => {
    const threadLogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-thread-log-')), 'waker.log')
    const h = await boot({ seedSessions: threadSeeds, config: { logFile: threadLogFile } })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'mesh · ops', text: 'one', thread: 'TH-3', taskId: 'T-TH-5' }, { sessionId: 'session-coord' })
    await tool.execute({ thread: 'TH-3', text: 'two', taskId: 'T-TH-6' }, { sessionId: 'session-coord' })
    const listed = await request(h.base, '/mesh/threads')
    const entry = listed.json?.threads?.find((row) => row.thread === 'TH-3')
    const ok =
      listed.status === 200 &&
      listed.json?.ok === true &&
      entry?.count === 2 &&
      entry?.targetTitle === 'mesh · ops' &&
      entry?.targetSessionId === 'session-ops' &&
      entry?.lastTaskId === 'T-TH-6' &&
      Array.isArray(entry?.taskIds) &&
      entry.taskIds.join(',') === 'T-TH-5,T-TH-6'
    report('threads: /mesh/threads lists bindings with their task ids', ok, `status=${listed.status} count=${entry?.count ?? '-'} taskIds=${JSON.stringify(entry?.taskIds ?? [])}`)
  })

  // 131-132. A null baselineTurn (no turn knowledge at injection) must not leave a running
  // task looking pending forever, but a much later turn must NOT be claimed either.
  await runCase('tasks: a null baseline claims a turn/start inside the window and settles', async (boot) => {
    const claimLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-claim-log-')), 'waker.log')
    const h = await boot({ seedSessions: [{ id: 'session-nullbase', title: 'null baseline' }], config: { logFile: claimLog } })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'null baseline', text: 'run with unknown baseline', taskId: 'T-CLAIM' })
    const before = await request(h.base, '/mesh/tasks/T-CLAIM')
    h.emit('session/event', { id: 'session-nullbase' }, { type: 'turn/start', turn: 1 })
    const after = await request(h.base, '/mesh/tasks/T-CLAIM')
    h.emit('session/event', { id: 'session-nullbase' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const settled = await request(h.base, '/mesh/tasks/T-CLAIM')
    const log = threadLog(claimLog)
    const ok =
      before.json?.task?.status === 'pending' &&
      before.json?.task?.startedAt === null &&
      after.json?.task?.status === 'started' &&
      Number.isFinite(after.json?.task?.startedAt) &&
      settled.json?.task?.status === 'settled' &&
      /claimed null baseline within 30000ms: turn=1 baselineTurn=0/.test(log)
    report(
      'tasks: a null baseline claims a turn/start inside the window and settles',
      ok,
      `before=${before.json?.task?.status}/${String(before.json?.task?.startedAt)} after=${after.json?.task?.status}/${String(after.json?.task?.startedAt)} settled=${settled.json?.task?.status}`,
    )
  })

  await runCase('tasks: a late turn/start is not claimed when the baseline is null', async (boot) => {
    const lateLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-claim-log-')), 'waker.log')
    const h = await boot({
      seedSessions: [{ id: 'session-late', title: 'late turn' }],
      config: { logFile: lateLog, startedClaimWindowMs: 1000 },
    })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'late turn', text: 'no turn for a while', taskId: 'T-LATE' })
    await sleep(1300)
    h.emit('session/event', { id: 'session-late' }, { type: 'turn/start', turn: 2 })
    const after = await request(h.base, '/mesh/tasks/T-LATE')
    const log = threadLog(lateLog)
    const ok =
      after.json?.task?.status === 'pending' &&
      after.json?.task?.startedAt === null &&
      !/claimed null baseline/.test(log)
    report(
      'tasks: a late turn/start is not claimed when the baseline is null',
      ok,
      `status=${after.json?.task?.status} startedAt=${String(after.json?.task?.startedAt)} claimedLog=${/claimed null baseline/.test(log)}`,
    )
  })

  // 133-138. mesh_thread (0.7.23): a worker can see, take over, and hand back a thread.
  await runCase('thread tool: the task header carries THREAD, and "-" when absent', async (boot) => {
    const h = await boot({ seedSessions: threadSeeds })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'mesh · ops', text: 'threaded body', thread: 'TH-HDR', taskId: 'T-HDR-1' }, { sessionId: 'session-coord' })
    await tool.execute({ target: 'mesh · ops', text: 'plain body', taskId: 'T-HDR-2' }, { sessionId: 'session-coord' })
    const firstLines = h.state.prompts.map((prompt) => promptText(prompt).split('\n')[0])
    const withThread = firstLines.find((line) => line.startsWith('[TASK T-HDR-1 ')) ?? ''
    const withoutThread = firstLines.find((line) => line.startsWith('[TASK T-HDR-2 ')) ?? ''
    const ok =
      withThread.startsWith('[TASK T-HDR-1 · THREAD TH-HDR · BATCH - · FROM session-coord] ') &&
      withoutThread.startsWith('[TASK T-HDR-2 · THREAD - · BATCH - · FROM session-coord] ')
    report('thread tool: the task header carries THREAD, and "-" when absent', ok, `withThread=${JSON.stringify(withThread)} withoutThread=${JSON.stringify(withoutThread)}`)
  })

  await runCase('thread tool: a worker subscribes itself and appears in /mesh/threads', async (boot) => {
    const h = await boot({ seedSessions: threadSeeds })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_thread')
    if (!tool) throw new Error('mesh_thread was not registered')
    const subscribed = await tool.execute({ action: 'subscribe', thread: 'TH-MINE' }, { sessionId: 'session-ops' })
    // A second thread owned by another session lets mine/all differ.
    await tool.execute({ action: 'subscribe', thread: 'TH-OTHER' }, { sessionId: 'session-other' })
    const mine = await tool.execute({ action: 'list', scope: 'mine' }, { sessionId: 'session-ops' })
    const all = await tool.execute({ action: 'list', scope: 'all' }, { sessionId: 'session-ops' })
    const listed = await request(h.base, '/mesh/threads')
    const entry = listed.json?.threads?.find((row) => row.thread === 'TH-MINE')
    const ok =
      subscribed?.ok === true &&
      subscribed?.subscribedBy === 'self' &&
      entry?.targetSessionId === 'session-ops' &&
      entry?.targetTitle === 'mesh · ops' &&
      entry?.subscribedBy === 'self' &&
      mine.threads.length === 1 &&
      mine.threads[0].thread === 'TH-MINE' &&
      all.threads.length === 2
    report(
      'thread tool: a worker subscribes itself and appears in /mesh/threads',
      ok,
      `mine=${mine.threads.map((row) => row.thread).join(',')} all=${all.threads.map((row) => row.thread).join(',')} threads=${JSON.stringify(entry ?? {})}`,
    )
  })

  await runCase('thread tool: subscribing a thread owned by another session is refused', async (boot) => {
    const h = await boot({ seedSessions: threadSeeds })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_thread')
    if (!tool) throw new Error('mesh_thread was not registered')
    await tool.execute({ action: 'subscribe', thread: 'TH-OWNED' }, { sessionId: 'session-ops' })
    let message = ''
    try {
      await tool.execute({ action: 'subscribe', thread: 'TH-OWNED' }, { sessionId: 'session-other' })
    } catch (error) {
      message = String(error && error.message ? error.message : error)
    }
    const listed = await request(h.base, '/mesh/threads')
    const entry = listed.json?.threads?.find((row) => row.thread === 'TH-OWNED')
    const ok =
      /already bound to session-ops \(mesh · ops\)/.test(message) &&
      entry?.targetSessionId === 'session-ops'
    report('thread tool: subscribing a thread owned by another session is refused', ok, `error=${JSON.stringify(message)} owner=${entry?.targetSessionId ?? '-'}`)
  })

  await runCase('thread tool: only the current owner can release, and release unbinds', async (boot) => {
    const h = await boot({ seedSessions: threadSeeds })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_thread')
    if (!tool) throw new Error('mesh_thread was not registered')
    await tool.execute({ action: 'subscribe', thread: 'TH-REL' }, { sessionId: 'session-ops' })
    let foreignError = ''
    try {
      await tool.execute({ action: 'release', thread: 'TH-REL' }, { sessionId: 'session-other' })
    } catch (error) {
      foreignError = String(error && error.message ? error.message : error)
    }
    const stillBound = (await request(h.base, '/mesh/threads')).json?.threads?.find((row) => row.thread === 'TH-REL')
    const released = await tool.execute({ action: 'release', thread: 'TH-REL' }, { sessionId: 'session-ops' })
    const after = (await request(h.base, '/mesh/threads')).json?.threads?.find((row) => row.thread === 'TH-REL')
    const ok =
      /only the current owner can release it/.test(foreignError) &&
      stillBound?.targetSessionId === 'session-ops' &&
      released?.released === true &&
      !after
    report('thread tool: only the current owner can release, and release unbinds', ok, `foreignError=${JSON.stringify(foreignError)} stillBound=${stillBound?.targetSessionId ?? '-'} released=${released?.released === true}`)
  })

  await runCase('thread tool: after release a dispatch without target reports unknown thread', async (boot) => {
    const h = await boot({ seedSessions: threadSeeds })
    const threadTool = h.state.tools.find((entry) => entry.name === 'mesh_thread')
    const dispatch = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!threadTool || !dispatch) throw new Error('tools were not registered')
    await threadTool.execute({ action: 'subscribe', thread: 'TH-GONE' }, { sessionId: 'session-ops' })
    await threadTool.execute({ action: 'release', thread: 'TH-GONE' }, { sessionId: 'session-ops' })
    let message = ''
    try {
      await dispatch.execute({ thread: 'TH-GONE', text: 'should not deliver', taskId: 'T-GONE' }, { sessionId: 'session-coord' })
    } catch (error) {
      message = String(error && error.message ? error.message : error)
    }
    const ok = /unknown thread "TH-GONE"/.test(message) && h.state.prompts.length === 0
    report('thread tool: after release a dispatch without target reports unknown thread', ok, `error=${JSON.stringify(message)} prompts=${h.state.prompts.length}`)
  })

  await runCase('thread tool: HTTP subscribe/release share the tool rules', async (boot) => {
    const h = await boot({ seedSessions: threadSeeds })
    const subscribed = await request(h.base, '/mesh/threads/subscribe', {
      method: 'POST',
      body: { thread: 'TH-HTTP', sessionId: 'session-other' },
    })
    const listed = await request(h.base, '/mesh/threads')
    const entry = listed.json?.threads?.find((row) => row.thread === 'TH-HTTP')
    const conflict = await request(h.base, '/mesh/threads/subscribe', {
      method: 'POST',
      body: { thread: 'TH-HTTP', sessionId: 'session-ops' },
    })
    const released = await request(h.base, '/mesh/threads/release', {
      method: 'POST',
      body: { thread: 'TH-HTTP', sessionId: 'session-other' },
    })
    const again = await request(h.base, '/mesh/threads/release', {
      method: 'POST',
      body: { thread: 'TH-HTTP', sessionId: 'session-other' },
    })
    const ok =
      subscribed.status === 200 &&
      subscribed.json?.subscribedBy === 'self' &&
      entry?.targetSessionId === 'session-other' &&
      conflict.status === 400 &&
      /already bound to session-other/.test(conflict.json?.error ?? '') &&
      released.status === 200 &&
      released.json?.released === true &&
      again.status === 400 &&
      /unknown thread "TH-HTTP"/.test(again.json?.error ?? '')
    report(
      'thread tool: HTTP subscribe/release share the tool rules',
      ok,
      `subscribe=${subscribed.status}/${subscribed.json?.subscribedBy ?? '-'} conflict=${conflict.status} release=${released.status} again=${again.status}`,
    )
  })

  // 139-143. Receipts must never vanish (T-255): file mode logs, the requester can be
  // inferred from the target's cwd, and a reused taskId is flagged.
  const fileLogFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-file-log-')), 'waker.log')
  const workspaceCwd = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-cwd-'))
    const cwd = path.join(root, 'project')
    fs.mkdirSync(cwd, { recursive: true })
    return cwd
  }
  const settleOnTurn = (h, sessionId, turn = 1) => {
    h.emit('session/event', { id: sessionId }, { type: 'turn/start', turn })
    h.emit('session/event', { id: sessionId }, { type: 'turn/end', turn, reason: { kind: 'completed' } })
  }

  await runCase('receipt: file mode logs the outcome and still does not inject', async (boot) => {
    const logFile = fileLogFile()
    const cwd = workspaceCwd()
    const h = await boot({
      seedSessions: [
        { id: 'session-pipeline', title: 'util4freesub · pipeline', cwd },
        { id: 'session-pipe-coord', title: 'util4freesub · 协调', cwd },
      ],
      config: { logFile, receiptMode: 'file', receiptTo: '' },
    })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute(
      { target: 'util4freesub · pipeline', text: 'file-mode receipt', taskId: 'T-FILE-1', requester: 'session-pipe-coord' },
      { sessionId: 'session-pipe-coord' },
    )
    settleOnTurn(h, 'session-pipeline')
    const settled = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-FILE-1')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const log = threadLog(logFile)
    const fileLine = (log.match(/receipt T-FILE-1 completed → file only[^\n]*/) ?? ['-'])[0]
    const injectedReceipt = h.state.prompts.some((prompt) => JSON.stringify(prompt).includes('[RECEIPT] T-FILE-1'))
    const ok = settled?.json?.task?.status === 'settled' && /file only \(requester=有/.test(log) && injectedReceipt === false
    report('receipt: file mode logs the outcome and still does not inject', ok, `fileLine=${fileLine} injectedReceipt=${injectedReceipt}`)
  })

  await runCase('receipt: file mode without any target warns that nobody was notified', async (boot) => {
    const logFile = fileLogFile()
    const h = await boot({
      seedSessions: [{ id: 'session-silent', title: 'quiet worker' }],
      config: { logFile, receiptMode: 'file', receiptTo: '' },
    })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'quiet worker', text: 'no requester at all', taskId: 'T-SILENT-1' })
    settleOnTurn(h, 'session-silent')
    await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-SILENT-1')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const log = threadLog(logFile)
    const fileLine = (log.match(/receipt T-SILENT-1 completed → file only[^\n]*/) ?? ['-'])[0]
    const warnLine = (log.match(/WARN receipt T-SILENT-1 has no delivery target; nobody was notified/) ?? ['-'])[0]
    const ok = /file only \(requester=无/.test(fileLine) && /nobody was notified/.test(warnLine)
    report('receipt: file mode without any target warns that nobody was notified', ok, `fileLine=${fileLine} warn=${warnLine}`)
  })

  await runCase('receipt: a missing requester is inferred from the unique coordinator in the same cwd', async (boot) => {
    const logFile = fileLogFile()
    const cwd = workspaceCwd()
    const h = await boot({
      seedSessions: [
        { id: 'session-infer-target', title: 'pilot · pipeline', cwd },
        { id: 'session-infer-coord', title: 'pilot · 协调', cwd },
      ],
      config: { logFile, receiptMode: 'file', receiptTo: '' },
    })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'pilot · pipeline', text: 'infer from workspace', taskId: 'T-INFER-1' })
    const stored = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-INFER-1')
      return snapshot.json?.task?.requester ? snapshot : null
    }, 4000)
    const log = threadLog(logFile)
    const ok =
      stored.json?.task?.requester === 'pilot · 协调' &&
      stored.json?.task?.requester !== null &&
      /requester inferred from workspace: pilot · 协调/.test(log)
    report('receipt: a missing requester is inferred from the unique coordinator in the same cwd', ok, `requester=${JSON.stringify(stored.json?.task?.requester ?? null)} inferredLine=${/requester inferred/.test(log)}`)
  })

  await runCase('receipt: two coordinators in the same cwd stay ambiguous and are not guessed', async (boot) => {
    const logFile = fileLogFile()
    const cwd = workspaceCwd()
    // Equal mtimes: no newest candidate, so inference must refuse to guess (T-287 keeps
    // "clearly newest wins", but indistinguishable stays ambiguous).
    const sameTime = Date.now() - 2 * 60 * 60 * 1000
    const h = await boot({
      seedSessions: [
        { id: 'session-amb-target', title: 'pilot · pipeline', cwd },
        { id: 'session-amb-a', title: 'pilot · 协调', cwd, mtime: sameTime },
        { id: 'session-amb-b', title: 'pilot · coordinator', cwd, mtime: sameTime },
      ],
      config: { logFile, receiptMode: 'file', receiptTo: '' },
    })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'pilot · pipeline', text: 'ambiguous requester', taskId: 'T-AMB-1' })
    settleOnTurn(h, 'session-amb-target')
    await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-AMB-1')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const stored = await request(h.base, '/mesh/tasks/T-AMB-1')
    const log = threadLog(logFile)
    const ok =
      stored.json?.task?.requester === null &&
      /requester inference ambiguous: 2 coordinator sessions share cwd/.test(log) &&
      /nobody was notified/.test(log)
    report('receipt: two coordinators in the same cwd stay ambiguous and are not guessed', ok, `requester=${String(stored.json?.task?.requester)} ambiguous=${/requester inference ambiguous: 2/.test(log)} warn=${/nobody was notified/.test(log)}`)
  })

  await runCase('receipt: a reused taskId is flagged on the row and in the log', async (boot) => {
    const logFile = fileLogFile()
    const cwd = workspaceCwd()
    const h = await boot({
      seedSessions: [
        { id: 'session-reuse', title: 'reuse worker', cwd },
        { id: 'session-reuse-coord', title: 'reuse · 协调', cwd },
      ],
      config: { logFile, receiptMode: 'file', receiptTo: '' },
    })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'reuse worker', text: 'first use', taskId: 'T-REUSE', requester: 'session-reuse-coord' }, { sessionId: 'session-reuse-coord' })
    settleOnTurn(h, 'session-reuse')
    await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-REUSE')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    await tool.execute({ target: 'reuse worker', text: 'second use', taskId: 'T-REUSE', requester: 'session-reuse-coord' }, { sessionId: 'session-reuse-coord' })
    // Two dispatches append pending+settled each; compare the two pending rows.
    const rows = readTaskRows(h).filter((row) => row.taskId === 'T-REUSE')
    const pendings = rows.filter((row) => row.status === 'pending')
    const log = threadLog(logFile)
    const ok =
      pendings.length === 2 &&
      pendings[0].reusedId === undefined &&
      pendings[1].reusedId === true &&
      /WARN taskId T-REUSE reused \(previous settled at /.test(log)
    report('receipt: a reused taskId is flagged on the row and in the log', ok, `rows=${rows.length} firstReused=${String(pendings[0]?.reusedId)} secondReused=${String(pendings[1]?.reusedId)}`)
  })

  // 144-148. Receipt summaries must contain answers only (T-260): thinking blocks also
  // carry `text`, and treating them as the answer leaked internal reasoning into receipts.
  await runCase('receipt: thinking blocks are excluded from the assistant summary', async () => {
    const { messageText } = await import(pathToFileURL(ENTRY).href)
    const text = messageText({
      content: [
        { type: 'thinking', text: '内部推理：先看看日志' },
        { type: 'text', text: '答复正文' },
      ],
    })
    const ok = text === '答复正文' && !text.includes('内部推理')
    report('receipt: thinking blocks are excluded from the assistant summary', ok, `text=${JSON.stringify(text)}`)
  })

  await runCase('receipt: a message with only thinking yields an empty summary', async () => {
    const { messageText } = await import(pathToFileURL(ENTRY).href)
    const text = messageText({ content: [{ type: 'thinking', text: '只有思考' }] })
    const ok = text === ''
    report('receipt: a message with only thinking yields an empty summary', ok, `text=${JSON.stringify(text)}`)
  })

  await runCase('receipt: tool blocks are excluded and a bare text block still answers', async () => {
    const { messageText } = await import(pathToFileURL(ENTRY).href)
    const text = messageText({
      content: [
        { type: 'tool_use', text: '{"path":"x"}' },
        { type: 'tool_result', text: 'tool output' },
        { type: 'text', text: '结果' },
      ],
    })
    const ok = text === '结果'
    report('receipt: tool blocks are excluded and a bare text block still answers', ok, `text=${JSON.stringify(text)}`)
  })

  await runCase('receipt: a block with text but no type is still accepted', async () => {
    const { messageText } = await import(pathToFileURL(ENTRY).href)
    const text = messageText({ parts: [{ text: '无 type 的文本' }] })
    const ok = text === '无 type 的文本'
    report('receipt: a block with text but no type is still accepted', ok, `text=${JSON.stringify(text)}`)
  })

  await runCase('receipt: multiple text blocks still join with newlines', async () => {
    const { messageText } = await import(pathToFileURL(ENTRY).href)
    const text = messageText({ content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] })
    const ok = text === '第一段\n第二段'
    report('receipt: multiple text blocks still join with newlines', ok, `text=${JSON.stringify(text)}`)
  })

  // 149-153. A restart leaves pending/started rows from the previous process; startup marks
  // them lost and sends the receipt the dispatcher was still waiting for (T-265).
  const seedOrphan = (taskId, patch = {}) =>
    seededTask(taskId, { targetSessionId: 'session-orphan-target', targetTitle: 'orphan target', createdAt: Date.now() - 60 * 1000, ...patch })
  const orphanReceipts = (h) => {
    try {
      return fs
        .readFileSync(h.receiptsPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }

  await runCase('restart: pending and started orphans both become lost and get receipts', async (boot) => {
    const logFile = fileLogFile()
    const h = await boot({
      seedSessions: [{ id: 'session-orphan-target', title: 'orphan target' }],
      tasksSeed: [seedOrphan('T-ORPH-P', { status: 'pending' }), seedOrphan('T-ORPH-S', { status: 'started', startedAt: Date.now() - 30 * 1000 })],
      config: { logFile, receiptMode: 'file' },
    })
    const pending = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-ORPH-P')
      return snapshot.json?.task?.status === 'lost' ? snapshot : null
    }, 5000)
    const started = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-ORPH-S')
      return snapshot.json?.task?.status === 'lost' ? snapshot : null
    }, 5000)
    const receipts = orphanReceipts(h).filter((receipt) => receipt.status === 'lost')
    const log = threadLog(logFile)
    const ok =
      pending?.json?.task?.status === 'lost' &&
      started?.json?.task?.status === 'lost' &&
      pending.json.task.settledAt !== null &&
      receipts.length === 2 &&
      receipts.every((receipt) => /session restarted before this task finished/.test(receipt.summary ?? '')) &&
      /task T-ORPH-P marked lost after restart/.test(log) &&
      /task T-ORPH-S marked lost after restart/.test(log)
    report(
      'restart: pending and started orphans both become lost and get receipts',
      ok,
      `pending=${pending?.json?.task?.status}/${String(pending?.json?.task?.settledAt)} started=${started?.json?.task?.status} receipts=${receipts.length}`,
    )
  })

  await runCase('restart: a finished row is untouched and gets no receipt', async (boot) => {
    const logFile = fileLogFile()
    const h = await boot({
      tasksSeed: [seedOrphan('T-ORPH-ERR', { status: 'error', settledAt: Date.now() - 10 * 1000, reasonKind: 'error' })],
      config: { logFile, receiptMode: 'file' },
    })
    await request(h.base, '/mesh/tasks')
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
    const row = await request(h.base, '/mesh/tasks/T-ORPH-ERR')
    const receipts = orphanReceipts(h)
    const log = threadLog(logFile)
    const ok = row.json?.task?.status === 'error' && receipts.length === 0 && !/T-ORPH-ERR marked lost/.test(log)
    report('restart: a finished row is untouched and gets no receipt', ok, `status=${row.json?.task?.status} receipts=${receipts.length}`)
  })

  await runCase('restart: an orphan with a requester delivers its lost receipt there', async (boot) => {
    const logFile = fileLogFile()
    const h = await boot({
      seedSessions: [{ id: 'session-orph-coord', title: 'orphan · 协调' }],
      tasksSeed: [seedOrphan('T-ORPH-REQ', { status: 'started', startedAt: Date.now() - 20 * 1000, requester: 'session-orph-coord' })],
      config: { logFile, receiptMode: 'queue', receiptTo: '', receiptSummaryChars: 300 },
    })
    const delivered = await waitFor(
      () => h.state.prompts.find((prompt) => prompt.sessionId === 'session-orph-coord' && JSON.stringify(prompt).includes('T-ORPH-REQ')),
      5000,
    )
    const ok = Boolean(delivered) && JSON.stringify(delivered).includes('lost')
    report('restart: an orphan with a requester delivers its lost receipt there', ok, `deliveredTo=${delivered?.sessionId ?? '-'}`)
  })

  await runCase('restart: a requester-less orphan uses the unique coordinator from its cwd', async (boot) => {
    const logFile = fileLogFile()
    const cwd = workspaceCwd()
    const h = await boot({
      seedSessions: [
        { id: 'session-orphan-target', title: 'orphan target', cwd },
        { id: 'session-orph-coord', title: 'orphan · 协调', cwd },
      ],
      tasksSeed: [seedOrphan('T-ORPH-INFER', { status: 'pending' })],
      config: { logFile, receiptMode: 'queue', receiptTo: '' },
    })
    const delivered = await waitFor(
      () => h.state.prompts.find((prompt) => prompt.sessionId === 'session-orph-coord' && JSON.stringify(prompt).includes('T-ORPH-INFER')),
      5000,
    )
    const log = threadLog(logFile)
    const ok = Boolean(delivered) && /requester inferred from workspace: orphan · 协调/.test(log)
    report('restart: a requester-less orphan uses the unique coordinator from its cwd', ok, `deliveredTo=${delivered?.sessionId ?? '-'} inferred=${/requester inferred/.test(log)}`)
  })

  await runCase('restart: an ambiguous workspace stays undelivered without failing', async (boot) => {
    const logFile = fileLogFile()
    const cwd = workspaceCwd()
    // Equal mtimes so inference stays ambiguous; a clearly newer coordinator would now win.
    const sameTime = Date.now() - 2 * 60 * 60 * 1000
    const h = await boot({
      seedSessions: [
        { id: 'session-orphan-target', title: 'orphan target', cwd },
        { id: 'session-orph-a', title: 'orphan · 协调', cwd, mtime: sameTime },
        { id: 'session-orph-b', title: 'orphan · coordinator', cwd, mtime: sameTime },
      ],
      tasksSeed: [seedOrphan('T-ORPH-AMB', { status: 'pending' })],
      config: { logFile, receiptMode: 'queue', receiptTo: '' },
    })
    const lost = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-ORPH-AMB')
      return snapshot.json?.task?.status === 'lost' ? snapshot : null
    }, 5000)
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
    const log = threadLog(logFile)
    const receipts = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-ORPH-AMB')
    const ok =
      lost?.json?.task?.status === 'lost' &&
      /requester inference ambiguous: 2 coordinator sessions share cwd/.test(log) &&
      // No requester survives inference -> the lost receipt falls back to file-only + WARN.
      /receipt T-ORPH-AMB lost → file only \(requester=无/.test(log) &&
      /nobody was notified/.test(log) &&
      receipts.length === 1 &&
      receipts[0].receiptMode === 'file' &&
      h.state.prompts.length === 0
    report('restart: an ambiguous workspace stays undelivered without failing', ok, `lost=${lost?.json?.task?.status ?? '-'} receipts=${receipts.length} mode=${receipts[0]?.receiptMode ?? '-'} prompts=${h.state.prompts.length}`)
  })

  // 154-157. Receipt summaries must come from this task's own turn (T-267): turn numbers
  // alone are not enough, the assistant snapshot must also be newer than the injection.
  const readReceipt = async (h, taskId) => {
    const settled = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/' + taskId)
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    return settled?.json?.task?.receiptSummary ?? null
  }
  const seedReply = (h, sessionId, turn, text) => {
    h.emit('session/event', { id: sessionId }, { type: 'assistant/message', turn, message: { content: [{ type: 'text', text }] } })
  }
  const finishTurn = (h, sessionId, turn) => {
    h.emit('session/event', { id: sessionId }, { type: 'turn/start', turn })
    h.emit('session/event', { id: sessionId }, { type: 'turn/end', turn, reason: { kind: 'completed' } })
  }

  await runCase('receipt: text written before the injection is never used as the summary', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-old-text', title: 'old text target' }] })
    // Same turn number as the task will settle in, but written before injection.
    seedReply(h, 'session-old-text', 2, '验收成立，接下来等三单收尾。')
    await sleep(20)
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'old text target', text: 'only answer one line', taskId: 'T-OLD-TEXT' }, { sessionId: 'session-coord' })
    finishTurn(h, 'session-old-text', 2)
    const summary = await readReceipt(h, 'T-OLD-TEXT')
    const ok = summary === ''
    report('receipt: text written before the injection is never used as the summary', ok, `summary=${JSON.stringify(summary)}`)
  })

  await runCase('receipt: a fresh snapshot from the same turn is used as the summary', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-fresh-text', title: 'fresh text target' }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'fresh text target', text: 'answer one line', taskId: 'T-FRESH-TEXT' }, { sessionId: 'session-coord' })
    seedReply(h, 'session-fresh-text', 2, 'T4F-ROUTE-OK 20261101-1208')
    finishTurn(h, 'session-fresh-text', 2)
    const summary = await readReceipt(h, 'T-FRESH-TEXT')
    const ok = summary === 'T4F-ROUTE-OK 20261101-1208'
    report('receipt: a fresh snapshot from the same turn is used as the summary', ok, `summary=${JSON.stringify(summary)}`)
  })

  await runCase('receipt: a fresh snapshot from another turn is still rejected', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-other-turn', title: 'other turn target' }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'other turn target', text: 'answer in turn 3', taskId: 'T-OTHER-TURN' }, { sessionId: 'session-coord' })
    seedReply(h, 'session-other-turn', 9, '这段属于另一个回合')
    finishTurn(h, 'session-other-turn', 3)
    const summary = await readReceipt(h, 'T-OTHER-TURN')
    const ok = summary === ''
    report('receipt: a fresh snapshot from another turn is still rejected', ok, `summary=${JSON.stringify(summary)}`)
  })

  await runCase('receipt: no assistant snapshot keeps the summary empty', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-no-shot', title: 'no snapshot target' }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'no snapshot target', text: 'no answer text', taskId: 'T-NO-SHOT' }, { sessionId: 'session-coord' })
    finishTurn(h, 'session-no-shot', 1)
    const summary = await readReceipt(h, 'T-NO-SHOT')
    const ok = summary === ''
    report('receipt: no assistant snapshot keeps the summary empty', ok, `summary=${JSON.stringify(summary)}`)
  })

  // 158-162. A receipt notice is a completion signal, not a letter (T-269): the summary
  // stays in the file/API, only error/lost carry a reason line.
  await runCase('receipt notice: completed injects the status line without the summary', async () => {
    const { receiptNoticeText } = await import(pathToFileURL(ENTRY).href)
    const summary = '验收成立，接下来等三单收尾。'.repeat(3)
    const text = receiptNoticeText({ taskId: 'T-NOTICE-1', status: 'completed', durationMs: 5000, summary })
    const ok = text === '[RECEIPT] T-NOTICE-1 completed 5000ms' && text.indexOf(summary) === -1
    report('receipt notice: completed injects the status line without the summary', ok, `text=${JSON.stringify(text)} summaryInjected=${text.includes(summary)}`)
  })

  await runCase('receipt notice: error adds exactly one reason line', async () => {
    const { receiptNoticeText } = await import(pathToFileURL(ENTRY).href)
    const text = receiptNoticeText({
      taskId: 'T-NOTICE-ERR',
      status: 'error',
      durationMs: 120,
      summary: '长篇摘要不应出现',
      reasonDetail: 'error: SERVER upstream 502',
    })
    const lines = text.split('\n')
    const ok = lines.length === 2 && lines[0] === '[RECEIPT] T-NOTICE-ERR error 120ms' && lines[1] === 'error: SERVER upstream 502'
    report('receipt notice: error adds exactly one reason line', ok, `text=${JSON.stringify(text)}`)
  })

  await runCase('receipt notice: lost carries its reason', async () => {
    const { receiptNoticeText } = await import(pathToFileURL(ENTRY).href)
    const text = receiptNoticeText({
      taskId: 'T-NOTICE-LOST',
      status: 'lost',
      durationMs: 0,
      reasonDetail: 'host restart',
      summary: 'session restarted before this task finished; resend if still needed',
    })
    const ok = text.includes('host restart') && !text.includes('session restarted before this task finished')
    report('receipt notice: lost carries its reason', ok, `text=${JSON.stringify(text)}`)
  })

  await runCase('receipt notice: includeSummary restores the legacy text', async () => {
    const { receiptNoticeText } = await import(pathToFileURL(ENTRY).href)
    const text = receiptNoticeText(
      { taskId: 'T-NOTICE-OLD', status: 'completed', durationMs: 42, summary: '旧行为摘要' },
      { includeSummary: true },
    )
    const ok = text === '[RECEIPT] T-NOTICE-OLD completed 42ms\n旧行为摘要'
    report('receipt notice: includeSummary restores the legacy text', ok, `text=${JSON.stringify(text)}`)
  })

  await runCase('receipt notice: an empty summary leaves a single clean line', async () => {
    const { receiptNoticeText } = await import(pathToFileURL(ENTRY).href)
    const text = receiptNoticeText({ taskId: 'T-NOTICE-EMPTY', status: 'completed', durationMs: 1, summary: '' })
    const ok = text === '[RECEIPT] T-NOTICE-EMPTY completed 1ms' && !text.endsWith('\n')
    report('receipt notice: an empty summary leaves a single clean line', ok, `text=${JSON.stringify(text)}`)
  })

  // 163-166. A lost receipt must reach the dispatcher (T-273): the registry row now records
  // receiptMode, and pre-0.7.30 rows with a requester default to queue.
  await runCase('tasks: the registry row records the effective receiptMode', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-mode-target', title: 'mode target' }], config: { receiptMode: 'queue' } })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'mode target', text: 'persist mode', taskId: 'T-MODE-1', requester: 'session-mode-target' }, { sessionId: 'session-coord' })
    const row = readTaskRows(h).find((entry) => entry.taskId === 'T-MODE-1' && entry.status === 'pending')
    const ok = row?.receiptMode === 'queue'
    report('tasks: the registry row records the effective receiptMode', ok, `receiptMode=${String(row?.receiptMode)}`)
  })

  await runCase('restart: a lost receipt honours the row receiptMode=queue', async (boot) => {
    const h = await boot({
      seedSessions: [{ id: 'session-mode-coord', title: 'mode · 协调' }],
      tasksSeed: [seedOrphan('T-LOST-QUEUE', { status: 'started', startedAt: Date.now() - 9000, requester: 'session-mode-coord', receiptMode: 'queue' })],
      // The global config stays file: the row's recorded mode must win.
      config: { receiptMode: 'file', receiptTo: '' },
    })
    const delivered = await waitFor(
      () => h.state.prompts.find((prompt) => prompt.sessionId === 'session-mode-coord' && JSON.stringify(prompt).includes('T-LOST-QUEUE')),
      5000,
    )
    const ok = Boolean(delivered)
    report('restart: a lost receipt honours the row receiptMode=queue', ok, `deliveredTo=${delivered?.sessionId ?? '-'} prompts=${h.state.prompts.length}`)
  })

  await runCase('restart: an old row without receiptMode but with a requester defaults to queue', async (boot) => {
    const h = await boot({
      seedSessions: [{ id: 'session-old-coord', title: 'old · 协调' }],
      tasksSeed: [seedOrphan('T-LOST-OLD', { status: 'started', startedAt: Date.now() - 9000, requester: 'session-old-coord' })],
      config: { receiptMode: 'file', receiptTo: '' },
    })
    const delivered = await waitFor(
      () => h.state.prompts.find((prompt) => prompt.sessionId === 'session-old-coord' && JSON.stringify(prompt).includes('T-LOST-OLD')),
      5000,
    )
    const ok = Boolean(delivered) && JSON.stringify(delivered).includes('lost')
    report('restart: an old row without receiptMode but with a requester defaults to queue', ok, `deliveredTo=${delivered?.sessionId ?? '-'}`)
  })

  await runCase('restart: an old row without requester stays file only and warns', async (boot) => {
    const h = await boot({
      tasksSeed: [seedOrphan('T-LOST-FILE', { status: 'started', startedAt: Date.now() - 9000 })],
      config: { receiptMode: 'file', receiptTo: '' },
    })
    const lost = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-LOST-FILE')
      return snapshot.json?.task?.status === 'lost' ? snapshot : null
    }, 5000)
    const receipts = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-LOST-FILE' && receipt.status === 'lost')
    const ok = lost?.json?.task?.status === 'lost' && receipts.length === 1 && receipts[0].receiptMode === 'file' && h.state.prompts.length === 0
    report('restart: an old row without requester stays file only and warns', ok, `status=${lost?.json?.task?.status ?? '-'} receiptMode=${receipts[0]?.receiptMode ?? '-'} prompts=${h.state.prompts.length}`)
  })

  // 167-172. Task bodies are stored by content hash (T-277): the jsonl keeps only a ref,
  // identical bodies dedupe, and old inline rows migrate without losing the text.
  const textsDirOf = (h) => path.join(h.home, '.dsh', 'mesh-waker', 'texts')
  const listTextFiles = (h) => {
    try {
      return fs.readdirSync(textsDirOf(h)).filter((name) => name.endsWith('.txt'))
    } catch {
      return []
    }
  }

  await runCase('tasks: a registered row keeps a textRef instead of the inline body', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-txt', title: 'txt target' }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    const body = '正文只存一次：content addressed body'
    await tool.execute({ target: 'txt target', text: body, taskId: 'T-TXT-1' }, { sessionId: 'session-coord' })
    const row = readTaskRows(h).find((entry) => entry.taskId === 'T-TXT-1')
    const ref = /^sha256:([a-f0-9]{64})$/.exec(row?.textRef ?? '')
    const stored = ref ? fs.readFileSync(path.join(textsDirOf(h), `${ref[1]}.txt`), 'utf8') : ''
    const ok =
      typeof row?.textRef === 'string' &&
      row.text === undefined &&
      row.textBytes === Buffer.byteLength(body) &&
      typeof row.subject === 'string' &&
      stored === body
    report('tasks: a registered row keeps a textRef instead of the inline body', ok, `textRef=${String(row?.textRef).slice(0, 20)} bytes=${row?.textBytes ?? '-'} hasText=${row?.text !== undefined}`)
  })

  await runCase('tasks: identical bodies share one text file', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-dup-txt', title: 'dup txt target' }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target: 'dup txt target', text: '完全相同的正文', taskId: 'T-TXT-A' }, { sessionId: 'session-coord' })
    await tool.execute({ target: 'dup txt target', text: '完全相同的正文', taskId: 'T-TXT-B' }, { sessionId: 'session-coord' })
    const rows = readTaskRows(h).filter((entry) => entry.taskId === 'T-TXT-A' || entry.taskId === 'T-TXT-B')
    const files = listTextFiles(h)
    const ok = rows.length === 2 && rows[0].textRef === rows[1].textRef && files.length === 1
    report('tasks: identical bodies share one text file', ok, `files=${files.length} sameRef=${rows[0]?.textRef === rows[1]?.textRef}`)
  })

  await runCase('tasks: a legacy inline row migrates to a textRef and still resolves', async (boot) => {
    const body = '迁移前的内嵌正文'
    const h = await boot({
      tasksSeed: [seededTask('T-LEGACY-TXT', { status: 'settled', settledAt: Date.now() - 1000, text: body, textBytes: Buffer.byteLength(body) })],
    })
    const row = readTaskRows(h).find((entry) => entry.taskId === 'T-LEGACY-TXT')
    const { resolveTaskText } = await import(pathToFileURL(ENTRY).href)
    const resolved = resolveTaskText(row, textsDirOf(h))
    const ok =
      typeof row?.textRef === 'string' &&
      row.text === undefined &&
      row.textBytes === Buffer.byteLength(body) &&
      resolved === body &&
      listTextFiles(h).length === 1
    report('tasks: a legacy inline row migrates to a textRef and still resolves', ok, `textRef=${String(row?.textRef).slice(0, 20)} resolved=${JSON.stringify(resolved)}`)
  })

  await runCase('tasks: resolveTaskText handles ref, legacy text and nothing', async () => {
    const { resolveTaskText } = await import(pathToFileURL(ENTRY).href)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-texts-'))
    try {
      const body = '内容寻址正文'
      const hex = require('node:crypto').createHash('sha256').update(body, 'utf8').digest('hex')
      fs.writeFileSync(path.join(dir, `${hex}.txt`), body)
      const byRef = resolveTaskText({ textRef: `sha256:${hex}` }, dir)
      const byText = resolveTaskText({ text: '旧行内正文' }, dir)
      const missing = resolveTaskText({}, dir)
      const broken = resolveTaskText({ textRef: 'sha256:not-a-hash' }, dir)
      const ok = byRef === body && byText === '旧行内正文' && missing === '' && broken === ''
      report('tasks: resolveTaskText handles ref, legacy text and nothing', ok, `ref=${JSON.stringify(byRef)} legacy=${JSON.stringify(byText)} missing=${JSON.stringify(missing)} broken=${JSON.stringify(broken)}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await runCase('tasks: the task list hides text by default and adds it with include=text', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-inc', title: 'include target' }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    const body = '按需返回的正文'
    await tool.execute({ target: 'include target', text: body, taskId: 'T-INC-1' }, { sessionId: 'session-coord' })
    const plain = await request(h.base, '/mesh/tasks')
    const withText = await request(h.base, '/mesh/tasks?include=text')
    const plainRow = plain.json?.tasks?.find((row) => row.taskId === 'T-INC-1')
    const textRow = withText.json?.tasks?.find((row) => row.taskId === 'T-INC-1')
    const ok =
      plainRow?.text === undefined &&
      typeof plainRow?.textRef === 'string' &&
      textRow?.text === body
    report('tasks: the task list hides text by default and adds it with include=text', ok, `defaultHasText=${plainRow?.text !== undefined} includeText=${JSON.stringify(textRow?.text ?? null)}`)
  })

  await runCase('tasks: a failed migration leaves tasks.jsonl untouched', async (boot) => {
    let before = ''
    const h = await boot({
      tasksSeed: [seededTask('T-MIG-FAIL', { status: 'settled', settledAt: Date.now() - 1000, text: '不能被破坏的正文' })],
      // Keep the legacy single file so this case is about text compaction, not tier splitting.
      config: { storageTiers: false },
      prepareHome: (home) => {
        const registry = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(registry, { recursive: true })
        before = fs.readFileSync(path.join(registry, 'tasks.jsonl'), 'utf8')
        // A file where the texts directory should be makes every text write fail.
        fs.writeFileSync(path.join(registry, 'texts'), 'not a directory')
      },
    })
    await request(h.base, '/mesh/tasks')
    const after = fs.readFileSync(path.join(h.home, '.dsh', 'mesh-waker', 'tasks.jsonl'), 'utf8')
    const ok = before.length > 0 && after === before && /T-MIG-FAIL/.test(after)
    report('tasks: a failed migration leaves tasks.jsonl untouched', ok, `unchanged=${after === before} bytes=${after.length}`)
  })

  // 173-179. mesh_complete (0.7.31): the worker declares the outcome instead of waker
  // guessing from turn/end; observed settlement stays as the fallback.
  const dispatchTo = async (h, target, text, taskId) => {
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    if (!tool) throw new Error('mesh_dispatch was not registered')
    await tool.execute({ target, text, taskId }, { sessionId: 'session-coord' })
  }
  const completedTool = (h) => {
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_complete')
    if (!tool) throw new Error('mesh_complete was not registered')
    return tool
  }
  const lastReceiptFor = (h, taskId) =>
    orphanReceipts(h)
      .filter((receipt) => receipt.taskId === taskId)
      .pop()

  await runCase('complete: a declared completion settles with its own summary and source', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-declare', title: 'declare target' }], config: { receiptMode: 'file' } })
    await dispatchTo(h, 'declare target', 'do the thing', 'T-DECL-1')
    const result = await completedTool(h).execute(
      { taskId: 'T-DECL-1', status: 'done', summary: '我写的一行摘要' },
      { agent: { id: 'session-declare' } },
    )
    const task = await request(h.base, '/mesh/tasks/T-DECL-1')
    const receipt = lastReceiptFor(h, 'T-DECL-1')
    const status = await request(h.base, '/mesh/status')
    const ok =
      result?.ok === true &&
      result?.source === 'declared' &&
      task.json?.task?.status === 'settled' &&
      receipt?.status === 'completed' &&
      receipt?.source === 'declared' &&
      receipt?.summary === '我写的一行摘要' &&
      status.json?.tools?.complete === true
    report('complete: a declared completion settles with its own summary and source', ok, `task=${task.json?.task?.status} receipt=${receipt?.status}/${receipt?.source} tools.complete=${String(status.json?.tools?.complete)}`)
  })

  await runCase('complete: a session cannot complete another session task', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-owner', title: 'owner target' },
        { id: 'session-intruder', title: 'intruder' },
      ],
      config: { receiptMode: 'file' },
    })
    await dispatchTo(h, 'owner target', 'owner only', 'T-OWN-1')
    let message = ''
    try {
      await completedTool(h).execute({ taskId: 'T-OWN-1', status: 'done' }, { agent: { id: 'session-intruder' } })
    } catch (error) {
      message = String(error && error.message ? error.message : error)
    }
    const task = await request(h.base, '/mesh/tasks/T-OWN-1')
    const ok = /belongs to session-owner/.test(message) && task.json?.task?.status === 'pending'
    report('complete: a session cannot complete another session task', ok, `error=${JSON.stringify(message)} status=${task.json?.task?.status}`)
  })

  await runCase('complete: an unknown task id is rejected', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-unknown', title: 'unknown target' }] })
    let message = ''
    try {
      await completedTool(h).execute({ taskId: 'T-NOPE', status: 'done' }, { agent: { id: 'session-unknown' } })
    } catch (error) {
      message = String(error && error.message ? error.message : error)
    }
    const ok = /unknown task "T-NOPE"/.test(message)
    report('complete: an unknown task id is rejected', ok, `error=${JSON.stringify(message)}`)
  })

  await runCase('complete: a second declaration returns already settled', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-twice', title: 'twice target' }], config: { receiptMode: 'file' } })
    await dispatchTo(h, 'twice target', 'settle me once', 'T-TWICE-1')
    const tool = completedTool(h)
    const first = await tool.execute({ taskId: 'T-TWICE-1', status: 'done' }, { agent: { id: 'session-twice' } })
    const promptsAfterFirst = h.state.prompts.length
    const second = await tool.execute({ taskId: 'T-TWICE-1', status: 'done' }, { agent: { id: 'session-twice' } })
    const receipts = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-TWICE-1')
    const ok =
      first?.ok === true &&
      second?.alreadySettled === true &&
      receipts.length === 1 &&
      h.state.prompts.length === promptsAfterFirst
    report('complete: a second declaration returns already settled', ok, `alreadySettled=${String(second?.alreadySettled)} receipts=${receipts.length} prompts=${h.state.prompts.length}`)
  })

  await runCase('complete: blocked maps to failed and keeps the worker detail', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-blocked', title: 'blocked target' }], config: { receiptMode: 'file' } })
    await dispatchTo(h, 'blocked target', 'will block', 'T-BLOCK-1')
    const result = await completedTool(h).execute(
      { taskId: 'T-BLOCK-1', status: 'blocked', detail: 'missing credentials for the deploy step' },
      { agent: { id: 'session-blocked' } },
    )
    const receipt = lastReceiptFor(h, 'T-BLOCK-1')
    const ok =
      result?.receiptStatus === 'failed' &&
      receipt?.status === 'failed' &&
      receipt?.reasonDetail === 'missing credentials for the deploy step' &&
      receipt?.source === 'declared'
    report('complete: blocked maps to failed and keeps the worker detail', ok, `receipt=${receipt?.status} detail=${JSON.stringify(receipt?.reasonDetail ?? '')}`)
  })

  await runCase('complete: an undeclared task still settles from turn/end as observed', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-observed', title: 'observed target' }], config: { receiptMode: 'file' } })
    await dispatchTo(h, 'observed target', 'no declaration', 'T-OBS-1')
    h.emit('session/event', { id: 'session-observed' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-observed' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const settled = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-OBS-1')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const receipt = lastReceiptFor(h, 'T-OBS-1')
    const ok = settled?.json?.task?.status === 'settled' && receipt?.source === 'observed' && receipt?.status === 'completed'
    report('complete: an undeclared task still settles from turn/end as observed', ok, `status=${settled?.json?.task?.status ?? '-'} source=${receipt?.source ?? '-'}`)
  })

  await runCase('complete: the receipt notice marks declared and observed sources', async () => {
    const { receiptNoticeText } = await import(pathToFileURL(ENTRY).href)
    const declared = receiptNoticeText({ taskId: 'T-NOTICE-D', status: 'completed', durationMs: 1234, source: 'declared' })
    const observed = receiptNoticeText({ taskId: 'T-NOTICE-O', status: 'completed', durationMs: 300100, source: 'observed' })
    const ok =
      declared === '[RECEIPT] T-NOTICE-D completed 1234ms (declared)' &&
      observed === '[RECEIPT] T-NOTICE-O completed 300100ms (observed)'
    report('complete: the receipt notice marks declared and observed sources', ok, `declared=${JSON.stringify(declared)} observed=${JSON.stringify(observed)}`)
  })

  // 180-185. A queued task must not be killed by the stall watchdog (T-279): re-arm while
  // another task runs, and keep a reported task dormant so a late turn can resume it.
  const stallConfig = { receiptStallMs: 1000, receiptMode: 'file' }
  const pendingCount = async (h) => (await request(h.base, '/mesh/status')).json?.pendingTasks ?? -1

  await runCase('stall: a queued task behind a running one is re-armed, not reported', async (boot) => {
    const logFile = fileLogFile()
    const h = await boot({ seedSessions: [{ id: 'session-queue', title: 'queue target' }], config: { ...stallConfig, logFile } })
    await dispatchTo(h, 'queue target', 'first long task', 'T-QA')
    h.emit('session/event', { id: 'session-queue' }, { type: 'turn/start', turn: 1 })
    await dispatchTo(h, 'queue target', 'queued behind first', 'T-QB')
    await sleep(1300)
    const receipts = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-QB')
    const log = threadLog(logFile)
    const stillPending = await pendingCount(h)
    const ok =
      receipts.length === 0 &&
      /task T-QB stall re-armed: another task is still running on session-queue/.test(log) &&
      stillPending === 2
    report('stall: a queued task behind a running one is re-armed, not reported', ok, `receipts=${receipts.length} pending=${stillPending} rearmed=${/T-QB stall re-armed/.test(log)}`)
  })

  await runCase('stall: the queued task starts after the first finishes and settles normally', async (boot) => {
    const logFile = fileLogFile()
    const h = await boot({ seedSessions: [{ id: 'session-queue2', title: 'queue2 target' }], config: { ...stallConfig, logFile } })
    await dispatchTo(h, 'queue2 target', 'first task', 'T-QC')
    h.emit('session/event', { id: 'session-queue2' }, { type: 'turn/start', turn: 1 })
    await dispatchTo(h, 'queue2 target', 'second task', 'T-QD')
    h.emit('session/event', { id: 'session-queue2' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    h.emit('session/event', { id: 'session-queue2' }, { type: 'turn/start', turn: 2 })
    h.emit('session/event', { id: 'session-queue2' }, { type: 'turn/end', turn: 2, reason: { kind: 'completed' } })
    const settled = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-QD')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const receipts = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-QD')
    const notStarted = receipts.filter((receipt) => receipt.status === 'not-started').length
    const ok = settled?.json?.task?.status === 'settled' && receipts.length === 1 && receipts[0].status === 'completed' && notStarted === 0
    report('stall: the queued task starts after the first finishes and settles normally', ok, `status=${settled?.json?.task?.status ?? '-'} receipts=${receipts.length} notStarted=${notStarted}`)
  })

  await runCase('stall: a genuinely silent session still gets not-started', async (boot) => {
    const logFile = fileLogFile()
    const h = await boot({ seedSessions: [{ id: 'session-silent-stall', title: 'silent target' }], config: { ...stallConfig, logFile } })
    await dispatchTo(h, 'silent target', 'nobody will run this', 'T-NS')
    const receipt = await waitFor(() => orphanReceipts(h).find((entry) => entry.taskId === 'T-NS'), 4000)
    const ok = receipt?.status === 'not-started' && /task T-NS not-started after 1000ms/.test(threadLog(logFile))
    report('stall: a genuinely silent session still gets not-started', ok, `status=${receipt?.status ?? '-'}`)
  })

  await runCase('stall: a reported task resumes on a late turn and settles with source=resumed', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-resume', title: 'resume target' }], config: stallConfig })
    await dispatchTo(h, 'resume target', 'runs much later', 'T-RES')
    await waitFor(() => orphanReceipts(h).find((entry) => entry.taskId === 'T-RES' && entry.status === 'not-started'), 4000)
    h.emit('session/event', { id: 'session-resume' }, { type: 'turn/start', turn: 5 })
    h.emit('session/event', { id: 'session-resume' }, { type: 'turn/end', turn: 5, reason: { kind: 'completed' } })
    const settled = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-RES')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const receipts = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-RES')
    const notStarted = receipts.filter((receipt) => receipt.status === 'not-started')
    const completed = receipts.filter((receipt) => receipt.status === 'completed')
    const ok =
      settled?.json?.task?.status === 'settled' &&
      notStarted.length === 1 &&
      completed.length === 1 &&
      completed[0].source === 'resumed'
    report('stall: a reported task resumes on a late turn and settles with source=resumed', ok, `notStarted=${notStarted.length} completed=${completed.length} source=${completed[0]?.source ?? '-'}`)
  })

  await runCase('stall: a dormant task is dropped after the session stays idle', async (boot) => {
    const logFile = fileLogFile()
    const h = await boot({ seedSessions: [{ id: 'session-dormant', title: 'dormant target' }], config: { ...stallConfig, logFile } })
    await dispatchTo(h, 'dormant target', 'never resumes', 'T-DORM')
    await waitFor(() => orphanReceipts(h).find((entry) => entry.taskId === 'T-DORM' && entry.status === 'not-started'), 4000)
    const afterReport = await pendingCount(h)
    await sleep(1300)
    const afterIdle = await pendingCount(h)
    const ok = afterReport === 1 && afterIdle === 0 && /task T-DORM dropped: dormant and the session stayed idle/.test(threadLog(logFile))
    report('stall: a dormant task is dropped after the session stays idle', ok, `pendingAfterReport=${afterReport} pendingAfterIdle=${afterIdle}`)
  })

  await runCase('stall: a task that starts immediately is unchanged', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-fast', title: 'fast target' }], config: stallConfig })
    await dispatchTo(h, 'fast target', 'starts at once', 'T-FAST')
    h.emit('session/event', { id: 'session-fast' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-fast' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const settled = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-FAST')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const receipts = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-FAST')
    const ok = settled?.json?.task?.status === 'settled' && receipts.length === 1 && receipts[0].status === 'completed' && receipts[0].source === 'observed'
    report('stall: a task that starts immediately is unchanged', ok, `status=${settled?.json?.task?.status ?? '-'} receipts=${receipts.length}`)
  })

  // T-354 (the reported incident): a task queued behind a long-running one must survive
  // SEVERAL stall windows without ever being reported, then start and settle normally.
  await runCase('stall: a queued task survives multiple stall windows and still settles', async (boot) => {
    const logFile = fileLogFile()
    const h = await boot({ seedSessions: [{ id: 'session-long-queue', title: 'long queue target' }], config: { ...stallConfig, logFile } })
    await dispatchTo(h, 'long queue target', 'long running first task', 'T-LQ1')
    h.emit('session/event', { id: 'session-long-queue' }, { type: 'turn/start', turn: 1 })
    await dispatchTo(h, 'long queue target', 'queued behind the long one', 'T-LQ2')
    // 2.6 stall windows: two re-arms for the queued task, none for the running one.
    await sleep(2600)
    const duringRun = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-LQ1' || receipt.taskId === 'T-LQ2')
    const rearmed = (threadLog(logFile).match(/T-LQ2 stall re-armed/g) ?? []).length
    h.emit('session/event', { id: 'session-long-queue' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    h.emit('session/event', { id: 'session-long-queue' }, { type: 'turn/start', turn: 2 })
    h.emit('session/event', { id: 'session-long-queue' }, { type: 'turn/end', turn: 2, reason: { kind: 'completed' } })
    const settled = await waitFor(async () => {
      const snapshot = await request(h.base, '/mesh/tasks/T-LQ2')
      return snapshot.json?.task?.status === 'settled' ? snapshot : null
    }, 4000)
    const queuedReceipts = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-LQ2')
    const notStarted = queuedReceipts.filter((receipt) => receipt.status === 'not-started').length
    const ok =
      duringRun.length === 0 &&
      rearmed >= 2 &&
      settled?.json?.task?.status === 'settled' &&
      queuedReceipts.length === 1 &&
      queuedReceipts[0].status === 'completed' &&
      notStarted === 0
    report('stall: a queued task survives multiple stall windows and still settles', ok, `during=${duringRun.length} rearmed=${rearmed} settled=${settled?.json?.task?.status ?? '-'} notStarted=${notStarted}`)
  })

  // 186-192. Storage tiers (T-282): records live at the LCA of both ends; legacy files split
  // once into ws/<slug>/ and local/, and reads aggregate every layer.
  const meshOf = (h) => path.join(h.home, '.dsh', 'mesh-waker')
  const linesOf = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const bootSessions = (cwdA, cwdB) => [
    { id: 'session-coord', title: 'mesh · 协调', cwd: cwdB ?? cwdA },
    { id: 'session-worker', title: 'worker', cwd: cwdA },
  ]

  await runCase('storage: same-workspace tasks stay in ws/<slug>/', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'wt-same-zone')
    const h = await boot({ seedSessions: bootSessions(cwd, cwd) })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'same zone work', meta: { taskId: 'T-SAME-1', requester: 'session-coord' } },
    })
    const wsRow = linesOf(path.join(meshOf(h), 'ws', 'wt-same-zone', 'tasks.jsonl')).find((row) => row.taskId === 'T-SAME-1')
    const localRows = linesOf(path.join(meshOf(h), 'local', 'tasks.jsonl'))
    const registry = JSON.parse(fs.readFileSync(path.join(meshOf(h), 'workspaces.json'), 'utf8'))
    const api = await request(h.base, '/mesh/workspaces')
    const ok =
      wsRow?.scope === 'workspace' &&
      wsRow?.workspace === 'wt-same-zone' &&
      localRows.length === 0 &&
      registry.workspaces?.['wt-same-zone']?.cwd === cwd &&
      api.json?.count === 1
    report('storage: same-workspace tasks stay in ws/<slug>/', ok, `wsRow=${Boolean(wsRow)} localRows=${localRows.length} workspaces=${api.json?.count ?? '-'}`)
  })

  await runCase('storage: cross-workspace tasks go to local/ with scope=machine and peers', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'wt-cross-a')
    const cwdB = path.join(os.tmpdir(), 'wt-cross-b')
    const h = await boot({ seedSessions: bootSessions(cwdA, cwdB) })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'cross zone work', meta: { taskId: 'T-CROSS-1', requester: 'session-coord' } },
    })
    const localRow = linesOf(path.join(meshOf(h), 'local', 'tasks.jsonl')).find((row) => row.taskId === 'T-CROSS-1')
    const wsRows = linesOf(path.join(meshOf(h), 'ws', 'wt-cross-a', 'tasks.jsonl')).filter((row) => row.taskId === 'T-CROSS-1')
    const machine = JSON.parse(fs.readFileSync(path.join(meshOf(h), 'workspaces.json'), 'utf8')).machine
    const ok =
      localRow?.scope === 'machine' &&
      localRow?.origin === `${machine}/wt-cross-b` &&
      JSON.stringify(localRow?.peers) === JSON.stringify([`${machine}/wt-cross-a`]) &&
      wsRows.length === 0
    report('storage: cross-workspace tasks go to local/ with scope=machine and peers', ok, `scope=${localRow?.scope ?? '-'} origin=${localRow?.origin ?? '-'} peers=${JSON.stringify(localRow?.peers ?? [])}`)
  })

  await runCase('storage: legacy files migrate into tier files and are kept as legacy', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'wt-mig-a')
    const cwdB = path.join(os.tmpdir(), 'wt-mig-b')
    // Pin the log target: logTarget is global, so a previous case's logFile would swallow
    // this boot's migration line (the suite reuses one process).
    const logFile = path.join(os.tmpdir(), `waker-tier-mig-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile },
      seedSessions: [
        { id: 'session-a', title: 'worker a', cwd: cwdA },
        { id: 'session-b', title: 'worker b', cwd: cwdB },
      ],
      tasksSeed: [
        seededTask('T-MIG-A', { targetSessionId: 'session-a' }),
        seededTask('T-MIG-B', { targetSessionId: 'session-b' }),
        seededTask('T-MIG-UNK', { targetSessionId: 'session-unknown' }),
      ],
      prepareHome: (home) => {
        const registry = path.join(home, '.dsh', 'mesh-waker')
        const receipts = [
          { taskId: 'T-MIG-A', sessionId: 'session-a', status: 'completed' },
          { taskId: 'T-MIG-B', sessionId: 'session-b', status: 'completed' },
          { taskId: 'T-MIG-UNK', sessionId: 'session-unknown', status: 'completed' },
        ]
        fs.writeFileSync(path.join(registry, 'receipts.jsonl'), receipts.map((row) => JSON.stringify(row)).join('\n') + '\n')
      },
    })
    const wsA = [...new Set(linesOf(path.join(meshOf(h), 'ws', 'wt-mig-a', 'tasks.jsonl')).map((row) => row.taskId))]
    const wsB = [...new Set(linesOf(path.join(meshOf(h), 'ws', 'wt-mig-b', 'tasks.jsonl')).map((row) => row.taskId))]
    const local = linesOf(path.join(meshOf(h), 'local', 'tasks.jsonl'))
    const legacyTasks = fs.existsSync(path.join(meshOf(h), 'tasks.legacy.jsonl'))
    const receiptA = [...new Set(linesOf(path.join(meshOf(h), 'ws', 'wt-mig-a', 'receipts.jsonl')).map((row) => row.taskId))]
    const receiptLocal = [...new Set(linesOf(path.join(meshOf(h), 'local', 'receipts.jsonl')).map((row) => row.taskId))]
    const legacyReceipts = fs.existsSync(path.join(meshOf(h), 'receipts.legacy.jsonl'))
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
    const conditions = {
      wsA: wsA.includes('T-MIG-A'),
      wsB: wsB.includes('T-MIG-B'),
      unk: local.some((row) => row.taskId === 'T-MIG-UNK' && row.scopeUncertain === true),
      legacyTasks,
      receiptA: receiptA.includes('T-MIG-A'),
      receiptLocal: receiptLocal.includes('T-MIG-UNK'),
      legacyReceipts,
      log: /storage tiers: migrated tasks=3 receipts=3/.test(log),
    }
    const ok = Object.values(conditions).every(Boolean)
    const bad = Object.entries(conditions).filter(([, value]) => !value).map(([key]) => key)
    report('storage: legacy files migrate into tier files and are kept as legacy', ok, `wsA=${wsA.length} wsB=${wsB.length} local=${local.length} legacy=${legacyTasks}/${legacyReceipts} bad=${bad.join(',') || '-'}`)
  })

  await runCase('storage: a second boot does not migrate or duplicate again', async (boot) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-tier-idem-'))
    const cwd = path.join(os.tmpdir(), 'wt-idem-zone')
    try {
      const first = await boot({
        tmpRoot,
        seedSessions: [{ id: 'session-idem', title: 'worker', cwd }],
        tasksSeed: [seededTask('T-IDEM-1', { targetSessionId: 'session-idem' })],
      })
      await request(first.base, '/mesh/tasks')
      first.close()
      const afterFirst = new Set(
        linesOf(path.join(tmpRoot, 'home', '.dsh', 'mesh-waker', 'ws', 'wt-idem-zone', 'tasks.jsonl'))
          .filter((row) => row.taskId === 'T-IDEM-1')
          .map((row) => row.taskId),
      ).size
      const second = await boot({ tmpRoot, seedSessions: [{ id: 'session-idem', title: 'worker', cwd }] })
      await request(second.base, '/mesh/tasks')
      const afterSecond = new Set(
        linesOf(path.join(tmpRoot, 'home', '.dsh', 'mesh-waker', 'ws', 'wt-idem-zone', 'tasks.jsonl'))
          .filter((row) => row.taskId === 'T-IDEM-1')
          .map((row) => row.taskId),
      ).size
      const legacyGone = !fs.existsSync(path.join(tmpRoot, 'home', '.dsh', 'mesh-waker', 'tasks.jsonl'))
      const ok = afterFirst === 1 && afterSecond === 1 && legacyGone
      report('storage: a second boot does not migrate or duplicate again', ok, `first=${afterFirst} second=${afterSecond} legacyGone=${legacyGone}`)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  await runCase('storage: a failed migration leaves the legacy file untouched', async (boot) => {
    let before = ''
    const cwd = path.join(os.tmpdir(), 'wt-fail-zone')
    const h = await boot({
      seedSessions: [{ id: 'session-fail', title: 'worker', cwd }],
      config: { compactTaskText: false },
      tasksSeed: [seededTask('T-FAIL-MIG', { targetSessionId: 'session-fail', status: 'settled', settledAt: Date.now() - 1000 })],
      prepareHome: (home) => {
        const registry = path.join(home, '.dsh', 'mesh-waker')
        before = fs.readFileSync(path.join(registry, 'tasks.jsonl'), 'utf8')
        // A file where the ws/ directory should be makes every tier write fail.
        fs.writeFileSync(path.join(registry, 'ws'), 'not a directory')
      },
    })
    const legacyPath = path.join(meshOf(h), 'tasks.jsonl')
    const after = fs.existsSync(legacyPath) ? fs.readFileSync(legacyPath, 'utf8') : ''
    const listed = await request(h.base, '/mesh/tasks')
    const ok = before.length > 0 && after === before && listed.json?.total === 1
    report('storage: a failed migration leaves the legacy file untouched', ok, `unchanged=${after === before} listed=${listed.json?.total ?? '-'}`)
  })

  await runCase('storage: the task API aggregates local/ and every ws/ layer', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'wt-agg-a')
    const cwdB = path.join(os.tmpdir(), 'wt-agg-b')
    const h = await boot({
      seedSessions: [
        { id: 'session-agg-a', title: 'worker a', cwd: cwdA },
        { id: 'session-agg-b', title: 'worker b', cwd: cwdB },
      ],
      tasksSeed: [
        seededTask('T-AGG-A', { targetSessionId: 'session-agg-a' }),
        seededTask('T-AGG-B', { targetSessionId: 'session-agg-b' }),
        seededTask('T-AGG-UNK', { targetSessionId: 'session-unknown' }),
      ],
    })
    const listed = await request(h.base, '/mesh/tasks?limit=50')
    const ids = (listed.json?.tasks ?? []).map((row) => row.taskId).sort()
    const ok = listed.json?.total === 3 && JSON.stringify(ids) === JSON.stringify(['T-AGG-A', 'T-AGG-B', 'T-AGG-UNK'])
    report('storage: the task API aggregates local/ and every ws/ layer', ok, `total=${listed.json?.total ?? '-'} ids=${ids.join(',')}`)
  })

  await runCase('storage: workspaces.json keeps human edits and only adds new cwds', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'wt-keep-a')
    const cwdB = path.join(os.tmpdir(), 'wt-keep-b')
    const h = await boot({
      seedSessions: [
        { id: 'session-keep-a', title: 'mesh · 协调', cwd: cwdA },
        { id: 'session-keep-b', title: 'worker b', cwd: cwdB },
      ],
      prepareHome: (home) => {
        const registry = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(registry, { recursive: true })
        const seededRegistry = {
          machine: 'test-machine',
          workspaces: {
            'wt-keep-a': { cwd: cwdA, coordinator: 'session-keep-a', roles: ['custom-role'] },
          },
        }
        fs.writeFileSync(path.join(registry, 'workspaces.json'), `${JSON.stringify(seededRegistry, null, 2)}\n`)
      },
    })
    const registry = JSON.parse(fs.readFileSync(path.join(meshOf(h), 'workspaces.json'), 'utf8'))
    const ok =
      registry.machine === 'test-machine' &&
      JSON.stringify(registry.workspaces?.['wt-keep-a']?.roles) === JSON.stringify(['custom-role']) &&
      registry.workspaces?.['wt-keep-a']?.coordinator === 'session-keep-a' &&
      Boolean(registry.workspaces?.['wt-keep-b'])
    report('storage: workspaces.json keeps human edits and only adds new cwds', ok, `machine=${registry.machine} aRoles=${JSON.stringify(registry.workspaces?.['wt-keep-a']?.roles)} b=${Boolean(registry.workspaces?.['wt-keep-b'])}`)
  })



  // 242-246. Receipt tiers (T-300): a receipt must sit in the same layer as its task row,
  // and historical mismatches are realigned once (append first, verify, then remove).
  await runCase('storage: a cross-workspace receipt stays in local/ with its task', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'wt-receipt-a')
    const cwdB = path.join(os.tmpdir(), 'wt-receipt-b')
    const h = await boot({
      seedSessions: [
        { id: 'session-receipt-req', title: 'mesh · 协调', cwd: cwdB },
        { id: 'session-receipt-target', title: 'worker', cwd: cwdA },
      ],
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'cross receipt work', meta: { taskId: 'T-RCPT-CROSS', requester: 'session-receipt-req' } },
    })
    h.emit('session/event', { id: 'session-receipt-target' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-receipt-target' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const localReceipt = await waitFor(
      () => linesOf(path.join(meshOf(h), 'local', 'receipts.jsonl')).find((row) => row.taskId === 'T-RCPT-CROSS'),
      4000,
    )
    const wsReceipts = linesOf(path.join(meshOf(h), 'ws', 'wt-receipt-a', 'receipts.jsonl')).filter((row) => row.taskId === 'T-RCPT-CROSS')
    const taskRow = linesOf(path.join(meshOf(h), 'local', 'tasks.jsonl')).find((row) => row.taskId === 'T-RCPT-CROSS')
    // The dispatcher lives in wt-receipt-b and looks up ws/wt-receipt-b/ then local/; the
    // local hit is exactly what findRecord() returns for a scope=machine task.
    const ok = Boolean(localReceipt) && wsReceipts.length === 0 && taskRow?.scope === 'machine'
    report('storage: a cross-workspace receipt stays in local/ with its task', ok, `local=${Boolean(localReceipt)} ws=${wsReceipts.length} taskScope=${taskRow?.scope ?? '-'}`)
  })

  await runCase('storage: a same-workspace receipt stays in ws/<slug>/', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'wt-receipt-same')
    const h = await boot({
      seedSessions: [
        { id: 'session-same-req', title: 'mesh · 协调', cwd },
        { id: 'session-same-target', title: 'worker', cwd },
      ],
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'same receipt work', meta: { taskId: 'T-RCPT-SAME', requester: 'session-same-req' } },
    })
    h.emit('session/event', { id: 'session-same-target' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-same-target' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const wsReceipt = await waitFor(
      () => linesOf(path.join(meshOf(h), 'ws', 'wt-receipt-same', 'receipts.jsonl')).find((row) => row.taskId === 'T-RCPT-SAME'),
      4000,
    )
    const localReceipts = linesOf(path.join(meshOf(h), 'local', 'receipts.jsonl')).filter((row) => row.taskId === 'T-RCPT-SAME')
    const ok = Boolean(wsReceipt) && localReceipts.length === 0
    report('storage: a same-workspace receipt stays in ws/<slug>/', ok, `ws=${Boolean(wsReceipt)} local=${localReceipts.length}`)
  })

  await runCase('storage: a historical mis-tiered receipt is realigned once', async (boot) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-realign-'))
    const logFile = path.join(tmpRoot, 'realign.log')
    const logFile2 = path.join(tmpRoot, 'realign-2.log')
    const cwdA = path.join(os.tmpdir(), 'wt-realign-a')
    const cwdB = path.join(os.tmpdir(), 'wt-realign-b')
    const seeds = [
      { id: 'session-realign-req', title: 'mesh · 协调', cwd: cwdB },
      { id: 'session-realign-target', title: 'worker', cwd: cwdA },
    ]
    try {
      const first = await boot({
        tmpRoot,
        config: { logFile },
        seedSessions: seeds,
        prepareHome: (home) => {
          const registry = path.join(home, '.dsh', 'mesh-waker')
          fs.mkdirSync(path.join(registry, 'local'), { recursive: true })
          fs.mkdirSync(path.join(registry, 'ws', 'wt-realign-a'), { recursive: true })
          fs.writeFileSync(
            path.join(registry, 'local', 'tasks.jsonl'),
            `${JSON.stringify(seededTask('T-RCPT-OLD', {
              scope: 'machine',
              origin: 'test-machine/wt-realign-b',
              peers: ['test-machine/wt-realign-a'],
              targetSessionId: 'session-realign-target',
              status: 'settled',
              settledAt: Date.now() - 1000,
            }))}\n`,
          )
          fs.writeFileSync(
            path.join(registry, 'ws', 'wt-realign-a', 'receipts.jsonl'),
            `${JSON.stringify({ taskId: 'T-RCPT-OLD', sessionId: 'session-realign-target', status: 'completed', kind: 'task' })}\n`,
          )
        },
      })
      const localReceipt = linesOf(path.join(meshOf(first), 'local', 'receipts.jsonl')).filter((row) => row.taskId === 'T-RCPT-OLD')
      const wsReceipt = linesOf(path.join(meshOf(first), 'ws', 'wt-realign-a', 'receipts.jsonl')).filter((row) => row.taskId === 'T-RCPT-OLD')
      const firstLog = fs.readFileSync(logFile, 'utf8')
      first.close()
      const second = await boot({ tmpRoot, config: { logFile: logFile2 }, seedSessions: seeds })
      const localAfter = linesOf(path.join(tmpRoot, 'home', '.dsh', 'mesh-waker', 'local', 'receipts.jsonl')).filter((row) => row.taskId === 'T-RCPT-OLD')
      const secondLog = fs.readFileSync(logFile2, 'utf8')
      const ok =
        localReceipt.length === 1 &&
        wsReceipt.length === 0 &&
        /tiers: receipts realigned 1/.test(firstLog) &&
        localAfter.length === 1 &&
        !/tiers: receipts realigned/.test(secondLog)
      report('storage: a historical mis-tiered receipt is realigned once', ok, `local=${localReceipt.length} ws=${wsReceipt.length} afterSecond=${localAfter.length} idempotent=${!/tiers: receipts realigned/.test(secondLog)}`)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  await runCase('storage: an orphan receipt is left alone and logged', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'wt-orphan-a')
    const logFile = path.join(os.tmpdir(), `waker-orphan-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile },
      seedSessions: [{ id: 'session-orphan-a', title: 'worker', cwd }],
      prepareHome: (home) => {
        const registry = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(path.join(registry, 'ws', 'wt-orphan-a'), { recursive: true })
        fs.writeFileSync(
          path.join(registry, 'ws', 'wt-orphan-a', 'receipts.jsonl'),
          `${JSON.stringify({ taskId: 'T-ORPHAN-RCPT', status: 'completed' })}\n`,
        )
      },
    })
    const kept = linesOf(path.join(meshOf(h), 'ws', 'wt-orphan-a', 'receipts.jsonl')).filter((row) => row.taskId === 'T-ORPHAN-RCPT')
    const log = fs.readFileSync(logFile, 'utf8')
    const ok = kept.length === 1 && /tiers: receipt realign skipped 1/.test(log)
    report('storage: an orphan receipt is left alone and logged', ok, `kept=${kept.length} logged=${/realign skipped 1/.test(log)}`)
  })

  await runCase('storage: a failed realign leaves the source receipt intact', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'wt-realign-fail-a')
    const cwdB = path.join(os.tmpdir(), 'wt-realign-fail-b')
    const logFile = path.join(os.tmpdir(), `waker-realign-fail-${process.pid}-${Date.now()}.log`)
    let sourceBefore = ''
    const h = await boot({
      config: { logFile },
      seedSessions: [
        { id: 'session-fail-req', title: 'mesh · 协调', cwd: cwdB },
        { id: 'session-fail-target', title: 'worker', cwd: cwdA },
      ],
      prepareHome: (home) => {
        const registry = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(path.join(registry, 'local'), { recursive: true })
        fs.mkdirSync(path.join(registry, 'ws', 'wt-realign-fail-a'), { recursive: true })
        fs.writeFileSync(
          path.join(registry, 'local', 'tasks.jsonl'),
          `${JSON.stringify(seededTask('T-RCPT-FAIL', {
            scope: 'machine',
            targetSessionId: 'session-fail-target',
            status: 'settled',
            settledAt: Date.now() - 1000,
          }))}\n`,
        )
        const source = path.join(registry, 'ws', 'wt-realign-fail-a', 'receipts.jsonl')
        sourceBefore = `${JSON.stringify({ taskId: 'T-RCPT-FAIL', status: 'completed' })}\n`
        fs.writeFileSync(source, sourceBefore)
        // A directory where the destination file must be makes the append fail (EISDIR).
        fs.mkdirSync(path.join(registry, 'local', 'receipts.jsonl'), { recursive: true })
      },
    })
    const sourceAfter = fs.readFileSync(path.join(meshOf(h), 'ws', 'wt-realign-fail-a', 'receipts.jsonl'), 'utf8')
    const log = fs.readFileSync(logFile, 'utf8')
    const ok = sourceAfter === sourceBefore && /tiers: receipt realign aborted before touching sources/.test(log)
    report('storage: a failed realign leaves the source receipt intact', ok, `unchanged=${sourceAfter === sourceBefore} aborted=${/realign aborted/.test(log)}`)
  })

  // 247-251. Task id uniqueness (T-301): a duplicate id in the same tier file is ambiguous,
  // so it is rejected for a different target, allowed for the same one, and cross-workspace
  // bare ids carry a namespacing warning (opt-in rejection via requireNamespacedIds).
  await runCase('tasks: re-dispatching the same id to the same target is allowed', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-dup-a', title: 'worker a' }] })
    const first = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker a', text: 'one', meta: { taskId: 'T-DUP-SAME' } },
    })
    const second = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker a', text: 'two', meta: { taskId: 'T-DUP-SAME' } },
    })
    const ok = first.status === 200 && second.status === 200 && second.json?.taskId === 'T-DUP-SAME'
    report('tasks: re-dispatching the same id to the same target is allowed', ok, `first=${first.status} second=${second.status}`)
  })

  await runCase('tasks: the same id for a different target is rejected with a conflict', async (boot) => {
    const logFile = path.join(os.tmpdir(), `waker-collision-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile },
      seedSessions: [
        { id: 'session-dup-x', title: 'worker x' },
        { id: 'session-dup-y', title: 'worker y' },
      ],
    })
    const first = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker x', text: 'mine', meta: { taskId: 'T-DUP-CONFLICT' } },
    })
    const conflict = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker y', text: 'not mine', meta: { taskId: 'T-DUP-CONFLICT' } },
    })
    const log = fs.readFileSync(logFile, 'utf8')
    const ok =
      first.status === 200 &&
      conflict.status === 409 &&
      conflict.json?.conflict?.taskId === 'T-DUP-CONFLICT' &&
      conflict.json?.conflict?.existingTarget === 'session-dup-x' &&
      conflict.json?.conflict?.requestedTarget === 'session-dup-y' &&
      /task id collision rejected: T-DUP-CONFLICT/.test(log)
    report('tasks: the same id for a different target is rejected with a conflict', ok, `status=${conflict.status} existing=${conflict.json?.conflict?.existingTarget ?? '-'} logged=${/collision rejected/.test(log)}`)
  })

  await runCase('tasks: the same id in two layers is allowed but warns', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'wt-idlayer-a')
    const cwdB = path.join(os.tmpdir(), 'wt-idlayer-b')
    const logFile = path.join(os.tmpdir(), `waker-idlayer-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile },
      seedSessions: [
        { id: 'session-idlayer-coord', title: 'mesh · 协调', cwd: cwdB },
        { id: 'session-idlayer-worker', title: 'worker', cwd: cwdA },
      ],
    })
    // Cross-workspace first: the row goes to local/. Then the same id inside the
    // coordinator's own workspace goes to ws/<slugB>/ — a different file, so no conflict.
    const cross = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'cross', meta: { taskId: 'T-SHARED-ID', requester: 'session-idlayer-coord' } },
    })
    const same = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'mesh · 协调', text: 'same layer', meta: { taskId: 'T-SHARED-ID', requester: 'session-idlayer-coord' } },
    })
    const localRows = linesOf(path.join(meshOf(h), 'local', 'tasks.jsonl')).filter((row) => row.taskId === 'T-SHARED-ID')
    const wsRows = linesOf(path.join(meshOf(h), 'ws', 'wt-idlayer-b', 'tasks.jsonl')).filter((row) => row.taskId === 'T-SHARED-ID')
    const log = fs.readFileSync(logFile, 'utf8')
    const ok =
      cross.status === 200 &&
      same.status === 200 &&
      localRows.length === 1 &&
      wsRows.length === 1 &&
      /WARN task id T-SHARED-ID also exists in local\//.test(log)
    report('tasks: the same id in two layers is allowed but warns', ok, `cross=${cross.status} same=${same.status} local=${localRows.length} ws=${wsRows.length} warned=${/also exists in local/.test(log)}`)
  })

  await runCase('tasks: a bare cross-workspace id carries a namespacing warning', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'wt-ns-a')
    const cwdB = path.join(os.tmpdir(), 'wt-ns-b')
    const h = await boot({
      seedSessions: [
        { id: 'session-ns-coord', title: 'mesh · 协调', cwd: cwdB },
        { id: 'session-ns-worker', title: 'worker', cwd: cwdA },
      ],
    })
    const res = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'cross work', meta: { taskId: 'T-NONAME', requester: 'session-ns-coord' } },
    })
    const ok = res.status === 200 && /namespaced/.test(res.json?.warning ?? '')
    report('tasks: a bare cross-workspace id carries a namespacing warning', ok, `status=${res.status} warning=${res.json?.warning ?? '-'}`)
  })

  await runCase('tasks: requireNamespacedIds rejects bare cross-workspace ids', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'wt-ns2-a')
    const cwdB = path.join(os.tmpdir(), 'wt-ns2-b')
    const h = await boot({
      config: { requireNamespacedIds: true },
      seedSessions: [
        { id: 'session-ns2-coord', title: 'mesh · 协调', cwd: cwdB },
        { id: 'session-ns2-worker', title: 'worker', cwd: cwdA },
      ],
    })
    const bare = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'cross work', meta: { taskId: 'T-BARE', requester: 'session-ns2-coord' } },
    })
    const namespaced = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'cross work', meta: { taskId: 'dsh-mesh/T-BARE2', requester: 'session-ns2-coord' } },
    })
    const ok = bare.status === 400 && /must be namespaced/.test(bare.json?.error ?? '') && namespaced.status === 200
    report('tasks: requireNamespacedIds rejects bare cross-workspace ids', ok, `bare=${bare.status} namespaced=${namespaced.status}`)
  })

  // 193-197. Code fingerprint staleness (T-284): same-version code changes must be visible.
  // A temp copy of index.js + package.json is used through MESH_WAKER_SELF_FILE so the suite
  // never touches the real plugin file.
  const withFakePlugin = async (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-self-'))
    fs.copyFileSync(path.join(__dirname, '..', 'plugins', 'mesh-waker', 'index.js'), path.join(dir, 'index.js'))
    // Track the real package version instead of hardcoding it: a version bump must not turn
    // these staleness cases red (T-309). The version-change case below deliberately writes a
    // different version on top of this.
    const realVersion = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'plugins', 'mesh-waker', 'package.json'), 'utf8'),
    ).version
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-mesh-waker', version: realVersion }))
    const previous = process.env.MESH_WAKER_SELF_FILE
    process.env.MESH_WAKER_SELF_FILE = path.join(dir, 'index.js')
    try {
      return await fn(dir)
    } finally {
      if (previous === undefined) delete process.env.MESH_WAKER_SELF_FILE
      else process.env.MESH_WAKER_SELF_FILE = previous
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  const versionsOf = async (h) => (await request(h.base, '/mesh/status')).json?.pluginVersions ?? {}

  await runCase('stale: a same-version code change on disk reports codeStale', async (boot) => {
    await withFakePlugin(async (dir) => {
      const h = await boot({})
      const before = await versionsOf(h)
      fs.appendFileSync(path.join(dir, 'index.js'), '\n// edited after boot\n')
      const after = await versionsOf(h)
      const forced = (await request(h.base, '/mesh/status?refresh=1')).json?.pluginVersions ?? {}
      const ok =
        before.codeStale === false &&
        before.stale === false &&
        after.codeStale === false && // 5s cache: no refresh yet
        forced.codeStale === true &&
        forced.stale === true &&
        forced.versionStale === false &&
        forced.codeHash !== forced.diskCodeHash
      report('stale: a same-version code change on disk reports codeStale', ok, `before=${before.codeStale}/${before.stale} cached=${after.codeStale} forced=${forced.codeStale}/${forced.stale} hashes=${forced.codeHash}/${forced.diskCodeHash}`)
    })
  })

  await runCase('stale: a version change still reports stale without a code change', async (boot) => {
    await withFakePlugin(async (dir) => {
      const h = await boot({})
      const before = await versionsOf(h)
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-mesh-waker', version: '9.9.9' }))
      const forced = (await request(h.base, '/mesh/status?refresh=1')).json?.pluginVersions ?? {}
      const ok =
        before.stale === false &&
        forced.versionStale === true &&
        forced.codeStale === false &&
        forced.stale === true &&
        forced.disk === '9.9.9'
      report('stale: a version change still reports stale without a code change', ok, `versionStale=${forced.versionStale} codeStale=${forced.codeStale} disk=${forced.disk}`)
    })
  })

  await runCase('stale: unchanged code and version stay quiet', async (boot) => {
    await withFakePlugin(async () => {
      const h = await boot({})
      const versions = await versionsOf(h)
      const ok =
        versions.codeStale === false &&
        versions.versionStale === false &&
        versions.stale === false &&
        typeof versions.codeHash === 'string' &&
        versions.codeHash.length === 12 &&
        versions.codeHash === versions.diskCodeHash &&
        typeof versions.bootedAt === 'string'
      report('stale: unchanged code and version stay quiet', ok, `codeStale=${versions.codeStale} stale=${versions.stale} hashes=${versions.codeHash}/${versions.diskCodeHash}`)
    })
  })

  await runCase('stale: the fake plugin tracks the real package version', async (boot) => {
    await withFakePlugin(async (dir) => {
      const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'mesh-waker', 'package.json'), 'utf8'))
      const h = await boot({})
      const versions = await versionsOf(h)
      // Guards the fixture itself: if it drifts from the real version (e.g. a bump leaves a
      // hardcoded value behind), versionStale turns true and this case fails loudly (T-309).
      const ok =
        fixture.version === real.version &&
        versions.versionStale === false &&
        versions.codeStale === false &&
        versions.stale === false
      report('stale: the fake plugin tracks the real package version', ok, `fixture=${fixture.version} real=${real.version} versionStale=${versions.versionStale} stale=${versions.stale}`)
    })
  })

  await runCase('stale: an unreadable own file reports null instead of throwing', async (boot) => {
    const previous = process.env.MESH_WAKER_SELF_FILE
    process.env.MESH_WAKER_SELF_FILE = path.join(os.tmpdir(), `missing-self-${process.pid}-${Date.now()}.js`)
    try {
      const h = await boot({})
      const versions = await versionsOf(h)
      const ok =
        versions.codeStale === null &&
        versions.stale === false &&
        versions.codeHash === null &&
        versions.diskCodeHash === null &&
        versions.disk === null
      report('stale: an unreadable own file reports null instead of throwing', ok, `codeStale=${versions.codeStale} codeHash=${versions.codeHash} disk=${versions.disk}`)
    } finally {
      if (previous === undefined) delete process.env.MESH_WAKER_SELF_FILE
      else process.env.MESH_WAKER_SELF_FILE = previous
    }
  })

  await runCase('stale: refresh=1 recomputes past the five-second cache', async (boot) => {
    await withFakePlugin(async (dir) => {
      const h = await boot({})
      const first = await versionsOf(h)
      fs.appendFileSync(path.join(dir, 'index.js'), '\n// cache probe\n')
      const cached = await versionsOf(h)
      const refreshed = (await request(h.base, '/mesh/status?refresh=1')).json?.pluginVersions ?? {}
      const ok =
        first.codeStale === false &&
        cached.codeStale === false &&
        cached.diskCodeHash === first.diskCodeHash &&
        refreshed.codeStale === true &&
        refreshed.diskCodeHash !== first.diskCodeHash
      report('stale: refresh=1 recomputes past the five-second cache', ok, `cached=${cached.codeStale} refreshed=${refreshed.codeStale} hashes=${first.diskCodeHash}/${refreshed.diskCodeHash}`)
    })
  })

  // 197b. Fingerprint coverage (T-339): the browser bundle and lib/**/*.mjs are loaded code
  // too; hashing index.js alone reported "fresh" while the page still ran the old UI.
  const withFakePluginTree = async (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-tree-'))
    const realPlugin = path.join(__dirname, '..', 'plugins', 'mesh-waker')
    fs.copyFileSync(path.join(realPlugin, 'index.js'), path.join(dir, 'index.js'))
    fs.writeFileSync(path.join(dir, 'client.js'), '// client bundle\n')
    fs.mkdirSync(path.join(dir, 'lib'))
    fs.writeFileSync(path.join(dir, 'lib', 'a.mjs'), 'export const a = 1\n')
    fs.writeFileSync(path.join(dir, 'lib', 'b.mjs'), 'export const b = 2\n')
    const realVersion = JSON.parse(fs.readFileSync(path.join(realPlugin, 'package.json'), 'utf8')).version
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-mesh-waker', version: realVersion }))
    const previous = process.env.MESH_WAKER_SELF_FILE
    process.env.MESH_WAKER_SELF_FILE = path.join(dir, 'index.js')
    try {
      return await fn(dir)
    } finally {
      if (previous === undefined) delete process.env.MESH_WAKER_SELF_FILE
      else process.env.MESH_WAKER_SELF_FILE = previous
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  await runCase('stale: editing client.js is detected and named', async (boot) => {
    await withFakePluginTree(async (dir) => {
      const h = await boot({})
      const before = (await request(h.base, '/mesh/status?refresh=1')).json?.pluginVersions ?? {}
      fs.appendFileSync(path.join(dir, 'client.js'), '\n// ui edit\n')
      const after = (await request(h.base, '/mesh/status?refresh=1')).json?.pluginVersions ?? {}
      const ok =
        before.codeStale === false &&
        before.codeDiff.length === 0 &&
        after.codeStale === true &&
        after.codeDiff.includes('client.js') &&
        after.codeFileCount >= 4
      report('stale: editing client.js is detected and named', ok, `before=${before.codeStale} after=${after.codeStale} diff=${(after.codeDiff ?? []).join('|')} count=${after.codeFileCount}`)
    })
  })

  await runCase('stale: editing a lib module is detected and named', async (boot) => {
    await withFakePluginTree(async (dir) => {
      const h = await boot({})
      fs.appendFileSync(path.join(dir, 'lib', 'a.mjs'), '\n// lib edit\n')
      const after = (await request(h.base, '/mesh/status?refresh=1')).json?.pluginVersions ?? {}
      const ok = after.codeStale === true && after.codeDiff.includes('lib/a.mjs') && !after.codeDiff.includes('lib/b.mjs')
      report('stale: editing a lib module is detected and named', ok, `stale=${after.codeStale} diff=${(after.codeDiff ?? []).join('|')}`)
    })
  })

  await runCase('stale: untouched files stay quiet with the expanded fingerprint', async (boot) => {
    await withFakePluginTree(async () => {
      const h = await boot({})
      const versions = (await request(h.base, '/mesh/status?refresh=1')).json?.pluginVersions ?? {}
      const ok = versions.codeStale === false && versions.stale === false && Array.isArray(versions.codeDiff) && versions.codeDiff.length === 0 && versions.codeHash === versions.diskCodeHash
      report('stale: untouched files stay quiet with the expanded fingerprint', ok, `codeStale=${versions.codeStale} diff=${(versions.codeDiff ?? []).length} count=${versions.codeFileCount}`)
    })
  })

  await runCase('stale: restoring the original content clears codeStale (content, not mtime)', async (boot) => {
    await withFakePluginTree(async (dir) => {
      const h = await boot({})
      const original = fs.readFileSync(path.join(dir, 'client.js'), 'utf8')
      fs.writeFileSync(path.join(dir, 'client.js'), original + '\n// ui edit\n')
      const dirty = (await request(h.base, '/mesh/status?refresh=1')).json?.pluginVersions ?? {}
      fs.writeFileSync(path.join(dir, 'client.js'), original)
      const restored = (await request(h.base, '/mesh/status?refresh=1')).json?.pluginVersions ?? {}
      const ok = dirty.codeStale === true && dirty.codeDiff.includes('client.js') && restored.codeStale === false && restored.codeDiff.length === 0
      report('stale: restoring the original content clears codeStale (content, not mtime)', ok, `dirty=${dirty.codeStale} restored=${restored.codeStale}`)
    })
  })

  // T-343: the settings page dropped its read-only right-tab diagnostic row; the browser half
  // reports that state to /mesh/status instead, so nothing is lost for diagnostics.
  await runCase('status: the browser half can report its right-tab state', async (boot) => {
    const h = await boot({})
    const before = await request(h.base, '/mesh/status')
    const posted = await request(h.base, '/mesh/ui-state', { method: 'POST', body: { rightTab: 'ok' } })
    const after = await request(h.base, '/mesh/status')
    const ok =
      before.json?.ui?.rightTab === null &&
      posted.json?.ok === true &&
      after.json?.ui?.rightTab === 'ok' &&
      typeof after.json?.ui?.reportedAt === 'string'
    report('status: the browser half can report its right-tab state', ok, `before=${JSON.stringify(before.json?.ui)} after=${JSON.stringify(after.json?.ui)}`)
  })
  // ephemeral cleanup, and idempotent convergence of registries written before this change.
  const registryOf = (h) => JSON.parse(fs.readFileSync(path.join(h.home, '.dsh', 'mesh-waker', 'workspaces.json'), 'utf8'))
  const wsDirOf = (h, slug) => path.join(h.home, '.dsh', 'mesh-waker', 'ws', slug)
  const workspacesFileOf = (h) => path.join(h.home, '.dsh', 'mesh-waker', 'workspaces.json')

  // T-370: the API used to answer from the boot-time snapshot, so a file edited on disk was
  // invisible until a restart (and a later save would write the stale map back).
  await runCase('workspaces: the API reflects an external file change immediately', async (boot) => {
    const h = await boot({})
    const file = workspacesFileOf(h)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const write = (coordinator) =>
      fs.writeFileSync(
        file,
        JSON.stringify({ machine: 'test-pc', workspaces: { 'dsh-mesh': { cwd: path.join('virtual', 'dsh-mesh', 'public'), coordinator } } }, null, 2),
      )
    write('session-file-1')
    const first = await request(h.base, '/mesh/workspaces')
    write('session-file-2')
    const second = await request(h.base, '/mesh/workspaces')
    const reload = await request(h.base, '/mesh/workspaces/reload', { method: 'POST' })
    const ok =
      first.json?.workspaces?.['dsh-mesh']?.coordinator === 'session-file-1' &&
      second.json?.workspaces?.['dsh-mesh']?.coordinator === 'session-file-2' &&
      second.json?.source === 'file' &&
      reload.json?.ok === true &&
      typeof reload.json?.reloadedAt === 'string' &&
      typeof reload.json?.workspaceCount === 'number'
    report('workspaces: the API reflects an external file change immediately', ok, `first=${first.json?.workspaces?.['dsh-mesh']?.coordinator ?? '-'} second=${second.json?.workspaces?.['dsh-mesh']?.coordinator ?? '-'} reload=${reload.json?.ok ?? '-'}`)
  })

  await runCase('workspaces: ensureWorkspace never rolls back the file or forks a -2 slug', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'virtual-ws-370', 'dsh-mesh', 'public')
    const h = await boot({ seedSessions: [{ id: 'session-ws-370', title: 'ws worker', cwd }] })
    const file = workspacesFileOf(h)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ machine: 'test-pc', workspaces: { 'dsh-mesh': { cwd, coordinator: 'session-file-coord' } } }, null, 2))
    // Three operations that route through ensureWorkspace(cwd): none may write a stale map.
    for (let index = 0; index < 3; index += 1) {
      const injected = await request(h.base, '/mesh/inject', {
        method: 'POST',
        body: { session: 'session-ws-370', text: `ws task ${index}`, meta: { taskId: `T-WS370-${index}` } },
      })
      if (injected.status !== 200) throw new Error(`inject ${index} failed: ${injected.status} ${injected.text.slice(0, 200)}`)
    }
    const after = registryOf(h)
    const slugs = Object.keys(after.workspaces ?? {})
    const entry = after.workspaces?.['dsh-mesh'] ?? {}
    const ok = slugs.length === 1 && slugs[0] === 'dsh-mesh' && entry.cwd === cwd && entry.coordinator === 'session-file-coord'
    report('workspaces: ensureWorkspace never rolls back the file or forks a -2 slug', ok, `slugs=${slugs.join(',')} cwd=${entry.cwd === cwd} coordinator=${entry.coordinator ?? '-'}`)
  })

  await runCase('workspaces: workers expose missing, archived and dormant separately', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'virtual-ws-372', 'dsh-mesh', 'public')
    const h = await boot({
      seedSessions: [
        { id: 'session-worker-docs', title: 'dsh-mesh · docs', cwd },
        { id: 'session-worker-waker', title: 'dsh-mesh · waker', cwd },
      ],
    })
    h.state.agents.set('session-worker-docs', {})
    const file = workspacesFileOf(h)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          machine: 'test-pc',
          workspaces: {
            'dsh-mesh': {
              cwd,
              workers: {
                docs: { sessionId: 'session-worker-docs' },
                ops: { sessionId: 'session-missing' },
                waker: { sessionId: 'session-worker-waker' },
              },
            },
          },
        },
        null,
        2,
      ),
    )
    const first = await request(h.base, '/mesh/workspaces')
    const docs = first.json?.workspaces?.['dsh-mesh']?.workers?.docs
    const ops = first.json?.workspaces?.['dsh-mesh']?.workers?.ops
    const waker = first.json?.workspaces?.['dsh-mesh']?.workers?.waker
    const written = await request(h.base, '/mesh/workspaces/workers', {
      method: 'POST',
      body: { slug: 'dsh-mesh', role: 'hub', sessionId: 'session-worker-docs', scopes: ['mesh'] },
    })
    const second = await request(h.base, '/mesh/workspaces')
    const hub = second.json?.workspaces?.['dsh-mesh']?.workers?.hub
    const ok =
      docs?.dormant === false &&
      docs?.stale === false &&
      ops?.missing === true &&
      ops?.stale === true &&
      // Seeded but not loaded: deliverable (dormant), not an addressing error.
      waker?.dormant === true &&
      waker?.stale === false &&
      written.json?.ok === true &&
      hub?.sessionId === 'session-worker-docs' &&
      JSON.stringify(hub?.scopes) === JSON.stringify(['mesh'])
    report('workspaces: workers expose missing, archived and dormant separately', ok, `docs=${docs?.dormant}/${docs?.stale} ops=${ops?.missing}/${ops?.stale} waker=${waker?.dormant}/${waker?.stale} written=${written.json?.ok ?? '-'}`)
  })

  await runCase('workspaces: a generic basename uses the parent project name', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'dsh-mesh', 'public')
    const h = await boot({ seedSessions: [{ id: 'session-generic', title: 'worker', cwd }] })
    const registry = registryOf(h)
    const ok = Boolean(registry.workspaces?.['dsh-mesh']) && !registry.workspaces?.public
    report('workspaces: a generic basename uses the parent project name', ok, `slugs=${Object.keys(registry.workspaces ?? {}).join(',')}`)
  })

  await runCase('workspaces: a specific basename keeps its own name', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'util4freesub')
    const h = await boot({ seedSessions: [{ id: 'session-specific', title: 'worker', cwd }] })
    const registry = registryOf(h)
    const ok = Boolean(registry.workspaces?.util4freesub)
    report('workspaces: a specific basename keeps its own name', ok, `slugs=${Object.keys(registry.workspaces ?? {}).join(',')}`)
  })

  await runCase('workspaces: one realpath under two spellings collapses to one entry', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'same-repo')
    const variant = `${cwd.toUpperCase()}${path.sep}`
    const h = await boot({
      seedSessions: [
        { id: 'session-spell-a', title: 'worker a', cwd },
        { id: 'session-spell-b', title: 'worker b', cwd: variant },
      ],
    })
    const registry = registryOf(h)
    const entries = Object.values(registry.workspaces ?? {}).filter((entry) => /same-repo/i.test(entry.cwd ?? ''))
    const ok = entries.length === 1
    report('workspaces: one realpath under two spellings collapses to one entry', ok, `entries=${entries.length} slugs=${Object.keys(registry.workspaces ?? {}).join(',')}`)
  })

  await runCase('workspaces: an all-selftest cwd is dropped and its empty ws directory pruned', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'ask3-selftest-abc123')
    const h = await boot({
      seedSessions: [{ id: 'session-ephemeral', title: 'test-ask-ephemeral', cwd }],
      prepareHome: (home) => {
        const registryDir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(path.join(registryDir, 'ws', 'ask3-selftest-abc123'), { recursive: true })
        fs.writeFileSync(path.join(registryDir, 'ws', 'ask3-selftest-abc123', 'tasks.jsonl'), '')
        fs.writeFileSync(
          path.join(registryDir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { 'ask3-selftest-abc123': { cwd, roles: [] } } }, null, 2)}\n`,
        )
      },
    })
    const registry = registryOf(h)
    const ok = !registry.workspaces?.['ask3-selftest-abc123'] && !fs.existsSync(wsDirOf(h, 'ask3-selftest-abc123'))
    report('workspaces: an all-selftest cwd is dropped and its empty ws directory pruned', ok, `entries=${Object.keys(registry.workspaces ?? {}).join(',')}`)
  })

  await runCase('workspaces: a title never makes a coordinator', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'coord-repo')
    const now = Date.now()
    const h = await boot({
      seedSessions: [
        { id: 'session-coord-old', title: 'mesh · 协调', cwd, mtime: now - 10 * 24 * 60 * 60 * 1000 },
        { id: 'session-coord-new', title: 'mesh · 协调', cwd, mtime: now - 60 * 60 * 1000 },
        { id: 'session-coord-worker', title: 'mesh · ops', cwd, mtime: now },
      ],
    })
    const entry = registryOf(h).workspaces?.['coord-repo']
    const ok = !entry?.coordinator && JSON.stringify(entry?.roles) === JSON.stringify(['ops'])
    report('workspaces: a title never makes a coordinator', ok, `coordinator=${entry?.coordinator ?? '-'} roles=${JSON.stringify(entry?.roles ?? [])}`)
  })

  await runCase('workspaces: an idle title is not a coordinator', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'stale-coord-repo')
    const logFile = path.join(os.tmpdir(), `waker-ws-stale-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile },
      seedSessions: [{ id: 'session-coord-idle', title: 'mesh · coordinator', cwd, mtime: Date.now() - 8 * 24 * 60 * 60 * 1000 }],
    })
    const registry = registryOf(h)
    const entry = registry.workspaces?.['stale-coord-repo']
    const ok = !entry?.coordinator && entry?.coordinatorStale !== true
    report('workspaces: an idle title is not a coordinator', ok, `coordinator=${entry?.coordinator ?? '-'} stale=${entry?.coordinatorStale ?? false}`)
  })

  // T-376: an archived session can still be live and have the newest last_active (DSH refuses
  // to delete live sessions), so derivation must exclude archived ones instead of picking them.
  await runCase('workspaces: an archived title is not a coordinator', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'archived-coord-repo')
    const now = Date.now()
    const h = await boot({
      seedSessions: [
        { id: 'session-coord-live', title: 'mesh · 协调', cwd, mtime: now - 60 * 60 * 1000 },
        { id: 'session-coord-archived', title: 'mesh · 协调', cwd, mtime: now },
      ],
      archivedIds: ['session-coord-archived'],
    })
    const entry = registryOf(h).workspaces?.['archived-coord-repo']
    const ok = !entry?.coordinator
    report('workspaces: an archived title is not a coordinator', ok, `coordinator=${entry?.coordinator ?? '-'}`)
  })

  await runCase('workspaces: an archived-only title leaves no coordinator', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'only-archived-coord-repo')
    const h = await boot({
      seedSessions: [{ id: 'session-coord-gone', title: 'mesh · 协调', cwd, mtime: Date.now() }],
      archivedIds: ['session-coord-gone'],
    })
    const entry = registryOf(h).workspaces?.['only-archived-coord-repo']
    const ok = entry !== undefined && !entry?.coordinator
    report('workspaces: an archived-only title leaves no coordinator', ok, `coordinator=${entry?.coordinator ?? '(none)'}`)
  })

  await runCase('workspaces: workers are explicit, never derived from titles', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'archived-worker-repo')
    const now = Date.now()
    const h = await boot({
      seedSessions: [
        { id: 'session-docs-live', title: 'mesh · docs', cwd, mtime: now - 60 * 60 * 1000 },
        { id: 'session-docs-archived', title: 'mesh · docs', cwd, mtime: now },
      ],
      archivedIds: ['session-docs-archived'],
    })
    const entry = registryOf(h).workspaces?.['archived-worker-repo']
    const ok = !entry?.workers?.docs
    report('workspaces: workers are explicit, never derived from titles', ok, `docs=${entry?.workers?.docs?.sessionId ?? '-'}`)
  })

  await runCase('workspaces: a human slug and roles survive restarts', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'custom-repo')
    const h = await boot({
      seedSessions: [{ id: 'session-custom', title: 'worker', cwd }],
      prepareHome: (home) => {
        const registryDir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(registryDir, { recursive: true })
        fs.writeFileSync(
          path.join(registryDir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { legacy: { cwd, slug: 'my-custom', roles: ['keep-role'] } } }, null, 2)}\n`,
        )
      },
    })
    const registry = registryOf(h)
    const entry = registry.workspaces?.['my-custom']
    const ok =
      Boolean(entry) &&
      entry?.slug === 'my-custom' &&
      JSON.stringify(entry?.roles) === JSON.stringify(['keep-role']) &&
      !registry.workspaces?.legacy
    report('workspaces: a human slug and roles survive restarts', ok, `slug=${entry?.slug ?? '-'} roles=${JSON.stringify(entry?.roles ?? [])} keys=${Object.keys(registry.workspaces ?? {}).join(',')}`)
  })

  await runCase('workspaces: convergence merges a reslug and is idempotent', async (boot) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-ws-converge-'))
    const cwdPublic = path.join(tmpRoot, 'work', 'dsh-mesh', 'public')
    const cwdOther = path.join(tmpRoot, 'work', 'other', 'dsh-mesh')
    const logFile1 = path.join(tmpRoot, 'first.log')
    const logFile2 = path.join(tmpRoot, 'second.log')
    try {
      const first = await boot({
        tmpRoot,
        config: { logFile: logFile1 },
        seedSessions: [
          { id: 'session-public', title: 'worker public', cwd: cwdPublic },
          { id: 'session-other', title: 'worker other', cwd: cwdOther },
        ],
        prepareHome: (home) => {
          const registryDir = path.join(home, '.dsh', 'mesh-waker')
          fs.mkdirSync(path.join(registryDir, 'ws', 'public'), { recursive: true })
          fs.writeFileSync(path.join(registryDir, 'ws', 'public', 'tasks.jsonl'), `${JSON.stringify(seededTask('T-RESLUG'))}\n`)
          fs.writeFileSync(
            path.join(registryDir, 'workspaces.json'),
            `${JSON.stringify({ machine: 'm', workspaces: { public: { cwd: cwdPublic, roles: [] }, other: { cwd: cwdOther, roles: [] } } }, null, 2)}\n`,
          )
        },
      })
      const registryAfterFirst = registryOf(first)
      const migratedRow = fs.existsSync(path.join(wsDirOf(first, 'dsh-mesh'), 'tasks.jsonl'))
        ? fs.readFileSync(path.join(wsDirOf(first, 'dsh-mesh'), 'tasks.jsonl'), 'utf8')
        : ''
      const firstLog = fs.readFileSync(logFile1, 'utf8')
      first.close()
      const second = await boot({
        tmpRoot,
        config: { logFile: logFile2 },
        seedSessions: [
          { id: 'session-public', title: 'worker public', cwd: cwdPublic },
          { id: 'session-other', title: 'worker other', cwd: cwdOther },
        ],
      })
      const registryAfterSecond = registryOf(second)
      const secondLog = fs.readFileSync(logFile2, 'utf8')
      const ok =
        Object.keys(registryAfterFirst.workspaces ?? {}).length === 1 &&
        Boolean(registryAfterFirst.workspaces?.['dsh-mesh']) &&
        !fs.existsSync(wsDirOf(first, 'public')) &&
        /T-RESLUG/.test(migratedRow) &&
        /workspaces: converged merged=1 ephemeral=0 reslugged=1/.test(firstLog) &&
        JSON.stringify(registryAfterFirst) === JSON.stringify(registryAfterSecond) &&
        /workspaces: converged merged=0 ephemeral=0 reslugged=0 \(no changes\)/.test(secondLog)
      report('workspaces: convergence merges a reslug and is idempotent', ok, `keys=${Object.keys(registryAfterFirst.workspaces ?? {}).join(',')} secondSame=${JSON.stringify(registryAfterFirst) === JSON.stringify(registryAfterSecond)}`)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })


  // 224-229. Role white list (T-295): only known role names reach `roles`; title fragments
  // are parked in `rolesUnrecognized`, cleanup is idempotent, and human roles survive it.
  await runCase('roles: a coordinator title contributes no role', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'roles-coord')
    const h = await boot({ seedSessions: [{ id: 'session-coord', title: 'mesh · 协调 2', cwd }] })
    const entry = registryOf(h).workspaces?.['roles-coord']
    const roles = entry?.roles ?? []
    const ok =
      Boolean(entry) &&
      !entry?.coordinator &&
      !roles.includes('协调 2') &&
      !roles.includes('协调') &&
      (entry?.rolesUnrecognized ?? []).length === 0
    report('roles: a coordinator title contributes no role', ok, `coordinator=${entry?.coordinator ?? '-'} roles=${JSON.stringify(roles)} unrecognized=${JSON.stringify(entry?.rolesUnrecognized ?? [])}`)
  })

  await runCase('roles: a whitelisted suffix becomes a role', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'roles-known')
    const h = await boot({ seedSessions: [{ id: 'session-waker', title: 'mesh · waker', cwd }] })
    const entry = registryOf(h).workspaces?.['roles-known']
    const ok = JSON.stringify(entry?.roles) === JSON.stringify(['waker']) && (entry?.rolesUnrecognized ?? []).length === 0
    report('roles: a whitelisted suffix becomes a role', ok, `roles=${JSON.stringify(entry?.roles ?? [])} unrecognized=${JSON.stringify(entry?.rolesUnrecognized ?? [])}`)
  })

  await runCase('roles: an unrecognised suffix is parked, not promoted', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'roles-noise')
    const h = await boot({
      seedSessions: [
        { id: 'session-noise-q', title: 'mesh · question/q-ad774b89', cwd },
        { id: 'session-noise-cn', title: 'mesh · 恢复1/2盘点', cwd },
      ],
    })
    const entry = registryOf(h).workspaces?.['roles-noise']
    const ok =
      (entry?.roles ?? []).length === 0 &&
      JSON.stringify(entry?.rolesUnrecognized) === JSON.stringify(['question/q-ad774b89', '恢复1/2盘点'])
    report('roles: an unrecognised suffix is parked, not promoted', ok, `roles=${JSON.stringify(entry?.roles ?? [])} unrecognized=${JSON.stringify(entry?.rolesUnrecognized ?? [])}`)
  })

  await runCase('roles: legacy title fragments are cleaned into unrecognized', async (boot) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-roles-clean-'))
    const cwd = path.join(tmpRoot, 'work', 'dsh-mesh', 'public')
    const logFile = path.join(tmpRoot, 'clean.log')
    try {
      const h = await boot({
        tmpRoot,
        config: { logFile },
        seedSessions: [
          { id: 'session-waker', title: 'mesh · waker', cwd },
          { id: 'session-create3', title: 'mesh · create3', cwd },
          { id: 'session-restore', title: 'mesh · 恢复1/2盘点', cwd },
        ],
        prepareHome: (home) => {
          const registryDir = path.join(home, '.dsh', 'mesh-waker')
          fs.mkdirSync(registryDir, { recursive: true })
          fs.writeFileSync(
            path.join(registryDir, 'workspaces.json'),
            `${JSON.stringify({ machine: 'm', workspaces: { 'dsh-mesh': { cwd, roles: ['waker', 'create3', '恢复1/2盘点'] } } }, null, 2)}\n`,
          )
        },
      })
      const entry = registryOf(h).workspaces?.['dsh-mesh']
      const log = fs.readFileSync(logFile, 'utf8')
      const ok =
        JSON.stringify(entry?.roles) === JSON.stringify(['waker']) &&
        JSON.stringify(entry?.rolesUnrecognized) === JSON.stringify(['create3', '恢复1/2盘点']) &&
        /workspaces: roles cleaned 2 → unrecognized/.test(log)
      report('roles: legacy title fragments are cleaned into unrecognized', ok, `roles=${JSON.stringify(entry?.roles ?? [])} unrecognized=${JSON.stringify(entry?.rolesUnrecognized ?? [])} cleaned=${/roles cleaned 2/.test(log)}`)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  await runCase('roles: a human role survives alongside inferred roles', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'roles-human')
    const h = await boot({
      seedSessions: [{ id: 'session-waker', title: 'mesh · waker', cwd }],
      prepareHome: (home) => {
        const registryDir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(registryDir, { recursive: true })
        fs.writeFileSync(
          path.join(registryDir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { 'roles-human': { cwd, roles: ['custom-role'] } } }, null, 2)}\n`,
        )
      },
    })
    const entry = registryOf(h).workspaces?.['roles-human']
    const ok = JSON.stringify(entry?.roles) === JSON.stringify(['custom-role', 'waker'])
    report('roles: a human role survives alongside inferred roles', ok, `roles=${JSON.stringify(entry?.roles ?? [])}`)
  })

  await runCase('roles: cleanup is idempotent across restarts', async (boot) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-roles-idem-'))
    const cwd = path.join(tmpRoot, 'work', 'dsh-mesh', 'public')
    const logOne = path.join(tmpRoot, 'one.log')
    const logTwo = path.join(tmpRoot, 'two.log')
    const seeds = [
      { id: 'session-waker', title: 'mesh · waker', cwd },
      { id: 'session-create3', title: 'mesh · create3', cwd },
    ]
    try {
      const first = await boot({
        tmpRoot,
        config: { logFile: logOne },
        seedSessions: seeds,
        prepareHome: (home) => {
          const registryDir = path.join(home, '.dsh', 'mesh-waker')
          fs.mkdirSync(registryDir, { recursive: true })
          fs.writeFileSync(
            path.join(registryDir, 'workspaces.json'),
            `${JSON.stringify({ machine: 'm', workspaces: { 'dsh-mesh': { cwd, roles: ['waker', 'create3'] } } }, null, 2)}\n`,
          )
        },
      })
      const afterFirst = registryOf(first)
      first.close()
      const second = await boot({ tmpRoot, config: { logFile: logTwo }, seedSessions: seeds })
      const afterSecond = registryOf(second)
      const log = fs.readFileSync(logTwo, 'utf8')
      const same = JSON.stringify(afterFirst) === JSON.stringify(afterSecond)
      const ok = same && !/roles cleaned/.test(log) && /workspaces: converged merged=0 ephemeral=0 reslugged=0 \(no changes\)/.test(log)
      report('roles: cleanup is idempotent across restarts', ok, `same=${same} cleanedLogged=${/roles cleaned/.test(log)}`)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })


  // 206-211. Numbered coordinators (T-287): one matcher, latest wins, ambiguity still wins
  // over guessing when mtimes cannot separate the candidates.
  await runCase('coordinator: numbered titles are recognised by the shared matcher', async () => {
    const { isCoordinatorTitle } = await import(pathToFileURL(ENTRY).href)
    const ok =
      isCoordinatorTitle('mesh · 协调 2') === true &&
      isCoordinatorTitle('mesh · 协调-3') === true &&
      isCoordinatorTitle('x · coordinator 2') === true &&
      isCoordinatorTitle('mesh · 协调') === true &&
      isCoordinatorTitle('mesh · coordinator') === true &&
      isCoordinatorTitle('任务（协调会话，abc）：请处理') === false &&
      isCoordinatorTitle('mesh · 协调 2 的说明') === false &&
      isCoordinatorTitle('mesh · waker') === false
    report('coordinator: numbered titles are recognised by the shared matcher', ok, `numbered=${isCoordinatorTitle('mesh · 协调 2')} plain=${isCoordinatorTitle('mesh · 协调')} body=${isCoordinatorTitle('任务（协调会话，abc）：请处理')}`)
  })

  await runCase('coordinator: plain titles still match and body mentions do not', async () => {
    const { isCoordinatorTitle } = await import(pathToFileURL(ENTRY).href)
    const ok =
      isCoordinatorTitle('mesh · 协调') === true &&
      isCoordinatorTitle('mesh · coordinator') === true &&
      isCoordinatorTitle('任务（协调会话，abc）：请处理') === false &&
      isCoordinatorTitle('mesh · 协调 2 的说明') === false
    report('coordinator: plain titles still match and body mentions do not', ok, `plain=${isCoordinatorTitle('mesh · 协调')} body=${isCoordinatorTitle('任务（协调会话，abc）：请处理')}`)
  })

  await runCase('coordinator: a legacy scalar is kept, not overwritten by titles', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'coord2-repo')
    const now = Date.now()
    const h = await boot({
      seedSessions: [
        { id: 'session-coord2-old', title: 'mesh · 协调', cwd, mtime: now - 3 * 24 * 60 * 60 * 1000 },
        { id: 'session-coord2-new', title: 'mesh · 协调 2', cwd, mtime: now - 60 * 60 * 1000 },
      ],
      prepareHome: (home) => {
        const registryDir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(registryDir, { recursive: true })
        fs.writeFileSync(
          path.join(registryDir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { 'coord2-repo': { cwd, coordinator: 'session-coord2-old', roles: [] } } }, null, 2)}\n`,
        )
      },
    })
    const entry = registryOf(h).workspaces?.['coord2-repo']
    const ok = entry?.coordinator === 'session-coord2-old'
    report('coordinator: a legacy scalar is kept, not overwritten by titles', ok, `coordinator=${entry?.coordinator ?? '-'}`)
  })

  await runCase('coordinator: a legacy scalar is not rewritten by titles', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'coord3-repo')
    const logFile = path.join(os.tmpdir(), `waker-coord3-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile },
      seedSessions: [
        { id: 'session-coord3-old', title: 'mesh · 协调', cwd, mtime: Date.now() - 5 * 24 * 60 * 60 * 1000 },
        { id: 'session-coord3-new', title: 'mesh · 协调 2', cwd, mtime: Date.now() - 30 * 60 * 1000 },
      ],
      prepareHome: (home) => {
        const registryDir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(registryDir, { recursive: true })
        fs.writeFileSync(
          path.join(registryDir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { 'coord3-repo': { cwd, coordinator: 'session-coord3-old', roles: [] } } }, null, 2)}\n`,
        )
      },
    })
    const entry = registryOf(h).workspaces?.['coord3-repo']
    const log = fs.readFileSync(logFile, 'utf8')
    const ok = entry?.coordinator === 'session-coord3-old' && !/coordinator session-coord3-old ->/.test(log)
    report('coordinator: a legacy scalar is not rewritten by titles', ok, `coordinator=${entry?.coordinator ?? '-'} rewritten=${/coordinator session-coord3-old ->/.test(log)}`)
  })

  await runCase('coordinator: requester inference reaches the numbered coordinator', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'coord4-repo')
    const logFile = path.join(os.tmpdir(), `waker-coord4-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile, receiptMode: 'queue' },
      seedSessions: [
        { id: 'session-coord4', title: 'mesh · 协调 2', cwd, mtime: Date.now() - 60 * 1000 },
        { id: 'session-coord4-worker', title: 'worker', cwd },
      ],
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'do the numbered work', meta: { taskId: 'T-COORD4' } },
    })
    h.emit('session/event', { id: 'session-coord4-worker' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-coord4-worker' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === 'session-coord4'), 4000)
    const log = fs.readFileSync(logFile, 'utf8')
    const ok = Boolean(delivered) && /requester inferred from workspace: mesh · 协调 2 \(session-coord4\)/.test(log)
    report('coordinator: requester inference reaches the numbered coordinator', ok, `deliveredTo=${delivered ? 'session-coord4' : '-'} inferred=${/requester inferred/.test(log)}`)
  })

  await runCase('coordinator: indistinguishable candidates stay ambiguous', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'coord5-repo')
    const sameTime = Date.now() - 2 * 60 * 60 * 1000
    const logFile = path.join(os.tmpdir(), `waker-coord5-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile, receiptMode: 'queue' },
      seedSessions: [
        { id: 'session-coord5-a', title: 'mesh · 协调', cwd, mtime: sameTime },
        { id: 'session-coord5-b', title: 'mesh · 协调 2', cwd, mtime: sameTime },
        { id: 'session-coord5-worker', title: 'worker', cwd },
      ],
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'worker', text: 'ambiguous work', meta: { taskId: 'T-COORD5' } },
    })
    h.emit('session/event', { id: 'session-coord5-worker' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-coord5-worker' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const settles = orphanReceipts(h).filter((receipt) => receipt.taskId === 'T-COORD5')
    const log = fs.readFileSync(logFile, 'utf8')
    const prompts = h.state.prompts.filter(
      (prompt) => prompt.sessionId === 'session-coord5-a' || prompt.sessionId === 'session-coord5-b',
    )
    const ok = settles.length === 1 && prompts.length === 0 && /requester inference ambiguous: 2 coordinator sessions/.test(log)
    report('coordinator: indistinguishable candidates stay ambiguous', ok, `receipts=${settles.length} prompts=${prompts.length} ambiguous=${/inference ambiguous/.test(log)}`)
  })

  // 212-218. Log tiering (T-288): same LCA shape as tasks, local day files, retention,
  // legacy migration and a read-only merged view.
  const { localDayName } = await import(pathToFileURL(ENTRY).href)
  const logsOf = (h) => {
    const root = path.join(h.home, '.dsh', 'mesh-waker')
    const files = []
    const add = (dir, label) => {
      try {
        for (const name of fs.readdirSync(dir)) if (name.endsWith('.log')) files.push({ file: path.join(dir, name), label })
      } catch {
        /* layer absent */
      }
    }
    add(path.join(root, 'local', 'logs'), 'local')
    try {
      for (const slug of fs.readdirSync(path.join(root, 'ws'))) add(path.join(root, 'ws', slug, 'logs'), slug)
    } catch {
      /* no workspace layers yet */
    }
    return files
  }
  const readLogFile = (h, label, day = localDayName()) => {
    const root = path.join(h.home, '.dsh', 'mesh-waker')
    const file = label === 'local' ? path.join(root, 'local', 'logs', `${day}.log`) : path.join(root, 'ws', label, 'logs', `${day}.log`)
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }

  await runCase('logs: a session event lands in its workspace day file', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'log-ws')
    const h = await boot({ seedSessions: [{ id: 'session-log-ws', title: 'log worker', cwd }] })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'log worker', text: 'workspace log line', meta: { taskId: 'T-LOG-WS' } },
    })
    const day = localDayName()
    const text = readLogFile(h, 'log-ws', day)
    const ok = /injected .*session-log-ws/.test(text) && logsOf(h).some((entry) => entry.label === 'log-ws')
    report('logs: a session event lands in its workspace day file', ok, `files=${logsOf(h).map((entry) => entry.label).join(',')}`)
  })

  await runCase('logs: a cross-workspace task event lands in local', async (boot) => {
    const cwdA = path.join(os.tmpdir(), 'Projects', 'log-cross-a')
    const cwdB = path.join(os.tmpdir(), 'Projects', 'log-cross-b')
    const h = await boot({
      seedSessions: [
        { id: 'session-log-cross', title: 'log cross worker', cwd: cwdA },
        { id: 'session-log-coord', title: 'mesh · 协调', cwd: cwdB },
      ],
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { title: 'log cross worker', text: 'cross log', meta: { taskId: 'T-LOG-CROSS', requester: 'session-log-coord' } },
    })
    const local = readLogFile(h, 'local')
    const ws = readLogFile(h, 'log-cross-a')
    const ok = /T-LOG-CROSS/.test(local) && !/T-LOG-CROSS/.test(ws)
    report('logs: a cross-workspace task event lands in local', ok, `localHasTask=${/T-LOG-CROSS/.test(local)}`)
  })

  await runCase('logs: global startup events land in local', async (boot) => {
    const h = await boot({})
    const local = readLogFile(h, 'local')
    const ok = /logs retention: removed \d+ files/.test(local) && /task registry loaded/.test(local)
    report('logs: global startup events land in local', ok, `localLines=${local.split('\n').filter(Boolean).length}`)
  })

  await runCase('logs: a day change starts a new file instead of appending', async (boot) => {
    const previous = process.env.MESH_WAKER_LOG_DAY
    try {
      process.env.MESH_WAKER_LOG_DAY = '2030-01-01'
      const h = await boot({ seedSessions: [{ id: 'session-log-day', title: 'day worker', cwd: path.join(os.tmpdir(), 'Projects', 'log-day') }] })
      await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'day worker', text: 'day one', meta: { taskId: 'T-LOG-D1' } } })
      process.env.MESH_WAKER_LOG_DAY = '2030-01-02'
      await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'day worker', text: 'day two', meta: { taskId: 'T-LOG-D2' } } })
      const root = path.join(h.home, '.dsh', 'mesh-waker')
      const dayOne = fs.existsSync(path.join(root, 'ws', 'log-day', 'logs', '2030-01-01.log'))
        ? fs.readFileSync(path.join(root, 'ws', 'log-day', 'logs', '2030-01-01.log'), 'utf8')
        : ''
      const dayTwo = fs.existsSync(path.join(root, 'ws', 'log-day', 'logs', '2030-01-02.log'))
        ? fs.readFileSync(path.join(root, 'ws', 'log-day', 'logs', '2030-01-02.log'), 'utf8')
        : ''
      const ok = /T-LOG-D1/.test(dayOne) && !/T-LOG-D2/.test(dayOne) && /T-LOG-D2/.test(dayTwo)
      report('logs: a day change starts a new file instead of appending', ok, `day1=${Boolean(dayOne)} day2=${Boolean(dayTwo)}`)
    } finally {
      if (previous === undefined) delete process.env.MESH_WAKER_LOG_DAY
      else process.env.MESH_WAKER_LOG_DAY = previous
    }
  })

  await runCase('logs: retention removes only files older than the window', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'log-retain')
    const h = await boot({
      seedSessions: [{ id: 'session-log-retain', title: 'retain worker', cwd }],
      config: { logsRetentionDays: 30 },
      prepareHome: (home) => {
        const root = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(path.join(root, 'local', 'logs'), { recursive: true })
        fs.mkdirSync(path.join(root, 'ws', 'log-retain', 'logs'), { recursive: true })
        fs.writeFileSync(path.join(root, 'local', 'logs', '2020-01-01.log'), 'old\n')
        fs.writeFileSync(path.join(root, 'ws', 'log-retain', 'logs', '2020-01-02.log'), 'old ws\n')
        fs.writeFileSync(path.join(root, 'local', 'logs', `${localDayName()}.log`), 'recent\n')
      },
    })
    const root = path.join(h.home, '.dsh', 'mesh-waker')
    const ok =
      !fs.existsSync(path.join(root, 'local', 'logs', '2020-01-01.log')) &&
      !fs.existsSync(path.join(root, 'ws', 'log-retain', 'logs', '2020-01-02.log')) &&
      fs.existsSync(path.join(root, 'local', 'logs', `${localDayName()}.log`)) &&
      /logs retention: removed 2 files/.test(readLogFile(h, 'local'))
    report('logs: retention removes only files older than the window', ok, `removed2=${/removed 2 files/.test(readLogFile(h, 'local'))}`)
  })

  await runCase('logs: the legacy waker.log is preserved once as legacy-waker.log', async (boot) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-log-legacy-'))
    try {
      const first = await boot({
        tmpRoot,
        prepareHome: (home) => {
          const root = path.join(home, '.dsh', 'mesh-waker')
          fs.mkdirSync(root, { recursive: true })
          fs.writeFileSync(path.join(root, 'waker.log'), 'legacy line one\n')
        },
      })
      const legacy = path.join(first.home, '.dsh', 'mesh-waker', 'local', 'logs', 'legacy-waker.log')
      const afterFirst = fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf8') : ''
      const rootGone = !fs.existsSync(path.join(first.home, '.dsh', 'mesh-waker', 'waker.log'))
      first.close()
      const second = await boot({ tmpRoot })
      const afterSecond = fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf8') : ''
      const ok = /legacy line one/.test(afterFirst) && rootGone && afterSecond === afterFirst
      report('logs: the legacy waker.log is preserved once as legacy-waker.log', ok, `migrated=${/legacy line one/.test(afterFirst)} rootGone=${rootGone} idempotent=${afterSecond === afterFirst}`)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  await runCase('logs: the merged view lists both layers with their source', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'log-view')
    const day = localDayName()
    const h = await boot({
      seedSessions: [{ id: 'session-log-view', title: 'view worker', cwd }],
      prepareHome: (home) => {
        const root = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(path.join(root, 'local', 'logs'), { recursive: true })
        fs.mkdirSync(path.join(root, 'ws', 'log-view', 'logs'), { recursive: true })
        fs.writeFileSync(path.join(root, 'local', 'logs', `${day}.log`), `2026-11-01T00:00:00.000Z local line\n`)
        fs.writeFileSync(path.join(root, 'ws', 'log-view', 'logs', `${day}.log`), `2026-11-01T00:00:01.000Z workspace line\n`)
      },
    })
    const view = await request(h.base, `/mesh/logs?day=${day}&scope=all&tail=50`)
    const entries = view.json?.entries ?? []
    const files = entries.map((entry) => entry.file).join(',')
    const ok =
      view.json?.ok === true &&
      entries.some((entry) => entry.scope === 'local' && /local-log|local line/.test(entry.line)) &&
      entries.some((entry) => entry.scope === 'log-view' && /workspace line/.test(entry.line)) &&
      files.includes('local/logs/') &&
      files.includes('ws/log-view/logs/')
    report('logs: the merged view lists both layers with their source', ok, `count=${view.json?.count ?? '-'} files=${files}`)
  })



  // 219-223. lib/ split (T-292): index re-exports stay stable, modules are self-contained,
  // the published file list includes lib/, and pure helpers behave the same from lib/.
  const LIB = path.join(REPO, 'plugins', 'mesh-waker', 'lib')
  const libUrl = (name) => pathToFileURL(path.join(LIB, name)).href

  await runCase('lib: index.js still exports every original symbol', async () => {
    const api = await import(pathToFileURL(ENTRY).href)
    const expected = [
      'hubConsoleUrlFor', 'localDayName', 'nextPollDelayMs', 'classifyTurnEnd', 'truncateText', 'buildReceipt',
      'receiptNoticeText', 'isCoordinatorTitle', 'resolveTaskText', 'storeTaskText', 'compactTaskRows', 'messageText',
      'deriveLivenessState', 'humanDuration', 'buildBatchReceipt', 'durationToMs', 'buildDispatchMeta',
      'MESH_DISPATCH_TOOL', 'MESH_ASK_TOOL', 'DISPATCH_OUTPUT', 'ASK_OUTPUT', 'MESH_COMPLETE_TOOL', 'COMPLETE_OUTPUT',
      'MESH_THREAD_TOOL', 'THREAD_OUTPUT', 'validateToolSchema', 'previewText', 'truncateUtf8', 'inlineBodyText',
      'cleanTaskSubject', 'resolveTaskSubject', 'normalizeThread', 'withTaskHeader', 'SESSION_PAGE_DEFAULT',
      'SESSION_PAGE_MAX', 'paginateSessions', 'ROLE_NAMES', 'ROLE_UNRECOGNIZED_MAX', 'titleRoleCandidate',
      'classifyRoleCandidates', 'createReceiptFlow', 'createThreads', 'createTaskRegistry', 'createTaskLifecycle', 'apply', 'name', 'inject',
    ]
    const missing = expected.filter((key) => api[key] === undefined)
    const wrongType = expected.filter((key) => {
      const value = api[key]
      if (key === 'apply') return typeof value !== 'function'
      if (key === 'name' || key === 'inject') return typeof value === 'undefined'
      if (key === 'SESSION_PAGE_DEFAULT' || key === 'SESSION_PAGE_MAX' || key === 'ROLE_UNRECOGNIZED_MAX') return typeof value !== 'number'
      if (key === 'ROLE_NAMES') return !Array.isArray(value)
      if (key.endsWith('_TOOL') || key.endsWith('_OUTPUT')) return typeof value !== 'object'
      return typeof value !== 'function'
    })
    const ok = missing.length === 0 && wrongType.length === 0
    report('lib: index.js still exports every original symbol', ok, `missing=${missing.join(',') || '-'} wrongType=${wrongType.join(',') || '-'}`)
  })

  await runCase('lib: every module imports standalone and the graph has no cycles', async () => {
    const files = ['text', 'receipt', 'tools', 'session', 'tasks', 'settings', 'receipt-flow', 'threads', 'task-registry', 'task-lifecycle']
    const modules = {}
    for (const name of files) modules[name] = await import(libUrl(`${name}.mjs`))
    const edges = {}
    for (const name of files) {
      const source = fs.readFileSync(path.join(LIB, `${name}.mjs`), 'utf8')
      edges[name] = [...source.matchAll(/from '(\.\/[^']+)'/g)].map((m) => m[1].replace('./', '').replace('.mjs', ''))
    }
    const visiting = new Set()
    const seen = new Set()
    const cycle = (node) => {
      if (visiting.has(node)) return true
      if (seen.has(node)) return false
      visiting.add(node)
      for (const next of edges[node] ?? []) if (cycle(next)) return true
      visiting.delete(node)
      seen.add(node)
      return false
    }
    const cyclic = files.filter((name) => cycle(name))
    const exportsOk =
      typeof modules.text.truncateText === 'function' &&
      typeof modules.receipt.buildReceipt === 'function' &&
      typeof modules.tools.validateToolSchema === 'function' &&
      typeof modules.session.withTaskHeader === 'function' &&
      typeof modules.tasks.resolveTaskText === 'function' &&
      typeof modules['receipt-flow'].createReceiptFlow === 'function' &&
      typeof modules.threads.createThreads === 'function' &&
      typeof modules['task-registry'].createTaskRegistry === 'function' &&
      typeof modules['task-lifecycle'].createTaskLifecycle === 'function' &&
      typeof modules.settings.clampInterval === 'function'
    const ok = exportsOk && cyclic.length === 0
    report('lib: every module imports standalone and the graph has no cycles', ok, `cyclic=${cyclic.join(',') || '-'} edges=${JSON.stringify(edges)}`)
  })

  await runCase('lib: pure helpers behave the same when imported from lib/', async () => {
    const text = await import(libUrl('text.mjs'))
    const receipt = await import(libUrl('receipt.mjs'))
    const tools = await import(libUrl('tools.mjs'))
    const filtered = text.messageText({
      content: [
        { type: 'thinking', text: 'hidden' },
        { type: 'text', text: 'visible answer' },
        { type: 'tool_result', text: 'tool noise' },
      ],
    })
    const built = receipt.buildReceipt({ taskId: 'T-LIB-1', status: 'completed', injectedAt: Date.now() - 1200, source: 'declared' })
    const rejected = tools.validateToolSchema({ schema: { type: 'object', properties: { a: { type: ['string'] } } } })
    const ok =
      filtered === 'visible answer' &&
      /^\[RECEIPT\] T-LIB-1 completed \d+ms \(declared\)$/.test(receipt.receiptNoticeText(built)) &&
      rejected.ok === false
    report('lib: pure helpers behave the same when imported from lib/', ok, `message=${JSON.stringify(filtered)} schemaOk=${rejected.ok}`)
  })

  await runCase('lib: resolveTaskText still resolves refs, legacy text and misses', async () => {
    const { resolveTaskText } = await import(pathToFileURL(ENTRY).href)
    const { resolveTaskText: fromLib } = await import(libUrl('tasks.mjs'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-lib-tasks-'))
    try {
      const body = 'lib 内容寻址正文'
      const hex = require('node:crypto').createHash('sha256').update(body, 'utf8').digest('hex')
      fs.writeFileSync(path.join(dir, `${hex}.txt`), body)
      const viaIndex = resolveTaskText({ textRef: `sha256:${hex}` }, dir)
      const viaLib = fromLib({ textRef: `sha256:${hex}` }, dir)
      const legacy = fromLib({ text: '旧行内正文' }, dir)
      const missing = fromLib({}, dir)
      const ok = viaIndex === body && viaLib === body && legacy === '旧行内正文' && missing === ''
      report('lib: resolveTaskText still resolves refs, legacy text and misses', ok, `index=${JSON.stringify(viaIndex)} lib=${JSON.stringify(viaLib)}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await runCase('lib: package.json files includes lib/ for publishing', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'package.json'), 'utf8'))
    const files = Array.isArray(pkg.files) ? pkg.files : []
    const exportsMap = pkg.exports ?? {}
    const ok = files.includes('lib/') && exportsMap['.'] === './index.js'
    report('lib: package.json files includes lib/ for publishing', ok, `files=${files.join(',')} entry=${exportsMap['.'] ?? '-'}`)
  })

  // 252-256. Receipt flow factory (T-314): the subsystem must run without apply(). These
  // cases call createReceiptFlow(fakeDeps) directly, so a hidden closure reference throws
  // instead of silently working, and a static check guards the factory body.
  const makeReceiptFlow = (overrides = {}) => {
    const logs = []
    const calls = []
    const deps = {
      state: { lastError: null, lastReceipt: null },
      config: { receiptTo: '', wakeSecret: '', receiptSummaryChars: 300 },
      log: { warn: (message) => logs.push(`warn: ${message}`) },
      fileLog: (message) => logs.push(String(message)),
      listLocalSessions: () => [],
      resolveLocalSession: () => ({ id: 'session-default' }),
      promptWithResume: async (...args) => {
        calls.push(args)
      },
      receiptBody: () => 'receipt body',
      writeReceiptFile: () => true,
      dirForRow: () => '/tmp/records',
      updateTaskRow: () => {},
      taskRows: new Map(),
      getLastReceipt: () => deps.state.lastReceipt,
      setLastReceipt: (value) => {
        deps.state.lastReceipt = value
      },
      ...overrides,
    }
    return { deps, logs, calls, flow: createReceiptFlow(deps) }
  }
  const { createReceiptFlow } = await import(pathToFileURL(ENTRY).href)
  const { createThreads } = await import(pathToFileURL(ENTRY).href)
  const { createTaskRegistry } = await import(pathToFileURL(ENTRY).href)
  const { createTaskLifecycle } = await import(pathToFileURL(ENTRY).href)

  await runCase('receipt flow: resolves a named requester without apply()', async () => {
    const { flow } = makeReceiptFlow({ resolveLocalSession: (draft) => ({ id: `session-for-${draft.title}` }) })
    const resolved = flow.resolveRequester('mesh · 协调 2')
    const ok =
      resolved.requester === 'mesh · 协调 2' &&
      resolved.sessionId === 'session-for-mesh · 协调 2' &&
      resolved.inferred === false
    report('receipt flow: resolves a named requester without apply()', ok, `sessionId=${resolved.sessionId ?? '-'} inferred=${resolved.inferred}`)
  })

  await runCase('receipt flow: infers the newest numbered coordinator in the target cwd', async () => {
    const cwd = path.join('virtual', 'proj')
    const { flow } = makeReceiptFlow({
      listLocalSessions: () => [
        { id: 'session-old', title: 'mesh · 协调', cwd, archived: false, last_active: 1000 },
        { id: 'session-new', title: 'mesh · 协调 2', cwd, archived: false, last_active: 2000 },
        { id: 'session-worker', title: 'worker', cwd, archived: false, last_active: 3000 },
      ],
    })
    const resolved = flow.resolveRequester(null, { id: 'session-target', cwd })
    const ok = resolved.inferred === true && resolved.sessionId === 'session-new' && resolved.requester === 'mesh · 协调 2'
    report('receipt flow: infers the newest numbered coordinator in the target cwd', ok, `sessionId=${resolved.sessionId ?? '-'} inferred=${resolved.inferred}`)
  })

  await runCase('receipt flow: file mode logs without injecting, queue mode delivers', async () => {
    const { calls, logs, flow } = makeReceiptFlow()
    await flow.deliverReceipt(
      { taskId: 'T-RF-FILE', status: 'completed', receiptMode: 'file' },
      { requester: 'x', requesterSessionId: 'session-req' },
    )
    const fileMode = calls.length === 0 && logs.some((line) => /T-RF-FILE completed → file only/.test(line))
    await flow.deliverReceipt(
      { taskId: 'T-RF-QUEUE', status: 'completed', receiptMode: 'queue' },
      { requester: 'x', requesterSessionId: 'session-req' },
    )
    const queueMode = calls.length === 1 && calls[0][0] === 'session-req' && calls[0][1] === 'receipt body' && calls[0][2] === 'queue'
    report('receipt flow: file mode logs without injecting, queue mode delivers', fileMode && queueMode, `fileMode=${fileMode} queueMode=${queueMode}`)
  })

  await runCase('receipt flow: wake without wakeSecret warns and delivers as queue', async () => {
    const { calls, logs, flow } = makeReceiptFlow()
    await flow.deliverReceipt(
      { taskId: 'T-RF-WAKE', status: 'completed', receiptMode: 'wake' },
      { requesterSessionId: 'session-req' },
    )
    const ok = calls.length === 1 && calls[0][2] === 'queue' && logs.some((line) => /needs wakeSecret/.test(line))
    report('receipt flow: wake without wakeSecret warns and delivers as queue', ok, `mode=${calls[0]?.[2] ?? '-'} warned=${logs.some((line) => /needs wakeSecret/.test(line))}`)
  })

  // Static guard shared by every subsystem factory (T-318). A factory may only reach plugin
  // state through `deps.`, so any bare closure name in its source is a leak. The lookbehind
  // excludes `deps.NAME` and member access (`.NAME`), but still flags the spread form
  // (`...NAME`) that a plain `(?<![\w.])` check misses — the threads move hit exactly that.
  const factoryFreeRefs = (factory, forbidden) => {
    const code = String(factory).replace(/\/\/[^\n]*/g, '')
    return forbidden.filter((name) => new RegExp(`(?<!deps\\.)(?:(?<=\\.\\.\\.)|(?<![\\w$.]))${name}\\b`).test(code))
  }
  const RECEIPT_FLOW_DEPS = [
    'state',
    'taskRows',
    'lastReceipt',
    'fileLog',
    'listLocalSessions',
    'resolveLocalSession',
    'promptWithResume',
    'writeReceiptFile',
    'dirForRow',
    'updateTaskRow',
    'receiptBody',
    'c',
  ]

  await runCase('receipt flow: the factory body has no free apply() references', async () => {
    const free = factoryFreeRefs(createReceiptFlow, RECEIPT_FLOW_DEPS)
    const ok = free.length === 0
    report('receipt flow: the factory body has no free apply() references', ok, `free=${free.join(',') || '-'} (${RECEIPT_FLOW_DEPS.length} checked)`)
  })

  await runCase('threads factory: binds, lists and releases without apply()', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-threads-factory-'))
    try {
      const threadRows = new Map()
      const taskRows = new Map([['T-TF-1', { taskId: 'T-TF-1', thread: 'TH-1', createdAt: 1000 }]])
      const flow = createThreads({
        threadsFile: path.join(tmpRoot, 'threads.json'),
        threadRows,
        taskRows,
        fileLog: () => {},
        resolveLocalSession: (draft) => ({ id: `session-for-${draft.session ?? draft.title}` }),
      })
      flow.bindThread('TH-1', { id: 'session-a', title: 'worker a' }, 'T-TF-1')
      const listed = flow.listThreads({ scope: 'all' })
      const persisted = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'threads.json'), 'utf8'))
      let refused = false
      try {
        flow.subscribeThread('TH-1', { id: 'session-b' })
      } catch {
        refused = true
      }
      flow.releaseThread('TH-1', 'session-a')
      const afterRelease = flow.listThreads({ scope: 'all' })
      const ok =
        listed.length === 1 &&
        listed[0].targetSessionId === 'session-a' &&
        JSON.stringify(listed[0].taskIds) === JSON.stringify(['T-TF-1']) &&
        Boolean(persisted['TH-1']) &&
        refused &&
        afterRelease.length === 0
      report('threads factory: binds, lists and releases without apply()', ok, `listed=${listed.length} persisted=${Boolean(persisted['TH-1'])} refused=${refused} afterRelease=${afterRelease.length}`)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  await runCase('threads: the factory body has no free apply() references', async () => {
    const free = factoryFreeRefs(createThreads, ['threadRows', 'threadsFile', 'pendingTasks', 'taskRows', 'fileLog', 'resolveLocalSession', 'state', 'c'])
    const ok = free.length === 0
    report('threads: the factory body has no free apply() references', ok, `free=${free.join(',') || '-'}`)
  })

  await runCase('task registry factory: loads latest rows and applies retention without apply()', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-task-registry-'))
    try {
      const tasksDir = path.join(tmpRoot, 'ws')
      const registryFile = path.join(tasksDir, 'tasks.jsonl')
      fs.mkdirSync(tasksDir, { recursive: true })
      const now = Date.now()
      const seed = [
        { taskId: 'T-LAST-1', createdAt: now - 5000, status: 'pending' },
        { taskId: 'T-LAST-1', createdAt: now - 4000, status: 'settled' },
        { taskId: 'T-OLD-1', createdAt: now - 3 * 24 * 60 * 60 * 1000, status: 'settled' },
        { taskId: 'T-LAST-2', createdAt: now - 3000, status: 'pending' },
        { taskId: 'T-LAST-3', createdAt: now - 2000, status: 'pending' },
      ]
      fs.writeFileSync(registryFile, `${seed.map((row) => JSON.stringify(row)).join('\n')}\n`)
      const baseDeps = {
        taskFiles: new Map(),
        fileLog: () => {},
        tasksFileIn: (dir) => path.join(dir, 'tasks.jsonl'),
        dirForRow: () => tasksDir,
        taskRecordFiles: () => [registryFile],
        taskTextDir: path.join(tmpRoot, 'tasks'),
        taskTextsDir: path.join(tmpRoot, 'texts'),
        writeTaskText: () => 'texts/ref.md',
        routeForSessions: () => ({ dir: tasksDir, scope: 'ws', workspace: 'w' }),
        scopeFields: (route) => ({ scope: route.scope, workspace: route.workspace }),
      }
      const keptRows = new Map()
      createTaskRegistry({ ...baseDeps, taskRows: keptRows, config: { tasksRetentionDays: 1, tasksMaxRows: 10 } }).loadTaskRegistry()
      const lastWins = keptRows.get('T-LAST-1')?.status === 'settled'
      const retentionPruned = !keptRows.has('T-OLD-1')
      const cappedRows = new Map()
      createTaskRegistry({ ...baseDeps, taskRows: cappedRows, config: { tasksRetentionDays: 1, tasksMaxRows: 2 } }).loadTaskRegistry()
      const capped = cappedRows.size === 2
      const ok = lastWins && retentionPruned && capped
      report('task registry factory: loads latest rows and applies retention without apply()', ok, `lastWins=${lastWins} retentionPruned=${retentionPruned} capped=${cappedRows.size}/2`)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  await runCase('task registry: the factory body has no free apply() references', async () => {
    const free = factoryFreeRefs(createTaskRegistry, [
      'taskRows',
      'taskFiles',
      'fileLog',
      'state',
      'c',
      'tasksFileIn',
      'dirForRow',
      'taskRecordFiles',
      'taskTextDir',
      'taskTextsDir',
      'writeTaskText',
      'routeForSessions',
      'scopeFields',
    ])
    const ok = free.length === 0
    report('task registry: the factory body has no free apply() references', ok, `free=${free.join(',') || '-'}`)
  })

  // Behavior guards for the lifecycle factory (T-320). T-279's two rules — a queued task
  // behind a running turn is re-armed rather than reported not-started, and a dormant task
  // resumes on a late turn — are exactly what a bad extraction would break silently.
  const makeLifecycle = (overrides = {}) => {
    const logs = []
    const receipts = []
    const pendingTasks = new Map()
    const deps = {
      pendingTasks,
      receiptTimers: new Set(),
      liveness: new Map(),
      assistantText: new Map(),
      turnStartedAt: new Map(),
      state: { pendingTasks: 0, lastReceipt: null },
      config: {
        receiptStallMs: 80,
        receiptSummaryChars: 300,
        receiptFile: 'receipts.jsonl',
        receiptMode: 'queue',
        requireNamespacedIds: false,
        startedClaimWindowMs: 60000,
      },
      fileLog: (message) => logs.push(String(message)),
      taskRegistry: { recordTaskPending: () => {}, updateTaskRow: () => null },
      receiptFlow: {
        resolveRequester: () => ({ requester: null, sessionId: null, inferred: false }),
        deliverReceipt: async (receipt) => {
          receipts.push(receipt)
        },
      },
      setLastReceipt: (value) => {
        deps.state.lastReceipt = value
      },
      writeReceiptFile: () => true,
      receiptDirForTask: () => 'dir',
      receiptDirFor: () => 'dir',
      livenessFor: () => ({ openTurn: null, openCalls: new Set(), openJobs: new Set(), openApprovals: new Set() }),
      maxTurnFor: () => 1,
      sessionCwdOf: () => 'proj',
      routeForCwds: () => ({ dir: 'dir', scope: 'ws', workspace: 'w' }),
      scopeFields: () => ({}),
      findTaskRowInFile: () => null,
      layerLabel: () => 'ws',
      taskRecordFiles: () => [],
      registerBatchTask: () => {},
      updateBatchTask: () => {},
      ...overrides,
    }
    return { deps, logs, receipts, pendingTasks, flow: createTaskLifecycle(deps) }
  }
  const waitForLifecycle = async (predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    return predicate()
  }

  await runCase('lifecycle: a queued task behind a running turn is re-armed, not not-started (T-279)', async () => {
    const { flow, pendingTasks, receipts, logs } = makeLifecycle()
    const now = Date.now()
    pendingTasks.set('T-RUNNING', {
      sessionId: 'sess-q',
      mode: 'queue',
      baselineTurn: 1,
      injectedAt: now,
      startedAt: now - 10,
      settled: false,
      receiptMode: 'queue',
      stallTimer: null,
    })
    flow.registerPendingTask({ id: 'sess-q', cwd: 'proj' }, { taskId: 'T-QUEUED' }, 'queue', 'body')
    const rearmed = await waitForLifecycle(() => logs.some((line) => /stall re-armed/.test(line)))
    const queued = pendingTasks.get('T-QUEUED')
    const ok = rearmed && Boolean(queued) && queued.settled !== true && receipts.length === 0
    report('lifecycle: a queued task behind a running turn is re-armed, not not-started', ok, `rearmed=${rearmed} pending=${Boolean(queued)} settled=${queued?.settled} receipts=${receipts.length}`)
    flow.clearPending(queued)
  })

  await runCase('lifecycle: a dormant task resumes and its receipt carries source=resumed (T-279)', async () => {
    const { flow, pendingTasks, receipts } = makeLifecycle()
    flow.registerPendingTask({ id: 'sess-d', cwd: 'proj' }, { taskId: 'T-DORMANT' }, 'queue', 'body')
    const dormant = await waitForLifecycle(() => Boolean(pendingTasks.get('T-DORMANT')?.dormant))
    const notStarted = receipts.some((receipt) => receipt.status === 'not-started')
    flow.handleSessionEvent({ id: 'sess-d' }, { type: 'turn/start', data: { turn: 5 } })
    const task = pendingTasks.get('T-DORMANT')
    const resumed = task?.source === 'resumed' && task?.dormant === false
    flow.handleSessionEvent({ id: 'sess-d' }, { type: 'turn/end', data: { turn: 5, reason: 'completed' } })
    const finalReceipt = receipts.find((receipt) => receipt.status !== 'not-started')
    const ok = dormant && notStarted && resumed && finalReceipt?.source === 'resumed'
    report('lifecycle: a dormant task resumes and its receipt carries source=resumed', ok, `dormant=${dormant} notStarted=${notStarted} resumed=${resumed} source=${finalReceipt?.source ?? '-'}`)
  })

  await runCase('lifecycle: the factory body has no free apply() references', async () => {
    const free = factoryFreeRefs(createTaskLifecycle, [
      'pendingTasks',
      'receiptTimers',
      'liveness',
      'assistantText',
      'turnStartedAt',
      'state',
      'fileLog',
      'taskRegistry',
      'receiptFlow',
      'setLastReceipt',
      'writeReceiptFile',
      'receiptDirForTask',
      'receiptDirFor',
      'livenessFor',
      'maxTurnFor',
      'sessionCwdOf',
      'routeForCwds',
      'scopeFields',
      'findTaskRowInFile',
      'layerLabel',
      'taskRecordFiles',
      'registerBatchTask',
      'updateBatchTask',
      'c',
    ])
    const ok = free.length === 0
    report('lifecycle: the factory body has no free apply() references', ok, `free=${free.join(',') || '-'}`)
  })

  await runCase('receipt flow: lib/receipt-flow.mjs imports without index.js', async () => {
    const modulePath = path.join(REPO, 'plugins', 'mesh-waker', 'lib', 'receipt-flow.mjs')
    const module = await import(pathToFileURL(modulePath).href)
    const flow = module.createReceiptFlow({
      state: { lastError: null, lastReceipt: null },
      config: { receiptTo: '', wakeSecret: '', receiptSummaryChars: 300 },
      log: { warn: () => {} },
      fileLog: () => {},
      listLocalSessions: () => [],
      resolveLocalSession: () => ({ id: 'session-direct' }),
      promptWithResume: async () => {},
      receiptBody: () => 'body',
      writeReceiptFile: () => true,
      dirForRow: () => 'records',
      updateTaskRow: () => {},
      taskRows: new Map(),
      getLastReceipt: () => null,
      setLastReceipt: () => {},
    })
    const resolved = flow.resolveRequester('direct requester')
    const ok =
      typeof module.createReceiptFlow === 'function' &&
      resolved.sessionId === 'session-direct' &&
      typeof flow.deliverReceipt === 'function'
    report('receipt flow: lib/receipt-flow.mjs imports without index.js', ok, `sessionId=${resolved.sessionId ?? '-'} exports=${Object.keys(module).join(',')}`)
  })

  // 266-267. Design tokens (T-330): the panel must draw every colour and font size from the
  // TOKENS vocabulary. The gate only proves the counts; the second case proves the vocabulary
  // has no dead entries (a token nobody references is drift waiting to happen).
  await runCase('ui tokens: client.js has no raw colours or font sizes left', async () => {
    const { execFileSync } = require('node:child_process')
    const raw = execFileSync(process.execPath, ['scripts/check-ui-tokens.mjs', '--paths', 'plugins/mesh-waker/client.js', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
    })
    const parsed = JSON.parse(raw.slice(raw.indexOf('{')))
    const file = parsed.files.find((entry) => entry.path === 'plugins/mesh-waker/client.js')
    const ok = Boolean(file) && file.rawColorCount === 0 && file.rawFontSizeCount === 0 && file.tokenRefCount > 61
    report('ui tokens: client.js has no raw colours or font sizes left', ok, `rawColor=${file?.rawColorCount} rawFontSize=${file?.rawFontSizeCount} tokenRef=${file?.tokenRefCount}`)
  })

  await runCase('ui tokens: every declared token is referenced at least once', async () => {
    const source = fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'client.js'), 'utf8')
    const parts = source.split('// BEGIN UI TOKENS')
    const tail = parts[1] ? parts[1].split('// END UI TOKENS') : ['', '']
    const block = tail[0] ?? ''
    const outside = `${parts[0] ?? ''}${tail[1] ?? ''}`
    const keys = [...block.matchAll(/^\s{2,4}([a-zA-Z]+): \{([^}]*)\}/gms)].flatMap((match) =>
      [...match[2].matchAll(/([a-zA-Z]+):/g)].map((entry) => `${match[1]}.${entry[1]}`),
    )
    const unused = keys.filter((key) => !outside.includes(`TOKENS.${key}`))
    const ok = keys.length > 0 && unused.length === 0
    report('ui tokens: every declared token is referenced at least once', ok, `tokens=${keys.length} unused=${unused.join(',') || '-'}`)
  })

  // 268-270. Control vocabulary (T-331): one constructor per shape. The gate proves call
  // sites stopped building raw controls; the style cases prove the constructors really share
  // one style per variant (and do not collapse every variant into the same look).
  const loadClientUi = () => {
    const source = fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'client.js'), 'utf8')
    const tokenBlock = source.split('// BEGIN UI TOKENS')[1]?.split('// END UI TOKENS')[0] ?? ''
    const controlBlock = source.split('// BEGIN UI CONTROLS')[1]?.split('// END UI CONTROLS')[0] ?? ''
    const sandbox = {
      h: (tag, props, ...children) => ({ tag, props: props ?? {}, children }),
      styles: { input: { flex: 1, minWidth: 0 } },
      controlStyle: { padding: '6px 12px' },
      selectStyle: { appearance: 'none' },
      buttonBase: { borderRadius: 6, cursor: 'pointer' },
    }
    const code = `${tokenBlock}\n${controlBlock}\n;globalThis.__ui = ui`
    vm.runInNewContext(code, sandbox)
    return sandbox.__ui
  }

  await runCase('ui controls: client.js builds no raw controls outside the vocabulary', async () => {
    const { execFileSync } = require('node:child_process')
    const raw = execFileSync(process.execPath, ['scripts/check-ui-tokens.mjs', '--paths', 'plugins/mesh-waker/client.js', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
    })
    const parsed = JSON.parse(raw.slice(raw.indexOf('{')))
    const file = parsed.files.find((entry) => entry.path === 'plugins/mesh-waker/client.js')
    const ok = Boolean(file) && file.rawControlCount === 0
    report('ui controls: client.js builds no raw controls outside the vocabulary', ok, `rawControl=${file?.rawControlCount}`)
  })

  await runCase('ui controls: the same variant yields one shared style', async () => {
    const ui = loadClientUi()
    const first = ui.button({ variant: 'secondary' }).props.style
    const second = ui.button({ variant: 'secondary', style: { width: 80 } }).props.style
    const ok = JSON.stringify(ui.button({}).props.style) === JSON.stringify(first) && JSON.stringify({ ...second, width: undefined }) === JSON.stringify({ ...first, width: undefined }) && second.width === 80
    report('ui controls: the same variant yields one shared style', ok, `secondary=${JSON.stringify(first)}`)
  })

  await runCase('ui controls: danger and primary buttons stay different', async () => {
    const ui = loadClientUi()
    const danger = ui.button({ variant: 'danger' }).props.style
    const primary = ui.button({ variant: 'primary' }).props.style
    const secondary = ui.button({ variant: 'secondary' }).props.style
    const ok = JSON.stringify(danger) !== JSON.stringify(primary) && JSON.stringify(danger) !== JSON.stringify(secondary) && danger.color !== primary.color
    report('ui controls: danger and primary buttons stay different', ok, `danger=${danger.color} primary=${primary.color}`)
  })

  await runCase('config: sidebar switches default on and persist through the config API', async (boot) => {
    const h = await boot({})
    const before = await request(h.base, '/mesh/status')
    const defaultsOn = before.json?.config?.sidebarLeft !== false && before.json?.config?.sidebarRight !== false
    const savedLeft = await request(h.base, '/mesh/config', { method: 'POST', body: { sidebarLeft: false } })
    const savedRight = await request(h.base, '/mesh/config', { method: 'POST', body: { sidebarRight: false } })
    const after = await request(h.base, '/mesh/status')
    const leftOff = after.json?.config?.sidebarLeft === false
    const rightOff = after.json?.config?.sidebarRight === false
    await request(h.base, '/mesh/config', { method: 'POST', body: { sidebarLeft: true, sidebarRight: true } })
    const ok = defaultsOn && savedLeft.json?.ok !== false && savedRight.json?.ok !== false && leftOff && rightOff
    report('config: sidebar switches default on and persist through the config API', ok, `defaults=${defaultsOn} left=${leftOff} right=${rightOff}`)
  })

  // 241. Boot diagnostics (T-299): a listener that cannot bind must fail fast and name the
  // real error instead of burning the 5s probe budget and reporting "never answered".
  {
    const occupied = await freePort()
    const blocker = net.createServer()
    await new Promise((resolveListen) => blocker.listen(occupied, '127.0.0.1', resolveListen))
    let message = ''
    const startedAt = Date.now()
    try {
      await startHarness({ config: { listenPort: occupied } })
    } catch (error) {
      message = error.message
    } finally {
      await new Promise((resolveClose) => blocker.close(resolveClose))
    }
    const elapsedMs = Date.now() - startedAt
    const ok =
      /the test listener failed to start/.test(message) &&
      /EADDRINUSE/.test(message) &&
      !/never answered/.test(message) &&
      elapsedMs < 4000
    report('harness: a listener that cannot bind fails fast with the real error', ok, `error=${message.split('\n')[0].slice(0, 220)} ms=${elapsedMs}`)
  }

  // ---- T-388: cross-machine task consumer (pull / claim / heartbeat / settle) ----
  const hubTasksUrl = pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'lib', 'hub-tasks.mjs')).href
  const taskRow = (id, overrides = {}) => ({
    task_id: id,
    target_agent: 'mesh-b',
    intent: 'auto',
    text_ref: 'sha256:' + 'a'.repeat(64),
    status: 'pending',
    ...overrides,
  })

  const taskFetchStub = (rows, { claimStatus = 200, settleStatus = 200, listThrows = false } = {}) => {
    const calls = []
    const fetchJson = async (requestPath, { method = 'GET', body } = {}) => {
      calls.push({ path: requestPath, method, body })
      if (listThrows) throw new Error('hub unreachable')
      if (requestPath.startsWith('/api/tasks?')) return { ok: true, status: 200, json: { ok: true, tasks: rows } }
      if (requestPath.endsWith('/claim')) return claimStatus === 200 ? { ok: true, status: 200, json: { ok: true } } : { ok: false, status: claimStatus, json: null }
      if (requestPath.endsWith('/heartbeat')) return { ok: true, status: 200, json: { ok: true } }
      // The real hub validates the settle body (T-399): status must be one of the four, so a
      // client that sends `result` gets a 400 instead of a silent success.
      if (requestPath.endsWith('/settle')) {
        const ok = ['completed', 'error', 'lost', 'partial'].includes(String(body?.status ?? ''))
        return { ok, status: ok ? settleStatus : 400, json: ok ? { ok: true } : { error: 'status must be completed|error|lost|partial' } }
      }
      if (requestPath.startsWith('/api/blobs?')) return { ok: true, status: 200, json: { ok: true, blobs: [{ id: 'blob-1' }] } }
      // The real hub streams the blob as text, so the stub returns `text` with no JSON (T-392).
      if (requestPath.startsWith('/api/blob/')) return { ok: true, status: 200, json: null, text: 'do the thing' }
      return { ok: false, status: 404, json: null }
    }
    return { calls, fetchJson }
  }

  await runCase('hub tasks: pull -> claim -> blob -> deliver -> settle observed', async () => {
    const { createHubTaskConsumer } = await import(hubTasksUrl)
    const stub = taskFetchStub([taskRow('P-20261108-01')])
    const delivered = []
    const consumer = createHubTaskConsumer({
      enabled: true,
      agent: 'mesh-b',
      pollIntervalMs: 600000,
      leaseMs: 600000,
      fetchJson: stub.fetchJson,
      deliverTask: async (task) => delivered.push(task),
    })
    try {
      const round = await consumer.pollOnce()
      const settle = await consumer.settleTask('P-20261108-01', { result: 'completed', summary: 'ok', source: 'observed' })
      const claim = stub.calls.find((call) => call.path.endsWith('/claim'))
      const blobLookup = stub.calls.find((call) => call.path.startsWith('/api/blobs?'))
      const blobGet = stub.calls.find((call) => call.path.startsWith('/api/blob/'))
      const settleCall = stub.calls.find((call) => call.path.endsWith('/settle'))
      const ok =
        round.polled === 1 &&
        round.claimed === 1 &&
        delivered.length === 1 &&
        delivered[0].text === 'do the thing' &&
        claim?.body?.lease_ms === 600000 &&
        Boolean(blobLookup) &&
        Boolean(blobGet) &&
        settle.ok === true &&
        settleCall?.body?.source === 'observed' &&
        settleCall?.body?.status === 'completed'
      report('hub tasks: pull -> claim -> blob -> deliver -> settle observed', ok, `polled=${round.polled} claimed=${round.claimed} delivered=${delivered.length} settle=${settle.ok}`)
    } finally {
      consumer.stop()
    }
  })

  await runCase('hub tasks: a 409 claim is skipped without delivering', async () => {
    const { createHubTaskConsumer } = await import(hubTasksUrl)
    const stub = taskFetchStub([taskRow('P-20261108-02')], { claimStatus: 409 })
    const delivered = []
    const consumer = createHubTaskConsumer({
      enabled: true,
      agent: 'mesh-b',
      pollIntervalMs: 600000,
      leaseMs: 600000,
      fetchJson: stub.fetchJson,
      deliverTask: async (task) => delivered.push(task),
    })
    try {
      const round = await consumer.pollOnce()
      const ok = round.polled === 1 && round.claimed === 0 && delivered.length === 0 && !stub.calls.some((call) => call.path.startsWith('/api/blob'))
      report('hub tasks: a 409 claim is skipped without delivering', ok, `polled=${round.polled} claimed=${round.claimed} delivered=${delivered.length}`)
    } finally {
      consumer.stop()
    }
  })

  await runCase('hub tasks: declared and observed settle exactly once', async () => {
    const { createHubTaskConsumer } = await import(hubTasksUrl)
    const stub = taskFetchStub([taskRow('P-20261108-03')])
    const consumer = createHubTaskConsumer({
      enabled: true,
      agent: 'mesh-b',
      pollIntervalMs: 600000,
      leaseMs: 600000,
      fetchJson: stub.fetchJson,
      deliverTask: async () => {},
    })
    try {
      await consumer.pollOnce()
      const first = await consumer.settleTask('P-20261108-03', { result: 'completed', summary: 'declared', source: 'declared' })
      const second = await consumer.settleTask('P-20261108-03', { result: 'completed', summary: 'observed', source: 'observed' })
      const settles = stub.calls.filter((call) => call.path.endsWith('/settle'))
      const ok = first.ok === true && second.skipped === true && settles.length === 1 && settles[0].body.source === 'declared'
      report('hub tasks: declared and observed settle exactly once', ok, `settles=${settles.length} source=${settles[0]?.body?.source ?? '-'} second=${second.skipped ? 'skipped' : 'sent'}`)
    } finally {
      consumer.stop()
    }
  })

  await runCase('hub tasks: a heartbeat renews the lease while the task runs', async () => {
    const { createHubTaskConsumer } = await import(hubTasksUrl)
    const stub = taskFetchStub([taskRow('P-20261108-04')])
    const consumer = createHubTaskConsumer({
      enabled: true,
      agent: 'mesh-b',
      pollIntervalMs: 600000,
      leaseMs: 2000,
      fetchJson: stub.fetchJson,
      deliverTask: async () => {},
    })
    try {
      await consumer.pollOnce()
      const beat = await waitFor(() => (stub.calls.some((call) => call.path.endsWith('/heartbeat')) ? true : null), 3000)
      const ok = beat === true && stub.calls.some((call) => call.path.endsWith('/heartbeat') && call.body?.lease_ms === 2000)
      report('hub tasks: a heartbeat renews the lease while the task runs', ok, `heartbeat=${beat === true}`)
    } finally {
      consumer.stop()
    }
  })

  await runCase('hub tasks: disabled means zero requests, and a failing list is retried next tick', async () => {
    const { createHubTaskConsumer } = await import(hubTasksUrl)
    const disabledStub = taskFetchStub([taskRow('P-20261108-05')])
    const disabled = createHubTaskConsumer({
      enabled: false,
      agent: 'mesh-b',
      fetchJson: disabledStub.fetchJson,
      deliverTask: async () => {},
    })
    const disabledRound = await disabled.pollOnce()
    disabled.stop()
    const failingStub = taskFetchStub([], { listThrows: true })
    const failing = createHubTaskConsumer({
      enabled: true,
      agent: 'mesh-b',
      pollIntervalMs: 600000,
      fetchJson: failingStub.fetchJson,
      deliverTask: async () => {},
    })
    const failingRound = await failing.pollOnce()
    const snap = failing.status()
    failing.stop()
    const ok =
      disabledStub.calls.length === 0 &&
      disabledRound.polled === 0 &&
      failingRound.polled === 0 &&
      /tasks poll failed/.test(snap.lastError ?? '') &&
      snap.isRunning === false &&
      typeof snap.lastPollAt === 'number'
    report('hub tasks: disabled means zero requests, and a failing list is retried next tick', ok, `disabledCalls=${disabledStub.calls.length} lastError=${snap.lastError ? 'set' : 'none'}`)
  })

  await runCase('hub tasks: the plugin delivers a claimed task and settles it on turn/end', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      fake.addTask({ task_id: 'P-20261108-06', target_agent: 'dsh-test', intent: 'inbox', subject: 'cross-machine' }, 'do the cross thing')
      h = await boot({
        config: {
          hubUrl: fake.url,
          pollIntervalMs: 5000,
          pollIdleIntervalMs: 5000,
          tasksPollEnabled: true,
          tasksPollIntervalMs: 1000,
        },
      })
      const delivered = await waitFor(() => (h.state.prompts.length ? h.state.prompts[0] : null), 15000)
      const settleBeforeTurnEnd = fake.taskSettles.length
      h.emit('session/event', { id: delivered?.sessionId }, { type: 'turn/start', turn: 3 })
      h.emit('session/event', { id: delivered?.sessionId }, { type: 'turn/end', turn: 3, reason: { kind: 'completed' } })
      const settled = await waitFor(() => (fake.taskSettles.length ? fake.taskSettles[0] : null), 5000)
      const status = await request(h.base, '/mesh/status')
      const claim = fake.taskClaims[0]
      const ok =
        Boolean(delivered) &&
        fake.tasks[0]?.status === 'settled' &&
        claim?.body?.lease_ms === 600000 &&
        settleBeforeTurnEnd === 0 &&
        settled?.body?.source === 'observed' &&
        settled?.body?.status === 'completed' &&
        status.json?.tasksPoll?.enabled === true &&
        typeof status.json?.tasksPoll?.lastPollAt === 'number'
      report('hub tasks: the plugin delivers a claimed task and settles it on turn/end', ok, `delivered=${delivered?.sessionId ?? '-'} settles=${fake.taskSettles.length} source=${settled?.body?.source ?? '-'}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('hub tasks: mesh_complete settles with source=declared', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      fake.addTask({ task_id: 'P-20261108-07', target_agent: 'dsh-test', intent: 'inbox' }, 'declared thing')
      h = await boot({
        config: { hubUrl: fake.url, pollIntervalMs: 5000, pollIdleIntervalMs: 5000, tasksPollEnabled: true, tasksPollIntervalMs: 1000 },
      })
      const delivered = await waitFor(() => (h.state.prompts.length ? h.state.prompts[0] : null), 15000)
      const completed = await request(h.base, '/mesh/tasks/complete', {
        method: 'POST',
        body: { sessionId: delivered?.sessionId, taskId: 'P-20261108-07', status: 'done', summary: 'all done' },
      })
      const settled = await waitFor(() => (fake.taskSettles.length ? fake.taskSettles[0] : null), 5000)
      const ok =
        completed.json?.ok === true &&
        settled?.body?.source === 'declared' &&
        settled?.body?.summary === 'all done' &&
        fake.tasks[0]?.status === 'settled'
      report('hub tasks: mesh_complete settles with source=declared', ok, `source=${settled?.body?.source ?? '-'} summary=${settled?.body?.summary ?? '-'}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('hub tasks: tasksPollEnabled=false sends no task requests', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      fake.addTask({ task_id: 'P-20261108-08', target_agent: 'dsh-test' }, 'should stay untouched')
      h = await boot({ config: { hubUrl: fake.url, pollIntervalMs: 5000, pollIdleIntervalMs: 5000 } })
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000))
      const status = await request(h.base, '/mesh/status')
      const ok =
        fake.taskListRequests.length === 0 &&
        status.json?.tasksPoll?.enabled === false &&
        (await Promise.resolve(fake.tasks[0]?.status)) === 'pending'
      report('hub tasks: tasksPollEnabled=false sends no task requests', ok, `listRequests=${fake.taskListRequests.length} enabled=${status.json?.tasksPoll?.enabled}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // ---- T-389: cross-machine dispatch (blob + hub task row + one local reference) ----
  await runCase('CLI hub: --dry-run prints the plan and sends nothing', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--transport', 'hub', '--to', 'dsh-mate', '--text', 'cross thing', '--dry-run', '--task', 'DMSH-20261108-01'])
    let calls = 0
    const result = await run(options, async () => {
      calls += 1
      throw new Error('network used')
    })
    const ok =
      result.dryRun === true &&
      result.transport === 'hub' &&
      result.taskId === 'DMSH-20261108-01' &&
      result.payload.target_agent === 'dsh-mate' &&
      /^sha256:[0-9a-f]{64}$/.test(result.payload.text_ref) &&
      result.payload.text_bytes === Buffer.byteLength('cross thing') &&
      result.localRow.scope === 'hub' &&
      result.localRow.hasInlineText === false &&
      calls === 0
    report('CLI hub: --dry-run prints the plan and sends nothing', ok, `task=${result.taskId} calls=${calls} bytes=${result.payload.text_bytes}`)
  })

  await runCase('CLI hub: bare task ids are rejected before any request', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--transport', 'hub', '--to', 'dsh-mate', '--text', 'x', '--task', 'T-123'])
    let calls = 0
    let error = null
    try {
      await run(options, async () => {
        calls += 1
        throw new Error('network used')
      })
    } catch (caught) {
      error = caught
    }
    const ok = error?.exitCode === 1 && /not <PREFIX>-<YYYYMMDD>-<SEQ>/.test(error.message) && calls === 0
    report('CLI hub: bare task ids are rejected before any request', ok, `exit=${error?.exitCode ?? '-'} calls=${calls}`)
  })

  await runCase('CLI hub: blob + task on the hub, one reference row locally', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      h = await boot({ config: { hubUrl: fake.url, pollIntervalMs: 5000, pollIdleIntervalMs: 5000 } })
      const { parseArgs, run } = await import(cliUrl)
      const options = parseArgs([
        '--transport', 'hub', '--to', 'dsh-mate', '--text', 'cross machine payload',
        '--task', 'DMSH-20261108-02', '--origin-ws', 'dsh-mesh', '--waker', h.base,
      ])
      const result = await run(options)
      const blobRequests = fake.requests.filter((entry) => entry.path === '/api/blob')
      const taskRequests = fake.requests.filter((entry) => entry.path === '/api/tasks' && entry.method === 'POST')
      const localFile = path.join(h.home, '.dsh', 'mesh-waker', 'local', 'tasks.jsonl')
      const rows = fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
      const row = rows.find((item) => item.taskId === 'DMSH-20261108-02')
      const ok =
        result.transport === 'hub' &&
        blobRequests.length === 1 &&
        taskRequests.length === 1 &&
        fake.blobUploads[0]?.text === 'cross machine payload' &&
        fake.taskCreates[0]?.text_ref === result.textRef &&
        fake.taskCreates[0]?.target_agent === 'dsh-mate' &&
        fake.taskCreates[0]?.origin_ws === 'dsh-mesh' &&
        row?.scope === 'hub' &&
        row?.text === undefined &&
        row?.textRef === result.textRef &&
        rows.length === 1 &&
        h.state.created.length === 0 &&
        h.state.prompts.length === 0
      report('CLI hub: blob + task on the hub, one reference row locally', ok, `blob=${blobRequests.length} task=${taskRequests.length} rows=${rows.length} bodyInRow=${row?.text !== undefined}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('CLI hub: a hub failure exits non-zero and writes no reference row', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest', failTaskStatus: 500 })
    let h = null
    try {
      h = await boot({ config: { hubUrl: fake.url, pollIntervalMs: 5000, pollIdleIntervalMs: 5000 } })
      const { parseArgs, run } = await import(cliUrl)
      const options = parseArgs(['--transport', 'hub', '--to', 'dsh-mate', '--text', 'will fail', '--task', 'DMSH-20261108-03', '--waker', h.base])
      let error = null
      try {
        await run(options)
      } catch (caught) {
        error = caught
      }
      const localFile = path.join(h.home, '.dsh', 'mesh-waker', 'local', 'tasks.jsonl')
      const rows = fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf8').split('\n').filter(Boolean) : []
      const ok = error?.exitCode === 1 && /HTTP 500/.test(error.message) && rows.length === 0 && fake.taskCreates.length === 1
      report('CLI hub: a hub failure exits non-zero and writes no reference row', ok, `exit=${error?.exitCode ?? '-'} rows=${rows.length}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('hub tasks: a raw octet-stream blob is parsed, delivered and settled', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      fake.addTask({ task_id: 'P-20261110-01', target_agent: 'dsh-test', intent: 'inbox', subject: 'raw blob' }, 'raw stream body')
      h = await boot({
        config: { hubUrl: fake.url, pollIntervalMs: 5000, pollIdleIntervalMs: 5000, tasksPollEnabled: true, tasksPollIntervalMs: 1000 },
      })
      const delivered = await waitFor(() => (h.state.prompts.length ? h.state.prompts[0] : null), 15000)
      const status = await request(h.base, '/mesh/status')
      h.emit('session/event', { id: delivered?.sessionId }, { type: 'turn/start', turn: 2 })
      h.emit('session/event', { id: delivered?.sessionId }, { type: 'turn/end', turn: 2, reason: { kind: 'completed' } })
      const settled = await waitFor(() => (fake.taskSettles.length ? fake.taskSettles[0] : null), 5000)
      const bodyDelivered = h.state.prompts.some((prompt) => JSON.stringify(prompt.content ?? '').includes('raw stream body'))
      const ok =
        Boolean(delivered) &&
        status.json?.tasksPoll?.lastError === null &&
        settled?.body?.source === 'observed' &&
        fake.tasks[0]?.status === 'settled'
      report('hub tasks: a raw octet-stream blob is parsed, delivered and settled', ok, `delivered=${delivered?.sessionId ?? '-'} body=${bodyDelivered} settle=${settled?.body?.source ?? '-'}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // ---- T-394: authoritative session identity (registry only, never titles) ----
  await runCase('identity: the registry decides who the coordinator is', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'ident-repo', 'public')
    const h = await boot({
      seedSessions: [
        { id: 'session-ident-coord', title: 'mesh · 协调', cwd },
        { id: 'session-ident-waker', title: 'ident-repo · waker', cwd },
        { id: 'session-ident-plain', title: 'just a session', cwd },
      ],
      prepareHome: (home) => {
        const dir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { 'ident-repo': { cwd, coordinator: 'session-ident-coord' } } }, null, 2)}\n`,
        )
      },
    })
    const coord = await request(h.base, '/mesh/session/identity?session=session-ident-coord')
    const worker = await request(h.base, '/mesh/session/identity?session=session-ident-waker')
    const plain = await request(h.base, '/mesh/session/identity?session=session-ident-plain')
    const unknown = await request(h.base, '/mesh/session/identity?session=session-nope')
    const ok =
      coord.json?.ok === true &&
      coord.json?.isCoordinator === true &&
      coord.json?.workspace === 'ident-repo' &&
      coord.json?.sessionId === 'session-ident-coord' &&
      // T-468: the routing-position fields, and the old aliases still agree with them.
      coord.json?.routingRole === 'primary' &&
      coord.json?.isPrimaryRouter === true &&
      coord.json?.primaryRouterSessionId === 'session-ident-coord' &&
      coord.json?.primaryRouterSessionId === coord.json?.coordinatorSessionId &&
      coord.json?.isPrimaryRouter === coord.json?.isCoordinator &&
      worker.json?.routingRole === 'none' &&
      worker.json?.isPrimaryRouter === false &&
      worker.json?.primaryRouterSessionId === 'session-ident-coord' &&
      worker.json?.isCoordinator === false &&
      worker.json?.role === 'waker' &&
      worker.json?.coordinatorSessionId === 'session-ident-coord' &&
      plain.json?.isCoordinator === false &&
      plain.json?.routingRole === 'none' &&
      plain.json?.primaryRouterSessionId === 'session-ident-coord' &&
      plain.json?.role === null &&
      unknown.json?.ok === false &&
      /session not found/.test(unknown.json?.reason ?? '')
    report(
      'identity: the registry decides who the coordinator is',
      ok,
      `coord=${coord.json?.isCoordinator} worker=${worker.json?.isCoordinator}/${worker.json?.role ?? '-'} plain=${plain.json?.isCoordinator} unknown=${unknown.json?.ok}`,
    )
  })

  await runCase('identity: a created session gets the identity line on its first prompt only', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'ident-create', 'public')
    const h = await boot({
      seedSessions: [{ id: 'session-ident-boss', title: 'mesh · 协调', cwd }],
      prepareHome: (home) => {
        const dir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { 'ident-create': { cwd, coordinator: 'session-ident-boss' } } }, null, 2)}\n`,
        )
      },
    })
    const created = await request(h.base, '/mesh/sessions/create', {
      method: 'POST',
      body: { title: 'ident-create · docs', prompt: 'write the docs', workspacePath: cwd },
    })
    const sessionId = created.json?.sessionId
    const first = h.state.prompts.find((prompt) => prompt.sessionId === sessionId)
    const firstText = JSON.stringify(first?.content ?? '')
    await request(h.base, '/mesh/inject', { method: 'POST', body: { session: sessionId, text: 'second message' } })
    const all = h.state.prompts.filter((prompt) => prompt.sessionId === sessionId)
    const secondText = JSON.stringify(all[1]?.content ?? '')
    const ok =
      created.status === 201 &&
      /\[身份\] sessionId=/.test(firstText) &&
      /workspace=ident-create/.test(firstText) &&
      /routingRole=none/.test(firstText) &&
      /isPrimaryRouter=false/.test(firstText) &&
      /primaryRouterSessionId=session-ident-boss/.test(firstText) &&
      !/isCoordinator=/.test(firstText) &&
      all.length === 2 &&
      !secondText.includes('[身份]')
    report('identity: a created session gets the identity line on its first prompt only', ok, `first=${/\[身份\]/.test(firstText)} second=${/\[身份\]/.test(secondText)} prompts=${all.length} snippet=${firstText.slice(0, 220)}`)
  })

  // ---- T-469: B-tier role injection (role card appended by target title) ----

  const roleCwd = (slug) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `waker-role-${slug}-`))
    fs.mkdirSync(path.join(cwd, '.worklog', 'roles'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.worklog', 'roles', 'docs.md'), '# docs role\n\n只改 docs 范围。\n')
    return cwd
  }

  const seedWorker = (h, slug, cwd, role, sessionId) => {
    const registry = registryOf(h)
    const entry = registry.workspaces[slug] ?? { cwd }
    entry.cwd = entry.cwd ?? cwd
    entry.workers = { ...(entry.workers ?? {}), [role]: { sessionId, cwd } }
    registry.workspaces[slug] = entry
    fs.writeFileSync(workspacesFileOf(h), `${JSON.stringify(registry, null, 2)}\n`)
  }

  await runCase('role card: a configured role file is appended to the injected task', async (boot) => {
    const cwd = roleCwd('inject')
    const logFile = path.join(os.tmpdir(), `waker-role-inject-${process.pid}-${Date.now()}.log`)
    try {
      const h = await boot({
        config: { roleInstructions: { docs: '.worklog/roles/docs.md' }, logFile },
        seedSessions: [{ id: 'session-role-docs', title: 'renamed title', cwd }],
      })
      seedWorker(h, 'role-inject', cwd, 'docs', 'session-role-docs')
      const res = await request(h.base, '/mesh/inject', { method: 'POST', body: { session: 'session-role-docs', text: 'do the thing' } })
      const text = JSON.stringify(h.state.prompts[0]?.content ?? '')
      const log = fs.readFileSync(logFile, 'utf8')
      const ok =
        res.status === 200 &&
        /do the thing/.test(text) &&
        text.includes('## 角色卡（自动注入 · docs）') &&
        text.includes('只改 docs 范围。') &&
        /role-card injected role=docs/.test(log)
      report(
        'role card: a configured role file is appended to the injected task',
        ok,
        `status=${res.status} card=${/角色卡/.test(text)} injectedLog=${/role-card injected/.test(log)}`,
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  await runCase('role card: without configuration the prompt is byte-for-byte unchanged', async (boot) => {
    const h = await boot({
      config: { injectHeader: false },
      seedSessions: [{ id: 'session-role-plain', title: 'mesh · docs', cwd: roleCwd('plain') }],
    })
    const res = await request(h.base, '/mesh/inject', { method: 'POST', body: { session: 'session-role-plain', text: 'exact body' } })
    const text = h.state.prompts[0]?.content?.[0]?.text ?? ''
    const ok = res.status === 200 && text === 'exact body'
    report('role card: without configuration the prompt is byte-for-byte unchanged', ok, `status=${res.status} text=${JSON.stringify(text).slice(0, 80)}`)
  })

  await runCase('role card: a missing file is logged and never fails the injection', async (boot) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-role-missing-'))
    const logFile = path.join(os.tmpdir(), `waker-role-missing-${process.pid}-${Date.now()}.log`)
    try {
      const h = await boot({
        config: { roleInstructions: { docs: '.worklog/roles/docs.md' }, logFile, injectHeader: false },
        seedSessions: [{ id: 'session-role-missing', title: 'whatever', cwd }],
      })
      seedWorker(h, 'role-missing', cwd, 'docs', 'session-role-missing')
      const res = await request(h.base, '/mesh/inject', { method: 'POST', body: { session: 'session-role-missing', text: 'still delivered' } })
      const text = h.state.prompts[0]?.content?.[0]?.text ?? ''
      const log = fs.readFileSync(logFile, 'utf8')
      const ok =
        res.status === 200 &&
        text === 'still delivered' &&
        /role-card missing role=docs path=/.test(log) &&
        !/角色卡（自动注入/.test(text)
      report('role card: a missing file is logged and never fails the injection', ok, `status=${res.status} missingLog=${/role-card missing/.test(log)}`)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  await runCase('role card: an unregistered title gets no injection', async (boot) => {
    const cwd = roleCwd('nonrole')
    try {
      const h = await boot({
        config: { roleInstructions: { docs: '.worklog/roles/docs.md' } },
        seedSessions: [{ id: 'session-role-none', title: 'mesh · docs', cwd }],
      })
      const res = await request(h.base, '/mesh/inject', { method: 'POST', body: { session: 'session-role-none', text: 'no card here' } })
      const text = h.state.prompts[0]?.content?.[0]?.text ?? ''
      const ok = res.status === 200 && !/角色卡（自动注入/.test(text)
      report('role card: an unregistered title gets no injection', ok, `status=${res.status} card=${/角色卡/.test(text)}`)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  await runCase('role card: a created session without registration gets no card', async (boot) => {
    const cwd = roleCwd('create')
    try {
      const h = await boot({
        config: { roleInstructions: { docs: '.worklog/roles/docs.md' } },
        seedSessions: [],
      })
      const created = await request(h.base, '/mesh/sessions/create', {
        method: 'POST',
        body: { title: 'mesh · docs', prompt: 'start work', workspacePath: cwd },
      })
      const prompt = h.state.prompts.find((entry) => entry.sessionId === created.json?.sessionId)
      const text = JSON.stringify(prompt?.content ?? '')
      const ok =
        created.status === 201 &&
        /start work/.test(text) &&
        !/角色卡（自动注入/.test(text)
      report('role card: a created session without registration gets no card', ok, `status=${created.status} card=${/角色卡/.test(text)}`)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  // ---- T-395: multi-coordinator claim protocol ----
  const coordPost = (base, action, body) => request(base, `/mesh/coordinator/${action}`, { method: 'POST', body })
  const coordWorkspace = (id) => path.join(os.tmpdir(), 'Projects', `coord-${id}`, 'public')
  const seedCoordWorkspace = (h, slug, cwd) => {
    const registry = registryOf(h)
    registry.workspaces[slug] = { cwd }
    fs.writeFileSync(workspacesFileOf(h), `${JSON.stringify(registry, null, 2)}\n`)
  }

  await runCase('coordinators: an empty workspace bootstraps its first coordinator', async (boot) => {
    const cwd = coordWorkspace('boot')
    const logFile = path.join(os.tmpdir(), `waker-coord-boot-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile },
      seedSessions: [{ id: 'session-coord-a', title: 'plain session', cwd }],
    })
    seedCoordWorkspace(h, 'coord-boot', cwd)
    const claimed = await coordPost(h.base, 'claim', { session: 'session-coord-a', channel: 'chat' })
    const entry = registryOf(h).workspaces?.['coord-boot'] ?? {}
    const log = fs.readFileSync(logFile, 'utf8')
    const ok =
      claimed.status === 201 &&
      claimed.json?.status === 'approved' &&
      entry.coordinator === 'session-coord-a' &&
      entry.coordinators?.length === 1 &&
      entry.coordinators[0].approvedBy === 'bootstrap' &&
      entry.coordinators[0].isPrimary === true &&
      /WARN .*bootstrap auto-approved/.test(log)
    report('coordinators: an empty workspace bootstraps its first coordinator', ok, `status=${claimed.json?.status} approvedBy=${entry.coordinators?.[0]?.approvedBy ?? '-'} primary=${entry.coordinator ?? '-'}`)
  })

  await runCase('coordinators: bootstrap requires the owner token when configured', async (boot) => {
    const cwd = coordWorkspace('token')
    const tokenFile = path.join(os.tmpdir(), `waker-owner-token-${process.pid}-${Date.now()}.json`)
    fs.writeFileSync(tokenFile, JSON.stringify({ token: 'own-' + 'secret' }))
    const h = await boot({
      config: { coordinatorOwnerTokenFile: tokenFile },
      seedSessions: [{ id: 'session-coord-t', title: 'plain session', cwd }],
    })
    seedCoordWorkspace(h, 'coord-token', cwd)
    const denied = await coordPost(h.base, 'claim', { session: 'session-coord-t' })
    const granted = await coordPost(h.base, 'claim', { session: 'session-coord-t', ownerToken: 'own-' + 'secret' })
    const entry = registryOf(h).workspaces?.['coord-token'] ?? {}
    const ok =
      denied.status === 403 &&
      /ownerToken/.test(denied.json?.error ?? '') &&
      granted.status === 201 &&
      granted.json?.status === 'approved' &&
      entry.coordinators?.[0]?.approvedBy === 'owner'
    report('coordinators: bootstrap requires the owner token when configured', ok, `denied=${denied.status} granted=${granted.status}/${entry.coordinators?.[0]?.approvedBy ?? '-'}`)
  })

  await runCase('coordinators: a second coordinator is approved and both stay online', async (boot) => {
    const cwd = coordWorkspace('two')
    const h = await boot({
      seedSessions: [
        { id: 'session-coord-1', title: 'plain one', cwd },
        { id: 'session-coord-2', title: 'plain two', cwd },
      ],
    })
    seedCoordWorkspace(h, 'coord-two', cwd)
    const first = await coordPost(h.base, 'claim', { session: 'session-coord-1' })
    const second = await coordPost(h.base, 'claim', { session: 'session-coord-2' })
    const identityPending = await request(h.base, '/mesh/session/identity?session=session-coord-2')
    const approved = await coordPost(h.base, 'approve', { session: 'session-coord-2', slug: 'coord-two', by: 'session-coord-1' })
    const identityApproved = await request(h.base, '/mesh/session/identity?session=session-coord-2')
    const identityPrimary = await request(h.base, '/mesh/session/identity?session=session-coord-1')
    const entry = registryOf(h).workspaces?.['coord-two'] ?? {}
    const ok =
      first.json?.status === 'approved' &&
      second.json?.status === 'pending' &&
      identityPending.json?.isCoordinator === false &&
      identityPending.json?.coordinatorStatus === 'pending' &&
      approved.status === 200 &&
      entry.coordinators?.length === 2 &&
      identityApproved.json?.isCoordinator === true &&
      identityApproved.json?.isPrimary === false &&
      // T-468: an approved non-primary member reads routingRole='member', not 'primary'.
      identityApproved.json?.routingRole === 'member' &&
      identityApproved.json?.isPrimaryRouter === true &&
      identityApproved.json?.primaryRouterSessionId === 'session-coord-1' &&
      identityPending.json?.routingRole === 'none' &&
      identityPrimary.json?.isPrimary === true &&
      identityPrimary.json?.routingRole === 'primary'
    report('coordinators: a second coordinator is approved and both stay online', ok, `coordinators=${entry.coordinators?.length} identityApproved=${identityApproved.json?.isCoordinator} isPrimary(first)=${identityPrimary.json?.isPrimary}`)
  })

  await runCase('coordinators: the limit, reject, release and primary promotion', async (boot) => {
    const cwd = coordWorkspace('limit')
    const h = await boot({
      config: { maxCoordinatorsPerWorkspace: 2 },
      seedSessions: [
        { id: 'session-c-limit-1', title: 'plain 1', cwd },
        { id: 'session-c-limit-2', title: 'plain 2', cwd },
        { id: 'session-c-limit-3', title: 'plain 3', cwd },
      ],
    })
    seedCoordWorkspace(h, 'coord-limit', cwd)
    await coordPost(h.base, 'claim', { session: 'session-c-limit-1' })
    await coordPost(h.base, 'claim', { session: 'session-c-limit-2' })
    await coordPost(h.base, 'approve', { session: 'session-c-limit-2', slug: 'coord-limit', by: 'session-c-limit-1' })
    const overLimit = await coordPost(h.base, 'claim', { session: 'session-c-limit-3' })
    const released = await coordPost(h.base, 'release', { session: 'session-c-limit-1', slug: 'coord-limit' })
    const afterRelease = registryOf(h).workspaces?.['coord-limit'] ?? {}
    const identityPromoted = await request(h.base, '/mesh/session/identity?session=session-c-limit-2')
    const rejected = await coordPost(h.base, 'reject', { session: 'session-c-limit-2', slug: 'coord-limit', by: 'session-nobody' })
    const ok =
      overLimit.status === 409 &&
      /limit 2/.test(overLimit.json?.error ?? '') &&
      (overLimit.json?.coordinators?.length ?? 0) === 2 &&
      released.status === 200 &&
      afterRelease.coordinator === 'session-c-limit-2' &&
      identityPromoted.json?.isPrimary === true &&
      rejected.status === 403
    report(
      'coordinators: the limit, reject, release and primary promotion',
      ok,
      `limit=${overLimit.status} primaryAfterRelease=${afterRelease.coordinator ?? '-'} promotedPrimary=${identityPromoted.json?.isPrimary}`,
    )
  })

  await runCase('coordinators: an expired lease is not a coordinator and can be claimed again', async (boot) => {
    const cwd = coordWorkspace('lease')
    const h = await boot({ seedSessions: [{ id: 'session-c-lease', title: 'plain lease', cwd }] })
    seedCoordWorkspace(h, 'coord-lease', cwd)
    await coordPost(h.base, 'claim', { session: 'session-c-lease' })
    const registry = registryOf(h)
    registry.workspaces['coord-lease'].coordinators[0].leaseUntil = Date.now() - 1000
    fs.writeFileSync(workspacesFileOf(h), `${JSON.stringify(registry, null, 2)}\n`)
    const identity = await request(h.base, '/mesh/session/identity?session=session-c-lease')
    const workspacesView = await request(h.base, '/mesh/workspaces')
    const reclaimed = await coordPost(h.base, 'claim', { session: 'session-c-lease' })
    const ok =
      identity.json?.isCoordinator === false &&
      identity.json?.coordinatorStatus === 'none' &&
      (workspacesView.json?.workspaces?.['coord-lease']?.coordinators?.length ?? 0) === 0 &&
      reclaimed.status === 201
    report('coordinators: an expired lease is not a coordinator and can be claimed again', ok, `identity=${identity.json?.coordinatorStatus} view=${workspacesView.json?.workspaces?.['coord-lease']?.coordinators?.length ?? 0} reclaim=${reclaimed.status}`)
  })

  await runCase('coordinators: a permanent claim has no expiry and heartbeat keeps it', async (boot) => {
    const cwd = coordWorkspace('permanent')
    const h = await boot({ seedSessions: [{ id: 'session-c-perm', title: 'plain perm', cwd }] })
    seedCoordWorkspace(h, 'coord-perm', cwd)
    const claimed = await coordPost(h.base, 'claim', { session: 'session-c-perm', slug: 'coord-perm', permanent: true })
    const member = registryOf(h).workspaces?.['coord-perm']?.coordinators?.[0]
    const hb = await coordPost(h.base, 'heartbeat', { session: 'session-c-perm', slug: 'coord-perm' })
    const memberAfter = registryOf(h).workspaces?.['coord-perm']?.coordinators?.[0]
    const ok = claimed.status === 201 && member?.leaseUntil === null && hb.status === 200 && memberAfter?.leaseUntil === null
    report('coordinators: a permanent claim has no expiry and heartbeat keeps it', ok, `claim=${claimed.status} hb=${hb.status} lease=${JSON.stringify(member?.leaseUntil)} afterHb=${JSON.stringify(memberAfter?.leaseUntil)}`)
  })

  await runCase('coordinators: a duplicate claim is refused with the current list', async (boot) => {
    const cwd = coordWorkspace('dup')
    const h = await boot({ seedSessions: [{ id: 'session-c-dup', title: 'plain dup', cwd }] })
    seedCoordWorkspace(h, 'coord-dup', cwd)
    await coordPost(h.base, 'claim', { session: 'session-c-dup' })
    const again = await coordPost(h.base, 'claim', { session: 'session-c-dup' })
    const ok = again.status === 409 && /already claimed/.test(again.json?.error ?? '') && (again.json?.coordinators?.length ?? 0) === 1
    report('coordinators: a duplicate claim is refused with the current list', ok, `status=${again.status} list=${again.json?.coordinators?.length ?? 0}`)
  })

  // T-398: historical workspaces only carry the scalar coordinator. Reading them must migrate
  // that session into an approved member, otherwise they look empty and a claim auto-approves.
  await runCase('coordinators: a legacy scalar coordinator is migrated into the array', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'coord-legacy', 'public')
    const h = await boot({
      seedSessions: [{ id: 'session-legacy', title: 'mesh · 协调', cwd }],
      prepareHome: (home) => {
        const dir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { 'coord-legacy': { cwd, coordinator: 'session-legacy' } } }, null, 2)}\n`,
        )
      },
    })
    const identity = await request(h.base, '/mesh/session/identity?session=session-legacy')
    const first = await request(h.base, '/mesh/workspaces')
    const second = await request(h.base, '/mesh/workspaces')
    const entry = first.json?.workspaces?.['coord-legacy']?.coordinators ?? []
    const ok =
      identity.json?.isCoordinator === true &&
      entry.length === 1 &&
      entry[0].sessionId === 'session-legacy' &&
      entry[0].status === 'approved' &&
      entry[0].isPrimary === true &&
      entry[0].approvedBy === 'legacy' &&
      JSON.stringify(second.json?.workspaces?.['coord-legacy']?.coordinators) === JSON.stringify(entry)
    report(
      'coordinators: a legacy scalar coordinator is migrated into the array',
      ok,
      `legacyViewApproved=${entry[0]?.status === 'approved'} legacyApprovedBy=${entry[0]?.approvedBy ?? '-'} count=${entry.length}`,
    )
  })

  await runCase('coordinators: claiming a migrated legacy workspace needs approval (no bootstrap)', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'coord-legacy-claim', 'public')
    const h = await boot({
      seedSessions: [
        { id: 'session-legacy-owner', title: 'mesh · 协调', cwd },
        { id: 'session-legacy-new', title: 'plain new', cwd },
      ],
      prepareHome: (home) => {
        const dir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { 'coord-legacy-claim': { cwd, coordinator: 'session-legacy-owner' } } }, null, 2)}\n`,
        )
      },
    })
    const claimed = await coordPost(h.base, 'claim', { session: 'session-legacy-new' })
    const approved = await coordPost(h.base, 'approve', { session: 'session-legacy-new', slug: 'coord-legacy-claim', by: 'session-legacy-owner' })
    const members = registryOf(h).workspaces?.['coord-legacy-claim']?.coordinators ?? []
    const legacyCopies = members.filter((member) => member.sessionId === 'session-legacy-owner').length
    const ok =
      claimed.status === 201 &&
      claimed.json?.status === 'pending' &&
      approved.status === 200 &&
      members.length === 2 &&
      legacyCopies === 1 &&
      members.find((member) => member.sessionId === 'session-legacy-owner')?.approvedBy === 'legacy' &&
      members.find((member) => member.sessionId === 'session-legacy-new')?.approvedBy === 'session-legacy-owner'
    report(
      'coordinators: claiming a migrated legacy workspace needs approval (no bootstrap)',
      ok,
      `legacyClaimStatus=${claimed.json?.status ?? '-'} legacyApprovedBy=${members.find((m) => m.sessionId === 'session-legacy-owner')?.approvedBy ?? '-'} noDuplicate=${legacyCopies === 1}`,
    )
  })

  await runCase('coordinators: a workspace with no legacy coordinator still bootstraps', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'coord-empty-new', 'public')
    const h = await boot({
      seedSessions: [{ id: 'session-empty-new', title: 'plain empty', cwd }],
      prepareHome: (home) => {
        const dir = path.join(home, '.dsh', 'mesh-waker')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, 'workspaces.json'),
          `${JSON.stringify({ machine: 'm', workspaces: { 'coord-empty-new': { cwd } } }, null, 2)}\n`,
        )
      },
    })
    const claimed = await coordPost(h.base, 'claim', { session: 'session-empty-new' })
    const members = registryOf(h).workspaces?.['coord-empty-new']?.coordinators ?? []
    const ok = claimed.status === 201 && claimed.json?.status === 'approved' && members.length === 1 && members[0].approvedBy === 'bootstrap'
    report('coordinators: a workspace with no legacy coordinator still bootstraps', ok, `status=${claimed.json?.status ?? '-'} approvedBy=${members[0]?.approvedBy ?? '-'}`)
  })

  // T-399: the hub settle field is `status`, not `result`. The fake hub now validates it, so a
  // regression would fail here instead of silently passing.
  await runCase('hub tasks: settle sends the status key and the fake hub rejects a result-only body', async () => {
    const { createHubTaskConsumer } = await import(hubTasksUrl)
    const stub = taskFetchStub([taskRow('P-20261110-01')])
    const consumer = createHubTaskConsumer({
      enabled: true,
      agent: 'mesh-b',
      pollIntervalMs: 600000,
      leaseMs: 600000,
      fetchJson: stub.fetchJson,
      deliverTask: async () => {},
    })
    let clientSettle = null
    let settleCall = null
    try {
      await consumer.pollOnce()
      clientSettle = await consumer.settleTask('P-20261110-01', { result: 'completed', summary: 'ok', source: 'observed' })
      settleCall = stub.calls.find((call) => call.path.endsWith('/settle'))
    } finally {
      consumer.stop()
    }
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    try {
      fake.addTask({ task_id: 'P-20261110-02', target_agent: 'dsh-test' }, 'x')
      const rejected = await request(fake.url, '/api/tasks/P-20261110-02/settle', { method: 'POST', body: { result: 'completed', source: 'observed' } })
      const accepted = await request(fake.url, '/api/tasks/P-20261110-02/settle', { method: 'POST', body: { status: 'completed', source: 'observed' } })
      const ok =
        clientSettle?.ok === true &&
        settleCall?.body?.status === 'completed' &&
        settleCall?.body?.result === undefined &&
        rejected.status === 400 &&
        /status must be completed\|error\|lost\|partial/.test(rejected.json?.error ?? '') &&
        accepted.status === 200
      report('hub tasks: settle sends the status key and the fake hub rejects a result-only body', ok, `settleStatusKey=${settleCall?.body?.status ?? '-'} fakeHubRejectsResultOnly=${rejected.status} accepted=${accepted.status}`)
    } finally {
      await fake.close()
    }
  })

  await runCase('hub tasks: a rejected settle is surfaced in lastError', async () => {
    const { createHubTaskConsumer } = await import(hubTasksUrl)
    const stub = taskFetchStub([taskRow('P-20261110-03')], {})
    // Override settle to mimic the hub's 400 for a bad body.
    const rejecting = async (requestPath, options) => {
      const res = await stub.fetchJson(requestPath, options)
      if (requestPath.endsWith('/settle')) return { ok: false, status: 400, json: { error: 'status must be completed|error|lost|partial' } }
      return res
    }
    const consumer = createHubTaskConsumer({
      enabled: true,
      agent: 'mesh-b',
      pollIntervalMs: 600000,
      leaseMs: 600000,
      fetchJson: rejecting,
      deliverTask: async () => {},
    })
    try {
      await consumer.pollOnce()
      const settled = await consumer.settleTask('P-20261110-03', { result: 'completed', source: 'observed' })
      const snap = consumer.status()
      const ok = settled.ok === false && /settle P-20261110-03 failed: HTTP 400/.test(snap.lastError ?? '')
      report('hub tasks: a rejected settle is surfaced in lastError', ok, `ok=${settled.ok} lastError=${snap.lastError ?? '-'}`)
    } finally {
      consumer.stop()
    }
  })

  // ---- T-403: cancel stops the turn (not just the row) ----
  const injectAndStart = async (h, { taskId, sessionId, turn = 1 }) => {
    await request(h.base, '/mesh/inject', { method: 'POST', body: { session: sessionId, text: 'work', meta: { taskId } } })
    h.emit('session/event', { id: sessionId }, { type: 'turn/start', turn })
  }

  await runCase('cancel: a started task stops the turn and settles aborted', async (boot) => {
    const h = await boot({ config: { cancelWaitMs: 150 }, seedSessions: [{ id: 'session-cancel-a', title: 'cancel target' }] })
    h.state.agents.set('session-cancel-a', {})
    await injectAndStart(h, { taskId: 'T-cancel-a', sessionId: 'session-cancel-a' })
    const result = await request(h.base, '/mesh/cancel', { method: 'POST', body: { task: 'T-cancel-a', reason: 'wrong workspace' } })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-cancel-a'), 4000)
    const ok =
      result.status === 200 &&
      result.json?.turnWasOpen === true &&
      result.json?.sessionLive === true &&
      result.json?.taskStatus === 'cancelled' &&
      h.state.cancels.includes('session-cancel-a') &&
      receipt?.status === 'aborted' &&
      /cancelled by loopback: wrong workspace/.test(receipt?.reasonDetail ?? '')
    report('cancel: a started task stops the turn and settles aborted', ok, `turnWasOpen=${result.json?.turnWasOpen} sessionLive=${result.json?.sessionLive} cancels=${h.state.cancels.length} receipt=${receipt?.status}`)
  })

  await runCase('cancel: a task that never started still gets an aborted receipt', async (boot) => {
    const h = await boot({ config: { cancelWaitMs: 150 }, seedSessions: [{ id: 'session-cancel-b', title: 'idle target' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { session: 'session-cancel-b', text: 'work', meta: { taskId: 'T-cancel-b' } } })
    const result = await request(h.base, '/mesh/cancel', { method: 'POST', body: { task: 'T-cancel-b' } })
    const status = await request(h.base, '/mesh/status')
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-cancel-b'), 4000)
    const ok = result.status === 200 && result.json?.turnWasOpen === false && status.json?.pendingTasks === 0 && receipt?.status === 'aborted'
    report('cancel: a task that never started still gets an aborted receipt', ok, `turnWasOpen=${result.json?.turnWasOpen} pending=${status.json?.pendingTasks} receipt=${receipt?.status}`)
  })

  await runCase('cancel: a settled task is refused without touching the session', async (boot) => {
    const h = await boot({ config: { cancelWaitMs: 150 }, seedSessions: [{ id: 'session-cancel-c', title: 'settled target' }] })
    await injectAndStart(h, { taskId: 'T-cancel-c', sessionId: 'session-cancel-c' })
    h.emit('session/event', { id: 'session-cancel-c' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-cancel-c'), 4000)
    const result = await request(h.base, '/mesh/cancel', { method: 'POST', body: { task: 'T-cancel-c' } })
    const ok = result.status === 409 && h.state.cancels.length === 0
    report('cancel: a settled task is refused without touching the session', ok, `status=${result.status} cancels=${h.state.cancels.length}`)
  })

  await runCase('cancel: session-only cancel stops the turn and leaves tasks alone', async (boot) => {
    const h = await boot({ config: { cancelWaitMs: 150 }, seedSessions: [{ id: 'session-cancel-d', title: 'session only' }] })
    h.emit('session/event', { id: 'session-cancel-d' }, { type: 'turn/start', turn: 2 })
    const result = await request(h.base, '/mesh/cancel', { method: 'POST', body: { session: 'session-cancel-d' } })
    const status = await request(h.base, '/mesh/status')
    const ok =
      result.status === 200 &&
      result.json?.turnWasOpen === true &&
      result.json?.taskId === null &&
      h.state.cancels.includes('session-cancel-d') &&
      status.json?.pendingTasks === 0 &&
      readReceipts(h.receiptsPath).length === 0
    report('cancel: session-only cancel stops the turn and leaves tasks alone', ok, `turnWasOpen=${result.json?.turnWasOpen} cancels=${h.state.cancels.length} receipts=${readReceipts(h.receiptsPath).length}`)
  })

  await runCase('cancel: nothing running is a 409', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-cancel-e', title: 'idle session' }] })
    const result = await request(h.base, '/mesh/cancel', { method: 'POST', body: { session: 'session-cancel-e' } })
    const ok = result.status === 409 && /nothing to cancel/.test(result.json?.error ?? '')
    report('cancel: nothing running is a 409', ok, `status=${result.status} error=${result.json?.error ?? '-'}`)
  })

  await runCase('cancel: DELETE /mesh/tasks/:id really stops the turn', async (boot) => {
    const h = await boot({ config: { cancelWaitMs: 150 }, seedSessions: [{ id: 'session-cancel-f', title: 'delete target' }] })
    await injectAndStart(h, { taskId: 'T-cancel-f', sessionId: 'session-cancel-f' })
    const result = await request(h.base, '/mesh/tasks/T-cancel-f', { method: 'DELETE' })
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-cancel-f'), 4000)
    const ok = result.status === 200 && h.state.cancels.includes('session-cancel-f') && receipt?.status === 'aborted'
    report('cancel: DELETE /mesh/tasks/:id really stops the turn', ok, `status=${result.status} cancels=${h.state.cancels.length} receipt=${receipt?.status ?? '-'}`)
  })

  await runCase('cancel: the mesh_cancel tool is registered and requires a target', async (boot) => {
    const h = await boot({})
    await waitFor(() => h.state.tools.length > 0, 5000)
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_cancel')
    let error = null
    try {
      await tool.execute({}, { sessionId: 'session-tool-cancel' })
    } catch (caught) {
      error = caught
    }
    const ok = Boolean(tool) && Boolean(tool.parameters?.properties?.task) && Boolean(tool.parameters?.properties?.session) && /task|session/.test(error?.message ?? '')
    report('cancel: the mesh_cancel tool is registered and requires a target', ok, `registered=${Boolean(tool)} rejected=${error ? 'yes' : 'no'}`)
  })

  // ---- T-404: receipt summaries are opt-in; the default notice stays a status line ----
  const receiptLibUrl = pathToFileURL(path.join(REPO, 'plugins', 'mesh-waker', 'lib', 'receipt.mjs')).href

  await runCase('receipt summary: default notices stay status-only', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-sum-work', title: 'sum worker' },
        { id: 'session-sum-notify', title: 'sum notify' },
      ],
      config: { receiptTo: 'session-sum-notify', receiptMode: 'wake' },
    })
    const { buildBatchReceipt } = await import(receiptLibUrl)
    const batch = buildBatchReceipt({ batchId: 'B-sum-default', tasks: [{ taskId: 'T-sum-0', status: 'completed', durationMs: 5, summary: 'SECRET SUMMARY' }] })
    await request(h.base, '/mesh/inject', { method: 'POST', body: { session: 'session-sum-work', text: 'work', meta: { taskId: 'T-sum-0', receipt: 'wake' } } })
    h.emit('session/event', { id: 'session-sum-work' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-sum-work' }, { type: 'assistant/message', turn: 1, message: { content: [{ type: 'text', text: 'SECRET SUMMARY' }] } })
    h.emit('session/event', { id: 'session-sum-work' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const notice = await waitFor(() => h.state.prompts.find((prompt) => JSON.stringify(prompt).includes('[RECEIPT] T-sum-0')), 5000)
    const noticeText = JSON.stringify(notice ?? '')
    const ok = Boolean(notice) && !noticeText.includes('SECRET SUMMARY') && !batch.body.includes('SECRET SUMMARY') && /status|completed/.test(noticeText)
    report('receipt summary: default notices stay status-only', ok, `notice=${noticeText.slice(0, 90)} batchHasSummary=${batch.body.includes('SECRET SUMMARY')}`)
  })

  await runCase('receipt summary: a single dispatch can opt in', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-sum-optin', title: 'sum worker' },
        { id: 'session-sum-optin-notify', title: 'sum notify' },
      ],
      config: { receiptTo: 'session-sum-optin-notify', receiptMode: 'wake' },
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { session: 'session-sum-optin', text: 'work', meta: { taskId: 'T-sum-1', receipt: 'wake', receiptSummary: true } },
    })
    h.emit('session/event', { id: 'session-sum-optin' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-sum-optin' }, { type: 'assistant/message', turn: 1, message: { content: [{ type: 'text', text: 'BRANCH AND COMMIT SUMMARY' }] } })
    h.emit('session/event', { id: 'session-sum-optin' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    const notice = await waitFor(() => h.state.prompts.find((prompt) => JSON.stringify(prompt).includes('[RECEIPT] T-sum-1')), 5000)
    const ok = Boolean(notice) && JSON.stringify(notice).includes('BRANCH AND COMMIT SUMMARY')
    report('receipt summary: a single dispatch can opt in', ok, `containsSummary=${JSON.stringify(notice ?? '').includes('BRANCH AND COMMIT SUMMARY')}`)
  })

  await runCase('receipt summary: a batch member opt-in renders summaries in the aggregate', async (boot) => {
    const h = await boot({
      seedSessions: [
        { id: 'session-batch-sum', title: 'batch sum worker' },
        { id: 'session-batch-sum-notify', title: 'batch sum notify' },
      ],
      config: { receiptTo: 'session-batch-sum-notify', barrierMode: 'wake' },
    })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { session: 'session-batch-sum', text: 'a', meta: { taskId: 'T-bsum-a', batchId: 'B-sum-1', receiptSummary: true } },
    })
    h.emit('session/event', { id: 'session-batch-sum' }, { type: 'turn/start', turn: 1 })
    h.emit('session/event', { id: 'session-batch-sum' }, { type: 'assistant/message', turn: 1, message: { content: [{ type: 'text', text: 'ALPHA CONCLUSION' }] } })
    h.emit('session/event', { id: 'session-batch-sum' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { session: 'session-batch-sum', text: 'b', meta: { taskId: 'T-bsum-b', batchId: 'B-sum-1', receiptSummary: true } },
    })
    h.emit('session/event', { id: 'session-batch-sum' }, { type: 'turn/start', turn: 2 })
    h.emit('session/event', { id: 'session-batch-sum' }, { type: 'assistant/message', turn: 2, message: { content: [{ type: 'text', text: 'BETA CONCLUSION' }] } })
    h.emit('session/event', { id: 'session-batch-sum' }, { type: 'turn/end', turn: 2, reason: { kind: 'completed' } })
    const notice = await waitFor(
      () => h.state.prompts.find((prompt) => JSON.stringify(prompt).includes('[BATCH] B-sum-1') && JSON.stringify(prompt).includes('ALPHA')),
      6000,
    )
    const text = JSON.stringify(notice ?? '')
    const ok = Boolean(notice) && text.includes('ALPHA CONCLUSION') && text.includes('BETA CONCLUSION')
    report('receipt summary: a batch member opt-in renders summaries in the aggregate', ok, `aggregate=${Boolean(notice)} hasAlpha=${text.includes('ALPHA CONCLUSION')} hasBeta=${text.includes('BETA CONCLUSION')}`)
  })

  await runCase('receipt summary: summaries are truncated and the record keeps them', async () => {
    const { buildReceipt, receiptNoticeText, buildBatchReceipt } = await import(receiptLibUrl)
    const long = 'x'.repeat(500)
    const receipt = buildReceipt({ taskId: 'T-trunc', status: 'completed', summary: long, summaryChars: 300, noticeSummary: true })
    const rendered = receiptNoticeText(receipt, { includeSummary: true })
    const batch = buildBatchReceipt({
      batchId: 'B-trunc',
      tasks: [{ taskId: 'T-trunc', status: 'completed', durationMs: 5, summary: long }],
      includeSummaries: true,
      summaryChars: 300,
    })
    const ok =
      receipt.summary.length === 301 &&
      receipt.summary.endsWith('…') &&
      rendered.includes(receipt.summary) &&
      batch.body.includes(receipt.summary) &&
      batch.record.tasks[0].summary === receipt.summary
    report('receipt summary: summaries are truncated and the record keeps them', ok, `recordLen=${receipt.summary.length} renderedTruncated=${rendered.includes(receipt.summary)}`)
  })

  await runCase('receipt summary: the batch body is capped and says it was truncated', async () => {
    const { buildBatchReceipt } = await import(receiptLibUrl)
    const tasks = Array.from({ length: 12 }, (_, index) => ({
      taskId: `T-cap-${index}`,
      status: 'completed',
      durationMs: 1000,
      summary: 'y'.repeat(300),
    }))
    const batch = buildBatchReceipt({ batchId: 'B-cap', tasks, includeSummaries: true, summaryChars: 300, maxBytes: 1500 })
    const bytes = Buffer.byteLength(batch.body, 'utf8')
    const ok = bytes <= 1500 && batch.body.includes('摘要已截断') && batch.body.split('\n').length > 3
    report('receipt summary: the batch body is capped and says it was truncated', ok, `bytes=${bytes} hint=${batch.body.includes('摘要已截断')}`)
  })

  // T-407: minimal installs (hubUrl + token only) have no workspacePath/sessionCwd; the
  // system inbox must still be creatable, otherwise a hub task with an inbox fallback dies.
  await runCase('hub tasks: the inbox fallback works without a configured inbox workspace', async (boot) => {
    const fake = await startFakeHub({ token: 'tok-' + 'selftest' })
    let h = null
    try {
      fake.addTask({ task_id: 'P-20261111-09', target_agent: 'dsh-test', intent: 'inbox', subject: 'minimal install' }, 'inbox body')
      h = await boot({
        config: {
          hubUrl: fake.url,
          pollIntervalMs: 5000,
          pollIdleIntervalMs: 5000,
          tasksPollEnabled: true,
          tasksPollIntervalMs: 1000,
          workspacePath: undefined,
          sessionCwd: undefined,
        },
      })
      const delivered = await waitFor(() => (h.state.prompts.length ? h.state.prompts[0] : null), 15000)
      const status = await request(h.base, '/mesh/status')
      const ok = h.state.created.length === 1 && Boolean(delivered) && status.json?.tasksPoll?.lastError === null
      report('hub tasks: the inbox fallback works without a configured inbox workspace', ok, `created=${h.state.created.length} delivered=${Boolean(delivered)} lastError=${status.json?.tasksPoll?.lastError ?? 'none'}`)
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // T-413: a thread bound before anything was dispatched has lastTaskId: null; the host
  // rejected that under `type: string` for mesh_thread list.
  await runCase('tools: mesh_thread list satisfies THREAD_OUTPUT with a null lastTaskId', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-thread-null', title: 'thread null target' }] })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const subscribed = await request(h.base, '/mesh/threads/subscribe', { method: 'POST', body: { thread: 'TH-null-1', sessionId: 'session-thread-null' } })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_thread')
    const listed = await tool.execute({ action: 'list', scope: 'all' }, { sessionId: 'session-thread-null' })
    const { THREAD_OUTPUT } = await import(pathToFileURL(ENTRY).href)
    const issues = validateHostSubset(THREAD_OUTPUT.schema, listed)
    const row = (listed.threads ?? []).find((entry) => entry.thread === 'TH-null-1')
    const status = await request(h.base, '/mesh/status')
    const ok =
      subscribed.status === 200 &&
      row?.lastTaskId === null &&
      issues.length === 0 &&
      status.json?.tools?.cancel === true &&
      (status.json?.toolsError ?? null) === null
    report(
      'tools: mesh_thread list satisfies THREAD_OUTPUT with a null lastTaskId',
      ok,
      `lastTaskId=${row?.lastTaskId === null ? 'null' : String(row?.lastTaskId)} threadIssues=${issues.length} tools.cancel=${status.json?.tools?.cancel} toolsError=${status.json?.toolsError ?? 'null'}`,
    )
  })

  // ---- T-415: the injected header names its source instead of a bare `unknown` ----
  const headerLineOf = (h, index = 0) => String(h.state.prompts[index]?.content?.[0]?.text ?? '').split('\n')[0]
  const headerBodyOf = (h, index = 0) => String(h.state.prompts[index]?.content?.[0]?.text ?? '').split('\n\n').slice(1).join('\n\n')
  const STAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/

  await runCase('inject: a header falls back to the sender origin', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-hdr-origin', title: 'hdr origin' }] })
    const sent = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { session: 'session-hdr-origin', text: 'origin body', origin: 'dsh-peer-b/xiajiang' },
    })
    const header = headerLineOf(h)
    const taskMatch = header.match(/^\[TASK ([^ ]+) · THREAD - · BATCH - · FROM unknown\(dsh-peer-b\/xiajiang\)\] /)
    const ok =
      sent.status === 200 &&
      Boolean(taskMatch) &&
      /^T-[0-9a-z]+$/.test(taskMatch?.[1] ?? '') &&
      sent.json?.taskId === taskMatch?.[1] &&
      STAMP_RE.test(header) &&
      headerBodyOf(h) === 'origin body'
    report('inject: a header falls back to the sender origin', ok, `injectFrom=unknown(dsh-peer-b/xiajiang) injectTaskId=${sent.json?.taskId} header=${header}`)
  })

  await runCase('inject: a header with no source keeps the bare unknown', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-hdr-plain', title: 'hdr plain' }] })
    const sent = await request(h.base, '/mesh/inject', { method: 'POST', body: { session: 'session-hdr-plain', text: 'plain body' } })
    const header = headerLineOf(h)
    const ok = sent.status === 200 && / · FROM unknown\] /.test(header) && headerBodyOf(h) === 'plain body'
    report('inject: a header with no source keeps the bare unknown', ok, `header=${header}`)
  })

  await runCase('inject: a header with a requester is unchanged', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-hdr-legacy', title: 'hdr legacy' }] })
    const sent = await request(h.base, '/mesh/inject', {
      method: 'POST',
      body: { session: 'session-hdr-legacy', text: 'legacy body', requester: 'session-req-x', origin: 'ignored/origin' },
    })
    const header = headerLineOf(h)
    const taskId = sent.json?.taskId
    const stamp = header.slice(header.lastIndexOf('] ') + 2)
    const expected = `[TASK ${taskId} · THREAD - · BATCH - · FROM session-req-x] ${stamp}`
    const legacyHeaderByteIdentical = header === expected && STAMP_RE.test(stamp)
    const ok = sent.status === 200 && legacyHeaderByteIdentical && !header.includes('ignored/origin') && headerBodyOf(h) === 'legacy body'
    report('inject: a header with a requester is unchanged', ok, `legacyHeaderByteIdentical=${legacyHeaderByteIdentical} header=${header}`)
  })

  await runCase('CLI: DSH_SESSION_ID becomes the default requester', async () => {
    const cliPath = path.join(REPO, 'plugins', 'mesh-waker', 'bin', 'dispatch.mjs')
    const args = [cliPath, '--target', 'some-session', '--text', 'hi', '--dry-run', '--json']
    const withEnv = await runCliProcess(args, { env: { DSH_SESSION_ID: 'session-cli-env' } })
    const withoutEnv = await runCliProcess(args, { env: { DSH_SESSION_ID: '' } })
    const withJson = JSON.parse(withEnv.stdout || '{}')
    const withoutJson = JSON.parse(withoutEnv.stdout || '{}')
    const cliRequester = withJson.payload?.requester ?? null
    const ok =
      withEnv.status === 0 &&
      cliRequester === 'session-cli-env' &&
      withoutJson.payload?.requester === undefined &&
      /requester=session-cli-env/.test(withEnv.stderr)
    report('CLI: DSH_SESSION_ID becomes the default requester', ok, `cliRequester=${cliRequester ?? '-'} noEnv=${withoutJson.payload?.requester ?? '-'} stderrNoted=${/requester=session-cli-env/.test(withEnv.stderr)}`)
  })

  // T-412: the queue baseline under-counted across turn boundaries, so one turn/end settled
  // several tasks that had not run yet (T-407/T-408 reported completed while turn 53 ran
  // different work).
  await runCase('queue: a task behind a cross-turn backlog waits for its own turn', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-q412', title: 'queue 412' }] })
    const emit = (type, turn, extra = {}) => h.emit('session/event', { id: 'session-q412' }, { type, turn, ...extra })
    const inject = (taskId, text) => request(h.base, '/mesh/inject', { method: 'POST', body: { session: 'session-q412', text, meta: { taskId } } })
    const settled = (taskId) => readReceipts(h.receiptsPath).find((row) => !row.kind && row.taskId === taskId) ?? null
    emit('turn/start', 1)
    await inject('T-q412-a', 'a')
    await inject('T-q412-b', 'b')
    emit('turn/end', 1, { reason: { kind: 'completed' } })
    emit('turn/start', 2)
    await inject('T-q412-c', 'c')
    emit('turn/end', 2, { reason: { kind: 'completed' } })
    const afterTurn2 = ['T-q412-a', 'T-q412-b', 'T-q412-c'].filter((taskId) => settled(taskId))
    emit('turn/start', 3)
    emit('turn/end', 3, { reason: { kind: 'completed' } })
    const afterTurn3 = ['T-q412-a', 'T-q412-b', 'T-q412-c'].filter((taskId) => settled(taskId))
    emit('turn/start', 4)
    emit('turn/end', 4, { reason: { kind: 'completed' } })
    const turns = ['T-q412-a', 'T-q412-b', 'T-q412-c'].map((taskId) => settled(taskId)?.turn ?? null)
    const ok =
      afterTurn2.join(',') === 'T-q412-a' &&
      afterTurn3.join(',') === 'T-q412-a,T-q412-b' &&
      turns.every((turn) => turn !== null) &&
      new Set(turns).size === 3 &&
      turns[2] === 4
    report(
      'queue: a task behind a cross-turn backlog waits for its own turn',
      ok,
      `afterTurn2=[${afterTurn2}] afterTurn3=[${afterTurn3}] receiptTurns=[${turns}]`,
    )
  })

  // ---- T-416: dispatch carries git context and artifact expectations ----
  const gitTestSetup = () => {
    const { execFileSync } = require('node:child_process')
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
    } catch {
      return { available: false }
    }
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-waker-git-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    return { available: true, repo, branch }
  }

  await runCase('dispatch: the response carries the target git context', async (boot) => {
    const setup = gitTestSetup()
    if (!setup.available) {
      report('dispatch: the response carries the target git context', true, 'skipped: git is not installed')
      return
    }
    const h = await boot({ seedSessions: [{ id: 'session-git-a', title: 'git worker', cwd: setup.repo }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    const result = await tool.execute({ target: 'session-git-a', text: 'read the tree' })
    const git = result.git ?? {}
    const ok =
      result.ok === true &&
      result.git !== null &&
      git.cwd === setup.repo &&
      git.branch === setup.branch &&
      /^[0-9a-f]{4,}$/.test(git.head ?? '') &&
      git.dirty === false &&
      h.state.prompts.length === 1
    report('dispatch: the response carries the target git context', ok, `git=${JSON.stringify(git)}`)
  })

  await runCase('dispatch: expectBranch warns without blocking the task', async (boot) => {
    const setup = gitTestSetup()
    if (!setup.available) {
      report('dispatch: expectBranch warns without blocking the task', true, 'skipped: git is not installed')
      return
    }
    const h = await boot({ seedSessions: [{ id: 'session-git-b', title: 'git worker', cwd: setup.repo }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    const mismatch = await tool.execute({ target: 'session-git-b', text: 'one', expectBranch: 'not-this-branch' })
    const match = await tool.execute({ target: 'session-git-b', text: 'two', expectBranch: setup.branch })
    const ok =
      (mismatch.warnings ?? []).some((line) => /branch mismatch/.test(line) && line.includes('not-this-branch')) &&
      (match.warnings ?? []).length === 0 &&
      h.state.prompts.length === 2
    report('dispatch: expectBranch warns without blocking the task', ok, `mismatchWarning=${JSON.stringify(mismatch.warnings ?? [])} matchWarnings=${(match.warnings ?? []).length} delivered=${h.state.prompts.length}`)
  })

  await runCase('dispatch: artifacts are listed at settlement, missing ones included', async (boot) => {
    const setup = gitTestSetup()
    if (!setup.available) {
      report('dispatch: artifacts are listed at settlement, missing ones included', true, 'skipped: git is not installed')
      return
    }
    fs.writeFileSync(path.join(setup.repo, 'out.txt'), 'produced\n')
    const h = await boot({ seedSessions: [{ id: 'session-git-c', title: 'git worker', cwd: setup.repo }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    const result = await tool.execute({
      target: 'session-git-c',
      text: 'produce it',
      taskId: 'T-git-artifacts',
      artifacts: ['out.txt', 'missing.txt'],
    })
    settleOnTurn(h, 'session-git-c', 1)
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((row) => row.taskId === 'T-git-artifacts'), 4000)
    const produced = (receipt?.artifacts ?? []).find((entry) => entry.path === 'out.txt')
    const missing = (receipt?.artifacts ?? []).find((entry) => entry.path === 'missing.txt')
    const ok =
      result.ok === true &&
      (receipt?.artifacts ?? []).length === 2 &&
      produced?.exists === true &&
      typeof produced?.sizeBytes === 'number' &&
      missing?.exists === false &&
      missing?.sizeBytes === null &&
      receipt?.git?.branch === setup.branch
    report('dispatch: artifacts are listed at settlement, missing ones included', ok, `artifacts=${JSON.stringify(receipt?.artifacts ?? [])} receiptGit=${JSON.stringify(receipt?.git ?? null)}`)
  })

  await runCase('dispatch: a non-git workspace yields git:null but still delivers', async (boot) => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-waker-nogit-'))
    const h = await boot({ seedSessions: [{ id: 'session-git-d', title: 'plain worker', cwd: plain }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    const result = await tool.execute({ target: 'session-git-d', text: 'no repo here' })
    const ok = result.ok === true && result.git === null && h.state.prompts.length === 1
    report('dispatch: a non-git workspace yields git:null but still delivers', ok, `git=${JSON.stringify(result.git)} delivered=${h.state.prompts.length}`)
  })

  await runCase('dispatch: unsafe artifact paths are rejected before delivery', async (boot) => {
    const h = await boot({ seedSessions: [{ id: 'session-git-e', title: 'plain worker' }] })
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    const errors = []
    for (const artifacts of [['C:\\Windows\\win.ini'], ['../outside.txt'], ['ok.txt', 'dir/../../escape']]) {
      try {
        await tool.execute({ target: 'session-git-e', text: 'nope', artifacts })
      } catch (error) {
        errors.push(String(error.message))
      }
    }
    const ok = errors.length === 3 && errors.every((message) => /relative|\.\./.test(message)) && h.state.prompts.length === 0
    report('dispatch: unsafe artifact paths are rejected before delivery', ok, `rejected=${errors.length} delivered=${h.state.prompts.length} first=${(errors[0] ?? '-').slice(0, 80)}`)
  })

  // ---- T-418: advisory workspace lock ----
  await runCase('lock: acquire is idempotent, visible, and 409 to other sessions', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'lock-ws-a')
    const h = await boot({
      seedSessions: [
        { id: 'session-lock-holder', title: 'lock holder', cwd },
        { id: 'session-lock-other', title: 'lock other', cwd },
      ],
    })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_lock')
    const first = await tool.execute({ action: 'acquire', reason: 'build' }, { sessionId: 'session-lock-holder' })
    const again = await tool.execute({ action: 'acquire' }, { sessionId: 'session-lock-holder' })
    const status = await tool.execute({ action: 'status' }, { sessionId: 'session-lock-other' })
    const conflict = await request(h.base, '/mesh/workspace/lock', {
      method: 'POST',
      body: { workspace: first.workspace, sessionId: 'session-lock-other' },
    })
    const listed = await request(h.base, '/mesh/workspaces')
    const visible = listed.json?.workspaces?.[first.workspace]?.lock ?? null
    const released = await tool.execute({ action: 'release' }, { sessionId: 'session-lock-holder' })
    const after = await tool.execute({ action: 'status' }, { sessionId: 'session-lock-other' })
    const ok =
      first.ok === true &&
      first.renewed === false &&
      typeof first.lock?.expiresAt === 'number' &&
      again.renewed === true &&
      status.lock?.ownerSessionId === 'session-lock-holder' &&
      conflict.status === 409 &&
      conflict.json?.holder?.ownerSessionId === 'session-lock-holder' &&
      typeof conflict.json?.holder?.expiresAt === 'number' &&
      visible?.ownerSessionId === 'session-lock-holder' &&
      released.released === true &&
      after.lock === null
    report(
      'lock: acquire is idempotent, visible, and 409 to other sessions',
      ok,
      `lock=${JSON.stringify({ workspace: first.workspace, owner: status.lock?.ownerSessionId ?? null })} conflict=${conflict.status} released=${released.released} after=${after.lock ? 'held' : 'free'}`,
    )
  })

  await runCase('lock: a locked workspace queues dispatches and delivers after release', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'lock-ws-b')
    const h = await boot({
      config: { workspaceLockTtlMs: 60000 },
      seedSessions: [
        { id: 'session-lock-holder-b', title: 'holder b', cwd },
        { id: 'session-lock-worker-b', title: 'worker b', cwd },
        { id: 'session-lock-dispatcher-b', title: 'dispatcher b', cwd },
      ],
    })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const lockTool = h.state.tools.find((entry) => entry.name === 'mesh_lock')
    const dispatchTool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    const acquired = await lockTool.execute({ action: 'acquire' }, { sessionId: 'session-lock-holder-b' })
    const queued = await dispatchTool.execute(
      { target: 'session-lock-worker-b', text: 'change the tree', taskId: 'T-lock-queued' },
      { sessionId: 'session-lock-dispatcher-b' },
    )
    const row = await request(h.base, '/mesh/tasks/T-lock-queued')
    const promptsWhileLocked = h.state.prompts.length
    await lockTool.execute({ action: 'release' }, { sessionId: 'session-lock-holder-b' })
    const delivered = await waitFor(() => (h.state.prompts.length === 1 ? h.state.prompts[0] : null), 5000)
    settleOnTurn(h, 'session-lock-worker-b', 1)
    const receipt = await waitFor(() => readReceipts(h.receiptsPath).find((entry) => entry.taskId === 'T-lock-queued'), 4000)
    const ok =
      acquired.ok === true &&
      queued.ok === true &&
      queued.waitingLock?.workspace === acquired.workspace &&
      promptsWhileLocked === 0 &&
      row.json?.task?.status === 'waiting-lock' &&
      Boolean(delivered) &&
      receipt?.status === 'completed'
    report(
      'lock: a locked workspace queues dispatches and delivers after release',
      ok,
      `waitingLock=${queued.waitingLock?.workspace ?? '-'} promptsWhileLocked=${promptsWhileLocked} rowStatus=${row.json?.task?.status ?? '-'} receipt=${receipt?.status ?? '-'}`,
    )
  })

  await runCase('lock: an expired lock releases the queue automatically', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'lock-ws-c')
    const h = await boot({
      seedSessions: [
        { id: 'session-lock-holder-c', title: 'holder c', cwd },
        { id: 'session-lock-worker-c', title: 'worker c', cwd },
        { id: 'session-lock-dispatch-c', title: 'dispatch c', cwd },
      ],
    })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const lockTool = h.state.tools.find((entry) => entry.name === 'mesh_lock')
    const dispatchTool = h.state.tools.find((entry) => entry.name === 'mesh_dispatch')
    await lockTool.execute({ action: 'acquire', ttlMs: 10000, reason: 'short lease' }, { sessionId: 'session-lock-holder-c' })
    const dispatched = await dispatchTool.execute(
      { target: 'session-lock-worker-c', text: 'ttl task', taskId: 'T-lock-ttl' },
      { sessionId: 'session-lock-dispatch-c' },
    )
    const promptsBefore = h.state.prompts.length
    const delivered = await waitFor(() => (h.state.prompts.length > 0 ? h.state.prompts[0] : null), 20000)
    const ok = Boolean(dispatched.waitingLock) && promptsBefore === 0 && Boolean(delivered)
    report(
      'lock: an expired lock releases the queue automatically',
      ok,
      `ttlMs=10000 promptsBefore=${promptsBefore} deliveredAfterExpiry=${Boolean(delivered)}`,
    )
  })

  await runCase('lock: a restart starts with an empty lock table', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'lock-ws-d')
    const logFile = fileLogFile()
    const h = await boot({ config: { logFile }, seedSessions: [{ id: 'session-lock-restart', title: 'restart', cwd }] })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const listed = await request(h.base, '/mesh/workspaces')
    const locks = Object.values(listed.json?.workspaces ?? {}).map((entry) => entry.lock ?? null)
    const log = fs.readFileSync(logFile, 'utf8')
    const ok = locks.every((lock) => lock === null) && /workspace locks: cleared on start/.test(log)
    report('lock: a restart starts with an empty lock table', ok, `locks=${locks.filter(Boolean).length} logged=${/workspace locks: cleared on start/.test(log)}`)
  })

  await runCase('lock: the tool validates its action and workspace', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'lock-ws-e')
    const h = await boot({ seedSessions: [{ id: 'session-lock-e', title: 'lock e', cwd }] })
    await waitFor(() => h.state.tools.length > 0, 5000)
    const tool = h.state.tools.find((entry) => entry.name === 'mesh_lock')
    const errors = []
    for (const args of [{ action: 'bogus' }, { action: 'status', workspace: 'no-such-workspace-xyz' }]) {
      try {
        await tool.execute(args, { sessionId: 'session-lock-e' })
      } catch (error) {
        errors.push(String(error.message))
      }
    }
    const status = await request(h.base, '/mesh/status')
    const ok =
      Boolean(tool) &&
      errors.length === 2 &&
      /action must be acquire/.test(errors[0]) &&
      /unknown workspace/.test(errors[1]) &&
      status.json?.tools?.lock === true &&
      typeof status.json?.workspaceLocks?.count === 'number'
    report('lock: the tool validates its action and workspace', ok, `errors=${errors.length} tools.lock=${status.json?.tools?.lock} lockCount=${status.json?.workspaceLocks?.count}`)
  })

  // T-426: a restart must keep an existing binding and deliver into it, not create an inbox.
  await runCase('delivery: an existing binding survives a restart and receives the message', async (boot) => {
    const conversation = `conv-restart-bound-${Date.now()}`
    const logFile = path.join(os.tmpdir(), `waker-bound-${process.pid}-${Date.now()}.log`)
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-bound-1', sender: 'peer-b', conversation, body: 'deliver to the bound session' }],
    })
    let h = null
    try {
      h = await boot({
        seedSessions: [
          { id: 'session-bound-target', title: 'bound target' },
          { id: 'session-legacy-inbox', title: 'legacy inbox' },
        ],
        conversations: {
          [conversation]: { sessionId: 'session-legacy-inbox', createdAt: 123, wakes: 2, title: 'old inbox', deliverTo: 'session-bound-target' },
        },
        config: { logFile, hubUrl: fake.url, pollIntervalMs: 5000, pollBusyIntervalMs: 1000, pollIdleIntervalMs: 5000 },
      })
      const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === 'session-bound-target'), 15000)
      const conversations = await waitFor(() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(h.conversationsPath, 'utf8'))
          return parsed[conversation]?.wakes > 2 ? parsed : null
        } catch {
          return null
        }
      }, 5000)
      const entry = conversations?.[conversation] ?? {}
      const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
      const ok =
        Boolean(delivered) &&
        entry.deliverTo === 'session-bound-target' &&
        entry.sessionId === 'session-legacy-inbox' &&
        entry.createdAt === 123 &&
        /conversation=\S+ target=session-bound-target reason=bound/.test(logText) &&
        h.state.created.length === 0
      report(
        'delivery: an existing binding survives a restart and receives the message',
        ok,
        `target=${delivered?.sessionId ?? '-'} deliverTo=${entry.deliverTo ?? '-'} sessionId=${entry.sessionId ?? '-'} createdAt=${entry.createdAt ?? '-'} created=${h.state.created.length}`,
      )
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('delivery: an unbound conversation with a legacy inbox session stays deferred', async (boot) => {
    const conversation = `conv-restart-unbound-${Date.now()}`
    const logFile = path.join(os.tmpdir(), `waker-unbound-${process.pid}-${Date.now()}.log`)
    const createdAt = Date.now() - 60_000
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-unbound-1', sender: 'peer-b', conversation, body: 'nobody bound me' }],
    })
    let h = null
    try {
      h = await boot({
        seedSessions: [{ id: 'session-legacy-inbox-2', title: 'legacy inbox 2' }],
        conversations: { [conversation]: { sessionId: 'session-legacy-inbox-2', createdAt, wakes: 3, title: 'old inbox' } },
        config: { logFile, hubUrl: fake.url, pollIntervalMs: 5000, pollBusyIntervalMs: 1000, pollIdleIntervalMs: 5000 },
      })
      const decision = await waitFor(() => {
        if (!fs.existsSync(logFile)) return null
        const text = fs.readFileSync(logFile, 'utf8')
        return /target=deferred reason=unbound/.test(text) ? text : null
      }, 15000)
      const conversations = JSON.parse(fs.readFileSync(h.conversationsPath, 'utf8'))
      const entry = conversations[conversation] ?? {}
      const ok =
        Boolean(decision) &&
        h.state.created.length === 0 &&
        h.state.prompts.length === 0 &&
        fake.unread.length === 1 &&
        fake.readIds.length === 0 &&
        entry.sessionId === 'session-legacy-inbox-2' &&
        entry.createdAt === createdAt
      report(
        'delivery: an unbound conversation with a legacy inbox session stays deferred',
        ok,
        `created=${h.state.created.length} prompts=${h.state.prompts.length} unread=${fake.unread.length} read=${fake.readIds.length} sessionId=${entry.sessionId ?? '-'} createdAt=${entry.createdAt ?? '-'}`,
      )
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  await runCase('delivery: binding after a deferred message backfills it into the session', async (boot) => {
    const conversation = `conv-bind-backfill-${Date.now()}`
    const logFile = path.join(os.tmpdir(), `waker-bind-${process.pid}-${Date.now()}.log`)
    const fake = await startFakeHub({
      token: 'tok-' + 'selftest',
      messages: [{ id: 'm-bind-1', sender: 'peer-b', conversation, body: 'backfill me' }],
    })
    let h = null
    try {
      h = await boot({
        seedSessions: [{ id: 'session-bind-target', title: 'bind target' }],
        config: { logFile, hubUrl: fake.url, pollIntervalMs: 5000, pollBusyIntervalMs: 1000, pollIdleIntervalMs: 5000 },
      })
      const deferred = await waitFor(() => {
        if (!fs.existsSync(logFile)) return null
        const text = fs.readFileSync(logFile, 'utf8')
        return /target=deferred reason=unbound/.test(text) ? text : null
      }, 15000)
      const bound = await request(h.base, '/mesh/bind', {
        method: 'POST',
        body: { conversation, sessionId: 'session-bind-target', deliver: true, backfill: 5 },
      })
      const delivered = await waitFor(() => h.state.prompts.find((prompt) => prompt.sessionId === 'session-bind-target'), 8000)
      const conversations = JSON.parse(fs.readFileSync(h.conversationsPath, 'utf8'))
      const ok =
        Boolean(deferred) &&
        bound.status === 200 &&
        bound.json?.backfilled === 1 &&
        bound.json?.deliverTo === 'session-bind-target' &&
        Boolean(delivered) &&
        conversations[conversation]?.deliverTo === 'session-bind-target' &&
        // Backfill replays history as context; it is not a read (the message stays unread).
        fake.unread.length === 1 &&
        fake.readIds.length === 0
      report(
        'delivery: binding after a deferred message backfills it into the session',
        ok,
        `backfilled=${bound.json?.backfilled ?? '-'} deliverTo=${bound.json?.deliverTo ?? '-'} prompted=${Boolean(delivered)} read=${fake.readIds.length}`,
      )
    } finally {
      if (h) h.close()
      await fake.close()
    }
  })

  // ---- T-429: DSH owns the session title; the index is only a creation-time snapshot ----
  const writeProjcacheTitle = (home, sessionId, title) => {
    // The plugin derives the DSH base from MESH_WAKER_SESSIONS_ROOT's parent (production:
    // ~/.dsh); in the harness sessions root is <tmp>/sessions, so the base is <tmp>.
    const base = path.dirname(home)
    const dir = path.join(base, 'storages', 'session_projcache', 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ record: { rows: { title: { val: title } } } }))
  }

  await runCase('titles: the DSH projcache title wins over the sessions index', async (boot) => {
    const sessionId = 'session-title-dsh'
    const h = await boot({
      seedSessions: [{ id: sessionId, title: '虾酱 · 协调' }],
      prepareHome: (home) => writeProjcacheTitle(home, sessionId, '虾酱 · worker'),
    })
    const listed = await request(h.base, '/mesh/sessions')
    const entry = (listed.json?.sessions ?? []).find((session) => session.id === sessionId)
    const ok = entry?.title === '虾酱 · worker' && entry?.titleSource === 'dsh' && entry?.titleStale === true
    report('titles: the DSH projcache title wins over the sessions index', ok, `title=${entry?.title ?? '-'} source=${entry?.titleSource ?? '-'} stale=${entry?.titleStale ?? false}`)
  })

  await runCase('titles: a missing projcache row falls back to the cached title', async (boot) => {
    const sessionId = 'session-title-cached'
    const h = await boot({ seedSessions: [{ id: sessionId, title: 'only in index' }] })
    const listed = await request(h.base, '/mesh/sessions')
    const entry = (listed.json?.sessions ?? []).find((session) => session.id === sessionId)
    const ok = entry?.title === 'only in index' && entry?.titleSource === 'cached' && entry?.titleStale === undefined
    report('titles: a missing projcache row falls back to the cached title', ok, `title=${entry?.title ?? '-'} source=${entry?.titleSource ?? '-'} stale=${entry?.titleStale ?? false}`)
  })

  await runCase('titles: a stale title refuses title routing and names the session id', async (boot) => {
    const sessionId = 'session-title-stale'
    const logFile = path.join(os.tmpdir(), `waker-titles-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      seedSessions: [{ id: sessionId, title: 'old name' }],
      prepareHome: (home) => writeProjcacheTitle(home, sessionId, 'new name'),
      config: { logFile },
    })
    const byTitle = await request(h.base, '/mesh/inject', { method: 'POST', body: { title: 'old name', text: 'should be refused' } })
    const byId = await request(h.base, '/mesh/inject', { method: 'POST', body: { session: sessionId, text: 'by id is fine' } })
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
    const error = String(byTitle.json?.error ?? '')
    const ok =
      byTitle.status >= 400 &&
      /已过期/.test(error) &&
      error.includes(sessionId) &&
      byId.status === 200 &&
      h.state.prompts.length === 1 &&
      new RegExp(`title stale ${sessionId} index=old name dsh=new name`).test(logText)
    report(
      'titles: a stale title refuses title routing and names the session id',
      ok,
      `byTitle=${byTitle.status} byId=${byId.status} prompts=${h.state.prompts.length} logStale=${/title stale/.test(logText)}`,
    )
  })

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    for (const result of failed) console.error(`FAILED: ${result.name}`)
    process.exitCode = 1
  }
}

if (require.main === module) {
  main()
    .then(async () => {
      // If the process still holds server/socket handles after the last case, name them instead
      // of letting a CI runner hang until its global timeout (T-272). Give closers a moment:
      // server.closeAllConnections() is async on the socket side.
      const deadline = Date.now() + 3000
      let relevant = []
      for (;;) {
        const active = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : []
        relevant = active.filter((name) => /TCPServer|TCPSocket/.test(name))
        if (relevant.length === 0 || Date.now() >= deadline) break
        await new Promise((resolveWait) => setTimeout(resolveWait, 25))
      }
      if (relevant.length) console.error(`LEFTOVER RESOURCES: ${[...new Set(relevant)].join(',')}`)
      // A leaked handle must not hang the runner forever: the diagnostics above are the
      // actionable part, and a non-zero exit still fails CI.
      const code = process.exitCode ?? (relevant.length ? 1 : 0)
      setTimeout(() => process.exit(code), 25)
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
} else {
  // One-off verification scripts can boot the same harness against real data (T-301).
  module.exports = { startHarness }
}
