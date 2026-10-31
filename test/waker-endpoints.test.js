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
function report(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`)
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

async function request(base, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body: the assertion only needs the status */
  }
  return { status: response.status, json, text }
}

function seedSession(sessionsRoot, { id, title, workspace = 'ws-test' }) {
  const dir = path.join(sessionsRoot, workspace, id)
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(log, '')
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
async function startHarness({ seedSessions = [], conversations = null, config = {}, writeToken = true, batches = null, archivedIds = [], toolsDelayCalls = 0, tasksSeed = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-endpoints-'))
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  fs.mkdirSync(sessionsRoot, { recursive: true })
  fs.mkdirSync(tokenDir, { recursive: true })
  fs.mkdirSync(home, { recursive: true })

  const seeded = seedSessions.map((seed) => seedSession(sessionsRoot, seed))
  const sessionIndex = {}
  for (const seed of seeded) sessionIndex[seed.id] = { mtime: seed.mtime, title: seed.title, cwd: null }
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
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
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
  apply(ctx, merged)

  for (const key of Object.keys(previousEnv)) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 5000
  let ready = false
  while (Date.now() < deadline && !ready) {
    try {
      const probe = await request(base, '/mesh/status')
      ready = probe.status === 200
    } catch {
      ready = false
    }
    if (!ready) await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  if (!ready) throw new Error('the test listener never answered /mesh/status')

  return {
    base,
    state,
    seeded,
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
        fs.rmSync(tmp, { recursive: true, force: true })
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
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
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
    const ok = Boolean(receipt) && receipt.status === 'not-started' && receipt.reasonKind === 'not-started' && /receiptStallMs|1000ms/.test(receipt.reasonDetail ?? '') && status.json?.pendingTasks === 0
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
      params.target?.required === true &&
      params.text?.required === true &&
      MESH_DISPATCH_TOOL.required.join(',') === 'target,text' &&
      /batchId/.test(MESH_DISPATCH_TOOL.description) &&
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
      await sleep(1500)
      const during = await request(h.base, '/mesh/status')
      const listed = during.json?.pendingQuestions ?? []
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
      await sleep(400)
      const during = await request(h.base, '/mesh/status')
      const reservedDuringSend = (during.json?.pendingApprovals ?? []).length === 1
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
      const ok = rotatedSize === 3000 && current.includes('injected') && Buffer.byteLength(current) < 1024
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
    const ok = Boolean(delivered) && holderPrompts === 0 && status.json?.lastReceipt?.deliveredTo === 'session-orch'
    report('receipt: a requester receives the receipt instead of receiptTo', ok, `deliveredTo=${status.json?.lastReceipt?.deliveredTo ?? '-'} holderPrompts=${holderPrompts} orchPrompts=${h.state.prompts.filter((p) => p.sessionId === 'session-orch').length}`)
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
    const header = '[TASK T-hdr · BATCH B-hdr · FROM worker] '
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
    const ok = lines.length === 2 && /^\[TASK T-batch-1 · BATCH B-shared · FROM unknown\]/.test(lines[0]) && /^\[TASK T-batch-2 · BATCH B-shared · FROM unknown\]/.test(lines[1])
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
      row?.hasTextFile === false
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
        seededTask('T-a', { status: 'pending', targetSessionId: 'session-a', createdAt: now - 3000 }),
        seededTask('T-b', { status: 'settled', targetSessionId: 'session-b', createdAt: now - 2000, settledAt: now - 1000, durationMs: 1000 }),
        seededTask('T-c', { status: 'settled', targetSessionId: 'session-b', createdAt: now - 1000, settledAt: now - 500, durationMs: 500 }),
      ],
    })
    const byStatus = await request(h.base, '/mesh/tasks?status=pending')
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

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    for (const result of failed) console.error(`FAILED: ${result.name}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
