// Endpoint acceptance for the waker's local-session features (0.4.56–0.4.59).
//
// Every case boots a real listener on a random port with the same handlers the plugin
// registers at runtime. Sessions, the conversations map, the token file and the plugin's
// settings all live in throwaway temp directories: these tests must never list, prompt or
// delete the real sessions of the machine that runs them.
//
//   node test/waker-endpoints.test.js

const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')

const REPO = path.join(__dirname, '..')
const ENTRY = path.join(REPO, 'plugins', 'mesh-waker', 'index.js')

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
 */
async function startHarness({ seedSessions = [], conversations = null } = {}) {
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
  fs.writeFileSync(path.join(tokenDir, 'token'), 'test-token')
  const conversationsPath = path.join(tokenDir, 'conversations.json')
  if (conversations) fs.writeFileSync(conversationsPath, JSON.stringify(conversations, null, 2))

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
    archivedSessionIds: () => new Set(),
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
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    commands: { register: () => () => {} },
    sessionController,
    agents,
    workspaceRegistry,
  }
  apply(ctx, {
    hubUrl: 'http://127.0.0.1:1',
    token: 'test-token',
    wakeSecret: 'test-secret',
    listenHost: '127.0.0.1',
    listenPort: port,
    tokenFile: path.join(tokenDir, 'token'),
    workspacePath: path.join(tmp, 'inbox'),
    sessionCwd: path.join(tmp, 'inbox'),
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
  })

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
    conversationsPath,
    close() {
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
    const ok = res.status === 404 && res.json?.ok === false && /not found/.test(res.json?.error ?? '')
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
