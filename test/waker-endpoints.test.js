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
      fs.writeFileSync(log, '')
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
    for (const key of Object.keys(previousEnv)) {
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
async function startFakeHub({ token = 'tok-' + 'selftest', messages = [], sendDelayMs = 0, sendStatus = 201, onSend = null } = {}) {
  const requests = []
  const readIds = []
  const sends = []
  let unread = messages.map((message) => ({ ...message }))
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
    const conversationsText = fs.readFileSync(h.conversationsPath, 'utf8')
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
      h = await boot({ writeToken: false, config: { hubUrl: fake.url, joinCode: 'JOIN-123' } })
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
    const h = await boot({})
    await waitFor(() => h.state.tools.length > 0, 5000)
    const result = await h.state.tools[0].execute({ target: 'brand new worker', text: 'bootstrap it', createIfMissing: true })
    const ok =
      result.ok === true &&
      result.created === true &&
      Boolean(result.sessionId) &&
      h.state.created.length === 1 &&
      h.state.prompts.length === 1
    report('mesh_dispatch: createIfMissing=true creates the session and injects', ok, `created=${result.created} session=${result.sessionId} createCalls=${h.state.created.length} prompts=${h.state.prompts.length}`)
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

  await runCase('CLI: without --requester the body keeps no requester field', async () => {
    const { parseArgs, run } = await import(cliUrl)
    const options = parseArgs(['--target', 'mesh · hub', '--text', 'hi'])
    const plan = await run({ ...options, dryRun: true }, noFetch)
    const ok = !('requester' in (plan.payload ?? {}))
    report('CLI: without --requester the body keeps no requester field', ok, `keys=${Object.keys(plan.payload ?? {}).join(',')}`)
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

  // 83-85. Archived sessions have a UI exit; deleted ids stop polluting the archive set.
  await runCase('client: archived session rows are greyed, labelled and not actionable', async () => {
    const helpers = loadClientHelpers()
    const live = helpers.formatSessionRow({ id: 'session-a', title: '活跃', archived: false })
    const archived = helpers.formatSessionRow({ id: 'session-b', title: '归档', archived: true })
    const ok =
      live.label === '' &&
      live.disabled === false &&
      live.opacity === 1 &&
      archived.label === '已归档' &&
      archived.disabled === true &&
      archived.opacity === 0.55
    report('client: archived session rows are greyed, labelled and not actionable', ok, `live=${JSON.stringify(live)} archived=${JSON.stringify(archived)}`)
  })

  await runCase('client: the archive action posts one request to /mesh/sessions/archive', async () => {
    const helpers = loadClientHelpers()
    const calls = []
    const stub = async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200 }
    }
    const result = await helpers.archiveSessionRequest('session-b', stub, 'http://127.0.0.1:8795')
    const call = calls[0] ?? {}
    const ok =
      result === true &&
      calls.length === 1 &&
      call.url === 'http://127.0.0.1:8795/mesh/sessions/archive' &&
      call.init?.method === 'POST' &&
      JSON.parse(call.init?.body ?? '{}').session === 'session-b'
    report('client: the archive action posts one request to /mesh/sessions/archive', ok, `calls=${calls.length} url=${call.url ?? '-'} method=${call.init?.method ?? '-'}`)
  })

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

  await runCase('client: both task-panel buttons navigate through layout.selectPanel', async () => {
    const source = fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'client.js'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins', 'mesh-waker', 'package.json'), 'utf8'))
    const inject = pkg?.dsh?.client?.inject ?? []
    const entryPoints = (source.match(/requestTasksPanel\(\)/g) ?? []).length
    const ok =
      /selectPanel\('mesh-inbox'\)/.test(source) &&
      /inject:\s*\[[^\]]*'layout'/.test(source) &&
      inject.includes('@deepseek-ai/dsh-client-ui-layout') &&
      entryPoints >= 3 &&
      source.includes('宿主导航不可用')
    report('client: both task-panel buttons navigate through layout.selectPanel', ok, `selectPanel=${/selectPanel\('mesh-inbox'\)/.test(source)} layoutInject=${inject.includes('@deepseek-ai/dsh-client-ui-layout')} entryPoints=${entryPoints}`)
  })

  // 124-125. Host schema subset guard (T-236): type arrays silently block registration.
  await runCase('tools: both output schemas pass the host JSON Schema subset', async () => {
    const { DISPATCH_OUTPUT, ASK_OUTPUT, THREAD_OUTPUT, COMPLETE_OUTPUT, validateToolSchema } = await import(pathToFileURL(ENTRY).href)
    const dispatch = validateToolSchema(DISPATCH_OUTPUT)
    const ask = validateToolSchema(ASK_OUTPUT)
    const thread = validateToolSchema(THREAD_OUTPUT)
    const complete = validateToolSchema(COMPLETE_OUTPUT)
    const schemas = { dispatch: dispatch.ok, ask: ask.ok, thread: thread.ok, complete: complete.ok }
    const ok = Object.values(schemas).every(Boolean)
    report(
      'tools: both output schemas pass the host JSON Schema subset',
      ok,
      `dispatch=${dispatch.ok ? 'ok' : dispatch.issues.join('; ')} ask=${ask.ok ? 'ok' : ask.issues.join('; ')} thread=${thread.ok ? 'ok' : thread.issues.join('; ')} complete=${complete.ok ? 'ok' : complete.issues.join('; ')}`,
    )
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
      registry.workspaces?.['wt-same-zone']?.coordinator === 'session-coord' &&
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

  // 198-204. Workspace registry quality (T-286): meaningful slugs, newest coordinator,
  // ephemeral cleanup, and idempotent convergence of registries written before this change.
  const registryOf = (h) => JSON.parse(fs.readFileSync(path.join(h.home, '.dsh', 'mesh-waker', 'workspaces.json'), 'utf8'))
  const wsDirOf = (h, slug) => path.join(h.home, '.dsh', 'mesh-waker', 'ws', slug)

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

  await runCase('workspaces: coordinator is the most recently active matching session', async (boot) => {
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
    const ok = entry?.coordinator === 'session-coord-new' && entry?.coordinatorStale !== true && JSON.stringify(entry?.roles) === JSON.stringify(['ops'])
    report('workspaces: coordinator is the most recently active matching session', ok, `coordinator=${entry?.coordinator ?? '-'} stale=${entry?.coordinatorStale ?? false}`)
  })

  await runCase('workspaces: a coordinator idle for over a week is marked stale', async (boot) => {
    const cwd = path.join(os.tmpdir(), 'Projects', 'stale-coord-repo')
    const logFile = path.join(os.tmpdir(), `waker-ws-stale-${process.pid}-${Date.now()}.log`)
    const h = await boot({
      config: { logFile },
      seedSessions: [{ id: 'session-coord-idle', title: 'mesh · coordinator', cwd, mtime: Date.now() - 8 * 24 * 60 * 60 * 1000 }],
    })
    const registry = registryOf(h)
    const entry = registry.workspaces?.['stale-coord-repo']
    const log = fs.readFileSync(logFile, 'utf8')
    const ok = entry?.coordinator === 'session-coord-idle' && entry?.coordinatorStale === true && /coordinator idle for 8d/.test(log)
    report('workspaces: a coordinator idle for over a week is marked stale', ok, `coordinator=${entry?.coordinator ?? '-'} stale=${entry?.coordinatorStale ?? false} warned=${/coordinator idle/.test(log)}`)
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
      entry?.coordinator === 'session-coord' &&
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

  await runCase('coordinator: the newest numbered coordinator wins in the registry', async (boot) => {
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
    const ok = entry?.coordinator === 'session-coord2-new'
    report('coordinator: the newest numbered coordinator wins in the registry', ok, `coordinator=${entry?.coordinator ?? '-'}`)
  })

  await runCase('coordinator: a retired binding is rewritten and logged', async (boot) => {
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
    const ok =
      entry?.coordinator === 'session-coord3-new' &&
      /coordinator session-coord3-old -> session-coord3-new/.test(log)
    report('coordinator: a retired binding is rewritten and logged', ok, `coordinator=${entry?.coordinator ?? '-'} logged=${/coordinator session-coord3-old -> session-coord3-new/.test(log)}`)
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
      'classifyRoleCandidates', 'apply', 'name', 'inject',
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
    const files = ['text', 'receipt', 'tools', 'session', 'tasks', 'settings']
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
