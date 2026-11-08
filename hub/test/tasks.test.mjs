/**
 * T1 tasks/receipts: table migration, conditional claim, leases, receipts, parking and
 * deadline expiry. Runs against throwaway hub instances (temp port + temp data dir) — it
 * never touches the production data directory or the NAS.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const HUB = join(import.meta.dirname, '..')
const ADMIN = 'tasks-test-admin-token'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function startHub(dataDir) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'mesh-tasks-'))
  const port = await freePort()
  const env = { ...process.env }
  for (const key of ['MESH_TLS_CERT', 'MESH_TLS_KEY', 'MESH_CONSOLE_ALLOW']) delete env[key]
  Object.assign(env, {
    MESH_HOST: '127.0.0.1', MESH_PORT: String(port), MESH_DATA_DIR: dir, MESH_ADMIN_TOKEN: ADMIN,
  })
  const child = spawn(process.execPath, [join(HUB, 'server.mjs')], { cwd: HUB, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.status === 200) break
    } catch { /* not up yet */ }
    await wait(150)
  }
  return {
    base,
    dir,
    logs: () => logs,
    async stop({ clean = true } = {}) {
      child.kill()
      await wait(300)
      if (!clean) return
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); return } catch { await wait(100) }
      }
    },
  }
}

async function api(base, path, { token, method = 'GET', body } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.json().catch(() => ({}))
  return { status: response.status, body: payload }
}

let hub
let alice
let bob
let carol
let adminAudit

before(async () => {
  hub = await startHub()
  alice = await (await api(hub.base, '/api/admin/agents', { token: ADMIN, method: 'POST', body: { name: 'task-origin' } })).body.token
  bob = await (await api(hub.base, '/api/admin/agents', { token: ADMIN, method: 'POST', body: { name: 'task-target' } })).body.token
  carol = await (await api(hub.base, '/api/admin/agents', { token: ADMIN, method: 'POST', body: { name: 'task-outsider' } })).body.token
  adminAudit = async () => (await api(hub.base, '/api/admin/audit?limit=200', { token: ADMIN })).body.entries ?? []
})

after(async () => {
  await hub?.stop()
})

async function createTask(taskId, extra = {}) {
  return api(hub.base, '/api/tasks', {
    token: alice,
    method: 'POST',
    body: { task_id: taskId, origin_ws: 'mesh-a/ws', target_agent: 'task-target', subject: '跨机测试', ...extra },
  })
}

test('old data dir gains tasks/receipts tables without touching the seven old tables', async () => {
  const first = await startHub()
  await api(first.base, '/api/admin/agents', { token: ADMIN, method: 'POST', body: { name: 'legacy-node' } })
  await api(first.base, '/api/send', { token: (await api(first.base, '/api/admin/agents', { token: ADMIN, method: 'POST', body: { name: 'legacy-peer' } })).body.token, method: 'POST', body: { to: 'legacy-node', body: 'before' } })
  await first.stop({ clean: false })

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(first.dir, 'mesh.db'))
  const before = Object.fromEntries(['agents', 'messages', 'board', 'board_log', 'audit', 'mcp_sessions', 'blobs']
    .map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))
  for (const table of ['receipts', 'tasks']) db.exec(`DROP TABLE ${table}`)
  db.close()

  const second = await startHub(first.dir)
  try {
    const check = new DatabaseSync(join(first.dir, 'mesh.db'))
    const after = Object.fromEntries(['agents', 'messages', 'board', 'board_log', 'audit', 'mcp_sessions', 'blobs']
      .map((table) => [table, dbCount(check, table)]))
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND (name LIKE 'tasks%' OR name LIKE 'receipts%' OR name LIKE 'idx_tasks_%')").all().map((row) => row.name).sort()
    check.close()
    console.log('old-table rows before:', JSON.stringify(before))
    console.log('old-table rows after :', JSON.stringify(after))
    console.log('startup WARN/ERROR lines:', second.logs().split(/\r?\n/).filter((line) => /WARN|ERROR/i.test(line)).length)
    assert.deepEqual(after, before, 'old tables must not change')
    assert.deepEqual(tables, ['idx_tasks_batch', 'idx_tasks_origin', 'idx_tasks_target', 'receipts', 'tasks'])
    assert.ok(!/\[mesh\] (task|tasks)/i.test(second.logs()), 'no new task WARN/ERROR')
    const health = await (await fetch(`${second.base}/health`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.version, JSON.parse(readFileSync(join(HUB, 'package.json'), 'utf8')).version)
    assert.equal('tasks' in health, false, '/health shape must stay unchanged')
  } finally {
    await second.stop()
  }
})

function dbCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
}

test('create requires a prefixed task id and lists for origin and target only', async () => {
  const bad = await createTask('T-123')
  assert.equal(bad.status, 400, JSON.stringify(bad.body))
  const outsider = await api(hub.base, '/api/tasks?agent=task-target', { token: carol })
  assert.equal(outsider.status, 403)
  const created = await createTask('T1T-20261107-01')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.task.status, 'pending')
  assert.equal(created.body.task.origin_agent, 'task-origin')
  const originList = await api(hub.base, '/api/tasks?agent=task-origin', { token: alice })
  assert.equal(originList.status, 200)
  assert.ok(originList.body.tasks.some((task) => task.task_id === 'T1T-20261107-01'))
  const targetList = await api(hub.base, '/api/tasks?agent=task-target&status=pending', { token: bob })
  assert.ok(targetList.body.tasks.some((task) => task.task_id === 'T1T-20261107-01'))
})

test('two concurrent claims: exactly one wins', async () => {
  await createTask('T1T-20261107-02')
  const results = await Promise.all([
    api(hub.base, '/api/tasks/T1T-20261107-02/claim', { token: bob, method: 'POST', body: { lease_ms: 5000 } }),
    api(hub.base, '/api/tasks/T1T-20261107-02/claim', { token: bob, method: 'POST', body: { lease_ms: 5000 } }),
  ])
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  const task = (await api(hub.base, '/api/tasks?agent=task-target&status=claimed', { token: bob })).body.tasks
    .find((row) => row.task_id === 'T1T-20261107-02')
  assert.equal(task.claim_agent, 'task-target')
  assert.equal(task.attempts, 0)
})

test('heartbeat extends the lease; non-holders cannot', async () => {
  await createTask('T1T-20261107-03')
  const claim = await api(hub.base, '/api/tasks/T1T-20261107-03/claim', { token: bob, method: 'POST', body: { lease_ms: 1500 } })
  assert.equal(claim.status, 200)
  const beat = await api(hub.base, '/api/tasks/T1T-20261107-03/heartbeat', { token: bob, method: 'POST', body: { lease_ms: 60000 } })
  assert.equal(beat.status, 200)
  assert.ok(beat.body.task.lease_until > claim.body.task.lease_until)
  const outsider = await api(hub.base, '/api/tasks/T1T-20261107-03/heartbeat', { token: carol, method: 'POST', body: { lease_ms: 60000 } })
  assert.equal(outsider.status, 403)
})

test('settle writes a declared receipt, is idempotent, and the origin sees it', async () => {
  await createTask('T1T-20261107-04')
  const claim = await api(hub.base, '/api/tasks/T1T-20261107-04/claim', { token: bob, method: 'POST', body: { lease_ms: 5000 } })
  assert.equal(claim.status, 200)
  const settle = await api(hub.base, '/api/tasks/T1T-20261107-04/settle', {
    token: bob, method: 'POST', body: { status: 'completed', source: 'observed', summary: 'done', artifacts: [{ kind: 'git', commit: 'abc1234' }], routed_to: 'coordinator' },
  })
  assert.equal(settle.status, 201, JSON.stringify(settle.body))
  assert.equal(settle.body.receipt.source, 'observed')
  assert.equal(settle.body.receipt.settled_by, 'task-target')
  const settledAt = settle.body.receipt.settled_at
  const again = await api(hub.base, '/api/tasks/T1T-20261107-04/settle', { token: bob, method: 'POST', body: { status: 'completed', source: 'declared', summary: 'again' } })
  assert.equal(again.status, 200)
  assert.equal(again.body.idempotent, true)
  assert.equal(again.body.receipt.settled_at, settledAt)
  assert.equal(again.body.receipt.summary, 'done', 'repeat settle must not overwrite the receipt')
  const originView = await api(hub.base, '/api/tasks?agent=task-origin&status=settled', { token: alice })
  const settled = originView.body.tasks.find((row) => row.task_id === 'T1T-20261107-04')
  assert.equal(settled.receipt.summary, 'done')
  // Single-row read: origin and target only.
  const single = await api(hub.base, '/api/tasks/T1T-20261107-04', { token: alice })
  assert.equal(single.status, 200)
  assert.equal(single.body.receipt.source, 'observed')
  assert.equal((await api(hub.base, '/api/tasks/T1T-20261107-04', { token: carol })).status, 403)
  assert.equal((await api(hub.base, '/api/tasks/T1T-20990101-01', { token: alice })).status, 404)
  const audit = await adminAudit()
  assert.ok(audit.some((row) => row.action === 'task.settle'))
})

test('settle rejects an unknown source and leaves the task claimed for a valid retry', async () => {
  await createTask('T1T-20261107-07')
  assert.equal((await api(hub.base, '/api/tasks/T1T-20261107-07/claim', { token: bob, method: 'POST', body: { lease_ms: 5000 } })).status, 200)
  const bad = await api(hub.base, '/api/tasks/T1T-20261107-07/settle', { token: bob, method: 'POST', body: { status: 'completed', source: 'guessed' } })
  assert.equal(bad.status, 400)
  const ok = await api(hub.base, '/api/tasks/T1T-20261107-07/settle', { token: bob, method: 'POST', body: { status: 'completed' } })
  assert.equal(ok.status, 201)
  assert.equal(ok.body.receipt.source, 'declared')
  assert.equal((await api(hub.base, '/api/tasks/T1T-20261107-07/cancel', { token: alice, method: 'POST', body: {} })).status, 409)
})

test('lease expiry increments attempts, then parks at the ceiling; deadline expires', async () => {
  await createTask('T1T-20261107-05')
  for (let attempt = 1; attempt <= 1; attempt += 1) {
    const claim = await api(hub.base, '/api/tasks/T1T-20261107-05/claim', { token: bob, method: 'POST', body: { lease_ms: 1000 } })
    assert.equal(claim.status, 200)
    await wait(1300)
    const list = await api(hub.base, '/api/tasks?agent=task-target&status=pending', { token: bob })
    const row = list.body.tasks.find((task) => task.task_id === 'T1T-20261107-05')
    assert.equal(row.attempts, attempt)
  }
  // Two more leases: attempts 2 then 3 -> parked, never "lost".
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    const claim = await api(hub.base, '/api/tasks/T1T-20261107-05/claim', { token: bob, method: 'POST', body: { lease_ms: 1000 } })
    assert.equal(claim.status, 200, JSON.stringify(claim.body))
    await wait(1300)
    const list = await api(hub.base, `/api/tasks?agent=task-target&status=${attempt < 3 ? 'pending' : 'parked'}`, { token: bob })
    assert.ok(list.body.tasks.some((task) => task.task_id === 'T1T-20261107-05'))
  }
  const parked = (await api(hub.base, '/api/tasks?agent=task-target&status=parked', { token: bob })).body.tasks
    .find((task) => task.task_id === 'T1T-20261107-05')
  assert.equal(parked.status, 'parked')
  assert.equal(parked.attempts, 3)

  await createTask('T1T-20261107-06', { deadline_ms: Date.now() + 300 })
  await wait(500)
  const expired = await api(hub.base, '/api/tasks?agent=task-target&status=expired', { token: bob })
  const row = expired.body.tasks.find((task) => task.task_id === 'T1T-20261107-06')
  assert.equal(row?.status, 'expired')
})

test('redispatch resets a parked/expired task; cancel closes it; wrong role is refused', async () => {
  await createTask('T1T-20261107-08')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await api(hub.base, '/api/tasks/T1T-20261107-08/claim', { token: bob, method: 'POST', body: { lease_ms: 1000 } })).status, 200)
    await wait(1300)
    const list = await api(hub.base, `/api/tasks?agent=task-target&status=${attempt < 2 ? 'pending' : 'parked'}`, { token: bob })
    assert.ok(list.body.tasks.some((task) => task.task_id === 'T1T-20261107-08'))
  }
  assert.equal((await api(hub.base, '/api/tasks/T1T-20261107-08/redispatch', { token: bob, method: 'POST', body: {} })).status, 403)
  const red = await api(hub.base, '/api/tasks/T1T-20261107-08/redispatch', { token: alice, method: 'POST', body: {} })
  assert.equal(red.status, 200, JSON.stringify(red.body))
  assert.equal(red.body.task.status, 'pending')
  assert.equal(red.body.task.attempts, 0)
  assert.equal((await api(hub.base, '/api/tasks/T1T-20261107-08/cancel', { token: bob, method: 'POST', body: {} })).status, 403)
  const cancel = await api(hub.base, '/api/tasks/T1T-20261107-08/cancel', { token: alice, method: 'POST', body: {} })
  assert.equal(cancel.status, 200)
  assert.equal(cancel.body.task.status, 'cancelled')
  assert.equal((await api(hub.base, '/api/tasks/T1T-20261107-08/cancel', { token: alice, method: 'POST', body: {} })).status, 409)

  await createTask('T1T-20261107-09', { deadline_ms: Date.now() + 200 })
  await wait(400)
  const single = await api(hub.base, '/api/tasks/T1T-20261107-09', { token: alice })
  assert.equal(single.body.task.status, 'expired')
  const again = await api(hub.base, '/api/tasks/T1T-20261107-09/redispatch', { token: alice, method: 'POST', body: {} })
  assert.equal(again.status, 200)
  assert.equal(again.body.task.status, 'pending')
  assert.equal(again.body.task.attempts, 0)
})

test('GET /api/blobs filters exactly by sha256', async () => {
  const data = Buffer.from('t1 task body stored as a blob')
  const sha = createHash('sha256').update(data).digest('hex')
  const upload = await fetch(`${hub.base}/api/blob?name=t1-body.txt&sha256=${sha}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${alice}`, 'content-type': 'application/octet-stream' },
    body: data,
  })
  assert.equal(upload.status, 201, await upload.text())
  const hit = await api(hub.base, `/api/blobs?sha256=${sha}`, { token: alice })
  assert.equal(hit.status, 200)
  assert.ok(hit.body.blobs.some((blob) => blob.sha256 === sha))
  const miss = await api(hub.base, `/api/blobs?sha256=${'0'.repeat(64)}`, { token: alice })
  assert.deepEqual(miss.body.blobs, [])
  assert.equal((await api(hub.base, '/api/blobs?sha256=not-hex', { token: alice })).status, 400)
})
