import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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

test('wake: --dry-run by title resolves one active session and sends nothing', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(sessions, async ({ base, calls }) => {
    const result = await run(
      { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
      ['--wake', '--title', 'mesh · 协调', '--text', '[WAKE] probe', '--dry-run', '--repo', dir],
    )
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /dry-run: session=session-coord/)
    assert.match(result.stdout, /未投递/)
    assert.equal(calls.post, 0, 'dry-run must not POST')
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

test('wake: a title that only matches archived sessions fails with an actionable hint', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(sessions, async ({ base, calls }) => {
    const result = await run(
      { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
      ['--wake', '--title', 'mesh · 协调 2', '--text', '[WAKE] probe', '--dry-run', '--repo', dir],
    )
    assert.notEqual(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stderr, /only matches archived/)
    assert.match(result.stderr, /--session/)
    assert.equal(calls.post, 0)
  })
})

test('wake: --coordinator picks the live coordinator and skips archived ones', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  await withWaker(sessions, async ({ base, calls }) => {
    const result = await run(
      { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
      ['--wake', '--coordinator', 'mesh', '--text', '[WAKE] probe', '--dry-run', '--repo', dir],
    )
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /session=session-coord/)
    assert.equal(calls.post, 0)
  })
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

test('wake: no target with --create makes <slug> · 协调 <n>, verifies workspacePath and injects', async () => {
  const { dir, indexFile, wakeTarget } = fixtureIndex()
  const createdTitle = `${path.basename(dir)} · 协调 2`
  await withWaker(
    sessions,
    async ({ base, calls }) => {
      const result = await run(
        { MESH_WAKER_URL: base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
        ['--wake', '--create', '--text', '[WAKE] probe', '--repo', dir],
      )
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /session=session-created/)
      assert.match(result.stdout, /created=true/)
      assert.match(result.stdout, new RegExp(`workspacePath=`))
      assert.equal(calls.create, 1)
      assert.equal(calls.post, 1)
    },
    { workspaces: { 'demo-ws': { cwd: dir } }, createdTitle, workspacePath: dir },
  )
})
