/**
 * Session cap and idle recycling need different env from the shared smoke hub, so this
 * spawns its own instance with MESH_MAX_SESSIONS=1 and a 1s idle window.
 *
 *   node --test test/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN = 'limits-test-admin-token'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('MESH_MAX_SESSIONS caps sessions and idle sessions are recycled', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-limits-'))
  const port = await freePort()
  const env = { ...process.env }
  for (const key of ['MESH_TLS_CERT', 'MESH_TLS_KEY', 'MESH_CONSOLE_ALLOW']) delete env[key]
  Object.assign(env, {
    MESH_HOST: '127.0.0.1',
    MESH_PORT: String(port),
    MESH_DATA_DIR: dir,
    MESH_ADMIN_TOKEN: ADMIN,
    MESH_MAX_SESSIONS: '1',
    MESH_SESSION_IDLE_MS: '1000',
  })
  const child = spawn(process.execPath, [join(HUB, 'server.mjs')], { cwd: HUB, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(async () => {
    child.kill()
    await wait(300)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* held briefly */ }
  })

  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.status === 200) break
    } catch { /* not up */ }
    await wait(200)
  }
  const minted = await (await fetch(`${base}/api/admin/agents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'limits-a' }),
  })).json()

  const mcpInit = () => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${minted.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'limits', version: '1' } },
    }),
  })

  assert.equal((await mcpInit()).status, 200, logs)
  assert.equal((await mcpInit()).status, 503, 'second session must hit the cap')

  await wait(5600) // sweep interval is 5s; idle is 1s
  const health = await (await fetch(`${base}/health`)).json()
  assert.equal(health.sessions, 0, 'idle sessions should be recycled')
})
