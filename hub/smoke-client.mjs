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

  // A closing message is delivered and readable, but must not wake the recipient.
  const closing = await call(alice.client, 'mesh_send', {
    to: 'bob',
    subject: '收尾',
    body: '本轮结束，无需回复。',
    conversation: 'conv/smoke-1',
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
    wakeServer.close()
    check('hub pings the recipient wake endpoint', wakeHits.length >= 1, `${wakeHits.length} hit(s)`)
    check('wake ping is signed and carries no message body', Boolean(wakeHits[0]?.signature) && !String(wakeHits[0]?.body).includes('有人在吗'), String(wakeHits[0]?.signature ?? '').slice(0, 14))
    const expected = createHmac('sha256', bobSecret).update(wakeHits[0]?.body ?? '').digest('hex')
    check(
      "wake ping is signed with the recipient's own secret",
      wakeHits[0]?.signature === `sha256=${expected}`,
      wakeHits[0]?.signature === `sha256=${expected}` ? 'verified' : 'mismatch',
    )
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
    check('blob ACL blocks non-allowlisted agents', asBob.status === 403 && asAlice.status === 200, `bob ${asBob.status}, alice ${asAlice.status}`)
    const reopen = await fetch(`${BASE}/api/blob/${privBody.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visible_to: '*' }),
    })
    const asBob2 = await fetch(`${BASE}/api/blob/${privBody.id}`, { headers: { authorization: `Bearer ${bobToken}` } })
    check('uploader can reopen a blob to the mesh', reopen.status === 200 && asBob2.status === 200, `patch ${reopen.status}, bob ${asBob2.status}`)
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

// --- audit trail ------------------------------------------------------------
const auditTrail = await (await admin('/api/admin/audit?limit=200')).json()
check('failed auth attempts are audited', auditTrail.entries.some((e) => e.action === 'auth' && e.ok === 0), `${auditTrail.count} entries`)

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) {
  console.error('failed:', failed.map((f) => f.label).join('; '))
  process.exit(1)
}
