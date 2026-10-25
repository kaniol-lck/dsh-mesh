/**
 * Issue a self-signed CA and a server certificate for dsh-mesh.
 *
 * Design notes:
 *  - The CA is created once and then reused, so rotating the server cert does
 *    not force every client to re-trust a new root.
 *  - SANs must cover the address clients actually type. Behind an frp TCP
 *    tunnel the client connects to the frps address, so that IP/DNS must be in
 *    the SAN — not the hub-host LAN address.
 *  - Clients trust the CA with NODE_EXTRA_CA_CERTS=ca.crt.
 *
 * Usage:
 *   node scripts/make-cert.mjs --out certs --ip 203.0.113.10 --dns mesh.example.com
 *   node scripts/make-cert.mjs --out certs --ip 203.0.113.10 --days 3650 --force
 */
import fs from 'node:fs'
import path from 'node:path'
import selfsigned from 'selfsigned'

function parseArgs(argv) {
  const opts = { out: 'certs', dns: [], ip: [], days: 3650, force: false, cn: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') opts.out = argv[++i]
    else if (arg === '--dns') opts.dns.push(argv[++i])
    else if (arg === '--ip') opts.ip.push(argv[++i])
    else if (arg === '--days') opts.days = Number(argv[++i])
    else if (arg === '--cn') opts.cn = argv[++i]
    else if (arg === '--force') opts.force = true
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.dns.length && !opts.ip.length) {
  console.error('need at least one --dns <name> or --ip <addr> (the address clients connect to)')
  process.exit(1)
}

const outDir = path.resolve(opts.out)
const caCrtPath = path.join(outDir, 'ca.crt')
const caKeyPath = path.join(outDir, 'ca.key')
const srvCrtPath = path.join(outDir, 'server.crt')
const srvKeyPath = path.join(outDir, 'server.key')
fs.mkdirSync(outDir, { recursive: true })

if (fs.existsSync(srvCrtPath) && !opts.force) {
  console.error(`${srvCrtPath} already exists; pass --force to reissue`)
  process.exit(1)
}

const expires = new Date()
expires.setDate(expires.getDate() + opts.days)

// --- CA: create once, reuse afterwards -------------------------------------
let ca
if (fs.existsSync(caCrtPath) && fs.existsSync(caKeyPath)) {
  ca = { cert: fs.readFileSync(caCrtPath, 'utf8'), private: fs.readFileSync(caKeyPath, 'utf8') }
  console.log(`reusing existing CA: ${caCrtPath}`)
} else {
  ca = await selfsigned.generate([{ name: 'commonName', value: 'dsh-mesh local CA' }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: expires,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  fs.writeFileSync(caCrtPath, ca.cert)
  fs.writeFileSync(caKeyPath, ca.private, { mode: 0o600 })
  console.log(`created CA: ${caCrtPath}`)
}

// --- server certificate signed by that CA ----------------------------------
const altNames = [
  ...opts.dns.map((value) => ({ type: 2, value })),
  ...opts.ip.map((ip) => ({ type: 7, ip })),
]
const commonName = opts.cn || opts.dns[0] || opts.ip[0]

const server = await selfsigned.generate([{ name: 'commonName', value: commonName }], {
  keyType: 'rsa',
  keySize: 2048,
  algorithm: 'sha256',
  notAfterDate: expires,
  ca: { key: ca.private, cert: ca.cert },
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ],
})

fs.writeFileSync(srvCrtPath, server.cert)
fs.writeFileSync(srvKeyPath, server.private, { mode: 0o600 })

const listed = [...opts.dns, ...opts.ip].join(', ')
console.log(`issued server cert: ${srvCrtPath}`)
console.log(`  CN  : ${commonName}`)
console.log(`  SAN : ${listed}`)
console.log(`  until: ${expires.toISOString().slice(0, 10)} (${opts.days} days)`)
console.log('')
console.log('server side:')
console.log(`  MESH_TLS_CERT=${srvCrtPath}`)
console.log(`  MESH_TLS_KEY=${srvKeyPath}`)
console.log('')
console.log('client side — copy ONLY ca.crt (never ca.key) and set:')
console.log(`  NODE_EXTRA_CA_CERTS=<path to ca.crt>`)
