/**
 * dsh-mesh — LAN agent mesh hub.
 *
 * A single always-on process that lives on the NAS. It speaks MCP over
 * Streamable HTTP, so every DSH machine reaches it with nothing but an
 * `@deepseek-ai/dsh-mcp-client` entry (transport: streamable-http).
 *
 * Why this shape: DSH machines get switched off. Anything that requires them
 * to be reachable (A2A server, MCP server, remote GUI) only works while they
 * are on. The NAS is the one thing that is always up, so it owns the state:
 * presence, a durable message queue, and a shared board.
 *
 * Tools exposed:
 *   mesh_whoami   identity as the hub sees it
 *   mesh_register announce host/description for this agent
 *   mesh_peers    who exists, who is online, what they are doing
 *   mesh_send     durable message to another agent
 *   mesh_inbox    pull messages addressed to me
 *   mesh_ack      mark messages read
 *   mesh_board_*  shared key/value board + append log
 *   mesh_status   hub counters
 *
 * Identity comes from the X-Mesh-Agent header (plus optional Bearer token).
 * Each DSH profile pins its own name in its MCP client config.
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, createReadStream, statSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Hub version and the oldest plugin build the hub still fully understands. Both are
// advisory: they drive the drift hints in /api/peers and /api/status, never authorization.
const HUB_VERSION = '0.7.21'
const MIN_WAKER = process.env.MESH_MIN_WAKER || '0.4.0'
// Read-only console. Without a view token (or an admin token to fall back on) the
// console does not exist at all — a default-open dashboard is how tokens leak.
const VIEW_TOKEN = process.env.MESH_VIEW_TOKEN || process.env.MESH_ADMIN_TOKEN || null
// Who may even open the console. Default: loopback only — a management page on plain HTTP
// must not be reachable from the LAN unless the operator explicitly opts in.
const CONSOLE_ALLOW = String(process.env.MESH_CONSOLE_ALLOW ?? '').trim()
import { DatabaseSync } from 'node:sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.MESH_PORT ?? 8790)
const HOST = process.env.MESH_HOST ?? '0.0.0.0'
const DATA_DIR = process.env.MESH_DATA_DIR ?? join(HERE, 'data')
const ONLINE_TTL_MS = Number(process.env.MESH_ONLINE_TTL_MS ?? 120_000)
const MESSAGE_TTL_MS = Number(process.env.MESH_MESSAGE_TTL_MS ?? 7 * 24 * 3600_000)
// How often read mail is swept and unread mail is marked stale (tests shorten this).
const PURGE_INTERVAL_MS = Math.max(1000, Number(process.env.MESH_PURGE_INTERVAL_MS ?? 3600_000))
// Optional unread backlog alarm (0 = off). This never deletes: an unread message is the
// one piece of state that must survive a long-offline peer.
const MAX_UNREAD_MESSAGES = Number(process.env.MESH_MAX_UNREAD_MESSAGES ?? 0)

// --- resource caps -----------------------------------------------------------
// The hub is a long-lived process. Everything a caller can create without bound
// (request bodies, board values, message bodies, MCP sessions, append-only logs)
// gets a ceiling, otherwise one runaway agent can exhaust memory or the NAS disk.
const MAX_BODY_BYTES = Number(process.env.MESH_MAX_BODY_BYTES ?? 1_048_576) // 1 MiB per request
const MAX_MESSAGE_BYTES = Number(process.env.MESH_MAX_MESSAGE_BYTES ?? 65_536) // message body
const MAX_BOARD_BYTES = Number(process.env.MESH_MAX_BOARD_BYTES ?? 65_536) // board value
const MAX_KEY_BYTES = 200
const MAX_SUBJECT_BYTES = 200
const MAX_RECIPIENT_BYTES = 64
// --- blob channel ------------------------------------------------------------
// Files that do not belong in a 64 KiB board value: skill bundles, workspace
// snapshots, build artefacts. Uploads are bounded per file AND in total, carry a
// sha256, and expire on their own so a forgotten transfer cannot fill the disk.
const BLOB_DIR = join(DATA_DIR, 'blobs')
const MAX_BLOB_BYTES = Number(process.env.MESH_MAX_BLOB_BYTES ?? 64 * 1024 * 1024) // 64 MiB per file
const MAX_BLOB_CHUNK_BYTES = Number(process.env.MESH_MAX_BLOB_CHUNK_BYTES ?? 8 * 1024 * 1024) // 8 MiB per chunk
const MAX_BLOB_TOTAL_BYTES = Number(process.env.MESH_MAX_BLOB_TOTAL_BYTES ?? 2 * 1024 * 1024 * 1024) // 2 GiB
const BLOB_TTL_MS = Number(process.env.MESH_BLOB_TTL_MS ?? 24 * 3600_000) // 24 h
// A conversation id groups messages that belong to one dialogue, so a receiving dsh can
// keep that dialogue in one session instead of mixing everything into a single inbox.
const MAX_CONVERSATION_BYTES = 120
// Sessions live in this process's memory. DSH machines get switched off without a
// graceful DELETE, so a session must expire on its own or the map leaks forever.
const SESSION_IDLE_MS = Number(process.env.MESH_SESSION_IDLE_MS ?? 30 * 60_000)
// MCP sessions are persisted so a hub restart does not force every client to
// re-initialize (DSH does not reconnect on its own); the row TTL is what finally
// expires a dead session.
const MCP_SESSION_TTL_MS = Number(process.env.MESH_MCP_SESSION_TTL_MS ?? 7 * 24 * 3600_000)
// Lenient mode: rebuild a session for an unknown Mcp-Session-Id instead of answering 404.
const MCP_LENIENT_SESSION = ['1', 'true', 'yes', 'on'].includes(String(process.env.MESH_MCP_LENIENT_SESSION ?? '').toLowerCase())
const MAX_SESSIONS = Number(process.env.MESH_MAX_SESSIONS ?? 128)
// board_log and audit are append-only: keep a useful window, not an infinite table.
const LOG_KEEP_MS = Number(process.env.MESH_LOG_TTL_MS ?? 30 * 24 * 3600_000)
const LOG_KEEP_ROWS = Number(process.env.MESH_LOG_MAX_ROWS ?? 20_000)

// --- relay wake (host-network deployments only) ------------------------------
// Some agents expose an OpenAI-compatible API on the host loopback instead of a
// wake endpoint (a host-network Hub can reach it; bridge containers cannot). The
// target is a HARD-CODED allow instance: the hub may never be used as a generic
// HTTP proxy, whatever a caller registers.
const RELAY_TARGET = process.env.MESH_RELAY_TARGET ?? '127.0.0.1:18642'
const RELAY_API_KEY = process.env.MESH_RELAY_API_KEY ?? ''
const RELAY_MODEL = process.env.MESH_RELAY_MODEL ?? 'deepseek/deepseek-v4.1-flash'
const RELAY_TIMEOUT_MS = Number(process.env.MESH_RELAY_TIMEOUT_MS ?? 180_000)
const RELAY_ENABLED = Boolean(RELAY_API_KEY)
const RELAY_PROMPT =
  '自动通知，不是新任务。严格只做两步：① 调用 mesh_inbox(unread_only=true, mark_read=true)；' +
  '② 对每条未读消息调用 mesh_send 回复发送方（沿用该消息的 conversation，并带 no_reply=true）。' +
  '禁止调用 terminal / read_file / search_files 或任何其他工具；最多两次工具调用；做完立即结束，不要继续工作。'

// --- auth configuration -----------------------------------------------------
// 'token' (default): every request must carry a Bearer token minted by the admin.
// 'open': no app-level auth; X-Mesh-Agent names the caller. Only for a LAN you
// fully trust, never for a port reachable from another network.
const AUTH_MODE = process.env.MESH_AUTH_MODE ?? 'token'
let ADMIN_TOKEN = process.env.MESH_ADMIN_TOKEN ?? ''
// Only trust X-Forwarded-For when a reverse proxy you control sets it.
const TRUST_PROXY = process.env.MESH_TRUST_PROXY === '1'

// --- wake (inbound push) -----------------------------------------------------
// After a message is queued, the hub may POST a signed "you have mail" ping to the
// recipient's own LAN endpoint (a dsh host plugin listens there). The ping carries no
// message content — the receiver still reads /api/inbox — so a leaked wake endpoint
// can trigger a turn but cannot forge a message. Best effort only: the inbox is truth.
const WAKE_SECRET = process.env.MESH_WAKE_SECRET ?? ''
const WAKE_TIMEOUT_MS = Number(process.env.MESH_WAKE_TIMEOUT_MS ?? 3000)
const WAKE_DEBOUNCE_MS = Number(process.env.MESH_WAKE_DEBOUNCE_MS ?? 2000)

// --- transport encryption ----------------------------------------------------
// Terminate TLS inside the hub when you expose it through a plain TCP tunnel
// (frp type="tcp") or on a LAN IP. Leave unset when an frp https2http plugin or
// a reverse proxy already terminates TLS in front of it.
const TLS_CERT_FILE = process.env.MESH_TLS_CERT ?? ''
const TLS_KEY_FILE = process.env.MESH_TLS_KEY ?? ''
const TLS_ENABLED = Boolean(TLS_CERT_FILE && TLS_KEY_FILE)
if (Boolean(TLS_CERT_FILE) !== Boolean(TLS_KEY_FILE)) {
  console.error('[mesh] set both MESH_TLS_CERT and MESH_TLS_KEY, or neither')
  process.exit(1)
}
const FAIL_LIMIT = 8
const FAIL_WINDOW_MS = 60_000
if (!['token', 'open'].includes(AUTH_MODE)) {
  console.error(`[mesh] MESH_AUTH_MODE must be "token" or "open", got "${AUTH_MODE}"`)
  process.exit(1)
}

mkdirSync(DATA_DIR, { recursive: true })
const db = new DatabaseSync(join(DATA_DIR, 'mesh.db'))
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  name        TEXT PRIMARY KEY,
  host        TEXT,
  description TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  token_hash  TEXT,
  wake_url    TEXT,
  wake_secret TEXT,
  wake_api    TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  sender      TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  subject     TEXT,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER,
  reply_to    TEXT,
  conversation TEXT,
  no_reply    INTEGER DEFAULT 0,
  pinned      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation, created_at);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, created_at);
CREATE TABLE IF NOT EXISTS board (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  owner      TEXT,
  status     TEXT,
  version    INTEGER NOT NULL DEFAULT 1,
  visible_to TEXT NOT NULL DEFAULT '*'
);
CREATE TABLE IF NOT EXISTS board_log (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  actor TEXT,
  at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  agent  TEXT,
  action TEXT NOT NULL,
  ip     TEXT,
  ok     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_sessions (
  sid        TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  uploader   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ready',
  visible_to TEXT NOT NULL DEFAULT '*',
  expected_sha   TEXT,
  expected_bytes INTEGER
);
`)

// Migrate databases created by earlier versions.
{
  const agentColumns = db.prepare('PRAGMA table_info(agents)').all()
  if (!agentColumns.some((c) => c.name === 'token_hash')) db.exec('ALTER TABLE agents ADD COLUMN token_hash TEXT')
  if (!agentColumns.some((c) => c.name === 'wake_url')) db.exec('ALTER TABLE agents ADD COLUMN wake_url TEXT')
  // Per-agent wake secrets: a leaked key must not let anyone wake (or forge pings to)
  // every other machine. The hub signs with the recipient's own secret.
  if (!agentColumns.some((c) => c.name === 'wake_secret')) db.exec('ALTER TABLE agents ADD COLUMN wake_secret TEXT')
  // wake_api: agent runs on a host-network service exposing an OpenAI-compatible API
  // (relay wake). Only the deployment's configured target is accepted at registration.
  if (!agentColumns.some((c) => c.name === 'wake_api')) db.exec('ALTER TABLE agents ADD COLUMN wake_api TEXT')
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all()
  if (!messageColumns.some((c) => c.name === 'conversation')) db.exec('ALTER TABLE messages ADD COLUMN conversation TEXT')
  // no_reply = the closing message of a dialogue: delivered, readable, but it must NOT
  // wake the recipient, otherwise two auto-waking agents answer each other forever.
  if (!messageColumns.some((c) => c.name === 'no_reply')) db.exec('ALTER TABLE messages ADD COLUMN no_reply INTEGER DEFAULT 0')
  // pinned = "important": exempt from the message TTL purge (see purgeExpired).
  if (!messageColumns.some((c) => c.name === 'pinned')) db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0')
  // interrupt = the sender wants this message to steer a running turn instead of queueing
  // behind it. The receiver still decides (its waker policy), this is only a hint.
  if (!messageColumns.some((c) => c.name === 'interrupt')) db.exec('ALTER TABLE messages ADD COLUMN interrupt INTEGER DEFAULT 0')
  // origin_session: the DSH session that authored this message, when the agent passed one.
  // A reply's wake carries it back so the sender's waker can bind the conversation to the
  // session that actually started it.
  if (!messageColumns.some((c) => c.name === 'origin_session')) db.exec('ALTER TABLE messages ADD COLUMN origin_session TEXT')
  // delivery_mode: what the sender would like the receiver's waker to do with this message
  // (queue | steer | branch). Advisory: the receiver's local policy and rate caps still win.
  if (!messageColumns.some((c) => c.name === 'delivery_mode')) db.exec('ALTER TABLE messages ADD COLUMN delivery_mode TEXT')
  // claimed_at: a puller took these rows for processing. Not read; expires on its own so
  // a crashed puller's messages become claimable again (see the claim=1 inbox parameter).
  if (!messageColumns.some((c) => c.name === 'claimed_at')) db.exec('ALTER TABLE messages ADD COLUMN claimed_at INTEGER')
  // stale_at: an unread message older than the TTL. Unread mail is never deleted, only
  // marked, so a peer that was offline for a week still gets its inbox (see purgeExpired).
  if (!messageColumns.some((c) => c.name === 'stale_at')) db.exec('ALTER TABLE messages ADD COLUMN stale_at INTEGER')
  // Console P1: least privilege per agent. Empty scopes means the historical full set, so
  // existing nodes keep working after the upgrade.
  if (!agentColumns.some((c) => c.name === 'scopes')) db.exec('ALTER TABLE agents ADD COLUMN scopes TEXT')
  if (!agentColumns.some((c) => c.name === 'allowed_cidrs')) db.exec('ALTER TABLE agents ADD COLUMN allowed_cidrs TEXT')
  if (!agentColumns.some((c) => c.name === 'token_expires_at')) db.exec('ALTER TABLE agents ADD COLUMN token_expires_at INTEGER')
  if (!agentColumns.some((c) => c.name === 'token_issued_at')) db.exec('ALTER TABLE agents ADD COLUMN token_issued_at INTEGER')
  // Self-reported plugin identity: advisory only (an agent can lie), used to surface version
  // drift and compatibility hints in /api/peers and /api/status.
  if (!agentColumns.some((c) => c.name === 'plugin_name')) db.exec('ALTER TABLE agents ADD COLUMN plugin_name TEXT')
  if (!agentColumns.some((c) => c.name === 'plugin_version')) db.exec('ALTER TABLE agents ADD COLUMN plugin_version TEXT')
  if (!agentColumns.some((c) => c.name === 'plugin_platform')) db.exec('ALTER TABLE agents ADD COLUMN plugin_platform TEXT')
  if (!agentColumns.some((c) => c.name === 'plugin_reported_at')) db.exec('ALTER TABLE agents ADD COLUMN plugin_reported_at INTEGER')
  const boardColumns = db.prepare('PRAGMA table_info(board)').all()
  if (!boardColumns.some((c) => c.name === 'owner')) db.exec('ALTER TABLE board ADD COLUMN owner TEXT')
  if (!boardColumns.some((c) => c.name === 'status')) db.exec('ALTER TABLE board ADD COLUMN status TEXT')
  // Board CAS/visibility: version starts at 1 and old keys are mesh-visible.
  if (!boardColumns.some((c) => c.name === 'version')) db.exec('ALTER TABLE board ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
  if (!boardColumns.some((c) => c.name === 'visible_to')) db.exec("ALTER TABLE board ADD COLUMN visible_to TEXT NOT NULL DEFAULT '*'")
  // Blob v2: resumable upload (status uploading -> ready) and a per-blob read ACL.
  const blobColumns = db.prepare('PRAGMA table_info(blobs)').all()
  if (!blobColumns.some((c) => c.name === 'status')) db.exec("ALTER TABLE blobs ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'")
  if (!blobColumns.some((c) => c.name === 'visible_to')) db.exec("ALTER TABLE blobs ADD COLUMN visible_to TEXT NOT NULL DEFAULT '*'")
  if (!blobColumns.some((c) => c.name === 'expected_sha')) db.exec('ALTER TABLE blobs ADD COLUMN expected_sha TEXT')
  if (!blobColumns.some((c) => c.name === 'expected_bytes')) db.exec('ALTER TABLE blobs ADD COLUMN expected_bytes INTEGER')
}

const now = () => Date.now()

/** Numeric compare of dotted versions; unparseable parts count as 0. Advisory only. */
function compareVersion(left, right) {
  const parts = (value) => String(value || '').split('.').map((piece) => Number.parseInt(piece, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1
  }
  return 0
}

/** Touch an agent row, creating it on first sight. */
function touchAgent(name, host) {
  const ts = now()
  const existing = db.prepare('SELECT name, host FROM agents WHERE name = ?').get(name)
  if (existing) {
    db.prepare('UPDATE agents SET last_seen = ?, host = COALESCE(?, host) WHERE name = ?').run(ts, host ?? null, name)
  } else {
    db.prepare('INSERT INTO agents (name, host, description, first_seen, last_seen) VALUES (?, ?, NULL, ?, ?)')
      .run(name, host ?? null, ts, ts)
  }
}

function purgeExpired() {
  const ts = now()
  const cutoff = ts - MESSAGE_TTL_MS
  // Read mail ages out; unread mail is never dropped — a peer that was off the network for
  // longer than the TTL must still receive it. Mark it stale instead so the UI can say so.
  db.prepare('DELETE FROM messages WHERE created_at < ? AND read_at IS NOT NULL AND pinned = 0').run(cutoff)
  db.prepare('UPDATE messages SET stale_at = ? WHERE created_at < ? AND read_at IS NULL AND stale_at IS NULL AND pinned = 0').run(ts, cutoff)
  if (MAX_UNREAD_MESSAGES > 0) {
    const unread = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL').get().n
    if (unread > MAX_UNREAD_MESSAGES) {
      console.warn(`[mesh] WARN ${unread} unread messages exceed MESH_MAX_UNREAD_MESSAGES=${MAX_UNREAD_MESSAGES}; nothing is deleted, but peers should drain their inbox`)
    }
  }

  // board_log and audit are append-only; without this they grow for the life of the
  // NAS. Keep a time window and a row cap (whichever bites first).
  db.prepare('DELETE FROM board_log WHERE at < ?').run(ts - LOG_KEEP_MS)
  db.prepare('DELETE FROM audit WHERE at < ?').run(ts - LOG_KEEP_MS)
  for (const table of ['board_log', 'audit']) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    if (n <= LOG_KEEP_ROWS) continue
    const cutoff = db.prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1 OFFSET ?`).get(LOG_KEEP_ROWS)
    if (cutoff) db.prepare(`DELETE FROM ${table} WHERE id < ?`).run(cutoff.id)
  }
}

// ---------------------------------------------------------------- wake
const wakeRecent = new Map()

/** Validate a self-registered wake endpoint: absolute http(s) URL, bounded length. */
function wakeUrlOf(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new BadRequest('wake_url must be a string')
  const trimmed = value.trim()
  if (trimmed.length > 200) throw new BadRequest('wake_url is too long (max 200)')
  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new BadRequest('wake_url must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequest('wake_url must be http(s)')
  return url.toString()
}

/**
 * Validate a registered relay target. Only the one instance this deployment was
 * configured with is acceptable, so a caller can never turn the hub into a proxy
 * for arbitrary host services.
 */
function wakeApiOf(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new BadRequest('wake_api must be a string')
  const trimmed = value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (trimmed !== RELAY_TARGET) {
    throw new BadRequest(`wake_api must be exactly ${RELAY_TARGET} on this deployment`)
  }
  if (!RELAY_ENABLED) throw new BadRequest('relay wake is not configured on this hub')
  return trimmed
}

/** Fire the configured agent API to run one turn; never blocks and never throws. */
function relayWake(agentName, conversation, meta = {}) {
  if (!RELAY_ENABLED) return
  const ts = now()
  if (ts - (wakeRecent.get(`relay:${agentName}`) ?? 0) < WAKE_DEBOUNCE_MS) return
  wakeRecent.set(`relay:${agentName}`, ts)
  const user = `mesh:${conversation || 'default'}`
  const payload = JSON.stringify({
    model: RELAY_MODEL,
    user,
    messages: [
      {
        role: 'user',
        content:
          RELAY_PROMPT +
          (conversation ? `\n本轮 conversation：${conversation}` : '') +
          (meta.sender ? `\n发件人：${meta.sender}` : '') +
          (meta.subject ? `\n主题：${meta.subject}` : ''),
      },
    ],
  })
  fetch(`http://${RELAY_TARGET}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${RELAY_API_KEY}`,
      'content-type': 'application/json',
      // Hermes' api_server derives session identity from this header, NOT from the
      // OpenAI `user` field, so each mesh conversation gets its own Hermes session.
      'x-hermes-session-key': user,
    },
    body: payload,
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  }).catch(() => {})
}

/**
 * Best-effort "you have mail" ping to the recipient's own endpoint.
 *
 * Carries no message content (the receiver reads /api/inbox), is debounced per agent,
 * and never throws: a failed wake only means the receiver falls back to polling.
 */
function wakeAgent(agentName, conversation, meta = {}) {
  // Relay-woken agents (host-network OpenAI-compatible API) take precedence: their
  // turn carries full context, so the hub only needs to fire the request.
  const row = db.prepare('SELECT wake_url, wake_secret, wake_api FROM agents WHERE name = ?').get(agentName)
  if (!row) return
  if (row.wake_api) {
    relayWake(agentName, conversation, meta)
    return
  }
  if (!WAKE_SECRET) return
  if (!row.wake_url) return
  const ts = now()
  if (ts - (wakeRecent.get(agentName) ?? 0) < WAKE_DEBOUNCE_MS) return
  wakeRecent.set(agentName, ts)
  // conversation groups the dialogue; sender/subject let the receiver name the session
  // semantically without spending a model call on it.
  const body = JSON.stringify({
    agent: agentName,
    at: ts,
    kind: 'mesh/mail',
    ...(conversation ? { conversation } : {}),
    ...(meta.sender ? { sender: String(meta.sender).slice(0, 64) } : {}),
    ...(meta.subject ? { subject: String(meta.subject).slice(0, 120) } : {}),
    // Let the receiver's waker bind this conversation to the session that started it.
    ...(originSessionFor(conversation, agentName) ? { origin_session: originSessionFor(conversation, agentName) } : {}),
  })
  // Sign with the recipient's own secret; fall back to the deployment secret only for a
  // client that has not fetched its per-agent key yet (transitional).
  const agentSecret = row.wake_secret || ensureWakeSecret(agentName)
  const secret = agentSecret || WAKE_SECRET
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  fetch(row.wake_url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mesh-signature': `sha256=${signature}`,
      'x-mesh-timestamp': String(ts),
      'x-mesh-key': agentSecret ? 'agent' : 'global',
    },
    body,
    signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
  }).catch(() => {})
}

/**
 * The session a woken agent started this conversation from: its own latest message in the
 * conversation that carried an origin_session. Advisory only — the waker decides.
 */
function originSessionFor(conversation, agentName) {
  if (!conversation) return null
  const row = db
    .prepare('SELECT origin_session FROM messages WHERE conversation = ? AND sender = ? AND origin_session IS NOT NULL ORDER BY created_at DESC LIMIT 1')
    .get(conversation, agentName)
  return row?.origin_session ?? null
}

/** Lazily mint one wake secret per agent; the value is only ever shown to its owner. */
function ensureWakeSecret(agentName) {
  const row = db.prepare('SELECT wake_secret FROM agents WHERE name = ?').get(agentName)
  if (!row) return undefined
  if (row.wake_secret) return row.wake_secret
  const secret = randomBytes(32).toString('hex')
  db.prepare('UPDATE agents SET wake_secret = ? WHERE name = ?').run(secret, agentName)
  return secret
}

// ---------------------------------------------------------------- auth
//
// Threat model: the hub may be reachable from a work machine over a tunnel,
// so "it is only a LAN" is not a safe assumption. Design:
//   * one bearer token per agent, minted by the admin after deployment
//   * only the SHA-256 of a token is stored, so a DB leak does not leak tokens
//   * the token decides the identity; X-Mesh-Agent is ignored in token mode so
//     a caller cannot impersonate another agent by editing a header
//   * tokens can be rotated and revoked; every auth attempt is audited
//   * failed attempts are throttled per source IP
// Transport encryption (TLS/VPN) is still required; a bearer token over plain
// HTTP across a hostile network is worthless.

const hashToken = (token) => createHash('sha256').update(token).digest('hex')
const mintToken = (prefix = 'mesh') => `${prefix}_${randomBytes(32).toString('base64url')}`

const ALL_SCOPES = ['read', 'send', 'board', 'blob']
const TOOL_SCOPE = {
  mesh_send: 'send',
  mesh_board_set: 'board',
  mesh_blob_upload: 'blob',
  mesh_blob_download: 'blob',
  mesh_blob_list: 'blob',
  mesh_blob_delete: 'blob',
}

function scopesOfRow(row) {
  const raw = String(row?.scopes ?? '').trim()
  // Historical rows with an empty string predate the "empty means all" fix; keep treating
  // them as full access so a deploy does not silently break running nodes (startup warns).
  if (!raw) return ALL_SCOPES
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (parsed.includes('*')) return ALL_SCOPES
  return ALL_SCOPES.filter((scope) => parsed.includes(scope))
}

/**
 * Validates an incoming scopes update. The empty set is rejected: it used to be stored as
 * "" and read back as "all", so an admin who unchecked everything accidentally granted
 * everything. Full access must now be explicit ("*" or every scope).
 */
function parseScopesInput(raw) {
  if (raw === undefined) return { error: 'scopes is required (use ["*"] for all scopes)' }
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((value) => value.trim()).filter(Boolean)
      : null
  if (!list) return { error: 'scopes must be an array or a comma separated string' }
  if (list.length === 0) {
    return { error: '空 scope 集等于全权，已被拒绝；若要禁用该节点请吊销 token，若要全权请显式传 ["*"]（或现有全权表示）' }
  }
  const scopes = []
  for (const value of list) {
    const scope = String(value).trim()
    if (scope === '*') return { scopes: ['*'] }
    if (!ALL_SCOPES.includes(scope)) return { error: `unknown scope "${scope}" (allowed: ${ALL_SCOPES.join(', ')}, or ["*"] for all)` }
    if (!scopes.includes(scope)) scopes.push(scope)
  }
  return { scopes }
}

/**
 * Parses an optional token expiry. Accepts ISO 8601 or epoch milliseconds; omitted/null/
 * empty means "never expires" (the historical default). Past instants are allowed so an
 * admin can deliberately test expiry.
 */
function parseTokenExpiry(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null }
  let ms
  if (typeof raw === 'number') ms = raw
  else if (typeof raw === 'string') {
    const trimmed = raw.trim()
    ms = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
  } else {
    return { error: 'expires_at must be an ISO 8601 date or epoch milliseconds' }
  }
  if (!Number.isFinite(ms) || ms <= 0) return { error: 'expires_at must be a valid ISO 8601 date or epoch milliseconds' }
  return { value: Math.floor(ms) }
}

function ipInCidr(ip, cidr) {
  const [network, bitsRaw] = String(cidr).trim().split('/')
  const bits = Number(bitsRaw ?? 32)
  const toInt = (value) => {
    const parts = String(value).trim().split('.')
    if (parts.length !== 4) return null
    let result = 0
    for (const part of parts) {
      const octet = Number(part)
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
      result = (result << 8) | octet
    }
    return result >>> 0
  }
  const a = toInt(ip)
  const b = toInt(network)
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

function ipAllowed(ip, row) {
  const raw = String(row?.allowed_cidrs ?? '').trim()
  if (!raw) return true
  const list = raw.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (!list.length) return true
  return list.some((entry) => (entry.includes('/') ? ipInCidr(ip, entry) : entry === ip))
}

function bearerOf(req) {
  const auth = String(req.headers['authorization'] ?? '')
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    if (forwarded) return forwarded
  }
  return req.socket.remoteAddress ?? 'unknown'
}

// Failed-auth accounting.
//
// This is deliberately NOT an entry gate. A caller presenting a valid token is always
// served. Blocking by source IP used to lock out every agent at once when the hub sits
// behind an frp TCP tunnel (frpc forwards from 127.0.0.1, so all external clients share
// one source address) — a single port scanner could take the whole mesh down for 60s at
// a time. Now only the failing requests are slowed, and a good token clears the streak.
const failures = new Map()
function recordFailure(ip) {
  const ts = now()
  const entry = failures.get(ip)
  if (!entry || ts > entry.until) failures.set(ip, { count: 1, until: ts + FAIL_WINDOW_MS })
  else entry.count += 1
  return failures.get(ip).count > FAIL_LIMIT
}
function clearFailures(ip) {
  failures.delete(ip)
}
function sweepFailures() {
  const ts = now()
  for (const [ip, entry] of failures) if (ts > entry.until) failures.delete(ip)
}

function audit(action, agent, ip, ok) {
  try {
    db.prepare('INSERT INTO audit (at, agent, action, ip, ok) VALUES (?, ?, ?, ?, ?)').run(now(), agent ?? null, action, ip ?? null, ok ? 1 : 0)
  } catch {
    /* auditing must never break a request */
  }
}

const headerValue = (req, name) => {
  const raw = req.headers[name]
  return (Array.isArray(raw) ? raw[0] : raw)?.trim()
}

/**
 * Resolve the caller.
 *   token mode — the bearer token alone decides identity (headers are advisory)
 *   open mode  — X-Mesh-Agent names the caller; only for a LAN trusted end to end
 */
function resolveIdentity(req) {
  const ip = clientIp(req)

  if (AUTH_MODE === 'open') {
    clearFailures(ip)
    // No token, no per-agent grant: the historical full surface is the only sane default.
    return { ok: true, name: headerValue(req, 'x-mesh-agent') || 'anonymous', host: headerValue(req, 'x-mesh-host'), ip, scopes: ALL_SCOPES }
  }

  const token = bearerOf(req)
  const row = token
    ? db.prepare('SELECT name, scopes, allowed_cidrs, token_expires_at FROM agents WHERE token_hash = ?').get(hashToken(token))
    : undefined
  if (token && row) {
    clearFailures(ip)
    if (row.token_expires_at && Number(row.token_expires_at) <= now()) {
      audit('auth.expired', row.name, ip, false)
      return { ok: false, status: 401, reason: 'token expired; rotate or re-enroll this agent', ip }
    }
    if (!ipAllowed(ip, row)) {
      audit('auth.ip_blocked', row.name, ip, false)
      return { ok: false, status: 403, reason: `source address ${ip} is not in this agent's allowlist`, ip }
    }
    return { ok: true, name: row.name, host: headerValue(req, 'x-mesh-host'), ip, scopes: scopesOfRow(row) }
  }

  // Only the failing path is throttled, and only the first FAIL_LIMIT misses per
  // window are audited, so a scanner cannot flood the audit table either.
  const overLimit = recordFailure(ip)
  if (!overLimit) audit('auth', null, ip, false)
  return {
    ok: false,
    status: overLimit ? 429 : 401,
    reason: overLimit ? 'too many failed auth attempts, retry later' : token ? 'invalid token' : 'missing bearer token',
    ip,
  }
}

/**
 * Scope a REST route needs. Reads map to `read`, mailbox mutations to `send`, board
 * writes to `board`, blob transfers to `blob`. `null` means "any authenticated agent".
 *
 * Admin routes never reach here: /api/admin/* is dispatched before handleRest. The mapping
 * mirrors TOOL_SCOPE for MCP; both faces must agree or a restricted token can walk around
 * the other one.
 */
function restScope(req, path) {
  const method = req.method
  if (path === '/api/send') return 'send'
  // Registering a wake endpoint and acknowledging mail belong to the read side: they only
  // affect messages this agent is already allowed to receive.
  if (path === '/api/register' || path === '/api/read' || path === '/api/wake-secret') return 'read'
  if (path === '/api/inbox' || path === '/api/peers' || path === '/api/status') return 'read'
  if (path === '/api/board/log') return 'read'
  if (path === '/api/board') return method === 'POST' ? 'board' : 'read'
  if (path === '/api/conversations' || path === '/api/conversation' || path === '/api/message' || path === '/api/pinned') return 'read'
  if (/^\/api\/message\/[0-9a-f-]{36}\/pin$/.test(path)) return 'send'
  if (path === '/api/blob/init') return 'blob'
  if (/^\/api\/blob\/[0-9a-f-]{36}\/(chunk|commit)$/.test(path)) return 'blob'
  if (/^\/api\/blob\/[0-9a-f-]{36}(\/meta)?$/.test(path)) return method === 'GET' ? 'read' : 'blob'
  if (path === '/api/blob') return 'blob'
  if (path === '/api/blobs') return 'read'
  return null
}

function isAdmin(req) {
  const token = bearerOf(req)
  if (!ADMIN_TOKEN || !token) return false
  const given = Buffer.from(token)
  const expected = Buffer.from(ADMIN_TOKEN)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })

class BadRequest extends Error {}
class PayloadTooLarge extends Error {}

/** Reject a caller-supplied string that is not a string, or is over its byte ceiling. */
function assertText(label, value, maxBytes) {
  if (typeof value !== 'string') throw new BadRequest(`${label} must be a string`)
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > maxBytes) throw new BadRequest(`${label} is ${bytes} bytes; the limit is ${maxBytes}`)
  return value
}

/** Parse a ?limit= query value; reject junk instead of binding NaN into SQL. */
function parseLimit(raw, fallback, max) {
  if (raw === null || raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) throw new BadRequest(`limit must be an integer between 1 and ${max}`)
  return Math.min(parsed, max)
}

/** Truncate to at most maxBytes of UTF-8 without splitting a codepoint; adds … when cut. */
function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(String(text))
  if (buf.length <= maxBytes) return { value: String(text), truncated: false }
  const suffix = '…'
  let end = maxBytes - Buffer.byteLength(suffix)
  // back off continuation bytes, then drop the lead byte of the partial character
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  return { value: buf.subarray(0, end).toString('utf8') + suffix, truncated: true }
}

const DEFAULT_CLAIM_TTL_MS = 300_000

/**
 * One page of an agent's inbox. `order` asc (default) keeps the historical oldest-first
 * behaviour; desc is what a "anything new?" poll needs. `before` is an epoch-ms cursor
 * that only takes older rows, so a desc caller can walk backwards page by page.
 * Fetches limit+1 to answer has_more without a second COUNT query; nextBefore is the
 * cursor for the next older page (desc only — asc callers grow the limit instead).
 */
function fetchInboxPage(agentName, { unreadOnly = true, limit = 20, order = 'asc', before = null } = {}) {
  const descending = order === 'desc'
  const clauses = ['recipient = ?']
  const params = [agentName]
  if (unreadOnly) clauses.push('read_at IS NULL')
  if (Number.isFinite(before)) {
    clauses.push('created_at < ?')
    params.push(before)
  }
  params.push(limit + 1)
  const rows = db
    .prepare(
      `SELECT id, sender, subject, body, created_at, read_at, claimed_at, stale_at, reply_to, conversation, no_reply, pinned, interrupt, delivery_mode FROM messages
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
    )
    .all(...params)
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const nextBefore = hasMore && descending ? page[page.length - 1].created_at : null
  return { rows: page.map((row) => ({ ...row, stale: Boolean(row.stale_at) })), hasMore, nextBefore }
}

/** Build one MCP server bound to one agent identity. */
function buildServer(agentName, agentHost, publicUrl) {
  const server = new McpServer({ name: 'dsh-mesh', version: HUB_VERSION })

  const tool = (name, description, inputSchema, handler) => {
    server.registerTool(name, { description, inputSchema }, async (args, _extra) => {
      const required = TOOL_SCOPE[name]
      if (required) {
        const row = db.prepare('SELECT scopes FROM agents WHERE name = ?').get(agentName)
        const granted = scopesOfRow(row)
        if (!granted.includes(required)) {
          return { isError: true, content: [{ type: 'text', text: `${name} requires scope "${required}"; this agent has: ${granted.join(', ') || 'none'}` }] }
        }
      }
      touchAgent(agentName, agentHost)
      try {
        return text(await handler(args ?? {}))
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `${name} failed: ${error.message}` }] }
      }
    })
  }

  // Identity comes from the token; host/description come from the registry row, never
  // from the request header (clients usually do not send X-Mesh-Host, so reporting it
  // made `host` permanently null). `hub` reports the URL this caller actually reached,
  // not the listen address — 0.0.0.0 is useless to a caller.
  tool('mesh_whoami', 'Report the identity the hub associates with this caller, and the endpoint this caller used to reach the hub.', {}, () => {
    const row = db.prepare('SELECT name, host, description, last_seen FROM agents WHERE name = ?').get(agentName)
    return {
      agent: agentName,
      host: row?.host ?? agentHost ?? null,
      description: row?.description ?? null,
      last_seen: row?.last_seen ?? null,
      hub: publicUrl,
      online_ttl_seconds: ONLINE_TTL_MS / 1000,
      message_ttl_days: MESSAGE_TTL_MS / 86400000,
    }
  })

  tool(
    'mesh_register',
    'Announce or update this agent on the mesh: host machine, a one-line description, and optionally a wake_url (LAN endpoint the hub may ping when mail arrives) or wake_api (the deployment relay target, for agents exposing an OpenAI-compatible API on the hub host).',
    { host: z.string().optional(), description: z.string().optional(), wake_url: z.string().optional(), wake_api: z.string().optional() },
    ({ host, description, wake_url, wake_api }) => {
      touchAgent(agentName, host ?? agentHost)
      const wakeUrl = wakeUrlOf(wake_url)
      const wakeApi = wakeApiOf(wake_api)
      db.prepare('UPDATE agents SET host = COALESCE(?, host), description = COALESCE(?, description), wake_url = COALESCE(?, wake_url), wake_api = COALESCE(?, wake_api) WHERE name = ?')
        .run(host ?? null, description ?? null, wakeUrl, wakeApi, agentName)
      return db.prepare('SELECT name, host, description, wake_url, last_seen FROM agents WHERE name = ?').get(agentName)
    },
  )

  tool(
    'mesh_peers',
    'List every agent known to the hub with online status (a heartbeat within the TTL counts as online). Use this to find whom to talk to.',
    { include_offline: z.boolean().optional() },
    ({ include_offline }) => {
      const ts = now()
      const rows = db.prepare('SELECT name, host, description, last_seen FROM agents ORDER BY last_seen DESC').all()
      const peers = rows
        .map((r) => ({
          name: r.name,
          host: r.host,
          description: r.description,
          online: ts - r.last_seen <= ONLINE_TTL_MS,
          last_seen_seconds_ago: Math.round((ts - r.last_seen) / 1000),
          last_seen_at: new Date(r.last_seen).toISOString(),
          unread_for_them: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND read_at IS NULL').get(r.name).n,
        }))
        .filter((p) => include_offline || p.online)
      return { self: agentName, peers }
    },
  )

  tool(
    'mesh_send',
    'Send a durable message to another agent. It is stored on the hub and delivered when that agent next checks its inbox, even if the target machine is switched off. Pass `conversation` (a short id you keep for the whole dialogue) so the receiver can keep this dialogue in one session, and so replies can be grouped with it. Pass `important: true` to keep a message exempt from the 7-day message TTL (pin). Pass `no_reply: true` only for the closing message of a dialogue and only together with `reply_to`: without a reply_to the flag is ignored and the recipient is woken normally. Pass `silent: true` to store the message without waking anyone, for channels that need a human reply but must not start an agent turn (silent wins over no_reply). Pass `interrupt: true` only for a correction, cancellation or blocker: it asks the receiver to steer its running turn with this message instead of queueing it for later. Routine messages should leave it off.',
    {
      to: z.string(),
      body: z.string(),
      subject: z.string().optional(),
      reply_to: z.string().optional(),
      conversation: z.string().optional(),
      no_reply: z.boolean().optional(),
      silent: z.boolean().optional(),
      important: z.boolean().optional(),
      interrupt: z.boolean().optional(),
      session: z.string().optional(),
      delivery: z.enum(['queue', 'steer', 'branch']).optional(),
    },
    ({ to, body, subject, reply_to, conversation, no_reply, silent, important, interrupt, session, delivery }) => {
      assertText('to', to, MAX_RECIPIENT_BYTES)
      assertText('body', body, MAX_MESSAGE_BYTES)
      if (subject !== undefined) assertText('subject', subject, MAX_SUBJECT_BYTES)
      if (conversation !== undefined) assertText('conversation', conversation, MAX_CONVERSATION_BYTES)
      const replyTo = typeof reply_to === 'string' && reply_to.trim() ? reply_to : null
      const wantsSilent = silent === true
      let closing = no_reply === true ? 1 : 0
      let noReplyIgnored = false
      if (closing && !replyTo) {
        // no_reply only makes sense as "closing message of a dialogue"; without a reply_to
        // there is no dialogue to close, and dropping the wake silently loses real answers.
        closing = 0
        noReplyIgnored = true
      }
      const noWake = wantsSilent || closing === 1
      const flagged = important === true ? 1 : 0
      const urgent = interrupt === true ? 1 : 0
      const originSession = typeof session === 'string' && session.trim() ? session.trim().slice(0, 80) : null
      const extras = {}
      if (wantsSilent) extras.silent = true
      if (noReplyIgnored) {
        extras.no_reply_ignored = true
        extras.reason = 'no_reply requires reply_to (closing message only)'
      }
      if (wantsSilent && no_reply === true) extras.note = 'silent takes precedence over no_reply'
      if (to === '*') {
        // Broadcast: one durable copy per other registered agent (still per-recipient, so
        // each side reads/marks its own inbox and the wake ping stays per agent).
        const recipients = db.prepare('SELECT name FROM agents WHERE name != ?').all(agentName).map((row) => row.name)
        const insert = db.prepare('INSERT INTO messages (id, sender, recipient, subject, body, created_at, reply_to, conversation, no_reply, pinned, interrupt, origin_session, delivery_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        for (const name of recipients) {
          insert.run(randomUUID(), agentName, name, subject ?? null, body, now(), replyTo, conversation ?? null, closing, flagged, urgent, originSession, delivery ?? null)
          if (!noWake) wakeAgent(name, conversation, { sender: agentName, subject })
        }
        return {
          to: '*',
          recipients: recipients.length,
          conversation: conversation ?? null,
          no_reply: Boolean(closing),
          ...extras,
          note: extras.note ?? 'broadcast to every other registered agent',
        }
      }
      if (to === agentName) throw new Error('refusing to send a message to yourself')
      const target = db.prepare('SELECT name FROM agents WHERE name = ?').get(to)
      const id = randomUUID()
      db.prepare('INSERT INTO messages (id, sender, recipient, subject, body, created_at, reply_to, conversation, no_reply, pinned, interrupt, origin_session, delivery_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, agentName, to, subject ?? null, body, now(), replyTo, conversation ?? null, closing, flagged, urgent, originSession, delivery ?? null)
      if (!noWake) wakeAgent(to, conversation, { sender: agentName, subject })
      return {
        id,
        to,
        conversation: conversation ?? null,
        no_reply: Boolean(closing),
        ...extras,
        known_recipient: Boolean(target),
        note: extras.note ?? (closing ? 'queued as a closing message (no wake)' : target ? 'queued' : 'queued for an agent not yet registered'),
      }
    },
  )

  tool(
    'mesh_inbox',
    'Read messages addressed to this agent. Unread by default, oldest first; pass order:"desc" to read newest first. With unread_only:false the default order is desc. Set mark_read to acknowledge the returned page in the same call.',
    {
      limit: z.number().int().min(1).max(100).optional(),
      unread_only: z.boolean().optional(),
      mark_read: z.boolean().optional(),
      order: z.enum(['asc', 'desc']).optional(),
    },
    ({ limit, unread_only, mark_read, order }) => {
      const onlyUnread = unread_only ?? true
      const sortOrder = order ?? (onlyUnread ? 'asc' : 'desc')
      const page = fetchInboxPage(agentName, { unreadOnly: onlyUnread, limit: limit ?? 20, order: sortOrder })
      if (mark_read && page.rows.length) {
        const stmt = db.prepare('UPDATE messages SET read_at = ? WHERE id = ?')
        for (const row of page.rows) stmt.run(now(), row.id)
      }
      return {
        agent: agentName,
        count: page.rows.length,
        order: sortOrder,
        stale_count: page.rows.filter((row) => row.stale).length,
        has_more: page.hasMore,
        next_before: page.nextBefore,
        messages: page.rows,
      }
    },
  )

  tool('mesh_ack', 'Mark the given message ids as read.', { ids: z.array(z.string()).min(1) }, ({ ids }) => {
    const stmt = db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND recipient = ?')
    let updated = 0
    for (const id of ids) updated += Number(stmt.run(now(), id, agentName).changes ?? 0)
    return { acknowledged: updated }
  })

  tool(
    'mesh_board_set',
    'Write a shared key/value entry on the hub board. Optional owner/status turn an entry into an assignable task; if_version enables compare-and-set (mismatch returns current_version/current_value); visible_to is "*" or a comma-separated agent allowlist. Every change is also appended to the board log.',
    {
      key: z.string(),
      value: z.string(),
      owner: z.string().optional(),
      status: z.string().optional(),
      if_version: z.number().int().min(0).optional(),
      visible_to: z.string().optional(),
    },
    ({ key, value, owner, status, if_version, visible_to }) => {
      assertText('key', key, MAX_KEY_BYTES)
      assertText('value', value, MAX_BOARD_BYTES)
      if (owner !== undefined) assertText('owner', owner, MAX_RECIPIENT_BYTES)
      if (status !== undefined) assertText('status', status, 40)
      const visibleTo = visible_to === undefined ? null : visibilityOf(visible_to)
      const result = writeBoard({
        key,
        value,
        owner: owner ?? null,
        status: status ?? null,
        visibleTo,
        ifVersion: if_version ?? null,
        actor: agentName,
      })
      if (result.conflict) return { error: 'version conflict', ...result.conflict }
      return result.row
    },
  )

  tool('mesh_board_get', 'Read one shared board entry.', { key: z.string() }, ({ key }) => {
    const row = db.prepare('SELECT key, value, updated_by, updated_at, owner, status, version, visible_to FROM board WHERE key = ?').get(key)
    if (!row || !boardVisible(row, agentName, null)) return { key, found: false }
    return row
  })

  tool('mesh_board_list', 'List shared board keys, optionally filtered by prefix.', { prefix: z.string().optional() }, ({ prefix }) => {
    const rows = prefix
      ? db.prepare("SELECT key, value, updated_by, updated_at, owner, status, version, visible_to FROM board WHERE key LIKE ? ORDER BY key").all(`${prefix}%`)
      : db.prepare('SELECT key, value, updated_by, updated_at, owner, status, version, visible_to FROM board ORDER BY key').all()
    const entries = rows.filter((row) => boardVisible(row, agentName, null))
    return { count: entries.length, entries }
  })

  tool('mesh_status', 'Hub counters: agents, online agents, queued messages, board size.', {}, () => {
    const ts = now()
    const agents = db.prepare('SELECT COUNT(*) AS n FROM agents').get().n
    const online = db
      .prepare('SELECT COUNT(*) AS n FROM agents WHERE last_seen >= ?')
      .get(ts - ONLINE_TTL_MS).n
    const queued = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL').get().n
    const board = db.prepare('SELECT COUNT(*) AS n FROM board').get().n
    return { agents, online, queued_messages: queued, board_entries: board, uptime_seconds: Math.round(process.uptime()) }
  })

  return server
}

/** sessionId -> { transport, agentName, lastUsed } */
const sessions = new Map()

/** Drop expired blob payloads (and their rows) so transfers cannot fill the disk. */
function sweepBlobs() {
  const ts = now()
  const expired = db.prepare(
    "SELECT id FROM blobs WHERE expires_at <= ? OR (status = 'uploading' AND created_at <= ?)",
  ).all(ts, ts - 3600_000)
  for (const row of expired) {
    try { unlinkSync(join(BLOB_DIR, row.id)) } catch { /* already gone */ }
    db.prepare('DELETE FROM blobs WHERE id = ?').run(row.id)
  }
  if (expired.length) console.log(`[mesh] swept ${expired.length} expired blob(s)`)
}

/** Drop idle sessions: an ungraceful DSH shutdown never sends DELETE /mcp. */
function sweepSessions() {
  const ts = now()
  for (const [sid, entry] of sessions) {
    if (ts - entry.lastUsed <= SESSION_IDLE_MS) continue
    sessions.delete(sid)
    // Closing the transport fires onclose, which would delete the persisted row; the
    // whole point of mcp_sessions is to survive exactly this sweep, so detach it first.
    try {
      entry.transport.onclose = undefined
    } catch {
      /* already detached */
    }
    try {
      Promise.resolve(entry.transport.close()).catch(() => {})
    } catch {
      /* already closed */
    }
  }
  // Persisted rows outlive the in-memory map on purpose (restart recovery); drop the
  // ones nobody came back for after the longer TTL.
  db.prepare('DELETE FROM mcp_sessions WHERE last_used <= ?').run(ts - MCP_SESSION_TTL_MS)
}

/**
 * Resolve the session named by Mcp-Session-Id, refusing one that belongs to another
 * agent: the id alone must never be enough to act as somebody else.
 */
function rememberSession(sid, agentName) {
  const ts = now()
  db.prepare('INSERT INTO mcp_sessions (sid, agent, created_at, last_used) VALUES (?,?,?,?) ON CONFLICT(sid) DO UPDATE SET last_used = excluded.last_used').run(sid, agentName, ts, ts)
}

function forgetSession(sid) {
  try { db.prepare('DELETE FROM mcp_sessions WHERE sid = ?').run(sid) } catch { /* ignore */ }
}

/**
 * Rebuild an in-memory transport for a session id the hub knows from SQLite (or, in
 * lenient mode, for any id). The MCP SDK only needs `sessionId` + `_initialized` on the
 * transport; the tool registry is rebuilt by buildServer(), so no handshake is lost.
 */
async function rebuildSession(sid, agentName, host, publicUrl) {
  const server = buildServer(agentName, host, publicUrl)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sid,
    enableJsonResponse: true,
  })
  const raw = transport._webStandardTransport
  if (raw) {
    raw.sessionId = sid
    raw._initialized = true
  }
  transport.onclose = () => {
    sessions.delete(sid)
    forgetSession(sid)
  }
  await server.connect(transport)
  sessions.set(sid, { transport, agentName, lastUsed: now() })
  rememberSession(sid, agentName)
  return transport
}

function sessionFor(req, agentName) {
  const sid = req.headers['mcp-session-id']
  if (typeof sid !== 'string' || !sid) return { status: 400, error: 'missing Mcp-Session-Id header' }
  const entry = sessions.get(sid)
  if (!entry) return { status: 404, error: 'unknown session' }
  if (entry.agentName !== agentName) return { status: 403, error: 'session belongs to a different agent' }
  entry.lastUsed = now()
  return { entry }
}

async function handleMcp(req, res, body) {
  const id = resolveIdentity(req)
  if (!id.ok) {
    res.writeHead(id.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: id.reason } }))
    return
  }
  touchAgent(id.name, id.host)

  const sid = req.headers['mcp-session-id']
  const existing = typeof sid === 'string' ? sessions.get(sid) : undefined

  if (existing) {
    if (existing.agentName !== id.name) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'session belongs to a different agent' } }))
      return
    }
    existing.lastUsed = now()
    await existing.transport.handleRequest(req, res, body)
    return
  }

  if (typeof sid === 'string' && sid) {
    // A session the in-memory map lost (hub restart, or sweep). Two ways to recover:
    //   A. the id is in mcp_sessions and belongs to this agent -> rebuild it (no handshake);
    //   B. lenient mode -> rebuild whatever id the client presents.
    // Otherwise answer 404 per the MCP spec so a well-behaved client re-initializes.
    const known = db.prepare('SELECT agent FROM mcp_sessions WHERE sid = ?').get(sid)
    if (known && known.agent !== id.name) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'session belongs to a different agent' } }))
      return
    }
    if (known || MCP_LENIENT_SESSION) {
      if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'hub session limit reached, retry shortly' } }))
        return
      }
      const publicUrl = process.env.MESH_PUBLIC_URL || `${TLS_ENABLED ? 'https' : 'http'}://${String(req.headers.host ?? '').trim() || `${HOST}:${PORT}`}/mcp`
      const rebuilt = await rebuildSession(sid, id.name, id.host, publicUrl)
      console.log(`[mesh] rebuilt MCP session ${sid.slice(0, 8)} for ${id.name}${known ? '' : ' (lenient)'}`)
      await rebuilt.handleRequest(req, res, body)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unknown or expired session; re-initialize' } }))
    return
  }

  if (sessions.size >= MAX_SESSIONS) {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'hub session limit reached, retry shortly' } }))
    return
  }

  // The URL the caller used is the only honest answer to "where is the hub": the
  // listen address (0.0.0.0) means nothing to a remote agent. Behind a TLS-terminating
  // tunnel/proxy where the request scheme differs from the outside one, set
  // MESH_PUBLIC_URL to pin the address agents should remember.
  const hostHeader = String(req.headers.host ?? '').trim()
  const publicUrl = process.env.MESH_PUBLIC_URL || `${TLS_ENABLED ? 'https' : 'http'}://${hostHeader || `${HOST}:${PORT}`}/mcp`

  // New session: bind a fresh server to this caller's identity.
  const server = buildServer(id.name, id.host, publicUrl)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSid) => {
      sessions.set(newSid, { transport, agentName: id.name, lastUsed: now() })
      rememberSession(newSid, id.name)
    },
    enableJsonResponse: true,
  })
  transport.onclose = () => {
    const closedSid = transport.sessionId
    if (closedSid) {
      sessions.delete(closedSid)
      forgetSession(closedSid)
    }
  }
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

/**
 * Plain REST face, for agents that are not MCP clients (Hermes, cron jobs,
 * curl, shell scripts). Same store, same identity header, no protocol required.
 *
 *   POST /api/send      {to, body, subject?, reply_to?}
 *   GET  /api/inbox     ?unread=1&limit=20&mark_read=1
 *   GET  /api/peers     ?offline=1
 *   POST /api/register  {host?, description?}
 *   POST /api/board     {key, value}
 *   GET  /api/board     ?key=... | ?prefix=...
 *   GET  /api/status
 */
/** Read a request body with a hard ceiling, so a big payload cannot be buffered. */
async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new PayloadTooLarge(`request body exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, limit = MAX_BODY_BYTES) {
  const raw = await readBody(req, limit)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new BadRequest('body is not valid JSON')
  }
}

function sendJson(res, status, payload, headers) {
  res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) })
  res.end(JSON.stringify(payload))
}

/** Blob visibility: "*" (whole mesh) or a comma-separated agent allowlist. */
function visibilityOf(value) {
  if (value === undefined || value === null || value === '') return '*'
  const raw = String(value).trim()
  if (raw === '*') return '*'
  const names = raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,32}$/.test(s))
  if (!names.length) throw new BadRequest('visible_to must be "*" or a comma-separated agent list')
  return [...new Set(names)].join(',')
}

/** Who may read this board key: everyone ("*"), an allowlisted agent, or an admin. */
function boardVisible(row, agentName, req) {
  if (!row) return false
  if (req && isAdmin(req)) return true
  const visible = String(row.visible_to || '*')
  return visible === '*' || visible.split(',').includes(agentName)
}

/**
 * Compare-and-set board write shared by REST and MCP. Returns {row} on success or
 * {conflict:{current_version,current_value}} when ifVersion does not match.
 */
function writeBoard({ key, value, owner, status, visibleTo, ifVersion, actor }) {
  const existing = db.prepare('SELECT key, value, version, visible_to FROM board WHERE key = ?').get(key)
  if (!existing && ifVersion !== null && ifVersion !== 0) {
    return { conflict: { current_version: 0, current_value: null } }
  }
  if (existing && ifVersion !== null && ifVersion !== existing.version) {
    return { conflict: { current_version: existing.version, current_value: existing.value } }
  }
  const ts = now()
  if (existing) {
    db.prepare(
      'UPDATE board SET value = ?, updated_by = ?, updated_at = ?, owner = COALESCE(?, owner), status = COALESCE(?, status), version = version + 1, visible_to = COALESCE(?, visible_to) WHERE key = ?',
    ).run(value, actor, ts, owner, status, visibleTo, key)
  } else {
    db.prepare('INSERT INTO board (key, value, updated_by, updated_at, owner, status, version, visible_to) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run(key, value, actor, ts, owner, status, visibleTo ?? '*')
  }
  db.prepare('INSERT INTO board_log (key, value, actor, at) VALUES (?, ?, ?, ?)').run(key, value, actor, ts)
  const row = db.prepare('SELECT key, value, updated_by, updated_at, owner, status, version, visible_to FROM board WHERE key = ?').get(key)
  return { row }
}
function blobReadable(row, agentName, req) {
  if (isAdmin(req)) return true
  if (row.uploader === agentName) return true
  const visible = String(row.visible_to || '*')
  return visible === '*' || visible.split(',').includes(agentName)
}


// ---------------------------------------------------------------- read-only console
// A single page served by the hub itself: no assets, no build step, no write endpoints.
// Login exchanges the view token for an HttpOnly cookie; mutating operations stay in the
// DSH plugin, which already runs on the trusted machine with an owner-only token file.
const consoleSessions = new Map()
const consoleFailures = new Map()
const CONSOLE_SESSION_MS = 12 * 60 * 60 * 1000

function parseCookies(req) {
  const jar = {}
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return jar
}

function consoleAllowed(ip) {
  const entries = CONSOLE_ALLOW
    ? CONSOLE_ALLOW.split(',').map((entry) => entry.trim()).filter(Boolean)
    : ['127.0.0.1', '::1']
  return entries.some((entry) => (entry.includes('/') ? ipInCidr(ip, entry) : entry === ip))
}

function tokenMatches(offered, expected) {
  return Boolean(expected) && offered.length === expected.length && timingSafeEqual(Buffer.from(offered), Buffer.from(expected))
}

/** Returns { role: 'admin' | 'view', csrf } or null. */
function consoleAuthorized(req) {
  const header = String(req.headers.authorization ?? '')
  if (header.startsWith('Bearer ')) {
    const offered = header.slice(7).trim()
    if (tokenMatches(offered, ADMIN_TOKEN)) return { role: 'admin', csrf: null }
    if (tokenMatches(offered, VIEW_TOKEN)) return { role: 'view', csrf: null }
    return null
  }
  const session = parseCookies(req).mesh_console
  if (!session) return null
  const record = consoleSessions.get(session)
  if (!record) return null
  if (record.expires < Date.now()) {
    consoleSessions.delete(session)
    return null
  }
  return record
}

function csrfOk(req, auth) {
  if (auth.role !== 'admin') return false
  if (!auth.csrf) return true // bearer admin: no ambient cookie, nothing to forge
  const offered = String(req.headers['x-mesh-csrf'] ?? '')
  return offered.length === auth.csrf.length && timingSafeEqual(Buffer.from(offered), Buffer.from(auth.csrf))
}

function sendHtml(res, status, body, extraHeaders) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
    ...(extraHeaders ?? {}),
  })
  res.end(body)
}

const CONSOLE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.55 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
       background: #f6f7f9; color: #1c1f23; }
@media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e8eb; } .card { background: #1f2227 !important; border-color: #2c3036 !important; } th { color: #9aa0a6 !important; } td, th { border-color: #2c3036 !important; } input, select { background: #1f2227; color: #e6e8eb; border-color: #2c3036; } }
main { max-width: 1040px; margin: 0 auto; padding: 28px 20px 60px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: #6b7280; font-size: 12.5px; margin-bottom: 22px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px; }
.card .k { font-size: 12px; color: #6b7280; }
.card .v { font-size: 22px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
h2 { font-size: 14px; margin: 26px 0 10px; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #eef0f2; font-size: 13px; vertical-align: top; }
th { color: #6b7280; font-weight: 600; font-size: 12px; }
tr:last-child td { border-bottom: none; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11.5px; border: 1px solid transparent; }
.ok { color: #15803d; background: #dcfce7; border-color: #bbf7d0; }
.warn { color: #b45309; background: #fef3c7; border-color: #fde68a; }
.off { color: #6b7280; background: #f1f3f5; border-color: #e5e7eb; }
form.inline { display: inline-block; margin: 0 6px 0 0; }
input[type=password], input[type=text] { padding: 7px 10px; border-radius: 8px; border: 1px solid #d1d5db; font-size: 13px; }
button { margin-top: 6px; padding: 6px 12px; border-radius: 8px; border: 1px solid #111827;
         background: #111827; color: #fff; font-size: 13px; cursor: pointer; }
button.danger { background: #b91c1c; border-color: #b91c1c; }
.token { font-family: ui-monospace, Consolas, monospace; font-size: 13px; padding: 10px 12px;
         background: #f1f3f5; border: 1px dashed #9ca3af; border-radius: 8px; word-break: break-all; }
.err { color: #b91c1c; margin: 8px 0 0; font-size: 13px; }
.muted { color: #6b7280; font-size: 12px; }
`

function consoleLoginPage(error) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-mesh 控制台</title>
<style>${CONSOLE_STYLE}</style></head><body><main>
<h1>dsh-mesh 控制台</h1>
<p class="sub">只读令牌：看状态 · 管理员令牌：可铸令牌、改权限、吊销节点。登录后可在右上角「退出 / 切换令牌」换角色。</p>
<form method="post" action="/console/login">
  <input type="password" name="token" placeholder="view / admin token" autocomplete="current-password" autofocus>
  <button type="submit">进入</button>
  ${error ? `<p class="err">${error}</p>` : ''}
</form>
</main></body></html>`
}

function consoleTokenPage(title, name, token, note) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title><style>${CONSOLE_STYLE}</style></head><body><main>
<h1>${title}</h1>
<p class="sub">${note}</p>
<p class="muted">agent: <b>${name}</b></p>
<p class="token">${token}</p>
<p class="muted">只显示这一次，中枢只保存 SHA-256。写进节点侧 <code>~/.dsh/mesh-waker/token</code> 后重载插件。</p>
<p><a href="/console">返回控制台</a></p>
</main></body></html>`
}

function consolePage(auth) {
  const csrf = auth.csrf ?? ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-mesh 控制台</title>
<style>${CONSOLE_STYLE}</style></head><body><main>
<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
<h1>dsh-mesh 控制台 <span class="badge ${auth.role === 'admin' ? 'ok' : 'off'}">${auth.role === 'admin' ? '管理员' : '只读'}</span></h1>
<form method="post" action="/console/logout" style="margin:0">
  <button type="submit">退出 / 切换令牌</button>
</form>
</div>
<p class="sub" id="sub">加载中…</p>
${auth.role === 'admin' ? '' : '<p class="muted">只读会话：需要轮换令牌、改 scopes、改 IP 白名单时，点右上角「退出 / 切换令牌」用管理员令牌重新登录。</p>'}
<div class="grid" id="cards"></div>
<h2>成员与插件版本</h2>
<table><thead><tr><th>agent</th><th>状态</th><th>插件</th><th>版本</th><th>兼容</th><th>最后活动</th></tr></thead>
<tbody id="peers"></tbody></table>

<h2>节点权限与令牌</h2>
<p class="muted">scope：read（读消息/黑板）· send（发消息）· board（写黑板）· blob（文件）。IP 白名单留空=不限；填 CIDR 用逗号分隔。</p>
<table><thead><tr><th>agent</th><th>scopes</th><th>IP 白名单</th><th>令牌过期</th><th>最后活动</th><th>操作</th></tr></thead>
<tbody id="agents"></tbody></table>
<p class="muted" id="adminNote"></p>

<h2>新节点配对</h2>
<p class="muted">注册码 10 分钟有效、单次使用。也可以让新节点自己发起设备码，由你在这里批准。</p>
${auth.role === 'admin' ? '<button type="button" id="genEnroll">生成注册码</button>' : '<p class="muted">只读会话：用管理员令牌登录后可生成注册码或批准设备。</p>'}
<div id="enrollOut" style="display:none; margin-top:10px">
  <div class="token" id="enrollCode" style="font-size:26px; letter-spacing:4px; display:inline-block"></div>
  <span class="muted" id="enrollMeta"></span>
  <button type="button" id="copyEnroll" style="margin-left:8px">复制码</button>
  <pre class="token" id="enrollCmds" style="white-space:pre-wrap; margin-top:10px"></pre>
  <p class="muted">token 只返回一次；落盘 0600；配置 tokenFile 后重载插件。</p>
</div>
<h3 style="font-size:13px;margin-top:20px">待批准设备</h3>
<table><thead><tr><th>用户码</th><th>请求名</th><th>主机</th><th>请求时间</th><th>剩余</th><th>操作</th></tr></thead>
<tbody id="pending"></tbody></table>
<p class="muted" id="pendingEmpty" style="display:none">暂无待配对设备</p>

<h2>审计（最近 20 条）</h2>
<table><thead><tr><th>时间</th><th>agent</th><th>动作</th><th>结果</th></tr></thead>
<tbody id="audit"></tbody></table>
<script>
const ROLE = ${JSON.stringify(auth.role)};
const CSRF = ${JSON.stringify(csrf)};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const card = (label, value) => '<div class="card"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value) + '</div></div>';
const ALL_SCOPES = ['read', 'send', 'board', 'blob'];
const HUB = location.origin;
let enrollTimer = null;
let enrollExpires = 0;
function fmtClock(seconds) {
  const safe = Math.max(0, Math.round(seconds));
  return Math.floor(safe / 60) + ' 分 ' + String(safe % 60).padStart(2, '0') + ' 秒';
}
function humanAgo(ms) {
  if (!Number.isFinite(ms)) return '未知';
  const minutes = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.floor(hours / 24) + ' 天前';
}
function absTime(ms) {
  const value = new Date(ms);
  if (Number.isNaN(value.getTime())) return '未知';
  const pad = (n) => String(n).padStart(2, '0');
  return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate()) + ' ' +
    pad(value.getHours()) + ':' + pad(value.getMinutes()) + ':' + pad(value.getSeconds());
}
function copyText(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } catch (error) { window.prompt('复制失败，请手动复制：', text); }
  area.remove();
}
async function post(path, payload) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mesh-csrf': CSRF }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { alert(data.error || ('HTTP ' + response.status)); return null; }
  return data;
}
async function refresh() {
  try {
    const [overview, peers, audit, agents, pending] = await Promise.all([
      fetch('/console/api/overview').then((r) => r.json()),
      fetch('/console/api/peers').then((r) => r.json()),
      fetch('/console/api/audit?limit=20').then((r) => r.json()),
      fetch('/console/api/agents').then((r) => r.json()),
      fetch('/console/enroll/pending').then((r) => r.json()),
    ]);
    document.getElementById('sub').textContent =
      '中枢 ' + (overview.hub?.version ?? '?') + ' · 最低要求 waker ' + (overview.hub?.min_waker ?? '?') +
      ' · 更新于 ' + new Date().toLocaleTimeString();
    document.getElementById('cards').innerHTML = [
      card('在线 / 总数', (overview.online ?? 0) + ' / ' + (overview.agents ?? 0)),
      card('未读消息', overview.queued_messages ?? 0),
      card('黑板条目', overview.board_entries ?? 0),
      card('Blob', (overview.blobs?.n ?? 0) + ' 个 / ' + Math.round((overview.blobs?.bytes ?? 0) / 1048576) + ' MiB'),
      card('运行时长', Math.round((overview.uptime_seconds ?? 0) / 3600) + ' 小时'),
    ].join('');
    document.getElementById('peers').innerHTML = (peers.peers || []).map((p) => {
      const plugin = p.plugin || {};
      const seen = p.last_seen_at ? Date.parse(p.last_seen_at) : Date.now() - (p.last_seen_seconds_ago ?? 0) * 1000;
      const compat = plugin.compat === 'ok' ? '<span class="badge ok">ok</span>'
        : plugin.compat === 'outdated' ? '<span class="badge warn">outdated</span>'
        : '<span class="badge off">未上报</span>';
      return '<tr><td>' + esc(p.name) + '</td>' +
        '<td>' + (p.online ? '<span class="badge ok">在线</span>' : '<span class="badge off">离线</span>') + '</td>' +
        '<td>' + esc(plugin.name || '—') + '</td><td>' + esc(plugin.version || '—') + '</td>' +
        '<td>' + compat + '</td><td title="' + esc(absTime(seen)) + '">' + esc(humanAgo(seen)) + '</td></tr>';
    }).join('');
    const isAdmin = ROLE === 'admin';
    document.getElementById('agents').innerHTML = (agents.agents || []).map((a) => {
      const granted = a.scopes || ALL_SCOPES;
      const none = !ALL_SCOPES.some((scope) => granted.includes(scope));
      const scopeBoxes = ALL_SCOPES.map((scope) =>
        '<label style="margin-right:6px"><input type="checkbox" data-scope="' + scope + '" ' +
        (granted.includes(scope) ? 'checked' : '') + (isAdmin ? '' : ' disabled') + '> ' + scope + '</label>'
      ).join('') + '<div class="scope-hint muted" style="margin-top:4px">' +
        (none ? '未选择任何 scope ≠ 无权限，等于全部权限；请显式勾选或使用吊销' : '') + '</div>';
      const cidrs = '<input type="text" data-cidrs value="' + esc((a.allowed_cidrs || '')) + '" placeholder="192.168.1.0/24,10.0.0.0/8" size="22"' + (isAdmin ? '' : ' disabled') + '>';
      const expiryText = a.token_expires_at ? new Date(a.token_expires_at).toLocaleString() : '永久';
      const expiryInput = isAdmin
        ? '<div style="margin-top:4px"><input type="datetime-local" data-expiry value="' +
          (a.token_expires_at ? new Date(a.token_expires_at).toISOString().slice(0, 16) : '') +
          '" style="width:170px"> <button data-act="expiry">设置</button></div>'
        : '';
      const seen = a.last_seen_at ? Date.parse(a.last_seen_at) : a.last_seen;
      const actions = isAdmin
        ? '<button data-act="save"' + (none ? ' disabled' : '') + '>保存</button> ' +
          '<button data-act="rotate" class="danger">轮换</button> ' +
          '<button data-act="revoke" class="danger">吊销</button>' +
          (!a.has_token && !a.online ? ' <button data-act="purge" class="danger">清理</button>' : '')
        : '<span class="muted">只读</span>';
      return '<tr data-name="' + esc(a.name) + '"><td>' + esc(a.name) + '</td><td>' + scopeBoxes + '</td>' +
        '<td>' + cidrs + '</td><td>' + esc(expiryText) + expiryInput + '</td>' +
        '<td title="' + esc(absTime(seen)) + '">' + esc(humanAgo(seen)) + '</td><td>' + actions + '</td></tr>';
    }).join('');
    document.getElementById('adminNote').textContent = isAdmin
      ? '管理员会话：可直接改权限；轮换/吊销会立即影响对应节点。'
      : '只读会话：如需修改权限或令牌，请用管理员令牌登录。';
    renderPending(pending);
    document.getElementById('audit').innerHTML = (audit.entries || []).map((row) =>
      '<tr><td>' + esc(new Date(row.at).toLocaleTimeString()) + '</td><td>' + esc(row.agent || '—') + '</td>' +
      '<td>' + esc(row.action) + '</td><td>' + (row.ok ? '<span class="badge ok">ok</span>' : '<span class="badge warn">fail</span>') + '</td></tr>'
    ).join('');
  } catch (error) {
    document.getElementById('sub').textContent = '读取失败：' + error.message;
  }
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const row = button.closest('tr');
  const name = row.getAttribute('data-name');
  const act = button.getAttribute('data-act');
  if (act === 'save') {
    const scopes = [...row.querySelectorAll('input[data-scope]')].filter((box) => box.checked).map((box) => box.dataset.scope);
    const hint = row.querySelector('.scope-hint');
    if (!scopes.length) {
      if (hint) hint.textContent = '未选择任何 scope ≠ 无权限，等于全部权限；请显式勾选或使用吊销';
      return;
    }
    const cidrs = row.querySelector('input[data-cidrs]').value;
    const result = await post('/console/agents/update', { name, scopes, allowed_cidrs: cidrs });
    if (result) refresh();
  }
  if (act === 'expiry') {
    const raw = row.querySelector('input[data-expiry]').value;
    const result = await post('/console/agents/expiry', { name, expires_at: raw || null });
    if (result) refresh();
  }
  if (act === 'rotate') {
    if (!confirm('轮换 ' + name + ' 的令牌？旧令牌立即失效。')) return;
    const result = await post('/console/agents/rotate', { name });
    if (result) { alert('新令牌（只显示一次）：\\n\\n' + result.token); refresh(); }
  }
  if (act === 'revoke') {
    if (!confirm('吊销 ' + name + '？该节点将无法认证，需重新注册。')) return;
    const result = await post('/console/agents/revoke', { name });
    if (result) refresh();
  }
  if (act === 'purge') {
    if (!confirm('清理 ' + name + '？会连记录一起删除，不可恢复。')) return;
    const result = await post('/console/agents/purge', { name });
    if (result) refresh();
  }
});
document.addEventListener('change', (event) => {
  if (!event.target.matches('input[data-scope]')) return;
  const row = event.target.closest('tr');
  const boxes = [...row.querySelectorAll('input[data-scope]')];
  const none = boxes.every((box) => !box.checked);
  const button = row.querySelector('button[data-act="save"]');
  if (button) button.disabled = none;
  const hint = row.querySelector('.scope-hint');
  if (hint) hint.textContent = none ? '未选择任何 scope ≠ 无权限，等于全部权限；请显式勾选或使用吊销' : '';
});
async function generateEnroll() {
  const data = await post('/console/enroll-code', {});
  if (!data) return;
  document.getElementById('enrollOut').style.display = 'block';
  document.getElementById('enrollCode').textContent = data.code;
  enrollExpires = Date.now() + (data.expires_in_seconds || 600) * 1000;
  const cmds = [
    '# 1) 用注册码换 token（token 只返回一次）',
    "curl -s -X POST " + HUB + "/api/enroll -H 'content-type: application/json' -d '{\\"code\\":\\"" + data.code + "\\",\\"name\\":\\"<节点名>\\"}'",
    '',
    '# 2) 把返回的 token 落盘（0600）',
    'umask 077; mkdir -p ~/.dsh/mesh-waker; cat > ~/.dsh/mesh-waker/token',
    '',
    '# 3) 验证 token',
    'curl -s -H "Authorization: Bearer $(cat ~/.dsh/mesh-waker/token)" ' + HUB + '/api/status',
  ].join('\\n');
  document.getElementById('enrollCmds').textContent = cmds;
  renderEnrollMeta();
  clearInterval(enrollTimer);
  enrollTimer = setInterval(renderEnrollMeta, 1000);
}
function renderEnrollMeta() {
  const left = enrollExpires - Date.now();
  const meta = document.getElementById('enrollMeta');
  if (!meta) return;
  if (left <= 0) { meta.textContent = '已过期'; clearInterval(enrollTimer); return; }
  meta.textContent = '剩余 ' + fmtClock(left / 1000);
}
function renderPending(pending) {
  const rows = pending.pending || [];
  document.getElementById('pending').innerHTML = rows.map((p) => {
    const left = Math.max(0, Math.round(((p.expires_at || 0) - Date.now()) / 1000));
    const actions = ROLE === 'admin'
      ? '<button data-enroll="approve" data-code="' + esc(p.user_code) + '">批准</button> ' +
        '<button data-enroll="deny" data-code="' + esc(p.user_code) + '" class="danger">拒绝</button>'
      : '<span class="muted">只读</span>';
    return '<tr><td><code>' + esc(p.user_code) + '</code></td><td>' + esc(p.name || '—') + '</td>' +
      '<td>' + esc(p.host || '—') + '</td><td>' + esc(new Date(p.created_at).toLocaleTimeString()) + '</td>' +
      '<td>' + fmtClock(left) + '</td><td>' + actions + '</td></tr>';
  }).join('');
  document.getElementById('pendingEmpty').style.display = rows.length ? 'none' : 'block';
}
document.addEventListener('click', async (event) => {
  if (event.target.closest('#genEnroll')) { generateEnroll(); return; }
  if (event.target.closest('#copyEnroll')) { copyText(document.getElementById('enrollCode').textContent); return; }
  const decide = event.target.closest('button[data-enroll]');
  if (!decide) return;
  const act = decide.getAttribute('data-enroll');
  const code = decide.getAttribute('data-code');
  const result = await post('/console/enroll/' + act, { user_code: code });
  if (result) refresh();
});

refresh();
setInterval(refresh, 15000);
</script>
</main></body></html>`
}

async function handleConsole(req, res, url) {
  if (!VIEW_TOKEN) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"console disabled: set MESH_VIEW_TOKEN (or MESH_ADMIN_TOKEN)"}')
    return
  }
  const ip = clientIp(req)
  if (!consoleAllowed(ip)) {
    audit('console_blocked', null, ip, false)
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('console is not reachable from this address (MESH_CONSOLE_ALLOW)')
    return
  }
  const path = url.pathname

  if (path === '/console/login' && req.method === 'POST') {
    const raw = (await readBody(req, 4096)).toString('utf8')
    const offered = new URLSearchParams(raw).get('token') ?? ''
    const record = consoleFailures.get(ip) ?? { count: 0, until: 0 }
    if (record.until > Date.now()) {
      sendHtml(res, 429, consoleLoginPage('尝试过于频繁，请稍后再试'))
      return
    }
    const role = tokenMatches(offered, ADMIN_TOKEN) ? 'admin' : tokenMatches(offered, VIEW_TOKEN) ? 'view' : null
    if (!role) {
      record.count += 1
      if (record.count >= 5) {
        record.count = 0
        record.until = Date.now() + 60_000
      }
      consoleFailures.set(ip, record)
      audit('console_login', null, ip, false)
      sendHtml(res, 401, consoleLoginPage('令牌不正确'))
      return
    }
    const session = randomBytes(24).toString('hex')
    consoleSessions.set(session, { expires: Date.now() + CONSOLE_SESSION_MS, role, csrf: randomBytes(16).toString('hex') })
    audit(role === 'admin' ? 'console_login_admin' : 'console_login', null, ip, true)
    sendHtml(res, 303, '', {
      location: '/console',
      'set-cookie': `mesh_console=${session}; HttpOnly; SameSite=Strict; Path=/console; Max-Age=${CONSOLE_SESSION_MS / 1000}`,
    })
    return
  }

  if (path === '/console/logout' && req.method === 'POST') {
    const session = parseCookies(req).mesh_console
    if (session) consoleSessions.delete(session)
    sendHtml(res, 303, '', { location: '/console', 'set-cookie': 'mesh_console=; HttpOnly; SameSite=Strict; Path=/console; Max-Age=0' })
    return
  }

  if (path === '/console' && req.method === 'GET') {
    const auth = consoleAuthorized(req)
    if (!auth) {
      sendHtml(res, 401, consoleLoginPage(''))
      return
    }
    sendHtml(res, 200, consolePage(auth))
    return
  }

  if (path.startsWith('/console/api/') && req.method === 'GET') {
    const auth = consoleAuthorized(req)
    if (!auth) return sendJson(res, 401, { error: 'unauthorized' })
    if (path === '/console/api/overview') {
      const ts = Date.now()
      const blobStats = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM blobs').get()
      return sendJson(res, 200, {
        hub: { version: HUB_VERSION, min_waker: MIN_WAKER },
        agents: db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
        online: db.prepare('SELECT COUNT(*) AS n FROM agents WHERE last_seen >= ?').get(ts - ONLINE_TTL_MS).n,
        queued_messages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL').get().n,
        board_entries: db.prepare('SELECT COUNT(*) AS n FROM board').get().n,
        blobs: blobStats,
        uptime_seconds: Math.round(process.uptime()),
        role: auth.role,
      })
    }
    if (path === '/console/api/peers') {
      const ts = Date.now()
      const rows = db
        .prepare('SELECT name, host, description, last_seen, plugin_name, plugin_version, plugin_platform FROM agents ORDER BY last_seen DESC')
        .all()
      return sendJson(res, 200, {
        hub: { version: HUB_VERSION, min_waker: MIN_WAKER },
        peers: rows.map((r) => ({
          name: r.name,
          host: r.host,
          online: ts - r.last_seen <= ONLINE_TTL_MS,
          last_seen_seconds_ago: Math.round((ts - r.last_seen) / 1000),
          last_seen_at: new Date(r.last_seen).toISOString(),
          plugin: r.plugin_version
            ? { name: r.plugin_name, version: r.plugin_version, platform: r.plugin_platform,
                compat: compareVersion(r.plugin_version, MIN_WAKER) >= 0 ? 'ok' : 'outdated' }
            : null,
        })),
      })
    }
    if (path === '/console/api/agents') {
      const rows = db.prepare('SELECT name, host, scopes, allowed_cidrs, token_expires_at, token_issued_at, last_seen, token_hash FROM agents ORDER BY name').all()
      return sendJson(res, 200, {
        agents: rows.map((r) => ({
          name: r.name,
          host: r.host,
          scopes: scopesOfRow(r),
          allowed_cidrs: r.allowed_cidrs ?? '',
          token_expires_at: r.token_expires_at ?? null,
          token_issued_at: r.token_issued_at ?? null,
          has_token: Boolean(r.token_hash),
          last_seen: r.last_seen,
          last_seen_at: new Date(r.last_seen).toISOString(),
          online: Date.now() - r.last_seen <= ONLINE_TTL_MS,
        })),
      })
    }
    if (path === '/console/api/audit') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
      const rows = db.prepare('SELECT at, agent, action, ok FROM audit ORDER BY at DESC LIMIT ?').all(limit)
      return sendJson(res, 200, { entries: rows })
    }
    return sendJson(res, 404, { error: 'unknown console endpoint' })
  }

  if (path.startsWith('/console/agents/') && req.method === 'POST') {
    const auth = consoleAuthorized(req)
    if (!auth || auth.role !== 'admin') return sendJson(res, 403, { error: 'admin role required' })
    if (!csrfOk(req, auth)) return sendJson(res, 403, { error: 'bad csrf token' })
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return sendJson(res, 400, { error: error.message })
    }
    const name = String(body.name ?? '').trim()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return sendJson(res, 400, { error: 'invalid agent name' })
    const action = path.slice('/console/agents/'.length)
    if (action === 'update') {
      const parsedScopes = parseScopesInput(body.scopes)
      if (parsedScopes.error) return sendJson(res, 400, { error: parsedScopes.error })
      const scopes = parsedScopes.scopes
      const cidrs = String(body.allowed_cidrs ?? '').trim()
      if (cidrs && !cidrs.split(',').every((entry) => /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(entry.trim()))) {
        return sendJson(res, 400, { error: 'allowed_cidrs must be comma separated IPv4 or IPv4/CIDR' })
      }
      const stored = scopes.includes('*') ? '*' : scopes.join(',')
      db.prepare('UPDATE agents SET scopes = ?, allowed_cidrs = ? WHERE name = ?').run(stored, cidrs || null, name)
      audit('console.scopes', name, ip, true)
      return sendJson(res, 200, { ok: true, name, scopes: scopes.includes('*') ? ALL_SCOPES : scopes, stored, allowed_cidrs: cidrs })
    }
    if (action === 'expiry') {
      const expiry = parseTokenExpiry(body.expires_at)
      if (expiry.error) return sendJson(res, 400, { error: expiry.error })
      const result = db.prepare('UPDATE agents SET token_expires_at = ? WHERE name = ?').run(expiry.value, name)
      if (!Number(result.changes ?? 0)) return sendJson(res, 404, { error: 'unknown agent' })
      audit('console.expiry', name, ip, true)
      return sendJson(res, 200, { ok: true, name, token_expires_at: expiry.value })
    }
    if (action === 'rotate') {
      const row = db.prepare('SELECT name FROM agents WHERE name = ?').get(name)
      if (!row) return sendJson(res, 404, { error: 'unknown agent' })
      const token = mintToken('mesh')
      db.prepare('UPDATE agents SET token_hash = ?, token_issued_at = ? WHERE name = ?').run(hashToken(token), now(), name)
      audit('console.rotate', name, ip, true)
      return sendJson(res, 200, { ok: true, name, token })
    }
    if (action === 'revoke') {
      db.prepare('UPDATE agents SET token_hash = NULL WHERE name = ?').run(name)
      audit('console.revoke', name, ip, true)
      return sendJson(res, 200, { ok: true, name, revoked: true })
    }
    if (action === 'purge') {
      const row = db.prepare('SELECT name, last_seen, token_hash FROM agents WHERE name = ?').get(name)
      if (!row) return sendJson(res, 404, { error: 'unknown agent' })
      if (row.token_hash) return sendJson(res, 409, { error: 'revoke the token before purging' })
      db.prepare('DELETE FROM agents WHERE name = ?').run(name)
      audit('admin.purge', name, ip, true)
      return sendJson(res, 200, { ok: true, name, purged: true })
    }
    return sendJson(res, 404, { error: 'unknown action' })
  }

  if (path === '/console/enroll/pending' && req.method === 'GET') {
    const auth = consoleAuthorized(req)
    if (!auth) return sendJson(res, 401, { error: 'unauthorized' })
    return sendJson(res, 200, { pending: pendingDevices() })
  }

  if ((path === '/console/enroll/approve' || path === '/console/enroll/deny') && req.method === 'POST') {
    const auth = consoleAuthorized(req)
    if (!auth || auth.role !== 'admin') return sendJson(res, 403, { error: 'admin role required' })
    if (!csrfOk(req, auth)) return sendJson(res, 403, { error: 'bad csrf token' })
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return sendJson(res, 400, { error: error.message })
    }
    const result = decideDevice(body, path.endsWith('/approve'), ip)
    return sendJson(res, result.status, result.body)
  }

  if (path === '/console/enroll-code' && req.method === 'POST') {
    const auth = consoleAuthorized(req)
    if (!auth || auth.role !== 'admin') return sendJson(res, 403, { error: 'admin role required' })
    if (!csrfOk(req, auth)) return sendJson(res, 403, { error: 'bad csrf token' })
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return sendJson(res, 400, { error: error.message })
    }
    const name = body.name === undefined ? '' : String(body.name).trim()
    if (name && !/^[A-Za-z0-9_-]{1,32}$/.test(name)) return sendJson(res, 400, { error: 'invalid agent name' })
    const expiry = parseTokenExpiry(body.expires_at)
    if (expiry.error) return sendJson(res, 400, { error: expiry.error })
    const code = mintEnrollCode(name || null, expiry.value)
    audit('admin.enroll_code', name || null, ip, true)
    return sendJson(res, 201, { code, name: name || null, expires_at: expiry.value, expires_in_seconds: ENROLL_CODE_TTL_MS / 1000 })
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not found"}')
}

async function handleRest(req, res, url) {
  const id = resolveIdentity(req)
  if (!id.ok) return sendJson(res, id.status, { error: id.reason })
  touchAgent(id.name, id.host)
  const path = url.pathname
  const q = url.searchParams
  const ip = clientIp(req)

  const requiredScope = restScope(req, path)
  if (requiredScope && !(id.scopes ?? ALL_SCOPES).includes(requiredScope)) {
    return sendJson(res, 403, {
      ok: false,
      error: `this endpoint requires scope "${requiredScope}"; this agent has: ${(id.scopes ?? []).join(', ') || 'none'}`,
      required_scope: requiredScope,
    })
  }

  try {
    if (path === '/api/register' && req.method === 'POST') {
      const body = await readJson(req)
      const wakeUrl = wakeUrlOf(body.wake_url)
      const wakeApi = wakeApiOf(body.wake_api)
      db.prepare('UPDATE agents SET host = COALESCE(?, host), description = COALESCE(?, description), wake_url = COALESCE(?, wake_url), wake_api = COALESCE(?, wake_api) WHERE name = ?')
        .run(body.host ?? null, body.description ?? null, wakeUrl, wakeApi, id.name)
      // Optional, self-reported plugin identity. Never trusted for authorization; only shown
      // so an operator can spot a machine running an old build.
      const plugin = body.plugin && typeof body.plugin === 'object' ? body.plugin : null
      if (plugin) {
        const pluginName = typeof plugin.name === 'string' ? plugin.name.slice(0, 80) : null
        const pluginVersion = typeof plugin.version === 'string' ? plugin.version.slice(0, 40) : null
        const pluginPlatform = typeof plugin.platform === 'string' ? plugin.platform.slice(0, 40) : null
        if (pluginVersion) {
          db.prepare('UPDATE agents SET plugin_name = ?, plugin_version = ?, plugin_platform = ?, plugin_reported_at = ? WHERE name = ?')
            .run(pluginName, pluginVersion, pluginPlatform, now(), id.name)
        }
      }
      return sendJson(res, 200, db.prepare('SELECT name, host, description, wake_url, wake_api, plugin_name, plugin_version, plugin_platform, last_seen FROM agents WHERE name = ?').get(id.name))
    }

    if (path === '/api/peers' && req.method === 'GET') {
      const ts = now()
      const offline = q.get('offline') === '1'
      const rows = db
        .prepare('SELECT name, host, description, last_seen, plugin_name, plugin_version, plugin_platform, plugin_reported_at FROM agents ORDER BY last_seen DESC')
        .all()
      const peers = rows
        .map((r) => ({
          name: r.name,
          host: r.host,
          description: r.description,
          online: ts - r.last_seen <= ONLINE_TTL_MS,
          last_seen_seconds_ago: Math.round((ts - r.last_seen) / 1000),
          last_seen_at: new Date(r.last_seen).toISOString(),
          plugin: r.plugin_version
            ? { name: r.plugin_name, version: r.plugin_version, platform: r.plugin_platform, reported_at: r.plugin_reported_at,
                compat: compareVersion(r.plugin_version, MIN_WAKER) >= 0 ? 'ok' : 'outdated' }
            : null,
        }))
        .filter((p) => offline || p.online)
      return sendJson(res, 200, { self: id.name, hub: { version: HUB_VERSION, min_waker: MIN_WAKER }, peers })
    }

    // Each agent fetches ITS OWN wake secret over the authenticated channel: a leaked key
    // can only spoof pings to that one machine, never to the whole mesh.
    if (path === '/api/wake-secret' && req.method === 'GET') {
      if (!WAKE_SECRET) return sendJson(res, 404, { error: 'wake push is disabled on this hub' })
      const secret = ensureWakeSecret(id.name)
      if (!secret) return sendJson(res, 404, { error: 'agent is not registered' })
      return sendJson(res, 200, { wake_secret: secret, scope: 'agent', agent: id.name })
    }

    if (path === '/api/send' && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.to || body.body === undefined) return sendJson(res, 400, { error: 'to and body are required' })
      assertText('to', body.to, MAX_RECIPIENT_BYTES)
      assertText('body', body.body, MAX_MESSAGE_BYTES)
      if (body.subject !== undefined && body.subject !== null) assertText('subject', String(body.subject), MAX_SUBJECT_BYTES)
      const messageId = randomUUID()
      const conversation = body.conversation === undefined || body.conversation === null ? null : String(body.conversation)
      if (conversation !== null) assertText('conversation', conversation, MAX_CONVERSATION_BYTES)
      const replyTo = typeof body.reply_to === 'string' && body.reply_to.trim() ? body.reply_to : null
      const wantsSilent = body.silent === true
      let closing = body.no_reply === true ? 1 : 0
      let noReplyIgnored = false
      if (closing && !replyTo) {
        closing = 0
        noReplyIgnored = true
      }
      const noWake = wantsSilent || closing === 1
      const important = body.important === true || body.pinned === true
      const urgent = body.interrupt === true ? 1 : 0
      const originSession = typeof body.session === 'string' && body.session.trim() ? body.session.trim().slice(0, 80) : null
      const deliverMode = ['queue', 'steer', 'branch'].includes(String(body.delivery)) ? String(body.delivery) : null
      const extras = {}
      if (wantsSilent) extras.silent = true
      if (noReplyIgnored) {
        extras.no_reply_ignored = true
        extras.reason = 'no_reply requires reply_to (closing message only)'
      }
      if (wantsSilent && body.no_reply === true) extras.note = 'silent takes precedence over no_reply'
      if (body.to === '*') {
        const recipients = db.prepare('SELECT name FROM agents WHERE name != ?').all(id.name).map((row) => row.name)
        const insert = db.prepare('INSERT INTO messages (id, sender, recipient, subject, body, created_at, reply_to, conversation, no_reply, pinned, interrupt, origin_session, delivery_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        for (const name of recipients) {
          insert.run(randomUUID(), id.name, name, body.subject ?? null, body.body, now(), replyTo, conversation, closing, important ? 1 : 0, urgent, originSession, deliverMode)
          if (!noWake) wakeAgent(name, conversation, { sender: id.name, subject: body.subject })
        }
        return sendJson(res, 201, { to: '*', recipients: recipients.length, conversation, no_reply: Boolean(closing), ...extras })
      }
      db.prepare('INSERT INTO messages (id, sender, recipient, subject, body, created_at, reply_to, conversation, no_reply, pinned, interrupt, origin_session, delivery_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(messageId, id.name, body.to, body.subject ?? null, body.body, now(), replyTo, conversation, closing, important ? 1 : 0, urgent, originSession, deliverMode)
      if (!noWake) wakeAgent(body.to, conversation, { sender: id.name, subject: body.subject })
      return sendJson(res, 201, { id: messageId, to: body.to, conversation, no_reply: Boolean(closing), ...extras })
    }

    if (path === '/api/inbox' && req.method === 'GET') {
      const unreadOnly = q.get('unread') !== '0'
      const limit = parseLimit(q.get('limit'), 20, 100)
      const order = q.get('order') === 'desc' ? 'desc' : 'asc'
      const beforeRaw = q.get('before')
      const before = beforeRaw === null || beforeRaw === '' ? null : Number(beforeRaw)
      if (before !== null && !Number.isFinite(before)) throw new BadRequest('before must be epoch milliseconds')
      const claim = q.get('claim') === '1'
      const claimTtlRaw = q.get('claim_ttl_ms')
      const claimTtl = claimTtlRaw === null || claimTtlRaw === '' ? DEFAULT_CLAIM_TTL_MS : Number(claimTtlRaw)
      if (!Number.isFinite(claimTtl) || claimTtl < 0) throw new BadRequest('claim_ttl_ms must be a non-negative number')
      const page = fetchInboxPage(id.name, { unreadOnly, limit, order, before })
      if (claim && page.rows.length) {
        // Only take rows nobody holds (or whose lease expired); a second claim inside the
        // lease must not extend it. Claim is visibility, not read: mark_read stays separate.
        const ts = now()
        const stmt = db.prepare('UPDATE messages SET claimed_at = ? WHERE id = ? AND recipient = ? AND (claimed_at IS NULL OR claimed_at < ?)')
        for (const row of page.rows) {
          const changed = Number(stmt.run(ts, row.id, id.name, ts - claimTtl).changes ?? 0)
          if (changed) row.claimed_at = ts
        }
      }
      if (q.get('mark_read') === '1' && page.rows.length) {
        const stmt = db.prepare('UPDATE messages SET read_at = ? WHERE id = ?')
        for (const row of page.rows) stmt.run(now(), row.id)
      }
      return sendJson(res, 200, {
        agent: id.name,
        count: page.rows.length,
        order,
        stale_count: page.rows.filter((row) => row.stale).length,
        has_more: page.hasMore,
        next_before: page.nextBefore,
        messages: page.rows,
      })
    }

    // A client that inlines message content into its own prompt needs to acknowledge
    // exactly the messages it delivered — not "whatever is unread right now".
    if (path === '/api/read' && req.method === 'POST') {
      const body = await readJson(req)
      const ids = Array.isArray(body.ids) ? body.ids.filter((value) => typeof value === 'string').slice(0, 200) : []
      if (!ids.length) return sendJson(res, 400, { error: 'ids must be a non-empty string array' })
      const stmt = db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL')
      let read = 0
      for (const messageId of ids) read += stmt.run(now(), messageId, id.name).changes
      return sendJson(res, 200, { read })
    }

    if (path === '/api/board' && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.key || body.value === undefined) return sendJson(res, 400, { error: 'key and value are required' })
      assertText('key', String(body.key), MAX_KEY_BYTES)
      assertText('value', String(body.value), MAX_BOARD_BYTES)
      const owner = body.owner === undefined || body.owner === null ? null : String(body.owner)
      const status = body.status === undefined || body.status === null ? null : String(body.status)
      if (owner !== null) assertText('owner', owner, MAX_RECIPIENT_BYTES)
      if (status !== null) assertText('status', status, 40)
      const visibleTo = body.visible_to === undefined ? null : visibilityOf(body.visible_to)
      let ifVersion = null
      if (body.if_version !== undefined && body.if_version !== null && body.if_version !== '') {
        ifVersion = Number(body.if_version)
        if (!Number.isInteger(ifVersion) || ifVersion < 0) return sendJson(res, 400, { error: 'if_version must be a non-negative integer' })
      }
      const result = writeBoard({ key: String(body.key), value: String(body.value), owner, status, visibleTo, ifVersion, actor: id.name })
      if (result.conflict) return sendJson(res, 409, { error: 'version conflict', ...result.conflict })
      return sendJson(res, 200, result.row)
    }

    if (path === '/api/board' && req.method === 'GET') {
      const key = q.get('key')
      if (key) {
        const row = db.prepare('SELECT key, value, updated_by, updated_at, owner, status, version, visible_to FROM board WHERE key = ?').get(key)
        if (!row || !boardVisible(row, id.name, req)) return sendJson(res, 404, { key, found: false })
        return sendJson(res, 200, row)
      }
      const prefix = q.get('prefix')
      const rows = prefix
        ? db.prepare('SELECT key, value, updated_by, updated_at, owner, status, version, visible_to FROM board WHERE key LIKE ? ORDER BY key').all(`${prefix}%`)
        : db.prepare('SELECT key, value, updated_by, updated_at, owner, status, version, visible_to FROM board ORDER BY key').all()
      const entries = rows.filter((row) => boardVisible(row, id.name, req))
      return sendJson(res, 200, { count: entries.length, entries })
    }

    // The change log used to be write-only. Expose it so "who changed this key" is
    // answerable; retention is bounded by MESH_LOG_TTL_MS / MESH_LOG_MAX_ROWS.
    if (path === '/api/board/log' && req.method === 'GET') {
      const key = q.get('key')
      const prefix = q.get('prefix')
      const limit = parseLimit(q.get('limit'), 50, 500)
      const rows = key
        ? db.prepare('SELECT id, key, value, actor, at FROM board_log WHERE key = ? ORDER BY id DESC LIMIT ?').all(key, limit)
        : prefix
          ? db.prepare('SELECT id, key, value, actor, at FROM board_log WHERE key LIKE ? ORDER BY id DESC LIMIT ?').all(`${prefix}%`, limit)
          : db.prepare('SELECT id, key, value, actor, at FROM board_log ORDER BY id DESC LIMIT ?').all(limit)
      const boardRows = new Map(db.prepare('SELECT key, visible_to FROM board').all().map((row) => [row.key, row]))
      const entries = rows.filter((row) => {
        const boardRow = boardRows.get(row.key)
        return !boardRow || boardVisible(boardRow, id.name, req)
      })
      return sendJson(res, 200, { count: entries.length, entries })
    }

    if (path === '/api/status' && req.method === 'GET') {
      const ts = now()
      const pluginVersions = db
        .prepare('SELECT plugin_version AS version, COUNT(*) AS agents FROM agents WHERE plugin_version IS NOT NULL GROUP BY plugin_version ORDER BY agents DESC')
        .all()
      const outdatedAgents = db
        .prepare('SELECT name, plugin_version FROM agents WHERE plugin_version IS NOT NULL')
        .all()
        .filter((row) => compareVersion(row.plugin_version, MIN_WAKER) < 0)
      return sendJson(res, 200, {
        agents: db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
        online: db.prepare('SELECT COUNT(*) AS n FROM agents WHERE last_seen >= ?').get(ts - ONLINE_TTL_MS).n,
        queued_messages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL').get().n,
        board_entries: db.prepare('SELECT COUNT(*) AS n FROM board').get().n,
        blobs: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM blobs').get(),
        uptime_seconds: Math.round(process.uptime()),
        hub: { version: HUB_VERSION, min_waker: MIN_WAKER },
        plugin_versions: pluginVersions,
        outdated: outdatedAgents,
      })
    }

    // --- conversation views: what *I* sent and received -----------------------
    // Hub keeps messages for MESSAGE_TTL_MS; the client-side plugin mirrors them into a
    // local cache so history outlives the hub's retention window.
    if (path === '/api/conversations' && req.method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 50) || 50))
      const rows = db.prepare(
        `SELECT COALESCE(conversation, 'default') AS conversation,
                COUNT(*) AS messages,
                MAX(created_at) AS last_at,
                SUM(CASE WHEN recipient = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread,
                SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) AS pinned
           FROM messages
          WHERE sender = ? OR recipient = ?
          GROUP BY COALESCE(conversation, 'default')
          ORDER BY last_at DESC
          LIMIT ?`,
      ).all(id.name, id.name, id.name, limit)
      for (const row of rows) {
        const peers = db.prepare(
          `SELECT DISTINCT CASE WHEN sender = ? THEN recipient ELSE sender END AS peer
             FROM messages
            WHERE COALESCE(conversation, 'default') = ? AND (sender = ? OR recipient = ?)`,
        ).all(id.name, row.conversation, id.name, id.name).map((r) => r.peer).filter(Boolean)
        row.participants = [...new Set(peers)]
        const last = db.prepare(
          `SELECT subject FROM messages
            WHERE COALESCE(conversation, 'default') = ? AND (sender = ? OR recipient = ?)
            ORDER BY created_at DESC LIMIT 1`,
        ).get(row.conversation, id.name, id.name)
        row.last_subject = last?.subject ?? null
      }
      return sendJson(res, 200, { conversations: rows })
    }

    if (path === '/api/conversation' && req.method === 'GET') {
      const conv = String(q.get('conversation') ?? 'default')
      const limit = Math.min(500, Math.max(1, Number(q.get('limit') ?? 100) || 100))
      const before = Number(q.get('before') ?? 0)
      const full = q.get('full') === '1'
      const rows = db.prepare(
        `SELECT id, sender, recipient, subject, body, conversation, no_reply, pinned, interrupt, origin_session, delivery_mode, read_at, created_at, reply_to
           FROM messages
          WHERE COALESCE(conversation, 'default') = ?
            AND (sender = ? OR recipient = ?)
            AND (? = 0 OR created_at < ?)
          ORDER BY created_at DESC
          LIMIT ?`,
      ).all(conv, id.name, id.name, before, before, limit)
      const messages = rows.reverse().map((row) => {
        const out = { ...row, conversation: conv }
        if (!full && out.body) {
          const truncated = truncateUtf8(out.body, 4096)
          if (truncated.truncated) {
            out.body = truncated.value
            out.truncated = true
          }
        }
        return out
      })
      return sendJson(res, 200, { conversation: conv, messages, count: messages.length })
    }

    if (path === '/api/message' && req.method === 'GET') {
      const messageId = String(q.get('id') ?? '')
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)
      if (!row) return sendJson(res, 404, { error: 'message not found' })
      if (!isAdmin(req) && row.sender !== id.name && row.recipient !== id.name) {
        return sendJson(res, 403, { error: 'not a participant of this message' })
      }
      return sendJson(res, 200, row)
    }

    const pinPath = path.match(/^\/api\/message\/([0-9a-f-]{36})\/pin$/)
    if (pinPath && req.method === 'POST') {
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(pinPath[1])
      if (!row) return sendJson(res, 404, { error: 'message not found' })
      if (!isAdmin(req) && row.sender !== id.name && row.recipient !== id.name) {
        return sendJson(res, 403, { error: 'not a participant of this message' })
      }
      const body = await readJson(req)
      const pinned = body.pinned === false ? 0 : 1
      db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(pinned, row.id)
      audit(pinned ? 'message.pin' : 'message.unpin', id.name, ip, true)
      return sendJson(res, 200, { id: row.id, pinned })
    }

    if (path === '/api/pinned' && req.method === 'GET') {
      const rows = db.prepare(
        `SELECT id, sender, recipient, subject, conversation, created_at, read_at
           FROM messages
          WHERE pinned = 1 AND (sender = ? OR recipient = ?)
          ORDER BY created_at DESC LIMIT 100`,
      ).all(id.name, id.name)
      return sendJson(res, 200, { pinned: rows })
    }

    // --- blob channel: files too big for a board value ------------------------
    // Two ways in: one-shot POST /api/blob (small files) and a resumable
    // init -> chunk* -> commit sequence (large files, weak links, retries).
    if (path === '/api/blob' && req.method === 'POST') {
      const name = String(q.get('name') || req.headers['x-blob-name'] || 'blob.bin').slice(0, 200)
      const expected = String(q.get('sha256') || req.headers['x-blob-sha256'] || '').toLowerCase()
      const visible = visibilityOf(q.get('visible_to'))
      const used = db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM blobs').get().n
      const raw = await readBody(req, MAX_BLOB_BYTES)
      if (!raw.length) throw new BadRequest('empty blob')
      const sha = createHash('sha256').update(raw).digest('hex')
      if (expected && expected !== sha) {
        return sendJson(res, 400, { error: 'sha256 mismatch', expected, actual: sha })
      }
      if (used + raw.length > MAX_BLOB_TOTAL_BYTES) {
        return sendJson(res, 507, { error: 'blob storage quota exceeded', used, cap: MAX_BLOB_TOTAL_BYTES })
      }
      const blobId = randomUUID()
      mkdirSync(BLOB_DIR, { recursive: true })
      writeFileSync(join(BLOB_DIR, blobId), raw)
      const ts = now()
      db.prepare('INSERT INTO blobs (id,name,bytes,sha256,uploader,created_at,expires_at,status,visible_to,expected_sha,expected_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(blobId, name, raw.length, sha, id.name, ts, ts + BLOB_TTL_MS, 'ready', visible, sha, raw.length)
      audit('blob.put', id.name, ip, true)
      return sendJson(res, 201, {
        id: blobId, name, bytes: raw.length, sha256: sha, visible_to: visible,
        url: `/api/blob/${blobId}`, expires_at: ts + BLOB_TTL_MS, ttl_seconds: BLOB_TTL_MS / 1000,
      })
    }

    if (path === '/api/blob/init' && req.method === 'POST') {
      const body = await readJson(req)
      const name = String(body.name || 'blob.bin').slice(0, 200)
      const total = Number(body.bytes)
      const expected = String(body.sha256 || '').toLowerCase()
      if (!Number.isFinite(total) || total <= 0) throw new BadRequest('bytes must be a positive number')
      if (total > MAX_BLOB_BYTES) return sendJson(res, 413, { error: `blob exceeds ${MAX_BLOB_BYTES} bytes` })
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new BadRequest('sha256 must be 64 hex chars')
      const used = db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM blobs').get().n
      if (used + total > MAX_BLOB_TOTAL_BYTES) {
        return sendJson(res, 507, { error: 'blob storage quota exceeded', used, cap: MAX_BLOB_TOTAL_BYTES })
      }
      const blobId = randomUUID()
      mkdirSync(BLOB_DIR, { recursive: true })
      writeFileSync(join(BLOB_DIR, blobId), Buffer.alloc(0))
      const ts = now()
      db.prepare('INSERT INTO blobs (id,name,bytes,sha256,uploader,created_at,expires_at,status,visible_to,expected_sha,expected_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(blobId, name, 0, '', id.name, ts, ts + BLOB_TTL_MS, 'uploading', visibilityOf(body.visible_to), expected, total)
      audit('blob.init', id.name, ip, true)
      return sendJson(res, 201, {
        id: blobId, status: 'uploading', expected_bytes: total,
        chunk_url: `/api/blob/${blobId}/chunk`, commit_url: `/api/blob/${blobId}/commit`,
        expires_at: ts + BLOB_TTL_MS,
      })
    }

    const chunkPath = path.match(/^\/api\/blob\/([0-9a-f-]{36})\/chunk$/)
    if (chunkPath && (req.method === 'PUT' || req.method === 'POST')) {
      const row = db.prepare('SELECT * FROM blobs WHERE id = ?').get(chunkPath[1])
      if (!row) return sendJson(res, 404, { error: 'blob not found' })
      if (!isAdmin(req) && row.uploader !== id.name) return sendJson(res, 403, { error: 'only the uploader may write chunks' })
      if (row.status !== 'uploading') return sendJson(res, 409, { error: 'blob is not accepting chunks', status: row.status })
      const file = join(BLOB_DIR, row.id)
      const current = existsSync(file) ? statSync(file).size : 0
      const offset = Number(q.get('offset') ?? current)
      if (!Number.isFinite(offset) || offset !== current) {
        return sendJson(res, 409, { error: 'offset mismatch', expected_offset: current, got: offset })
      }
      const declared = Number(row.expected_bytes ?? 0)
      const chunkLimit = Math.min(MAX_BLOB_CHUNK_BYTES, Math.max(1, declared - current))
      const chunk = await readBody(req, chunkLimit)
      if (!chunk.length) throw new BadRequest('empty chunk')
      if (current + chunk.length > declared) {
        return sendJson(res, 413, { error: 'chunk exceeds declared size', declared, current })
      }
      appendFileSync(file, chunk)
      const size = current + chunk.length
      db.prepare('UPDATE blobs SET bytes = ? WHERE id = ?').run(size, row.id)
      return sendJson(res, 200, { id: row.id, received: size, expected_bytes: declared, next_offset: size })
    }

    const commitPath = path.match(/^\/api\/blob\/([0-9a-f-]{36})\/commit$/)
    if (commitPath && req.method === 'POST') {
      const row = db.prepare('SELECT * FROM blobs WHERE id = ?').get(commitPath[1])
      if (!row) return sendJson(res, 404, { error: 'blob not found' })
      if (!isAdmin(req) && row.uploader !== id.name) return sendJson(res, 403, { error: 'only the uploader may commit' })
      if (row.status === 'ready') {
        return sendJson(res, 200, { id: row.id, status: 'ready', bytes: row.bytes, sha256: row.sha256 })
      }
      const file = join(BLOB_DIR, row.id)
      if (!existsSync(file)) return sendJson(res, 404, { error: 'blob payload missing' })
      const size = statSync(file).size
      if (row.expected_bytes != null && size !== row.expected_bytes) {
        // Roll back the whole upload: a half-written file must not linger as "uploading",
        // which is what the docs promise and what the sha mismatch path already does.
        try { unlinkSync(file) } catch { /* already gone */ }
        db.prepare('DELETE FROM blobs WHERE id = ?').run(row.id)
        return sendJson(res, 400, { error: 'size mismatch', expected: row.expected_bytes, actual: size })
      }
      const sha = createHash('sha256').update(readFileSync(file)).digest('hex')
      if (row.expected_sha && sha !== row.expected_sha) {
        try { unlinkSync(file) } catch { /* ignore */ }
        db.prepare('DELETE FROM blobs WHERE id = ?').run(row.id)
        return sendJson(res, 400, { error: 'sha256 mismatch', expected: row.expected_sha, actual: sha })
      }
      const ts = now()
      db.prepare('UPDATE blobs SET status = ?, sha256 = ?, bytes = ?, expires_at = ? WHERE id = ?')
        .run('ready', sha, size, ts + BLOB_TTL_MS, row.id)
      audit('blob.commit', id.name, ip, true)
      return sendJson(res, 201, {
        id: row.id, status: 'ready', bytes: size, sha256: sha,
        url: `/api/blob/${row.id}`, expires_at: ts + BLOB_TTL_MS,
      })
    }

    if (path === '/api/blobs' && req.method === 'GET') {
      const mine = q.get('mine') === '1'
      const admin = isAdmin(req)
      const cols = 'id, name, bytes, sha256, uploader, created_at, expires_at, status, visible_to'
      const rows = mine
        ? db.prepare(`SELECT ${cols} FROM blobs WHERE uploader = ? ORDER BY created_at DESC LIMIT 100`).all(id.name)
        : db.prepare(`SELECT ${cols} FROM blobs ORDER BY created_at DESC LIMIT 1000`).all()
      // Never leak metadata for blobs the caller cannot read; filtered-out rows are simply
      // absent (no count, so the response does not confirm their existence).
      const visible = admin ? rows : rows.filter((row) => blobReadable(row, id.name, req))
      return sendJson(res, 200, { blobs: visible.slice(0, 100) })
    }

    const blobPath = path.match(/^\/api\/blob\/([0-9a-f-]{36})(\/meta)?$/)
    if (blobPath) {
      const row = db.prepare('SELECT * FROM blobs WHERE id = ?').get(blobPath[1])
      if (!row) return sendJson(res, 404, { error: 'blob not found' })
      if (req.method === 'PATCH') {
        if (!isAdmin(req) && row.uploader !== id.name) return sendJson(res, 403, { error: 'only the uploader or an admin may change visibility' })
        const body = await readJson(req)
        const visible = visibilityOf(body.visible_to)
        db.prepare('UPDATE blobs SET visible_to = ? WHERE id = ?').run(visible, row.id)
        audit('blob.acl', id.name, ip, true)
        return sendJson(res, 200, { id: row.id, visible_to: visible })
      }
      if (req.method === 'DELETE') {
        if (!isAdmin(req) && row.uploader !== id.name) {
          return sendJson(res, 403, { error: 'only the uploader or an admin may delete this blob' })
        }
        try { unlinkSync(join(BLOB_DIR, row.id)) } catch { /* already gone */ }
        db.prepare('DELETE FROM blobs WHERE id = ?').run(row.id)
        audit('blob.delete', id.name, ip, true)
        return sendJson(res, 200, { deleted: row.id })
      }
      if (blobPath[2]) {
        if (!blobReadable(row, id.name, req)) return sendJson(res, 404, { error: 'blob not found' })
        return sendJson(res, 200, row)
      }
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET, PATCH or DELETE' })
      if (!blobReadable(row, id.name, req)) return sendJson(res, 404, { error: 'blob not found' })
      if (row.status !== 'ready') return sendJson(res, 409, { error: 'blob is still uploading', status: row.status })
      const file = join(BLOB_DIR, row.id)
      if (!existsSync(file)) {
        db.prepare('DELETE FROM blobs WHERE id = ?').run(row.id)
        return sendJson(res, 404, { error: 'blob payload missing' })
      }
      audit('blob.get', id.name, ip, true)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(row.bytes),
        'x-blob-sha256': row.sha256,
        'x-blob-name': encodeURIComponent(row.name),
      })
      createReadStream(file).pipe(res)
      return
    }

    return sendJson(res, 404, { error: 'unknown endpoint', hint: 'see README for /api routes' })
  } catch (error) {
    if (error instanceof PayloadTooLarge) return sendJson(res, 413, { error: error.message }, { connection: 'close' })
    return sendJson(res, 400, { error: error.message })
  }
}

/**
 * Enrollment codes: the admin mints a short-lived, single-use code; the new node calls
 * POST /api/enroll with it and gets its own agent token. The token is still shown exactly
 * once, but it never has to travel through chat or a copy-paste.
 *
 *   POST /api/admin/enroll-codes {name?, ttl_ms?}  -> {code, expires_at}
 *   POST /api/enroll           {code, name?, host?} -> {name, token}
 */
const enrollCodes = new Map()
const ENROLL_CODE_TTL_MS = 10 * 60_000
const enrollAttempts = new Map()

function mintEnrollCode(name, tokenExpiresAt = null) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let index = 0; index < 8; index += 1) code += alphabet[randomBytes(1)[0] % alphabet.length]
  enrollCodes.set(code, { name: name || null, tokenExpiresAt, expiresAt: now() + ENROLL_CODE_TTL_MS, createdAt: now() })
  for (const [key, value] of enrollCodes) if (value.expiresAt <= now()) enrollCodes.delete(key)
  return code
}

async function handleEnroll(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
  const ip = clientIp(req)
  const attempts = (enrollAttempts.get(ip) ?? 0) + 1
  enrollAttempts.set(ip, attempts)
  if (attempts > 10) {
    audit('enroll', null, ip, false)
    return sendJson(res, 429, { error: 'too many enrollment attempts, retry later' })
  }
  try {
    const body = await readJson(req)
    const code = String(body.code ?? '').trim().toUpperCase()
    const entry = enrollCodes.get(code)
    if (!entry || entry.expiresAt <= now()) {
      enrollCodes.delete(code)
      audit('enroll', null, ip, false)
      return sendJson(res, 401, { error: 'invalid or expired enrollment code' })
    }
    const name = String(body.name ?? entry.name ?? '').trim()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return sendJson(res, 400, { error: 'name must match [A-Za-z0-9_-]{1,32} (pass name or bind it when minting the code)' })
    enrollCodes.delete(code) // single use, even if the insert below fails
    const expiry = parseTokenExpiry(body.expires_at ?? entry.tokenExpiresAt)
    if (expiry.error) return sendJson(res, 400, { error: expiry.error })
    const token = mintToken('mesh')
    const ts = now()
    const existing = db.prepare('SELECT name FROM agents WHERE name = ?').get(name)
    if (existing) {
      db.prepare('UPDATE agents SET token_hash = ?, token_expires_at = ?, host = COALESCE(?, host) WHERE name = ?')
        .run(hashToken(token), expiry.value, body.host ?? null, name)
    } else {
      db.prepare('INSERT INTO agents (name, host, description, first_seen, last_seen, token_hash, token_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, body.host ?? null, body.description ?? null, ts, ts, hashToken(token), expiry.value)
    }
    audit('enroll', name, ip, true)
    console.log(`[mesh] enrolled ${name} from ${ip}`)
    return sendJson(res, 201, { name, token, expires_at: expiry.value, note: 'store this now; rotate or re-enroll if lost' })
  } catch (error) {
    return sendJson(res, 400, { error: error.message })
  }
}

/**
 * Device-code pairing: the node asks for a code, a human approves it in the console, and
 * the node polls until its token is ready. Nothing secret has to travel through chat.
 *
 *   POST /api/enroll/request {name?, host?, description?} -> {user_code, device_code, ...}
 *   POST /api/enroll/token   {device_code}               -> 202 pending / 201 {name, token}
 *   POST /console/enroll/approve|deny {user_code}        (admin console session)
 *   POST /api/admin/enroll/approve|deny {user_code}      (admin token)
 *   GET  /console/enroll/pending                          (console session)
 */
const DEVICE_CODE_TTL_MS = 10 * 60_000
const DEVICE_POLL_INTERVAL_MS = 5_000
const ENROLL_RATE_WINDOW_MS = 60_000
const ENROLL_REQUEST_LIMIT = 5
const ENROLL_POLL_LIMIT = 10
const deviceCodes = new Map() // user_code -> record
const deviceByCode = new Map() // device_code -> record
const deviceRequestRate = new Map() // ip -> { count, resetAt }
const devicePollRate = new Map()

/** Optional agent name from a request body; same grammar as the rest of enrollment. */
function optionalAgentName(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new BadRequest('name must be a string')
  const name = raw.trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new BadRequest('name must match [A-Za-z0-9_-]{1,32}')
  return name
}

/** Sliding fixed window per IP; the maps are pruned by sweepEnrollState(). */
function overRate(map, ip, limit) {
  const ts = now()
  const entry = map.get(ip)
  if (!entry || ts >= entry.resetAt) {
    map.set(ip, { count: 1, resetAt: ts + ENROLL_RATE_WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > limit
}

function dropDevice(rec) {
  deviceCodes.delete(rec.userCode)
  deviceByCode.delete(rec.deviceCode)
}

function pruneDeviceCodes() {
  const ts = now()
  for (const rec of deviceCodes.values()) if (rec.expiresAt <= ts) dropDevice(rec)
}

function sweepEnrollState() {
  pruneDeviceCodes()
  for (const map of [deviceRequestRate, devicePollRate, bootstrapRate]) {
    for (const [ip, entry] of map) if (now() >= entry.resetAt) map.delete(ip)
  }
}

/** Human-readable, single-use pairing code: four letters/digits, a dash, four more. */
function mintUserCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  for (;;) {
    let raw = ''
    for (let index = 0; index < 8; index += 1) raw += alphabet[randomBytes(1)[0] % alphabet.length]
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
    if (!deviceCodes.has(code)) return code
  }
}

/** Flip a pending request to approved/denied; shared by the console and admin faces. */
function decideDevice(body, approve, ip) {
  const userCode = String(body.user_code ?? '').trim().toUpperCase()
  const rec = deviceCodes.get(userCode)
  if (!rec || rec.expiresAt <= now()) {
    if (rec) dropDevice(rec)
    audit(approve ? 'enroll.approve' : 'enroll.deny', null, ip, false)
    return { status: 404, body: { error: 'unknown or expired user code' } }
  }
  if (rec.status !== 'pending') {
    audit(approve ? 'enroll.approve' : 'enroll.deny', rec.name ?? null, ip, false)
    return { status: 409, body: { error: `device code already ${rec.status}` } }
  }
  try {
    const name = optionalAgentName(body.name)
    if (name) rec.name = name
    if (body.host !== undefined) rec.host = String(body.host).trim().slice(0, 200) || null
  } catch (error) {
    return { status: 400, body: { error: error.message } }
  }
  rec.status = approve ? 'approved' : 'denied'
  rec.decidedAt = now()
  if (!rec.name && approve) rec.name = `node-${randomBytes(3).toString('hex')}`
  audit(approve ? 'enroll.approve' : 'enroll.deny', rec.name ?? null, ip, true)
  return {
    status: 200,
    body: { ok: true, user_code: rec.userCode, status: rec.status, name: rec.name, host: rec.host, expires_at: rec.expiresAt },
  }
}

/** Pending requests as shown in the console — never contains device_code. */
function pendingDevices() {
  const ts = now()
  return [...deviceCodes.values()]
    .filter((rec) => rec.status === 'pending' && rec.expiresAt > ts)
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((rec) => ({
      user_code: rec.userCode,
      name: rec.name,
      host: rec.host,
      description: rec.description,
      created_at: rec.createdAt,
      expires_at: rec.expiresAt,
    }))
}

async function handleDeviceEnroll(req, res, url) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
  const ip = clientIp(req)
  const path = url.pathname

  try {
    if (path === '/api/enroll/request') {
      if (overRate(deviceRequestRate, ip, ENROLL_REQUEST_LIMIT)) {
        audit('enroll.request', null, ip, false)
        return sendJson(res, 429, { error: 'too many enrollment requests, retry later' })
      }
      const body = await readJson(req)
      const name = optionalAgentName(body.name)
      const host = body.host === undefined || body.host === null ? null : String(body.host).trim().slice(0, 200) || null
      const description = body.description === undefined || body.description === null ? null : String(body.description).trim().slice(0, 200) || null
      pruneDeviceCodes()
      const userCode = mintUserCode()
      const deviceCode = randomBytes(32).toString('hex')
      const ts = now()
      const rec = { userCode, deviceCode, name, host, description, createdAt: ts, expiresAt: ts + DEVICE_CODE_TTL_MS, status: 'pending' }
      deviceCodes.set(userCode, rec)
      deviceByCode.set(deviceCode, rec)
      audit('enroll.request', name ?? null, ip, true)
      return sendJson(res, 201, {
        user_code: userCode,
        device_code: deviceCode,
        expires_at: rec.expiresAt,
        interval_ms: DEVICE_POLL_INTERVAL_MS,
      })
    }

    if (path === '/api/enroll/token') {
      if (overRate(devicePollRate, ip, ENROLL_POLL_LIMIT)) {
        audit('enroll.token', null, ip, false)
        return sendJson(res, 429, { error: 'too many enrollment polls, retry later' })
      }
      const body = await readJson(req)
      const deviceCode = String(body.device_code ?? '').trim()
      if (!/^[0-9a-f]{64}$/.test(deviceCode)) return sendJson(res, 400, { error: 'device_code must be 64 hex chars' })
      const rec = deviceByCode.get(deviceCode)
      if (!rec || rec.expiresAt <= now()) {
        if (rec) dropDevice(rec)
        audit('enroll.token', null, ip, false)
        return sendJson(res, 410, { error: 'expired or unknown device code' })
      }
      if (rec.status === 'denied') {
        audit('enroll.token', rec.name ?? null, ip, false)
        return sendJson(res, 403, { error: 'denied' })
      }
      if (rec.status !== 'approved') return sendJson(res, 202, { status: 'pending', interval_ms: DEVICE_POLL_INTERVAL_MS })

      const ts = now()
      const name = rec.name
      const token = mintToken('mesh')
      const existing = db.prepare('SELECT name FROM agents WHERE name = ?').get(name)
      if (existing) {
        db.prepare('UPDATE agents SET token_hash = ?, token_issued_at = ?, host = COALESCE(?, host), description = COALESCE(?, description) WHERE name = ?')
          .run(hashToken(token), ts, rec.host ?? null, rec.description ?? null, name)
      } else {
        db.prepare('INSERT INTO agents (name, host, description, first_seen, last_seen, token_hash, token_issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(name, rec.host ?? null, rec.description ?? null, ts, ts, hashToken(token), ts)
      }
      dropDevice(rec)
      audit('enroll.token', name, ip, true)
      console.log(`[mesh] device-code enrolled ${name} from ${ip}`)
      return sendJson(res, 201, { name, token, note: 'store this now; rotate or re-enroll if lost' })
    }

    return sendJson(res, 404, { error: 'unknown enrollment endpoint' })
  } catch (error) {
    return sendJson(res, 400, { error: error.message })
  }
}

/**
 * Public bootstrap: enough for a fresh client to join without out-of-band CA/token
 * handling. No secrets and no filesystem paths leave this endpoint.
 */
const BOOTSTRAP_LIMIT_PER_MINUTE = 60
const WAKE_MIN_POLL_INTERVAL_MS = 5_000
const bootstrapRate = new Map()
let tlsCaWarned = false

function bootstrapTls() {
  const file = process.env.MESH_TLS_CA_FILE || ''
  if (!file) return null
  try {
    const raw = readFileSync(file)
    return { ca_pem: raw.toString('utf8'), ca_sha256: createHash('sha256').update(raw).digest('hex') }
  } catch (error) {
    if (!tlsCaWarned) {
      tlsCaWarned = true
      console.warn(`[mesh] MESH_TLS_CA_FILE is not readable (${error.code ?? error.message}); /api/bootstrap reports tls:null`)
    }
    return null
  }
}

async function handleBootstrap(req, res) {
  const ip = clientIp(req)
  if (overRate(bootstrapRate, ip, BOOTSTRAP_LIMIT_PER_MINUTE)) {
    return sendJson(res, 429, { error: 'too many bootstrap requests, retry later' })
  }
  // High-frequency public endpoint: deliberately not written to the bounded audit table,
  // which is the low-rate auth/ops trail (60 calls/min would push real events out).
  return sendJson(res, 200, {
    service: 'dsh-mesh',
    version: HUB_VERSION,
    protocol: 1,
    tls: bootstrapTls(),
    endpoints: {
      mcp: '/mcp',
      api: '/api',
      inbox: '/api/inbox',
      enroll: '/api/enroll',
      device_request: '/api/enroll/request',
      device_token: '/api/enroll/token',
    },
    enroll: { code_ttl_ms: ENROLL_CODE_TTL_MS, device_flow: true },
    wake: { modes: ['pull', 'push'], min_poll_interval_ms: WAKE_MIN_POLL_INTERVAL_MS },
  })
}

/**
 * Admin face: mint, rotate and revoke agent tokens.
 * Requires `Authorization: Bearer <MESH_ADMIN_TOKEN>` (or the generated
 * data/admin.token on first boot). A minted token is returned exactly once — * the hub only keeps its SHA-256.
 *
 *   POST   /api/admin/agents   {name, host?, description?}  -> {name, token}
 *   POST   /api/admin/rotate   {name}                       -> {name, token}
 *   GET    /api/admin/agents                                -> roster (no tokens)
 *   DELETE /api/admin/agents?name=...                       -> revoke
 *   DELETE /api/admin/agents?name=...&purge=1               -> delete the row entirely
 *   GET    /api/admin/audit?limit=50                        -> recent auth/ops
 */
async function handleAdmin(req, res, url) {
  const ip = clientIp(req)
  if (!consoleAllowed(ip)) {
    audit('admin_blocked', null, ip, false)
    return sendJson(res, 403, { error: 'admin is not reachable from this address (MESH_CONSOLE_ALLOW)' })
  }
  if (!isAdmin(req)) {
    audit('admin', null, ip, false)
    return sendJson(res, 401, { error: 'admin token required' })
  }
  const path = url.pathname

  try {
    if (path === '/api/admin/agents' && req.method === 'POST') {
      const body = await readJson(req)
      const name = String(body.name ?? '').trim()
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return sendJson(res, 400, { error: 'name must match [A-Za-z0-9_-]{1,32}' })
      const token = mintToken('mesh')
      const ts = now()
      const expiry = parseTokenExpiry(body.expires_at)
      if (expiry.error) return sendJson(res, 400, { error: expiry.error })
      const existing = db.prepare('SELECT name FROM agents WHERE name = ?').get(name)
      if (existing) {
        db.prepare('UPDATE agents SET token_hash = ?, token_expires_at = ?, host = COALESCE(?, host), description = COALESCE(?, description) WHERE name = ?')
          .run(hashToken(token), expiry.value, body.host ?? null, body.description ?? null, name)
      } else {
        db.prepare('INSERT INTO agents (name, host, description, first_seen, last_seen, token_hash, token_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(name, body.host ?? null, body.description ?? null, ts, ts, hashToken(token), expiry.value)
      }
      audit('admin.mint', name, ip, true)
      return sendJson(res, 201, {
        name,
        token,
        expires_at: expiry.value,
        note: 'store this now — only its SHA-256 is kept and it cannot be shown again; rotate to get a new one',
      })
    }

    if (path === '/api/admin/rotate' && req.method === 'POST') {
      const body = await readJson(req)
      const name = String(body.name ?? '').trim()
      const row = db.prepare('SELECT name FROM agents WHERE name = ?').get(name)
      if (!row) return sendJson(res, 404, { error: `unknown agent "${name}"` })
      const expiry = parseTokenExpiry(body.expires_at)
      if (expiry.error) return sendJson(res, 400, { error: expiry.error })
      const token = mintToken('mesh')
      db.prepare('UPDATE agents SET token_hash = ?, token_expires_at = ? WHERE name = ?').run(hashToken(token), expiry.value, name)
      audit('admin.rotate', name, ip, true)
      return sendJson(res, 200, { name, token, expires_at: expiry.value, note: 'previous token is now invalid' })
    }

    if ((path === '/api/admin/enroll/approve' || path === '/api/admin/enroll/deny') && req.method === 'POST') {
      const body = await readJson(req)
      const result = decideDevice(body, path.endsWith('/approve'), ip)
      return sendJson(res, result.status, result.body)
    }

    if (path === '/api/admin/enroll-codes' && req.method === 'POST') {
      const body = await readJson(req)
      const name = body.name === undefined ? '' : String(body.name).trim()
      if (name && !/^[A-Za-z0-9_-]{1,32}$/.test(name)) return sendJson(res, 400, { error: 'name must match [A-Za-z0-9_-]{1,32}' })
      const expiry = parseTokenExpiry(body.expires_at)
      if (expiry.error) return sendJson(res, 400, { error: expiry.error })
      const code = mintEnrollCode(name || null, expiry.value)
      audit('admin.enroll_code', name || null, ip, true)
      return sendJson(res, 201, { code, name: name || null, expires_at: expiry.value, expires_in_seconds: ENROLL_CODE_TTL_MS / 1000 })
    }

    if (path === '/api/admin/board' && req.method === 'GET') {
      const key = String(url.searchParams.get('key') ?? '').trim()
      if (key) {
        const row = db.prepare('SELECT key, value, updated_by, updated_at, owner, status, version, visible_to FROM board WHERE key = ?').get(key)
        if (!row) return sendJson(res, 404, { key, found: false })
        return sendJson(res, 200, row)
      }
      const rows = db.prepare('SELECT key, value, updated_by, updated_at, owner, status, version, visible_to FROM board ORDER BY key').all()
      return sendJson(res, 200, { count: rows.length, entries: rows })
    }

    if (path === '/api/admin/agents' && req.method === 'GET') {
      const rows = db.prepare('SELECT name, host, description, first_seen, last_seen, token_hash FROM agents ORDER BY name').all()
      const ts = now()
      return sendJson(res, 200, {
        agents: rows.map((r) => ({
          name: r.name,
          host: r.host,
          description: r.description,
          online: ts - r.last_seen <= ONLINE_TTL_MS,
          last_seen_seconds_ago: Math.round((ts - r.last_seen) / 1000),
          last_seen_at: new Date(r.last_seen).toISOString(),
          has_token: Boolean(r.token_hash),
        })),
      })
    }

    if (path === '/api/admin/agents' && req.method === 'DELETE') {
      const name = String(url.searchParams.get('name') ?? '').trim()
      if (!name) return sendJson(res, 400, { error: 'name is required' })
      if (url.searchParams.get('purge') === '1') {
        // Full removal: the row (and with it wake_url/wake_secret) is gone, not just revoked.
        const result = db.prepare('DELETE FROM agents WHERE name = ?').run(name)
        audit('admin.purge', name, ip, true)
        return sendJson(res, 200, { name, purged: Number(result.changes ?? 0) > 0 })
      }
      const result = db.prepare('UPDATE agents SET token_hash = NULL WHERE name = ?').run(name)
      audit('admin.revoke', name, ip, true)
      return sendJson(res, 200, { name, revoked: Number(result.changes ?? 0) > 0 })
    }

    if (path === '/api/admin/audit' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 500)
      const rows = db.prepare('SELECT at, agent, action, ip, ok FROM audit ORDER BY id DESC LIMIT ?').all(limit)
      return sendJson(res, 200, { count: rows.length, entries: rows })
    }

    return sendJson(res, 404, { error: 'unknown admin endpoint' })
  } catch (error) {
    return sendJson(res, 400, { error: error.message })
  }
}

const makeServer = TLS_ENABLED
  ? (handler) => createHttpsServer({ cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) }, handler)
  : (handler) => createHttpServer(handler)

const httpServer = makeServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    const blobStats = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM blobs').get()
    res.end(JSON.stringify({ ok: true, service: 'dsh-mesh', version: HUB_VERSION, sessions: sessions.size, persisted_sessions: db.prepare('SELECT COUNT(*) AS n FROM mcp_sessions').get().n, lenient_session: MCP_LENIENT_SESSION, session_cap: MAX_SESSIONS, wake: Boolean(WAKE_SECRET), relay: RELAY_ENABLED ? RELAY_TARGET : null, blobs: { count: blobStats.n, bytes: blobStats.bytes, max_file: MAX_BLOB_BYTES, max_chunk: MAX_BLOB_CHUNK_BYTES, max_total: MAX_BLOB_TOTAL_BYTES },
      pinned_messages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE pinned = 1').get().n, uptime_seconds: Math.round(process.uptime()) }))
    return
  }

  if (url.pathname === '/console' || url.pathname.startsWith('/console/')) {
    await handleConsole(req, res, url)
    return
  }

  if (url.pathname.startsWith('/api/admin/')) {
    await handleAdmin(req, res, url)
    return
  }

  if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
    await handleBootstrap(req, res)
    return
  }

  if (url.pathname === '/api/enroll/request' || url.pathname === '/api/enroll/token') {
    await handleDeviceEnroll(req, res, url)
    return
  }

  if (url.pathname === '/api/enroll') {
    await handleEnroll(req, res)
    return
  }

  if (url.pathname.startsWith('/api/')) {
    await handleRest(req, res, url)
    return
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', hint: 'MCP endpoint is /mcp, health is /health' }))
    return
  }

  if (req.method === 'POST') {
    let parsed
    try {
      const raw = await readBody(req)
      parsed = raw.length ? JSON.parse(raw.toString('utf8')) : undefined
    } catch (error) {
      if (error instanceof PayloadTooLarge) {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: error.message } }))
        return
      }
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
      return
    }
    try {
      await handleMcp(req, res, parsed)
    } catch (error) {
      console.error('[mesh] POST /mcp failed:', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: error.message } }))
      }
    }
    return
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    const id = resolveIdentity(req)
    if (!id.ok) {
      res.writeHead(id.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: id.reason }))
      return
    }
    const found = sessionFor(req, id.name)
    if (!found.entry) {
      res.writeHead(found.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: found.error }))
      return
    }
    await found.entry.transport.handleRequest(req, res)
    return
  }

  res.writeHead(405, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'method not allowed' }))
})

setInterval(() => {
  try {
    purgeExpired()
    sweepBlobs()
  } catch (error) {
    console.error('[mesh] purge failed:', error.message)
  }
}, PURGE_INTERVAL_MS).unref()

// Every minute: expire idle MCP sessions (ungraceful client shutdowns) and forget
// stale failure counters, so memory stays flat over months of uptime.
// Sweep often enough to honour the idle window, but never busier than once a minute.
const SWEEP_INTERVAL_MS = Math.min(60_000, Math.max(5_000, Math.floor(SESSION_IDLE_MS / 2)))
setInterval(() => {
  try {
    sweepSessions()
    sweepFailures()
    sweepEnrollState()
  } catch (error) {
    console.error('[mesh] sweep failed:', error.message)
  }
}, SWEEP_INTERVAL_MS).unref()

/**
 * Resolve the admin credential.
 * Precedence: MESH_ADMIN_TOKEN env > data/admin.token file > freshly minted.
 * A minted token is persisted with owner-only permissions so restarts keep it.
 */
function resolveAdminToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN
  if (AUTH_MODE !== 'token') return ''
  const file = join(DATA_DIR, 'admin.token')
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim()
    if (stored) return stored
  }
  const minted = mintToken('admin')
  writeFileSync(file, `${minted}\n`, { mode: 0o600 })
  console.log('[mesh] no MESH_ADMIN_TOKEN set — generated one')
  console.log(`[mesh]   file  : ${file}  (mode 600)`)
  console.log('[mesh]   read it on the host: cat <that file> -- not printed here by default,')
  console.log('[mesh]   because docker logs keep stdout for a long time. Set MESH_PRINT_ADMIN_TOKEN=1')
  console.log('[mesh]   if you accept that trade-off (e.g. one-shot local testing).')
  if (process.env.MESH_PRINT_ADMIN_TOKEN === '1') console.log(`[mesh]   token : ${minted}`)
  return minted
}
ADMIN_TOKEN = resolveAdminToken()

httpServer.listen(PORT, HOST, () => {
  const scheme = TLS_ENABLED ? 'https' : 'http'
  console.log(`[mesh] listening on ${scheme}://${HOST}:${PORT}/mcp  (health: /health)`)
  console.log(`[mesh] data: ${join(DATA_DIR, 'mesh.db')}  online TTL: ${ONLINE_TTL_MS / 1000}s`)
  console.log(`[mesh] transport: ${TLS_ENABLED ? `TLS on (${TLS_CERT_FILE})` : 'plain HTTP — put TLS in front of it before crossing an untrusted network'}`)
  console.log(`[mesh] auth mode: ${AUTH_MODE}${AUTH_MODE === 'token' ? '  (bearer token required for /mcp and /api)' : '  (NO app-level auth — LAN only)'}`)
  if (AUTH_MODE === 'token') console.log(`[mesh] admin endpoints: /api/admin/agents | rotate | audit  (token in ${ADMIN_TOKEN === process.env.MESH_ADMIN_TOKEN ? 'MESH_ADMIN_TOKEN' : `${join(DATA_DIR, 'admin.token')}`})`)
  if (!TLS_ENABLED && VIEW_TOKEN) {
    const sources = CONSOLE_ALLOW || 'loopback only (default; set MESH_CONSOLE_ALLOW to widen)'
    console.warn(`[mesh] WARN console/admin over plain HTTP (no MESH_TLS_CERT); allowed sources: ${sources}`)
  }
  const legacyScopes = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE scopes = ''").get().n
  if (legacyScopes) console.warn(`[mesh] ${legacyScopes} 个节点 scopes 为空串（等价全权），建议在控制台重新设置`)
})
