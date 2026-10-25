/**
 * Container health probe.
 *
 * The old inline `fetch('http://127.0.0.1:8790/health')` was hardcoded to plain HTTP,
 * so the moment MESH_TLS_CERT was set the container reported unhealthy forever (the
 * listener only speaks TLS). This probe follows the transport the process actually
 * started, and accepts the self-signed certificate because it is talking to itself on
 * loopback — verification here would only mean "is this the cert I just generated".
 */
import http from 'node:http'
import https from 'node:https'

const tls = Boolean(process.env.MESH_TLS_CERT && process.env.MESH_TLS_KEY)
const port = Number(process.env.MESH_PORT ?? 8790)
const mod = tls ? https : http

const req = mod.get(
  { host: '127.0.0.1', port, path: '/health', rejectUnauthorized: false, timeout: 4000 },
  (res) => {
    res.resume()
    process.exit(res.statusCode === 200 ? 0 : 1)
  },
)
req.on('timeout', () => {
  req.destroy()
  process.exit(1)
})
req.on('error', () => process.exit(1))
