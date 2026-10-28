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
