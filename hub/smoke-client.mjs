/**
 * End-to-end smoke test for dsh-mesh — auth-aware, no DSH profile touched.
 *
 * Covers: admin token minting, bearer-gated MCP + REST, identity binding,
 * presence, durable messaging, the shared board, revocation, and the hardening
 * added after the first handoff review (payload caps, session identity binding,
 * and "a valid token is never locked out by failures from the same address").
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.MESH_BASE ?? 'http://127.0.0.1:8790'
const MCP_URL = `${BASE}/mcp`

function readAdminToken() {
  if (process.env.MESH_ADMIN_TOKEN) return process.env.MESH_ADMIN_TOKEN
  const file = process.env.MESH_ADMIN_FILE ?? join(HERE, 'data', 'admin.token')
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    console.error(`cannot read the admin token: set MESH_ADMIN_TOKEN, or MESH_ADMIN_FILE=<path>.`)
    console.error(`tried: ${file}`)
    process.exit(2)
  }
}
const adminToken = readAdminToken()

const checks = []
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

const admin = (path, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

async function mint(name) {
  const res = await admin('/api/admin/agents', { method: 'POST', body: JSON.stringify({ name, host: `host-${name}` }) })
  const body = await res.json()
  if (!res.ok) throw new Error(`mint ${name} failed: ${JSON.stringify(body)}`)
  return body.token
}

async function connect(name, token) {
  const client = new Client({ name: `smoke-${name}`, version: '0.2.1' })
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    // Deliberately no x-mesh-host header: real dsh clients do not send one either, and
    // that absence is what used to make mesh_whoami report host: null.
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return { client, transport }
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  const raw = result.content?.[0]?.text ?? '{}'
  if (result.isError) throw new Error(`${name} -> ${raw}`)
  return JSON.parse(raw)
}

// --- unauthenticated access must be rejected --------------------------------
const anonMcp = await fetch(MCP_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
})
check('unauthenticated MCP is rejected', anonMcp.status === 401, `HTTP ${anonMcp.status}`)

const anonRest = await fetch(`${BASE}/api/peers`)
check('unauthenticated REST is rejected', anonRest.status === 401, `HTTP ${anonRest.status}`)

const badToken = await fetch(`${BASE}/api/peers`, { headers: { authorization: 'Bearer mesh_totally_wrong' } })
check('forged token is rejected', badToken.status === 401, `HTTP ${badToken.status}`)

// --- admin mints per-agent tokens -------------------------------------------
const aliceToken = await mint('alice')
const bobToken = await mint('bob')
check('admin mints distinct tokens', aliceToken !== bobToken && aliceToken.startsWith('mesh_'))

const roster = await (await admin('/api/admin/agents')).json()
check('roster never exposes tokens', roster.agents.every((a) => !('token' in a) && a.has_token), `${roster.agents.length} agents`)

const alice = await connect('alice', aliceToken)
const bob = await connect('bob', bobToken)

{
  const health = await (await fetch(`${BASE}/health`)).json()
  check(
    'initialized MCP sessions are persisted for restart recovery',
    health.persisted_sessions >= 2,
    `persisted=${health.persisted_sessions}, version=${health.version}`,
  )
  // The version is reported from HUB_VERSION in server.mjs; the npm package has its own
  // field. They drifted once (server 0.7.11 vs package 0.7.6) and broke release hygiene,
  // so the smoke suite now fails when they disagree.
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  check('package.json version matches the running hub', pkg.version === health.version, `pkg ${pkg.version}, hub ${health.version}`)
}

try {
  const who = await call(alice.client, 'mesh_whoami')
  check('identity comes from the token, not a header', who.agent === 'alice', who.agent)
  check('whoami reports the registered host', who.host === 'host-alice', String(who.host))
  check('whoami reports a reachable hub url', who.hub === `${BASE}/mcp` && !who.hub.includes('0.0.0.0'), who.hub)

  const tools = await alice.client.listTools()
  check('tools/list exposes the mesh surface', tools.tools.length >= 9, `${tools.tools.length} tools`)

  const sent = await call(alice.client, 'mesh_send', { to: 'bob', subject: '环境同步', body: '办公机今晚关机，明早 9 点上线。' })
  check('message queued', Boolean(sent.id) && sent.known_recipient === true)

  const inbox = await call(bob.client, 'mesh_inbox', { mark_read: true })
  check('recipient receives and can mark read', inbox.count === 1 && inbox.messages[0].body.includes('关机'))

  // Conversation ids keep one dialogue together so the receiver can map it to one session.
  const conv = await call(alice.client, 'mesh_send', { to: 'bob', body: '对话分支消息', conversation: 'conv/smoke-1' })
  const convInbox = await call(bob.client, 'mesh_inbox', { mark_read: true })
  check(
    'conversation id is stored and returned',
    conv.conversation === 'conv/smoke-1' && convInbox.messages.some((m) => m.conversation === 'conv/smoke-1'),
    convInbox.messages[0]?.conversation ?? 'none',
  )

  // Broadcast reaches every other registered agent, still as one durable copy each.
  const broadcast = await call(alice.client, 'mesh_send', { to: '*', subject: '公告', body: '全体注意' })
  const broadcastInbox = await call(bob.client, 'mesh_inbox', { mark_read: true })
  check(
    'broadcast reaches other agents',
    broadcast.recipients >= 1 && broadcastInbox.messages.some((m) => m.body === '全体注意'),
    `${broadcast.recipients} recipient(s)`,
  )

  await call(bob.client, 'mesh_board_set', { key: 'env/nas', value: 'x86, docker' })
  const board = await call(alice.client, 'mesh_board_get', { key: 'env/nas' })
  check('shared board readable across agents', board.value === 'x86, docker', board.updated_by)

  // Board entries can carry an owner/status so a key becomes an assignable task.
  await call(alice.client, 'mesh_board_set', { key: 'task/smoke', value: '装唤醒插件', owner: 'bob', status: 'todo' })
  const task = await call(bob.client, 'mesh_board_get', { key: 'task/smoke' })
  check('board entries carry owner and status', task.owner === 'bob' && task.status === 'todo', `${task.owner}/${task.status}`)

  // --- board CAS + per-key visibility -----------------------------------------
  {
    const boardPost = (token, payload) => fetch(`${BASE}/api/board`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const created = await boardPost(aliceToken, { key: 'cas/smoke', value: 'v1' })
    const createdBody = await created.json()
    check('board write starts at version 1', created.status === 200 && createdBody.version === 1, `v${createdBody.version}`)
    const bumped = await boardPost(aliceToken, { key: 'cas/smoke', value: 'v2', if_version: 1 })
    const bumpedBody = await bumped.json()
    check('board CAS match bumps the version', bumped.status === 200 && bumpedBody.version === 2, `v${bumpedBody.version}`)
    const conflict = await boardPost(aliceToken, { key: 'cas/smoke', value: 'v3', if_version: 1 })
    const conflictBody = await conflict.json()
    check(
      'board CAS mismatch is 409 with current state',
      conflict.status === 409 && conflictBody.current_version === 2 && conflictBody.current_value === 'v2',
      `HTTP ${conflict.status} v${conflictBody.current_version}`,
    )
    const fresh = await boardPost(aliceToken, { key: 'cas/new', value: 'first', if_version: 0 })
    const freshBody = await fresh.json()
    check('if_version=0 creates a new key at version 1', fresh.status === 200 && freshBody.version === 1, `v${freshBody.version}`)

    await boardPost(aliceToken, { key: 'board/private', value: 'secret', visible_to: 'alice' })
    const bobBoard = await (await fetch(`${BASE}/api/board`, { headers: { authorization: `Bearer ${bobToken}` } })).json()
    const bobKeys = (bobBoard.entries || []).map((entry) => entry.key)
    check('private board key is hidden from the list', !bobKeys.includes('board/private'), `${bobKeys.length} keys`)
    const bobRead = await fetch(`${BASE}/api/board?key=board/private`, { headers: { authorization: `Bearer ${bobToken}` } })
    check('private board key is 404 for other agents', bobRead.status === 404, `HTTP ${bobRead.status}`)
    const aliceRead = await fetch(`${BASE}/api/board?key=board/private`, { headers: { authorization: `Bearer ${aliceToken}` } })
    check('allowlisted agent can read the private board key', aliceRead.status === 200, `HTTP ${aliceRead.status}`)
    const adminBoard = await (await admin('/api/admin/board', { method: 'GET' })).json()
    check('admin sees private board keys', (adminBoard.entries || []).some((entry) => entry.key === 'board/private'), 'admin sees all')
    const boardLog = await (await fetch(`${BASE}/api/board/log?key=cas/smoke`, { headers: { authorization: `Bearer ${aliceToken}` } })).json()
    check('board log lists changes', (boardLog.entries || []).length >= 2, `${boardLog.count} entries`)
    const bobPrivateLog = await (await fetch(`${BASE}/api/board/log?key=board/private`, { headers: { authorization: `Bearer ${bobToken}` } })).json()
    check('board log hides invisible keys', bobPrivateLog.count === 0, `${bobPrivateLog.count} entries`)
  }

  // A closing message is delivered and readable, but must not wake the recipient.
  const closing = await call(alice.client, 'mesh_send', {
    to: 'bob',
    subject: '收尾',
    body: '本轮结束，无需回复。',
    conversation: 'conv/smoke-1',
    reply_to: 'conv-smoke-parent',
    no_reply: true,
  })
  const closingInbox = await call(bob.client, 'mesh_inbox', { mark_read: true })
  const closingSeen = closingInbox.messages.find((m) => m.body === '本轮结束，无需回复。')
  check('closing message is marked no_reply', closing.no_reply === true && closingSeen?.no_reply === 1, closingSeen?.subject ?? 'missing')

  // Offline durability: bob disconnects, message must survive.
  await bob.transport.close()
  const offline = await call(alice.client, 'mesh_send', { to: 'bob', body: '离线期间的消息' })
  const bob2 = await connect('bob', bobToken)
  const late = await call(bob2.client, 'mesh_inbox', { mark_read: true })
  check('offline message survives reconnect', late.messages.some((m) => m.id === offline.id))
  await bob2.transport.close()

  // --- wake push: the hub must ping the recipient's own endpoint --------------
  // Only meaningful when the hub runs with MESH_WAKE_SECRET; without it the feature is
  // off by design, so this is reported as skipped instead of failing.
  if (process.env.MESH_WAKE_SECRET) {
    const wakeHits = []
    const wakeServer = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        wakeHits.push({ body, signature: req.headers['x-mesh-signature'] })
        res.writeHead(202)
        res.end('{}')
      })
    })
    await new Promise((resolve) => wakeServer.listen(0, '127.0.0.1', resolve))
    const wakePort = wakeServer.address().port
    await fetch(`${BASE}/api/register`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wake_url: `http://127.0.0.1:${wakePort}/wake` }),
    })
    const bobSecret = (
      await (
        await fetch(`${BASE}/api/wake-secret`, { headers: { authorization: `Bearer ${bobToken}` } })
      ).json()
    ).wake_secret
    const aliceSecret = (
      await (
        await fetch(`${BASE}/api/wake-secret`, { headers: { authorization: `Bearer ${aliceToken}` } })
      ).json()
    ).wake_secret
    check(
      'each agent gets its own wake secret',
      Boolean(bobSecret) && Boolean(aliceSecret) && bobSecret !== aliceSecret,
      `${String(bobSecret ?? '').length} chars`,
    )
    await call(alice.client, 'mesh_send', { to: 'bob', subject: 'wake 测试', body: '有人在吗' })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    check('hub pings the recipient wake endpoint', wakeHits.length >= 1, `${wakeHits.length} hit(s)`)
    check('wake ping is signed and carries no message body', Boolean(wakeHits[0]?.signature) && !String(wakeHits[0]?.body).includes('有人在吗'), String(wakeHits[0]?.signature ?? '').slice(0, 14))
    const expected = createHmac('sha256', bobSecret).update(wakeHits[0]?.body ?? '').digest('hex')
    check(
      "wake ping is signed with the recipient's own secret",
      wakeHits[0]?.signature === `sha256=${expected}`,
      wakeHits[0]?.signature === `sha256=${expected}` ? 'verified' : 'mismatch',
    )

    // no_reply is only the closing marker of a dialogue: without reply_to it must wake;
    // silent must store the message without waking anyone.
    const plainToken = await mint('wake-plain')
    const silentToken = await mint('wake-silent')
    const closingToken = await mint('wake-closing')
    for (const [token, name] of [[plainToken, 'wake-plain'], [silentToken, 'wake-silent'], [closingToken, 'wake-closing']]) {
      await fetch(`${BASE}/api/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ wake_url: `http://127.0.0.1:${wakePort}/wake` }),
      })
    }
    const post = (path, token, payload) => fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((response) => response.json())
    const plainSend = await post('/api/send', aliceToken, { to: 'wake-plain', subject: 'no reply without reply_to', body: 'wake me', no_reply: true })
    const silentSend = await post('/api/send', aliceToken, { to: 'wake-silent', subject: 'silent', body: 'do not wake', silent: true })
    const closingSend = await post('/api/send', aliceToken, { to: 'wake-closing', subject: 'closing', body: 'no wake', no_reply: true, reply_to: 'parent-message-id' })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    wakeServer.close()
    const woken = new Set(wakeHits.map((hit) => { try { return JSON.parse(hit.body).agent } catch { return null } }))
    check(
      'no_reply without reply_to is ignored and wakes',
      plainSend.no_reply_ignored === true && plainSend.no_reply === false && woken.has('wake-plain'),
      `ignored=${plainSend.no_reply_ignored}, woken=${woken.has('wake-plain')}`,
    )
    check(
      'silent stores without waking',
      silentSend.silent === true && !woken.has('wake-silent'),
      `silent=${silentSend.silent}, woken=${woken.has('wake-silent')}`,
    )
    check(
      'no_reply with reply_to still does not wake',
      closingSend.no_reply === true && !woken.has('wake-closing'),
      `no_reply=${closingSend.no_reply}, woken=${woken.has('wake-closing')}`,
    )
    const mcpClosing = await call(alice.client, 'mesh_send', { to: 'wake-mcp', body: 'mcp no_reply', no_reply: true })
    check('MCP send ignores no_reply without reply_to', mcpClosing.no_reply_ignored === true, `ignored=${mcpClosing.no_reply_ignored}`)
  } else {
    console.log('SKIP  wake push (hub started without MESH_WAKE_SECRET)')
  }

  // --- blob channel: files too big for a board value -----------------------------
  {
    const payload = Buffer.from('blob channel smoke payload ' + 'x'.repeat(5000))
    const sha = createHash('sha256').update(payload).digest('hex')
    const put = await fetch(`${BASE}/api/blob?name=smoke.bin&sha256=${sha}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    const putBody = await put.json().catch(() => ({}))
    check('blob upload accepted with matching sha256', put.status === 201 && putBody.sha256 === sha, `HTTP ${put.status}`)
    const putMeta = await fetch(`${BASE}/api/blob/${putBody.id}/meta`, { headers: { authorization: `Bearer ${aliceToken}` } })
    check('blob metadata is readable by its uploader', putMeta.status === 200, `HTTP ${putMeta.status}`)

    const get = await fetch(`${BASE}/api/blob/${putBody.id}`, { headers: { authorization: `Bearer ${bobToken}` } })
    const got = Buffer.from(await get.arrayBuffer())
    check(
      'blob download returns identical bytes',
      get.status === 200 && got.equals(payload) && get.headers.get('x-blob-sha256') === sha,
      `${got.length} bytes`,
    )

    const bad = await fetch(`${BASE}/api/blob?name=bad.bin&sha256=${'0'.repeat(64)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    check('blob upload with wrong sha256 is rejected', bad.status === 400, `HTTP ${bad.status}`)

    const missing = await fetch(`${BASE}/api/blob/${'0'.repeat(8)}-0000-4000-8000-000000000000`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    })
    check('unknown blob id is a clean 404', missing.status === 404, `HTTP ${missing.status}`)

    const del = await fetch(`${BASE}/api/blob/${putBody.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${aliceToken}` },
    })
    const gone = await fetch(`${BASE}/api/blob/${putBody.id}`, { headers: { authorization: `Bearer ${aliceToken}` } })
    check('uploader can delete a blob', del.status === 200 && gone.status === 404, `del ${del.status}, get ${gone.status}`)

    // --- resumable upload: init -> two chunks -> commit ---------------------
    const big = Buffer.alloc(300 * 1024, 7)
    const bigSha = createHash('sha256').update(big).digest('hex')
    const initRes = await fetch(`${BASE}/api/blob/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'chunked.bin', bytes: big.length, sha256: bigSha }),
    })
    const initBody = await initRes.json()
    const half = Math.floor(big.length / 2)
    const chunkHeaders = { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/octet-stream' }
    const badOffset = await fetch(`${BASE}${initBody.chunk_url}?offset=12345`, {
      method: 'PUT', headers: chunkHeaders, body: Buffer.from('x'),
    })
    check('chunk offset mismatch is 409', badOffset.status === 409, `HTTP ${badOffset.status}`)
    const part1 = await fetch(`${BASE}${initBody.chunk_url}`, { method: 'PUT', headers: chunkHeaders, body: big.subarray(0, half) })
    const part2 = await fetch(`${BASE}${initBody.chunk_url}?offset=${half}`, {
      method: 'PUT', headers: chunkHeaders, body: big.subarray(half),
    })
    const commit = await fetch(`${BASE}${initBody.commit_url}`, {
      method: 'POST', headers: { authorization: `Bearer ${aliceToken}` },
    })
    const commitBody = await commit.json()
    check(
      'resumable upload commits with matching sha256',
      initRes.status === 201 && part1.status === 200 && part2.status === 200 && commit.status === 201 && commitBody.sha256 === bigSha,
      `init ${initRes.status}, parts ${part1.status}/${part2.status}, commit ${commit.status}`,
    )
    const resumed = Buffer.from(await (await fetch(`${BASE}${commitBody.url}`, {
      headers: { authorization: `Bearer ${bobToken}` },
    })).arrayBuffer())
    check('resumable upload downloads identical bytes', resumed.length === big.length && resumed.equals(big), `${resumed.length} bytes`)

    // --- blob ACL: an allowlisted blob is invisible to other agents ---------
    const priv = await fetch(`${BASE}/api/blob?name=private.bin&sha256=${sha}&visible_to=alice`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    const privBody = await priv.json()
    const asBob = await fetch(`${BASE}/api/blob/${privBody.id}`, { headers: { authorization: `Bearer ${bobToken}` } })
    const asAlice = await fetch(`${BASE}/api/blob/${privBody.id}`, { headers: { authorization: `Bearer ${aliceToken}` } })
    check('blob ACL blocks non-allowlisted agents', asBob.status === 404 && asAlice.status === 200, `bob ${asBob.status}, alice ${asAlice.status}`)
    const reopen = await fetch(`${BASE}/api/blob/${privBody.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visible_to: '*' }),
    })
    const asBob2 = await fetch(`${BASE}/api/blob/${privBody.id}`, { headers: { authorization: `Bearer ${bobToken}` } })
    check('uploader can reopen a blob to the mesh', reopen.status === 200 && asBob2.status === 200, `patch ${reopen.status}, bob ${asBob2.status}`)

    // --- list/meta/download must not leak invisible blobs ------------------
    const hiddenRes = await fetch(`${BASE}/api/blob?name=hidden.bin&sha256=${sha}&visible_to=alice`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    const hiddenBody = await hiddenRes.json()
    const sharedRes = await fetch(`${BASE}/api/blob?name=shared.bin&sha256=${sha}&visible_to=bob`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    const sharedBody = await sharedRes.json()
    const bobList = await (await fetch(`${BASE}/api/blobs`, { headers: { authorization: `Bearer ${bobToken}` } })).json()
    const bobIds = new Set((bobList.blobs || []).map((row) => row.id))
    check(
      'blob list hides invisible entries',
      bobIds.has(sharedBody.id) && !bobIds.has(hiddenBody.id),
      `shared=${bobIds.has(sharedBody.id)} hidden=${bobIds.has(hiddenBody.id)}`,
    )
    const hiddenMeta = await fetch(`${BASE}/api/blob/${hiddenBody.id}/meta`, { headers: { authorization: `Bearer ${bobToken}` } })
    check('invisible blob metadata is 404', hiddenMeta.status === 404, `HTTP ${hiddenMeta.status}`)
    const hiddenGet = await fetch(`${BASE}/api/blob/${hiddenBody.id}`, { headers: { authorization: `Bearer ${bobToken}` } })
    check('invisible blob download is 404', hiddenGet.status === 404, `HTTP ${hiddenGet.status}`)
    const aliceList = await (await fetch(`${BASE}/api/blobs`, { headers: { authorization: `Bearer ${aliceToken}` } })).json()
    check('uploader still sees their private blob in the list', (aliceList.blobs || []).some((row) => row.id === hiddenBody.id), 'visible to uploader')

    // --- size mismatch: roll back the payload and the row ------------------
    const mismatchPayload = Buffer.from('0123456789')
    const mismatchSha = createHash('sha256').update(mismatchPayload).digest('hex')
    const mismatchInit = await fetch(`${BASE}/api/blob/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'size-mismatch.bin', bytes: mismatchPayload.length, sha256: mismatchSha }),
    })
    const mismatchBody = await mismatchInit.json()
    await fetch(`${BASE}${mismatchBody.chunk_url}?offset=0`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/octet-stream' },
      body: mismatchPayload.subarray(0, 4),
    })
    const mismatchCommit = await fetch(`${BASE}${mismatchBody.commit_url}`, {
      method: 'POST', headers: { authorization: `Bearer ${aliceToken}` },
    })
    const mismatchResult = await mismatchCommit.json()
    const mismatchMeta = await fetch(`${BASE}/api/blob/${mismatchBody.id}/meta`, { headers: { authorization: `Bearer ${aliceToken}` } })
    check(
      'size mismatch rolls back the row',
      mismatchCommit.status === 400 && mismatchResult.expected === 10 && mismatchResult.actual === 4 && mismatchMeta.status === 404,
      `commit ${mismatchCommit.status}, meta ${mismatchMeta.status}`,
    )

    // --- per-endpoint caps: file cap and chunk cap -> 413 ------------------
    const overFile = await fetch(`${BASE}/api/blob/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'too-big.bin', bytes: 64 * 1024 * 1024 + 1, sha256: 'a'.repeat(64) }),
    })
    check('blob above MESH_MAX_BLOB_BYTES is 413', overFile.status === 413, `HTTP ${overFile.status}`)
    const chunkInit = await fetch(`${BASE}/api/blob/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'chunk-cap.bin', bytes: 9 * 1024 * 1024, sha256: 'b'.repeat(64) }),
    })
    const chunkInitBody = await chunkInit.json()
    const overChunk = await fetch(`${BASE}${chunkInitBody.chunk_url}?offset=0`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(8 * 1024 * 1024 + 1),
    })
    check('chunk above MESH_MAX_BLOB_CHUNK_BYTES is 413', overChunk.status === 413, `HTTP ${overChunk.status}`)
    const caps = await (await fetch(`${BASE}/health`)).json()
    check(
      'health exposes blob limits',
      caps.blobs?.max_file === 64 * 1024 * 1024 && caps.blobs?.max_chunk === 8 * 1024 * 1024,
      `file=${caps.blobs?.max_file} chunk=${caps.blobs?.max_chunk}`,
    )

    for (const id of [hiddenBody.id, sharedBody.id, chunkInitBody.id]) {
      await fetch(`${BASE}/api/blob/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${aliceToken}` } }).catch(() => {})
    }
  }

  // --- conversation views: my dialogues, truncation, pinning ---------------------
  {
    const convId = 'conv/conv-view-smoke'
    const carolToken = await mint('carol')
    await call(alice.client, 'mesh_send', { to: 'bob', subject: '视图测试', body: 'y'.repeat(5000), conversation: convId })
    const list = await (await fetch(`${BASE}/api/conversations`, { headers: { authorization: `Bearer ${aliceToken}` } })).json()
    check(
      'conversation list groups my dialogues',
      Array.isArray(list.conversations) && list.conversations.some((c) => c.conversation === convId),
      `${list.conversations?.length ?? 0} conversations`,
    )
    const thread = await (await fetch(`${BASE}/api/conversation?conversation=${encodeURIComponent(convId)}`, { headers: { authorization: `Bearer ${aliceToken}` } })).json()
    check(
      'conversation thread truncates long bodies',
      thread.messages?.length >= 1 && thread.messages.some((m) => m.truncated === true),
      `${thread.messages?.length ?? 0} messages`,
    )
    const full = await (await fetch(`${BASE}/api/conversation?conversation=${encodeURIComponent(convId)}&full=1`, { headers: { authorization: `Bearer ${aliceToken}` } })).json()
    const target = full.messages.find((m) => m.body.length === 5000)
    check('full=1 returns the untruncated body', Boolean(target), `${target?.body.length ?? 0} chars`)

    // Truncation is byte-based: CJK is 3 bytes/char, emoji 4, so a 4096-character slice
    // would overshoot and a naive byte slice could split a codepoint.
    const utf8Conv = 'conv/trunc-utf8'
    await call(alice.client, 'mesh_send', { to: 'bob', body: '中'.repeat(3000), conversation: utf8Conv })
    await call(alice.client, 'mesh_send', { to: 'bob', body: '😀'.repeat(2000), conversation: utf8Conv })
    const utf8Thread = await (await fetch(`${BASE}/api/conversation?conversation=${encodeURIComponent(utf8Conv)}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    })).json()
    const cjk = utf8Thread.messages.find((m) => m.body.startsWith('中'))
    const emoji = utf8Thread.messages.find((m) => m.body.startsWith('😀'))
    check(
      'truncation is byte-accurate for CJK',
      Boolean(cjk) && Buffer.byteLength(cjk.body) <= 4096 && !cjk.body.includes('\uFFFD'),
      `${Buffer.byteLength(cjk?.body ?? '')} bytes`,
    )
    check(
      'truncation keeps emoji codepoints whole',
      Boolean(emoji) && Buffer.byteLength(emoji.body) <= 4096 && !emoji.body.includes('\uFFFD'),
      `${Buffer.byteLength(emoji?.body ?? '')} bytes`,
    )

    const pin = await fetch(`${BASE}/api/message/${target.id}/pin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    })
    const pinned = await (await fetch(`${BASE}/api/pinned`, { headers: { authorization: `Bearer ${aliceToken}` } })).json()
    check('pinned messages are listed', pin.status === 200 && pinned.pinned.some((m) => m.id === target.id), `${pinned.pinned?.length ?? 0} pinned`)

    const outsider = await fetch(`${BASE}/api/message/${target.id}/pin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${carolToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    })
    check('non-participants cannot pin or read a message', outsider.status === 403, `HTTP ${outsider.status}`)

    // important at send time: the sender marks it, the hub stores it as pinned
    const sent = await call(alice.client, 'mesh_send', {
      to: 'bob', subject: '重要信件', body: 'must survive the TTL', conversation: 'conv/important-smoke', important: true,
    })
    const pinnedAtSend = await (await fetch(`${BASE}/api/pinned`, { headers: { authorization: `Bearer ${aliceToken}` } })).json()
    check(
      'important messages are pinned at send time',
      pinnedAtSend.pinned.some((m) => m.id === sent.id),
      `send id ${sent.id?.slice(0, 8)}`,
    )
    const bobInbox = await (await fetch(`${BASE}/api/inbox?unread=1&limit=100`, { headers: { authorization: `Bearer ${bobToken}` } })).json()
    check(
      'inbox exposes the pinned flag for client-side caching',
      bobInbox.messages.some((m) => m.id === sent.id && m.pinned === 1),
      `${bobInbox.messages.length} messages`,
    )
  }

  // --- inbox ordering + cursor: newest must be reachable past the page cap ------
  {
    const orderedToken = await mint('ordered')
    for (let index = 0; index < 30; index += 1) {
      await fetch(`${BASE}/api/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'ordered', subject: `page ${index}`, body: `message ${index}` }),
      })
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const firstPage = await (await fetch(`${BASE}/api/inbox?unread=1&limit=20&order=desc`, {
      headers: { authorization: `Bearer ${orderedToken}` },
    })).json()
    check(
      'inbox order=desc returns the newest page with a cursor',
      firstPage.count === 20 && firstPage.messages[0]?.subject === 'page 29' &&
        firstPage.has_more === true && Number.isFinite(firstPage.next_before),
      `count=${firstPage.count}, has_more=${firstPage.has_more}`,
    )
    const seen = new Set(firstPage.messages.map((message) => message.id))
    let cursor = firstPage.next_before
    let pages = 1
    while (cursor) {
      const page = await (await fetch(`${BASE}/api/inbox?unread=1&limit=20&order=desc&before=${cursor}`, {
        headers: { authorization: `Bearer ${orderedToken}` },
      })).json()
      for (const message of page.messages) seen.add(message.id)
      pages += 1
      cursor = page.has_more ? page.next_before : null
      if (pages > 10) break
    }
    check('before cursor pages through the whole backlog', seen.size === 30, `pages=${pages}, seen=${seen.size}`)

    const orderedClient = await connect('ordered', orderedToken)
    const mcpInbox = await call(orderedClient.client, 'mesh_inbox', { unread_only: false, limit: 5 })
    check(
      'MCP inbox defaults to desc when reading everything',
      mcpInbox.order === 'desc' && mcpInbox.messages[0]?.subject === 'page 29',
      String(mcpInbox.order ?? 'missing'),
    )
    await orderedClient.transport.close()
  }

  // --- bootstrap + claim: pull onboarding and two-phase delivery -----------------
  {
    const boot = await (await fetch(`${BASE}/api/bootstrap`)).json()
    const health = await (await fetch(`${BASE}/health`)).json()
    check(
      'bootstrap advertises the frozen contract',
      boot.service === 'dsh-mesh' && boot.version === health.version && boot.protocol === 1 && boot.tls === null &&
        boot.endpoints?.inbox === '/api/inbox' && boot.endpoints?.device_token === '/api/enroll/token' &&
        boot.enroll?.code_ttl_ms === 600000 && boot.enroll?.device_flow === true &&
        Array.isArray(boot.wake?.modes) && boot.wake.modes.includes('pull') && boot.wake.min_poll_interval_ms === 5000,
      Object.keys(boot).join(','),
    )

    let bootstrapLimited = false
    for (let attempt = 0; attempt < 70; attempt += 1) {
      const response = await fetch(`${BASE}/api/bootstrap`)
      if (response.status === 429) { bootstrapLimited = true; break }
    }
    check('bootstrap is rate-limited per IP', bootstrapLimited, bootstrapLimited ? '429 seen' : 'no 429')

    const claimToken = await mint('claim-test')
    for (let index = 0; index < 3; index += 1) {
      await fetch(`${BASE}/api/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'claim-test', subject: `claim ${index}`, body: `claim body ${index}` }),
      })
    }
    const inbox = (extra) => fetch(`${BASE}/api/inbox?unread=1&order=desc&limit=10&${extra}`, {
      headers: { authorization: `Bearer ${claimToken}` },
    }).then((response) => response.json())

    const firstClaim = await inbox('claim=1')
    check(
      'claim=1 stamps claimed_at on the returned page',
      firstClaim.messages.length === 3 && firstClaim.messages.every((message) => Number.isFinite(message.claimed_at)),
      `${firstClaim.messages.length} rows`,
    )
    const firstStamps = new Map(firstClaim.messages.map((message) => [message.id, message.claimed_at]))
    const secondClaim = await inbox('claim=1')
    check(
      'a second claim inside the lease does not renew claimed_at',
      secondClaim.messages.length === 3 && secondClaim.messages.every((message) => firstStamps.get(message.id) === message.claimed_at),
      'lease held',
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    const reclaimed = await inbox('claim=1&claim_ttl_ms=1')
    check(
      'an expired lease can be claimed again',
      reclaimed.messages.length === 3 && reclaimed.messages.every((message) => message.claimed_at > firstStamps.get(message.id)),
      'lease renewed',
    )
    const afterClaim = await inbox('')
    check('claim does not mark messages read', afterClaim.messages.length === 3, `${afterClaim.messages.length} unread`)
    const marked = await inbox('mark_read=1')
    const afterRead = await inbox('')
    check('mark_read removes rows from unread', marked.messages.length === 3 && afterRead.messages.length === 0, `marked=${marked.messages.length}, left=${afterRead.messages.length}`)
  }

  // --- relay wake: only the deployment's configured target may be registered -----
  const badRelay = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ wake_api: 'http://127.0.0.1:9999' }),
  })
  check('relay target outside the allowlist is rejected', badRelay.status === 400, `HTTP ${badRelay.status}`)
  // --- hardening: session ids are bound to the token that opened them -------
  const initBody = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
  })
  const rawInit = await fetch(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: initBody,
  })
  const aliceSid = rawInit.headers.get('mcp-session-id')
  const stolen = await fetch(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': aliceSid },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  })
  check('another agent cannot reuse a session id', stolen.status === 403, `HTTP ${stolen.status}`)
  await fetch(MCP_URL, { method: 'DELETE', headers: { authorization: `Bearer ${aliceToken}`, 'mcp-session-id': aliceSid } })

  // A session the hub no longer knows (restart / swept) must be a 404 so the client
  // knows to initialize again — not a doomed "new" transport answering 400.
  const stale = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${aliceToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': '00000000-0000-4000-8000-000000000000',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
  })
  check('unknown session id gets 404 to re-initialize', stale.status === 404, `HTTP ${stale.status}`)

  // --- hardening: payload caps ---------------------------------------------
  const hugeBody = await fetch(`${BASE}/api/board`, {
    method: 'POST',
    headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'env/huge', value: 'x'.repeat(2 * 1024 * 1024) }),
  })
  check('oversized request body is refused', hugeBody.status === 413, `HTTP ${hugeBody.status}`)

  const bigValue = await fetch(`${BASE}/api/board`, {
    method: 'POST',
    headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'env/big', value: 'x'.repeat(70 * 1024) }),
  })
  check('oversized board value is refused', bigValue.status === 400, `HTTP ${bigValue.status}`)

  const junkLimit = await fetch(`${BASE}/api/inbox?limit=abc`, { headers: { authorization: `Bearer ${aliceToken}` } })
  check('junk ?limit is a clean 400', junkLimit.status === 400, `HTTP ${junkLimit.status}`)

  // --- hardening: failures from one address must not lock that address out --
  for (let i = 0; i < 12; i += 1) {
    await fetch(`${BASE}/api/peers`, { headers: { authorization: 'Bearer mesh_wrong' } })
  }
  const stillWorks = await fetch(`${BASE}/api/status`, { headers: { authorization: `Bearer ${aliceToken}` } })
  check('valid token still served after 12 failures from this IP', stillWorks.status === 200, `HTTP ${stillWorks.status}`)
} finally {
  await alice.transport.close()
}

// --- REST scopes: a restricted token may not exceed its granted surface -------
{
  const readerToken = await mint('reader')
  const senderToken = await mint('sender')
  const setScopes = async (name, scopes) => {
    const res = await admin('/console/agents/update', { method: 'POST', body: JSON.stringify({ name, scopes, allowed_cidrs: '' }) })
    if (!res.ok) throw new Error(`set scopes for ${name} failed: HTTP ${res.status}`)
  }
  await setScopes('reader', ['read'])
  await setScopes('sender', ['send'])

  const readerSend = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'alice', body: 'should be refused' }),
  })
  const readerSendBody = await readerSend.json().catch(() => ({}))
  check(
    'read-only token cannot send over REST',
    readerSend.status === 403 && readerSendBody.ok === false && readerSendBody.required_scope === 'send',
    `HTTP ${readerSend.status}`,
  )

  const senderInbox = await fetch(`${BASE}/api/inbox`, { headers: { authorization: `Bearer ${senderToken}` } })
  const senderInboxBody = await senderInbox.json().catch(() => ({}))
  check(
    'send-only token cannot read the inbox',
    senderInbox.status === 403 && senderInboxBody.required_scope === 'read',
    `HTTP ${senderInbox.status}`,
  )

  const readerInbox = await fetch(`${BASE}/api/inbox`, { headers: { authorization: `Bearer ${readerToken}` } })
  check('read-only token keeps read access', readerInbox.status === 200, `HTTP ${readerInbox.status}`)

  const senderBoard = await fetch(`${BASE}/api/board`, {
    method: 'POST',
    headers: { authorization: `Bearer ${senderToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'scope/smoke', value: 'x' }),
  })
  const senderBoardBody = await senderBoard.json().catch(() => ({}))
  check(
    'send-only token cannot write the board',
    senderBoard.status === 403 && senderBoardBody.required_scope === 'board',
    `HTTP ${senderBoard.status}`,
  )

  const readerBlobPut = await fetch(`${BASE}/api/blob?name=denied.bin`, {
    method: 'POST',
    headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/octet-stream' },
    body: Buffer.from('should be refused'),
  })
  const readerBlobBody = await readerBlobPut.json().catch(() => ({}))
  check(
    'read-only token cannot upload a blob',
    readerBlobPut.status === 403 && readerBlobBody.required_scope === 'blob',
    `HTTP ${readerBlobPut.status}`,
  )

  const readerBlobs = await fetch(`${BASE}/api/blobs`, { headers: { authorization: `Bearer ${readerToken}` } })
  check('read-only token can list blob metadata', readerBlobs.status === 200, `HTTP ${readerBlobs.status}`)

  const unrestrictedSend = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'bob', body: 'unrestricted send still works' }),
  })
  check('unrestricted token still sends over REST', unrestrictedSend.status === 201, `HTTP ${unrestrictedSend.status}`)

  // An empty scope set used to be stored as "" and read back as "all"; it must 400 now,
  // and "all" must be asked for explicitly.
  const emptyArray = await admin('/console/agents/update', {
    method: 'POST',
    body: JSON.stringify({ name: 'reader', scopes: [], allowed_cidrs: '' }),
  })
  check('empty scope array is rejected (would mean all scopes)', emptyArray.status === 400, `HTTP ${emptyArray.status}`)

  const emptyString = await admin('/console/agents/update', {
    method: 'POST',
    body: JSON.stringify({ name: 'reader', scopes: '', allowed_cidrs: '' }),
  })
  check('empty scope string is rejected', emptyString.status === 400, `HTTP ${emptyString.status}`)

  const starToken = await mint('star')
  const starUpdate = await admin('/console/agents/update', {
    method: 'POST',
    body: JSON.stringify({ name: 'star', scopes: ['*'], allowed_cidrs: '' }),
  })
  const starInbox = await fetch(`${BASE}/api/inbox`, { headers: { authorization: `Bearer ${starToken}` } })
  const starSend = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${starToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'bob', body: 'star scope send' }),
  })
  check(
    '["*"] is explicit full access',
    starUpdate.status === 200 && starInbox.status === 200 && starSend.status === 201,
    `update ${starUpdate.status}, inbox ${starInbox.status}, send ${starSend.status}`,
  )

  const cidrUpdate = await admin('/console/agents/update', {
    method: 'POST',
    body: JSON.stringify({ name: 'reader', scopes: ['read'], allowed_cidrs: '10.9.0.0/16' }),
  })
  const cidrBlocked = await fetch(`${BASE}/api/inbox`, { headers: { authorization: `Bearer ${readerToken}` } })
  check(
    'allowed_cidrs blocks a non-matching source',
    cidrUpdate.status === 200 && cidrBlocked.status === 403,
    `HTTP ${cidrBlocked.status}`,
  )
  await admin('/console/agents/update', {
    method: 'POST',
    body: JSON.stringify({ name: 'reader', scopes: ['read'], allowed_cidrs: '' }),
  })
}

// --- message hints: interrupt / delivery_mode --------------------------------
{
  const hintToken = await mint('hint-target')
  await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'hint-target', body: 'steer this', interrupt: true, delivery: 'steer' }),
  })
  const hintInbox = await (await fetch(`${BASE}/api/inbox?unread=1`, { headers: { authorization: `Bearer ${hintToken}` } })).json()
  const hintRow = (hintInbox.messages || [])[0]
  check('interrupt hint is stored', hintRow?.interrupt === 1, String(hintRow?.interrupt))
  check('delivery_mode hint is stored', hintRow?.delivery_mode === 'steer', String(hintRow?.delivery_mode))
}

// --- plugin version drift detection ------------------------------------------
{
  const driftToken = await mint('drift-node')
  await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { authorization: `Bearer ${driftToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'drift-host', plugin: { name: 'drift-plugin', version: '0.0.1', platform: 'test' } }),
  })
  const status = await (await fetch(`${BASE}/api/status`, { headers: { authorization: `Bearer ${aliceToken}` } })).json()
  check('plugin version is reported', (status.plugin_versions || []).some((row) => row.version === '0.0.1'), JSON.stringify(status.plugin_versions))
  check('outdated plugin is flagged', (status.outdated || []).some((row) => row.name === 'drift-node'), `${(status.outdated || []).length} outdated`)
}

// --- expiring tokens: issuance and enforcement --------------------------------
{
  const expiredMint = await admin('/api/admin/agents', {
    method: 'POST',
    body: JSON.stringify({ name: 'expired', expires_at: Date.now() - 1000 }),
  })
  const expiredMintBody = await expiredMint.json()
  const expiredReq = await fetch(`${BASE}/api/status`, { headers: { authorization: `Bearer ${expiredMintBody.token}` } })
  const expiredBody = await expiredReq.json().catch(() => ({}))
  check(
    'expired token gets 401 with an expired reason',
    expiredReq.status === 401 && String(expiredBody.error ?? '').includes('expired'),
    `HTTP ${expiredReq.status} ${JSON.stringify(expiredBody)}`,
  )

  const freshMint = await admin('/api/admin/agents', {
    method: 'POST',
    body: JSON.stringify({ name: 'fresh', expires_at: Date.now() + 60_000 }),
  })
  const freshMintBody = await freshMint.json()
  const freshReq = await fetch(`${BASE}/api/status`, { headers: { authorization: `Bearer ${freshMintBody.token}` } })
  check('future expiry token still works', freshReq.status === 200, `HTTP ${freshReq.status}`)

  const invalidExpiry = await admin('/api/admin/agents', {
    method: 'POST',
    body: JSON.stringify({ name: 'bad-expiry', expires_at: 'not-a-date' }),
  })
  check('invalid expires_at is rejected', invalidExpiry.status === 400, `HTTP ${invalidExpiry.status}`)

  const rotateExpired = await admin('/api/admin/rotate', {
    method: 'POST',
    body: JSON.stringify({ name: 'fresh', expires_at: Date.now() - 1000 }),
  })
  const rotateExpiredBody = await rotateExpired.json()
  const rotateReq = await fetch(`${BASE}/api/status`, { headers: { authorization: `Bearer ${rotateExpiredBody.token}` } })
  check('rotate can set an already-expired token', rotateReq.status === 401, `HTTP ${rotateReq.status}`)
}

// --- enrollment: legacy 8-char code and device-code pairing -------------------
{
  const minted = await (await admin('/api/admin/enroll-codes', { method: 'POST', body: '{}' })).json()
  const enrolled = await fetch(`${BASE}/api/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: minted.code, name: 'code-node' }),
  })
  const enrolledBody = await enrolled.json().catch(() => ({}))
  check(
    'enrollment code exchanges for a token',
    enrolled.status === 201 && String(enrolledBody.token ?? '').startsWith('mesh_') && enrolledBody.name === 'code-node',
    `HTTP ${enrolled.status}`,
  )
  const reused = await fetch(`${BASE}/api/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: minted.code, name: 'code-node-2' }),
  })
  check('enrollment code is single use', reused.status === 401, `HTTP ${reused.status}`)

  // device code: request -> pending -> approve -> token -> gone
  const requested = await fetch(`${BASE}/api/enroll/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'device-node', host: 'device-host' }),
  })
  const requestBody = await requested.json().catch(() => ({}))
  const pollToken = () => fetch(`${BASE}/api/enroll/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: requestBody.device_code }),
  })
  check(
    'device code request returns a human code and a device code',
    requested.status === 201 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(requestBody.user_code ?? '') &&
      /^[0-9a-f]{64}$/.test(requestBody.device_code ?? '') && requestBody.interval_ms === 5000,
    `HTTP ${requested.status}`,
  )
  const pendingPoll = await pollToken()
  check('unapproved device poll returns 202 pending', pendingPoll.status === 202, `HTTP ${pendingPoll.status}`)
  const approved = await admin('/api/admin/enroll/approve', { method: 'POST', body: JSON.stringify({ user_code: requestBody.user_code }) })
  check('admin approves the device code', approved.status === 200, `HTTP ${approved.status}`)
  const tokenPoll = await pollToken()
  const tokenBody = await tokenPoll.json().catch(() => ({}))
  check(
    'approved device poll issues the token once',
    tokenPoll.status === 201 && String(tokenBody.token ?? '').startsWith('mesh_') && tokenBody.name === 'device-node',
    `HTTP ${tokenPoll.status}`,
  )
  const tokenAgain = await pollToken()
  check('device code expires after the token is issued', tokenAgain.status === 410, `HTTP ${tokenAgain.status}`)

  // deny path
  const deniedRequest = await fetch(`${BASE}/api/enroll/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'denied-node' }),
  })
  const deniedBody = await deniedRequest.json().catch(() => ({}))
  const denied = await admin('/api/admin/enroll/deny', { method: 'POST', body: JSON.stringify({ user_code: deniedBody.user_code }) })
  const deniedPoll = await fetch(`${BASE}/api/enroll/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: deniedBody.device_code }),
  })
  check('denied device poll is refused', denied.status === 200 && deniedPoll.status === 403, `deny ${denied.status}, poll ${deniedPoll.status}`)

  // polling is rate-limited per IP (10/min), so keep hammering an unknown code.
  let limited = false
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await fetch(`${BASE}/api/enroll/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: '0'.repeat(64) }),
    })
    if (response.status === 429) { limited = true; break }
  }
  check('device-code polling is rate-limited per IP', limited, limited ? '429 seen' : 'no 429')
}

// --- rotation and revocation ------------------------------------------------
const rotated = await (await admin('/api/admin/rotate', { method: 'POST', body: JSON.stringify({ name: 'alice' }) })).json()
const oldTokenAfterRotate = await fetch(`${BASE}/api/peers`, { headers: { authorization: `Bearer ${aliceToken}` } })
check('rotation invalidates the old token', oldTokenAfterRotate.status === 401, `HTTP ${oldTokenAfterRotate.status}`)

const newTokenWorks = await fetch(`${BASE}/api/peers`, { headers: { authorization: `Bearer ${rotated.token}` } })
check('rotated token works', newTokenWorks.ok, `HTTP ${newTokenWorks.status}`)

await admin('/api/admin/agents?name=bob', { method: 'DELETE' })
const revoked = await fetch(`${BASE}/api/peers`, { headers: { authorization: `Bearer ${bobToken}` } })
check('revocation blocks the agent', revoked.status === 401, `HTTP ${revoked.status}`)

// --- human-readable timestamps + full removal --------------------------------
{
  const roster = await (await admin('/api/admin/agents')).json()
  check(
    'admin roster exposes a parseable last_seen_at',
    roster.agents.length > 0 && roster.agents.every((row) => Number.isFinite(Date.parse(row.last_seen_at))),
    String(roster.agents[0]?.last_seen_at ?? 'missing'),
  )
  const peers = await (await fetch(`${BASE}/api/peers?offline=1`, { headers: { authorization: `Bearer ${rotated.token}` } })).json()
  check(
    '/api/peers exposes a parseable last_seen_at',
    peers.peers.length > 0 && peers.peers.every((row) => Number.isFinite(Date.parse(row.last_seen_at))),
    `${peers.peers.length} peers`,
  )

  await mint('purge-me')
  const revokedOnly = await (await admin('/api/admin/agents?name=purge-me', { method: 'DELETE' })).json()
  const afterRevoke = await (await admin('/api/admin/agents')).json()
  check(
    'DELETE without purge only revokes the token',
    revokedOnly.revoked === true && revokedOnly.purged === undefined && afterRevoke.agents.some((row) => row.name === 'purge-me'),
  )
  const purged = await (await admin('/api/admin/agents?name=purge-me&purge=1', { method: 'DELETE' })).json()
  const afterPurge = await (await admin('/api/admin/agents')).json()
  check(
    'purge=1 deletes the agent row',
    purged.purged === true && !afterPurge.agents.some((row) => row.name === 'purge-me'),
  )
}

// --- console auth: login cookie, CSRF, read-only role ------------------------
{
  const login = await fetch(`${BASE}/console/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: adminToken }),
    redirect: 'manual',
  })
  const cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0]
  check('console login issues a session cookie', login.status === 303 && cookie.startsWith('mesh_console='), `HTTP ${login.status}`)
  const page = await (await fetch(`${BASE}/console`, { headers: { cookie } })).text()
  const csrf = /const CSRF = "([^"]+)"/.exec(page)?.[1]
  const payload = JSON.stringify({ name: 'reader', scopes: ['read'], allowed_cidrs: '' })
  const withoutCsrf = await fetch(`${BASE}/console/agents/update`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: payload,
  })
  check('console mutation without CSRF is 403', withoutCsrf.status === 403, `HTTP ${withoutCsrf.status}`)
  const withCsrf = await fetch(`${BASE}/console/agents/update`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-mesh-csrf': csrf ?? '' },
    body: payload,
  })
  check('console mutation with CSRF succeeds', withCsrf.status === 200, `HTTP ${withCsrf.status}`)
}

// --- audit trail ------------------------------------------------------------
const auditTrail = await (await admin('/api/admin/audit?limit=200')).json()
check('failed auth attempts are audited', auditTrail.entries.some((e) => e.action === 'auth' && e.ok === 0), `${auditTrail.count} entries`)

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) {
  console.error('failed:', failed.map((f) => f.label).join('; '))
  process.exit(1)
}
