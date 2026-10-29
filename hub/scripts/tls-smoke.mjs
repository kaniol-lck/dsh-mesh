/**
 * Loopback TLS smoke test for the hub.
 *
 * Boots a throwaway hub on 127.0.0.1 with a freshly generated self-signed cert and
 * checks the transport boundary:
 *   * HTTPS /health is 200;
 *   * plain HTTP on the same port is not served (Node answers 400 or drops the socket);
 *   * /api/status without a token is still 401 over TLS.
 *
 * The child is killed and its temp data directory removed afterwards. Everything stays on
 * loopback: no NAS, no external network, no real credentials.
 *
 * Run from hub/:  node scripts/tls-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import selfsigned from 'selfsigned'

const HERE = dirname(fileURLToPath(import.meta.url))
const HUB = join(HERE, '..')

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

function request(module, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = module.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers, rejectUnauthorized: false },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const dir = mkdtempSync(join(tmpdir(), 'mesh-tls-smoke-'))
const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
  days: 1,
  keySize: 2048,
  extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
})
const cert = join(dir, 'server.crt')
const key = join(dir, 'server.key')
writeFileSync(cert, pems.cert)
writeFileSync(key, pems.private)

const port = await freePort()
const child = spawn(process.execPath, [join(HUB, 'server.mjs')], {
  cwd: HUB,
  env: {
    ...process.env,
    MESH_HOST: '127.0.0.1',
    MESH_PORT: String(port),
    MESH_DATA_DIR: join(dir, 'data'),
    MESH_ADMIN_TOKEN: 'tls' + '-smoke-admin',
    MESH_TLS_CERT: cert,
    MESH_TLS_KEY: key,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk })

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

try {
  let ready = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request(https, port, '/health')
      if (response.status === 200) { ready = true; break }
    } catch { /* not up yet */ }
    await wait(200)
  }
  if (!ready) throw new Error(`hub did not start over TLS\n${stderr.slice(-1000)}`)

  const health = await request(https, port, '/health')
  check('https /health is 200', health.status === 200, `HTTP ${health.status}`)

  let plain
  try {
    plain = await request(http, port, '/health')
  } catch (error) {
    plain = { status: null, error: error.message }
  }
  check(
    'plain HTTP is refused on the TLS port',
    plain.status === 400 || plain.status === null,
    plain.status === null ? `transport error: ${plain.error}` : `HTTP ${plain.status}`,
  )

  const anonymous = await request(https, port, '/api/status')
  check('unauthenticated /api/status is 401 over TLS', anonymous.status === 401, `HTTP ${anonymous.status}`)
} catch (error) {
  console.error(`tls-smoke error: ${error.message}`)
  failures.push('setup')
} finally {
  child.kill()
  await wait(300)
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\ntls-smoke: ${3 - failures.length}/3 passed`)
if (failures.length) process.exitCode = 1
