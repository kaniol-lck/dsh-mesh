import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'mesh-dispatch.mjs')

function runDispatch(baseUrl) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [SCRIPT, '--session', 'session-x', '--text', 'probe', '--task', 'T-9', '--waker', baseUrl],
      { cwd: ROOT, env: { ...process.env, MESH_WAKER_URL: baseUrl } },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function withServer(injectResponse, fn) {
  const server = createServer((request, response) => {
    if (request.url === '/mesh/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        sessions: [{ id: 'session-x', title: 't', cwd: ROOT, archived: false, last_active: 1 }],
      }))
      return
    }
    if (request.url === '/mesh/inject') {
      response.writeHead(injectResponse.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(injectResponse.body))
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('dispatch: 409 exits non-zero, prints the whole conflict body, no abort', async () => {
  const conflict = {
    ok: false,
    error: 'task id T-9 already exists in ws/x for target session-other',
    conflict: { taskId: 'T-9', existingTarget: 'session-other', requestedTarget: 'session-x' },
  }
  const result = await withServer({ status: 409, body: conflict }, runDispatch)
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /HTTP 409/)
  assert.match(result.stderr, /"conflict"/)
  assert.match(result.stderr, /session-other/)
  assert.doesNotMatch(result.stderr, /Assertion failed/)
})

test('dispatch: any other 4xx also exits non-zero', async () => {
  const result = await withServer({ status: 404, body: { ok: false, error: 'nope' } }, runDispatch)
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /HTTP 404/)
})

test('dispatch: 5xx exits 1', async () => {
  const result = await withServer({ status: 500, body: { ok: false, error: 'boom' } }, runDispatch)
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /HTTP 500/)
})

test('dispatch: success still exits 0', async () => {
  const result = await withServer({ status: 200, body: { ok: true, injected: true } }, runDispatch)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /^sent /)
})
