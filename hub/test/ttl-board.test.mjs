/**
 * Unread mail must survive the TTL; read mail ages out.
 *
 * Spawns a hub with a short TTL and purge interval, sends one unread and one read
 * message, waits for the sweep, then checks the inbox: the unread row stays with
 * stale:true and stale_count, the read row is gone.
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
const ADMIN = 'ttl-test-admin-token'

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

async function startHub(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-ttl-'))
  const port = await freePort()
  const env = { ...process.env }
  for (const key of ['MESH_CONSOLE_ALLOW', 'MESH_TLS_CERT', 'MESH_TLS_KEY', 'MESH_TRUST_PROXY', 'MESH_AUTH_MODE']) delete env[key]
  Object.assign(env, {
    MESH_HOST: '127.0.0.1',
    MESH_PORT: String(port),
    MESH_DATA_DIR: dir,
    MESH_ADMIN_TOKEN: ADMIN,
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
  return {
    base,
    logs: () => logs,
    async stop() {
      child.kill()
      await wait(300)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* held briefly on Windows */ }
    },
  }
}

const admin = (base, path, init = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
  ...init,
})

test('unread mail survives the TTL as stale; read mail is purged', async (t) => {
  const hub = await startHub({ MESH_MESSAGE_TTL_MS: '500', MESH_PURGE_INTERVAL_MS: '1000' })
  t.after(() => hub.stop())

  const alice = await (await admin(hub.base, '/api/admin/agents', { body: JSON.stringify({ name: 'ttl-a' }) })).json()
  const bob = await (await admin(hub.base, '/api/admin/agents', { body: JSON.stringify({ name: 'ttl-b' }) })).json()
  const aliceHeaders = { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' }
  const bobHeaders = { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' }

  const send = (body) => fetch(`${hub.base}/api/send`, {
    method: 'POST',
    headers: aliceHeaders,
    body: JSON.stringify({ to: 'ttl-b', body }),
  }).then((response) => response.json())

  const keep = await send('keep me even if I was offline')
  const drop = await send('already read, may age out')
  const marked = await fetch(`${hub.base}/api/read`, {
    method: 'POST',
    headers: bobHeaders,
    body: JSON.stringify({ ids: [drop.id] }),
  })
  assert.equal(marked.status, 200)

  await wait(2600) // purge ticks at 1s (and 2s) with a 500ms TTL

  const all = await (await fetch(`${hub.base}/api/inbox?unread=0`, { headers: bobHeaders })).json()
  const rows = all.messages || []
  const keptRow = rows.find((row) => row.id === keep.id)
  assert.ok(keptRow, 'unread message must not be deleted')
  assert.equal(keptRow.stale, true)
  assert.equal(rows.some((row) => row.id === drop.id), false, 'read message older than the TTL must be purged')

  const unread = await (await fetch(`${hub.base}/api/inbox?unread=1`, { headers: bobHeaders })).json()
  assert.equal(unread.stale_count, 1)
  assert.equal(unread.messages.length, 1)
})
