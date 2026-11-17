import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'mesh-dispatch.mjs')

function fixtureIndex() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dispatch-wake-'))
  const index = {
    'session-coord': { title: 'mesh · 协调', cwd: dir, mtime: 200 },
    'session-old': { title: 'mesh · 协调', cwd: dir, mtime: 100 },
    'session-arch': { title: 'mesh · 协调 2', cwd: dir, mtime: 50 },
  }
  const indexFile = path.join(dir, 'sessions-index.json')
  writeFileSync(indexFile, JSON.stringify(index), 'utf8')
  const wakeTarget = path.join(dir, 'wake-target.txt')
  writeFileSync(wakeTarget, 'session-coord', 'utf8')
  return { dir, indexFile, wakeTarget }
}

function startWaker(sessions, options = {}) {
  const calls = { get: 0, post: 0, create: 0 }
  const server = createServer((request, response) => {
    if (request.url === '/mesh/workspaces') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, workspaces: options.workspaces ?? {} }))
      return
    }
    if (request.url === '/mesh/sessions/create' && request.method === 'POST') {
      calls.create += 1
      request.resume()
      const title = options.createdTitle ?? 'demo-ws · 协调 2'
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, sessionId: 'session-created', title, workspacePath: options.workspacePath ?? null, prompted: false }))
      return
    }
    if (request.url === '/mesh/sessions') {
      calls.get += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, sessions }))
      return
    }
    if (request.url === '/mesh/inject') {
      calls.post += 1
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

function run(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function withWaker(sessions, fn, options = {}) {
  const waker = await startWaker(sessions, options)
  try {
    return await fn(waker)
  } finally {
    await new Promise((resolve) => waker.server.close(resolve))
  }
}

const sessions = [
  { id: 'session-coord', title: 'mesh · 协调', archived: false, live: true },
  { id: 'session-old', title: 'mesh · 协调', archived: true, live: true },
  { id: 'session-arch', title: 'mesh · 协调 2', archived: true, live: true },
]

test('wake: --dry-run by title is refused, with a session hint', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(sessions, async ({ base, calls }) => {
    const result = await run(
      { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
      ['--wake', '--title', 'mesh · 协调', '--text', '[WAKE] probe', '--dry-run', '--repo', dir],
    )
    assert.equal(result.code, 2, result.stdout + result.stderr)
    assert.match(result.stderr, /--title 已移除/)
    assert.match(result.stderr, /--session/)
    assert.equal(calls.post, 0, 'refused title must not POST')
  })
})

test('wake: --dry-run with --session makes no requests at all', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(sessions, async ({ base, calls }) => {
    const result = await run(
      { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
      ['--wake', '--session', 'session-coord', '--text', '[WAKE] probe', '--dry-run', '--repo', dir],
    )
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /未投递/)
    assert.equal(calls.get, 0)
    assert.equal(calls.post, 0)
  })
})

test('wake: --title is refused even for archived sessions', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(sessions, async ({ base, calls }) => {
    const result = await run(
      { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
      ['--wake', '--title', 'mesh · 协调 2', '--text', '[WAKE] probe', '--dry-run', '--repo', dir],
    )
    assert.equal(result.code, 2, result.stdout + result.stderr)
    assert.match(result.stderr, /--title 已移除/)
    assert.equal(calls.post, 0)
  })
})

// 行为变更（owner 2026-11-17）：--coordinator 不再按标题前缀找会话，改读注册表的
// `coordinator` 字段（session id）。这条用例验证「标题里有协调字样但注册表指向别处」时，
// 用的是注册表的值——即标题不参与寻址。
test('wake: --coordinator resolves from the registry coordinator field, not from titles', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(
    sessions,
    async ({ base }) => {
      const result = await run(
        { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
        ['--wake', '--coordinator', 'mesh', '--text', '[WAKE] probe', '--dry-run', '--repo', dir],
      )
      assert.equal(result.code, 0, result.stdout + result.stderr)
      // 注册表说 registry-session，就投给 registry-session；标题里的 session-coord 不被采用。
      assert.match(result.stdout, /session=session-registry/)
    },
    { workspaces: { mesh: { cwd: dir, coordinator: 'session-registry' } } },
  )
})

test('wake: --coordinator refuses when the registry has no usable coordinator', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(
    sessions,
    async ({ base }) => {
      const result = await run(
        { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
        ['--wake', '--coordinator', 'mesh', '--text', '[WAKE] probe', '--dry-run', '--repo', dir],
      )
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /没有登记可用的 coordinator/)
      assert.match(result.stderr, /--session/)
    },
    { workspaces: { mesh: { cwd: dir } } },
  )
})

test('wake: a real send posts once and the 60s dedupe suppresses the second', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(sessions, async ({ base, calls }) => {
    const env = { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget }
    const first = await run(env, ['--wake', '--session', 'session-coord', '--text', '[WAKE] probe', '--repo', dir])
    assert.equal(first.code, 0, first.stdout + first.stderr)
    const second = await run(env, ['--wake', '--session', 'session-coord', '--text', '[WAKE] probe', '--repo', dir])
    assert.equal(second.code, 0, second.stdout + second.stderr)
    assert.match(second.stdout, /deduped/)
    assert.equal(calls.post, 1)
  })
})

test('wake: no target and no --create exits 2 with the three explicit options', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(sessions, async ({ base, calls }) => {
    const result = await run(
      { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
      ['--wake', '--text', '[WAKE] probe', '--repo', dir],
    )
    assert.equal(result.code, 2, result.stdout + result.stderr)
    assert.match(result.stderr, /--session/)
    assert.match(result.stderr, /--coordinator/)
    assert.match(result.stderr, /--create/)
    assert.equal(calls.post, 0)
    assert.equal(calls.create, 0)
  })
})

// 行为变更（owner 2026-11-17）：通用协调会话模型废弃，--create 不再生成 `<slug> · 协调 <n>`。
// 这条用例从「断言新标题」改为「断言拒绝」，并且验证它**没有**发出任何创建请求。
test('wake: --create is refused (generic coordinator sessions are retired)', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(
    sessions,
    async ({ base, calls }) => {
      const result = await run(
        { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
        ['--wake', '--create', '--text', '[WAKE] probe', '--repo', dir],
      )
      assert.equal(result.code, 2, result.stdout + result.stderr)
      assert.match(result.stderr, /--create 已移除/)
      assert.match(result.stderr, /--session/)
      assert.equal(calls.create, 0, 'refused --create must not create a session')
      assert.equal(calls.post, 0, 'refused --create must not inject')
    },
    { workspaces: { 'demo-ws': { cwd: dir } } },
  )
})

test('--help documents --expect-branch with dev and warning semantics', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  for (const needle of ['--expect-branch', 'dev', 'warning']) {
    assert.ok(result.stdout.includes(needle), `--help is missing ${needle}`)
  }
  assert.match(result.stdout, /no default/i)
})
