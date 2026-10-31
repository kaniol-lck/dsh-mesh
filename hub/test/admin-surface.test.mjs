/**
 * Management-surface guards for the hub.
 *
 * These need process-level setup (TLS off, proxy headers trusted, MESH_CONSOLE_ALLOW
 * unset), so they spawn throwaway hubs instead of using the shared smoke instance:
 *
 *   node --test test/
 *
 * Covers: plain-HTTP startup warning, loopback-only default for console + /api/admin,
 * explicit MESH_CONSOLE_ALLOW widening, and the legacy empty-scopes startup warning.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { DatabaseSync } from 'node:sqlite'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN = 'surface-test-admin-token'
const VIEW = 'surface-test-view-token'

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

// Windows keeps the SQLite/log handles for a moment after the child exits; retry instead
// of failing the test on a cleanup race.
async function removeDir(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 9) throw error
      await wait(300)
    }
  }
}

async function startHub(extra = {}, dataDir = null) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'mesh-surface-'))
  const port = await freePort()
  const env = { ...process.env }
  for (const key of ['MESH_CONSOLE_ALLOW', 'MESH_TLS_CERT', 'MESH_TLS_KEY', 'MESH_TRUST_PROXY', 'MESH_AUTH_MODE']) delete env[key]
  Object.assign(env, {
    MESH_HOST: '127.0.0.1',
    MESH_PORT: String(port),
    MESH_DATA_DIR: dir,
    MESH_ADMIN_TOKEN: ADMIN,
    MESH_VIEW_TOKEN: VIEW,
    MESH_TRUST_PROXY: '1',
    ...extra,
  })
  const child = spawn(process.execPath, [join(HUB, 'server.mjs')], { cwd: HUB, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.status === 200) { ready = true; break }
    } catch { /* not up yet */ }
    await wait(200)
  }
  if (!ready) throw new Error(`hub did not start\n${logs}`)
  await wait(300) // let the listen callback's startup warnings reach the pipe
  return {
    base,
    dir,
    logs: () => logs,
    async stop({ keepData = false } = {}) {
      child.kill()
      await wait(300)
      if (!keepData) await removeDir(dir)
    },
  }
}

function get(base, path, headers = {}) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${ADMIN}`, ...headers } })
}

test('plain HTTP warns and console/admin default to loopback only', async (t) => {
  const hub = await startHub()
  t.after(() => hub.stop())

  const blockedConsole = await get(hub.base, '/console/api/overview', { 'x-forwarded-for': '192.168.1.9' })
  assert.equal(blockedConsole.status, 403, 'console from a LAN address must be blocked by default')
  const allowedConsole = await get(hub.base, '/console/api/overview', { 'x-forwarded-for': '127.0.0.1' })
  assert.equal(allowedConsole.status, 200, 'console from loopback must work')

  const blockedAdmin = await get(hub.base, '/api/admin/agents', { 'x-forwarded-for': '192.168.1.9' })
  assert.equal(blockedAdmin.status, 403, '/api/admin must obey the same source allow-list')
  const allowedAdmin = await get(hub.base, '/api/admin/agents', { 'x-forwarded-for': '127.0.0.1' })
  assert.equal(allowedAdmin.status, 200, 'admin from loopback must work')

  assert.match(hub.logs(), /WARN console\/admin over plain HTTP \(no MESH_TLS_CERT\)/)
  assert.match(hub.logs(), /allowed sources: loopback only/)
})

test('explicit MESH_CONSOLE_ALLOW widens console and admin sources', async (t) => {
  const hub = await startHub({ MESH_CONSOLE_ALLOW: '192.168.0.0/16' })
  t.after(() => hub.stop())

  const consoleResponse = await get(hub.base, '/console/api/overview', { 'x-forwarded-for': '192.168.1.9' })
  assert.equal(consoleResponse.status, 200)
  const adminResponse = await get(hub.base, '/api/admin/agents', { 'x-forwarded-for': '192.168.1.9' })
  assert.equal(adminResponse.status, 200)
})

test('legacy empty-scopes rows warn at startup but keep working', async () => {
  const first = await startHub()
  const dir = first.dir
  let second = null
  try {
    const minted = await fetch(`${first.base}/api/admin/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'legacy' }),
    })
    assert.equal(minted.status, 201)
    await first.stop({ keepData: true })

    const db = new DatabaseSync(join(dir, 'mesh.db'))
    db.exec("UPDATE agents SET scopes = '' WHERE name = 'legacy'")
    db.close()

    second = await startHub({}, dir)
    assert.match(second.logs(), /1 个节点 scopes 为空串（等价全权）/)
  } finally {
    if (second) await second.stop({ keepData: true })
    await removeDir(dir)
  }
})
