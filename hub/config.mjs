/**
 * hub/config.mjs — every environment-derived value the hub reads, parsed once at
 * import time (no lazy loading: start-up env reads must stay at module top level).
 *
 * Variables and defaults (all optional unless noted):
 *   MESH_MIN_WAKER                0.4.0      oldest waker build the hub understands (advisory)
 *   MESH_VIEW_TOKEN               —          read-only console token; falls back to MESH_ADMIN_TOKEN
 *   MESH_CONSOLE_ALLOW            ''         console/admin source allow-list; empty = loopback only
 *   MESH_PORT                     8790
 *   MESH_HOST                     0.0.0.0
 *   MESH_DATA_DIR                 <hub>/data SQLite, admin.token and blobs
 *   MESH_ONLINE_TTL_MS            120000
 *   MESH_MESSAGE_TTL_MS           604800000  read mail retention (7 days)
 *   MESH_PURGE_INTERVAL_MS        3600000    sweep interval, clamped to >= 1000
 *   MESH_MAX_UNREAD_MESSAGES      0          0 = backlog alarm off
 *   MESH_MAX_BODY_BYTES           1048576
 *   MESH_MAX_MESSAGE_BYTES        65536
 *   MESH_MAX_BOARD_BYTES          65536
 *   MESH_MAX_BLOB_BYTES           67108864
 *   MESH_MAX_BLOB_CHUNK_BYTES     8388608
 *   MESH_MAX_BLOB_TOTAL_BYTES     2147483648
 *   MESH_BLOB_TTL_MS              86400000
 *   MESH_SESSION_IDLE_MS          1800000
 *   MESH_MCP_SESSION_TTL_MS       604800000
 *   MESH_MCP_LENIENT_SESSION      off       1/true/yes/on enables lenient rebuild
 *   MESH_MAX_SESSIONS             128
 *   MESH_LOG_TTL_MS               2592000000
 *   MESH_LOG_MAX_ROWS             20000
 *   MESH_RELAY_TARGET             127.0.0.1:18642
 *   MESH_RELAY_API_KEY            ''
 *   MESH_RELAY_MODEL              deepseek/deepseek-v4.1-flash
 *   MESH_RELAY_TIMEOUT_MS         180000
 *   MESH_AUTH_MODE                token      token | open
 *   MESH_ADMIN_TOKEN              ''         REQUIRED in token mode (generated on first boot)
 *   MESH_TRUST_PROXY              0          trust X-Forwarded-For only when 1
 *   MESH_WAKE_SECRET              ''
 *   MESH_WAKE_TIMEOUT_MS          3000
 *   MESH_WAKE_DEBOUNCE_MS         2000
 *   MESH_TLS_CERT                 ''
 *   MESH_TLS_KEY                  ''
 *   MESH_TLS_CA_FILE              ''         (read by the bootstrap endpoint)
 *   MESH_PRINT_ADMIN_TOKEN        0
 *
 * Side effects (mkdir, validation, process.exit) deliberately stay in server.mjs.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const bool = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase())
const num = (value, fallback) => Number(value ?? fallback)

export const MIN_WAKER = process.env.MESH_MIN_WAKER || '0.4.0'
export const VIEW_TOKEN = process.env.MESH_VIEW_TOKEN || process.env.MESH_ADMIN_TOKEN || null
export const CONSOLE_ALLOW = String(process.env.MESH_CONSOLE_ALLOW ?? '').trim()
export const PORT = num(process.env.MESH_PORT, 8790)
export const HOST = process.env.MESH_HOST ?? '0.0.0.0'
export const DATA_DIR = process.env.MESH_DATA_DIR ?? join(HERE, 'data')
export const ONLINE_TTL_MS = num(process.env.MESH_ONLINE_TTL_MS, 120_000)
export const MESSAGE_TTL_MS = num(process.env.MESH_MESSAGE_TTL_MS, 7 * 24 * 3600_000)
export const PURGE_INTERVAL_MS = Math.max(1000, num(process.env.MESH_PURGE_INTERVAL_MS, 3600_000))
export const MAX_UNREAD_MESSAGES = num(process.env.MESH_MAX_UNREAD_MESSAGES, 0)
export const MAX_BODY_BYTES = num(process.env.MESH_MAX_BODY_BYTES, 1_048_576)
export const MAX_MESSAGE_BYTES = num(process.env.MESH_MAX_MESSAGE_BYTES, 65_536)
export const MAX_BOARD_BYTES = num(process.env.MESH_MAX_BOARD_BYTES, 65_536)
export const MAX_BLOB_BYTES = num(process.env.MESH_MAX_BLOB_BYTES, 64 * 1024 * 1024)
export const MAX_BLOB_CHUNK_BYTES = num(process.env.MESH_MAX_BLOB_CHUNK_BYTES, 8 * 1024 * 1024)
export const MAX_BLOB_TOTAL_BYTES = num(process.env.MESH_MAX_BLOB_TOTAL_BYTES, 2 * 1024 * 1024 * 1024)
export const BLOB_TTL_MS = num(process.env.MESH_BLOB_TTL_MS, 24 * 3600_000)
export const SESSION_IDLE_MS = num(process.env.MESH_SESSION_IDLE_MS, 30 * 60_000)
export const MCP_SESSION_TTL_MS = num(process.env.MESH_MCP_SESSION_TTL_MS, 7 * 24 * 3600_000)
export const MCP_LENIENT_SESSION = bool(process.env.MESH_MCP_LENIENT_SESSION)
export const MAX_SESSIONS = num(process.env.MESH_MAX_SESSIONS, 128)
export const LOG_KEEP_MS = num(process.env.MESH_LOG_TTL_MS, 30 * 24 * 3600_000)
export const LOG_KEEP_ROWS = num(process.env.MESH_LOG_MAX_ROWS, 20_000)
export const RELAY_TARGET = process.env.MESH_RELAY_TARGET ?? '127.0.0.1:18642'
export const RELAY_API_KEY = process.env.MESH_RELAY_API_KEY ?? ''
export const RELAY_MODEL = process.env.MESH_RELAY_MODEL ?? 'deepseek/deepseek-v4.1-flash'
export const RELAY_TIMEOUT_MS = num(process.env.MESH_RELAY_TIMEOUT_MS, 180_000)
export const RELAY_ENABLED = Boolean(RELAY_API_KEY)
export const AUTH_MODE = process.env.MESH_AUTH_MODE ?? 'token'
export const ADMIN_TOKEN = process.env.MESH_ADMIN_TOKEN ?? ''
export const TRUST_PROXY = process.env.MESH_TRUST_PROXY === '1'
export const WAKE_SECRET = process.env.MESH_WAKE_SECRET ?? ''
export const WAKE_TIMEOUT_MS = num(process.env.MESH_WAKE_TIMEOUT_MS, 3000)
export const WAKE_DEBOUNCE_MS = num(process.env.MESH_WAKE_DEBOUNCE_MS, 2000)
export const TLS_CERT_FILE = process.env.MESH_TLS_CERT ?? ''
export const TLS_KEY_FILE = process.env.MESH_TLS_KEY ?? ''
export const TLS_ENABLED = Boolean(TLS_CERT_FILE && TLS_KEY_FILE)

export const config = {
  MIN_WAKER, VIEW_TOKEN, CONSOLE_ALLOW, PORT, HOST, DATA_DIR, ONLINE_TTL_MS, MESSAGE_TTL_MS,
  PURGE_INTERVAL_MS, MAX_UNREAD_MESSAGES, MAX_BODY_BYTES, MAX_MESSAGE_BYTES, MAX_BOARD_BYTES,
  MAX_BLOB_BYTES, MAX_BLOB_CHUNK_BYTES, MAX_BLOB_TOTAL_BYTES, BLOB_TTL_MS, SESSION_IDLE_MS,
  MCP_SESSION_TTL_MS, MCP_LENIENT_SESSION, MAX_SESSIONS, LOG_KEEP_MS, LOG_KEEP_ROWS,
  RELAY_TARGET, RELAY_API_KEY, RELAY_MODEL, RELAY_TIMEOUT_MS, RELAY_ENABLED, AUTH_MODE,
  ADMIN_TOKEN, TRUST_PROXY, WAKE_SECRET, WAKE_TIMEOUT_MS, WAKE_DEBOUNCE_MS,
  TLS_CERT_FILE, TLS_KEY_FILE, TLS_ENABLED,
}

export default config
