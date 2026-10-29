#!/usr/bin/env node
/**
 * check-paths.mjs — gate against machine-local absolute paths and real LAN topology.
 *
 * The public repo must stay usable by anyone: no C:\... / D:\... paths, no \\NAS\share,
 * no private 192.168.x.y addresses, no usernames baked into node ids.
 *
 * Usage: node scripts/check-paths.mjs [--json]
 * Exit:  0 clean, 1 hits. Scans files tracked by git (git ls-files).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SELF = 'scripts/check-paths.mjs'

// Placeholders that are intentionally part of the docs/examples (see AGENTS.md C 类).
const PLACEHOLDER_FILES = new Set([
  'plugins/mesh-waker/cordis.patch.example.yml', // C:\Users\YOU..., D:\path\to\workdir
])
// Changelogs quote historical defects verbatim; they are history, not a leak.
const HISTORICAL_FILES = new Set(['hub/CHANGES.md'])
// Author/repo metadata is allowed by name; usernames are part of the upstream identity.
const MARKER_ALLOWLIST = new Set(['LICENSE', 'plugins/mesh-waker/package.json'])
// Fake-but-consistent example ranges (docs examples and the hub default allowlist).
const ALLOWED_LAN = new Set(['192.168.0.0/16', '192.168.1.0/24', '192.168.1.50', '192.168.1.10'])

// Anything outside these ranges is treated as a real public address (RFC 5737 / 2606 examples included).
function isPublicIpv4(match) {
  const octets = match.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a, b, c, d] = octets
  if (a === 10) return false // 10/8
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16/12
  if (a === 192 && b === 168) return false // 192.168/16
  if (a === 127) return false // loopback
  if (a === 169 && b === 254) return false // link-local
  if (a === 0 && b === 0 && c === 0 && d === 0) return false
  if (a === 255 && b === 255 && c === 255 && d === 255) return false
  if (a === 192 && b === 0 && c === 2) return false // 192.0.2/24 (docs)
  if (a === 198 && b === 51 && c === 100) return false // 198.51.100/24 (docs)
  if (a === 203 && b === 0 && c === 113) return false // 203.0.113/24 (docs)
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18/15 (benchmark)
  return true
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.webm', '.ogg',
])

const RULES = [
  {
    name: 'drive-path',
    regex: /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])[^\s"'<>|`]*/g,
    reason: '盘符绝对路径',
    allow: (match) => /^[A-Za-z]:[\\/]path[\\/]to[\\/]/i.test(match),
  },
  {
    name: 'unc-path',
    regex: /\\\\[A-Za-z0-9_.\-]+\\[A-Za-z0-9_.$\-]+/g,
    reason: 'UNC 网络路径',
    allow: () => false,
  },
  {
    name: 'lan-ip',
    regex: /192\.168\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?/g,
    reason: '内网 IP',
    allow: (match) => ALLOWED_LAN.has(match),
  },
  {
    name: 'public-ipv4',
    regex: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    reason: '公网 IP（疑似真实服务器地址）；示例请用 203.0.113.x / 198.51.100.x',
    allow: (match) => !isPublicIpv4(match),
  },
  {
    name: 'local-topology',
    // Written with escapes so this gate itself does not carry the literal fingerprints.
    regex: /\u534E\u6570|FAC1(?:)200R|fn(?:)OS/g,
    reason: '本环境拓扑指纹（设备/运营商特征）',
    allow: () => false,
  },
  {
    name: 'local-marker',
    regex: /KANIOL|matebooke2016|kaniol-pc/gi,
    reason: '本机标识',
    allow: () => false,
  },
]

function matchesOf(regex, line) {
  const found = []
  regex.lastIndex = 0
  let match
  while ((match = regex.exec(line)) !== null) {
    found.push(match[0])
    if (match.index === regex.lastIndex) regex.lastIndex += 1
  }
  return found
}

function markerAllowed(file) {
  if (MARKER_ALLOWLIST.has(file)) return true
  return /^README(\.[A-Za-z-]+)?\.md$/i.test(path.basename(file))
}

function isBinary(buffer) {
  return buffer.includes(0)
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/check-paths.mjs [--json]')
    process.exit(0)
  }
  return { json: argv.includes('--json') }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  let files
  try {
    files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  } catch (error) {
    console.error(`check-paths: cannot run git ls-files: ${error.message}`)
    process.exit(1)
  }

  const issues = []
  let scanned = 0
  for (const file of files) {
    if (file === SELF) continue
    if (PLACEHOLDER_FILES.has(file) || HISTORICAL_FILES.has(file)) continue
    if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    let buffer
    try {
      buffer = readFileSync(file)
    } catch {
      continue
    }
    if (isBinary(buffer)) continue
    scanned += 1
    const lines = buffer.toString('utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const reported = new Set()
      for (const rule of RULES) {
        if (rule.name === 'local-marker' && markerAllowed(file)) continue
        for (const match of matchesOf(rule.regex, line)) {
          if (rule.allow(match)) continue
          const key = `${rule.name}:${index + 1}`
          if (reported.has(key)) continue
          reported.add(key)
          issues.push({ file, line: index + 1, rule: rule.name, match, reason: rule.reason })
        }
      }
    })
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: issues.length === 0, scanned, issues }, null, 2))
    process.exit(issues.length === 0 ? 0 : 1)
  }

  for (const issue of issues) console.log(`${issue.file}:${issue.line}: ${issue.reason}（${issue.match}）`)
  if (issues.length === 0) {
    console.log(`check-paths: OK（${scanned} files）`)
    return
  }
  console.log(`check-paths: ${issues.length} hit(s)`)
  process.exit(1)
}

main()
