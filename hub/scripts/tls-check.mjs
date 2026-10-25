/**
 * Verify the TLS transport and the token gate over it.
 * Run with NODE_EXTRA_CA_CERTS pointing at data/tls/ca.crt so Node trusts the
 * self-signed cert, exactly like a DSH host would have to be configured.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.MESH_BASE ?? 'https://127.0.0.1:8790'

function readAdminToken() {
  if (process.env.MESH_ADMIN_TOKEN) return process.env.MESH_ADMIN_TOKEN
  const file = process.env.MESH_ADMIN_FILE ?? join(HERE, '..', 'data', 'admin.token')
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    console.error(`cannot read the admin token: set MESH_ADMIN_TOKEN, or MESH_ADMIN_FILE=<path>.`)
    console.error(`tried: ${file}`)
    process.exit(2)
  }
}
const admin = readAdminToken()

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

// 1. plain HTTP must not be served on this port any more
let plainHttpRejected = false
try {
  const res = await fetch(BASE.replace('https://', 'http://') + '/health', { signal: AbortSignal.timeout(3000) })
  plainHttpRejected = false
} catch {
  plainHttpRejected = true
}
check('TLS-only port refuses plain HTTP', plainHttpRejected)

// 2. TLS with a trusted CA works
const health = await fetch(`${BASE}/health`)
check('health over TLS', health.ok, `HTTP ${health.status}`)

// 3. token gate still applies over TLS
const anon = await fetch(`${BASE}/api/status`)
check('unauthenticated request rejected over TLS', anon.status === 401, `HTTP ${anon.status}`)

const authed = await fetch(`${BASE}/api/admin/agents`, { headers: { authorization: `Bearer ${admin}` } })
const body = await authed.json()
check('admin token accepted over TLS', authed.ok && Array.isArray(body.agents), `${body.agents?.length ?? '?'} agents`)

// 3b. a minted agent token works against the agent face
const minted = await fetch(`${BASE}/api/admin/agents`, {
  method: 'POST',
  headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'tls-probe' }),
}).then((r) => r.json())
const agentStatus = await fetch(`${BASE}/api/status`, { headers: { authorization: `Bearer ${minted.token}` } })
check('minted agent token accepted over TLS', agentStatus.ok, `HTTP ${agentStatus.status}`)

// 4. a wrong token is still rejected with TLS on
const wrong = await fetch(`${BASE}/api/status`, { headers: { authorization: 'Bearer mesh_wrong' } })
check('wrong token rejected over TLS', wrong.status === 401, `HTTP ${wrong.status}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
