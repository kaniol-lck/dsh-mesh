#!/usr/bin/env node
/**
 * check-docs-drift.mjs — documents carry a version signature; report when it is stale.
 *
 * Signature (first line, invisible on GitHub):
 *   <!-- drift: waker=^0.8.0 hub=^0.7.21 owner=docs -->
 * Versions support caret ^x.y.z, tilde ~x.y.z, exact x.y.z and * (concept doc,
 * never drifts). owner is a role slug (waker|docs|hub|ops|协调).
 *
 * Current versions come from plugins/mesh-waker/package.json and hub/package.json;
 * nothing is hard-coded here.
 *
 * Default is report-only (exit 0). --strict exits 1 when any document drifted, for
 * a later CI step. CHANGELOG.md / AGENTS.md / REFS.md are exempt (per-release or
 * local-only files). Text and --json are built from the same per-file results.
 *
 * Exit codes: 0 report-only or clean, 1 strict with drift, 2 usage error.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_SOURCES = {
  waker: 'plugins/mesh-waker/package.json',
  hub: 'hub/package.json',
}
const EXEMPT = [/CHANGELOG\.md$/i, /(^|\/)AGENTS\.md$/, /(^|\/)REFS\.md$/]
const USAGE = `check-docs-drift.mjs — document version signatures vs current versions

Usage:
  node check-docs-drift.mjs [--paths a,b] [--strict] [--json] [--help]

Signature (first line, HTML comment so it stays invisible):
  <!-- drift: waker=^0.8.0 hub=^0.7.21 owner=docs -->
  Ranges: ^x.y.z (same major, >=), ~x.y.z (same minor, >=), exact x.y.z, or *
  (* = concept doc, never drifts). owner must be a role slug.

Status:
  ok        signature range contains the current version
  drift     signature range does not contain it (document is stale)
  unsigned  no signature line
  exempt    CHANGELOG.md / AGENTS.md / REFS.md

Default exits 0 (report only); --strict exits 1 when drift > 0.
Exit codes: 0 report-only or clean, 1 strict with drift, 2 usage error.`

function defaultPaths() {
  const docs = path.join(ROOT, 'docs')
  const paths = []
  if (existsSync(docs)) {
    for (const entry of readdirSync(docs).sort()) if (entry.endsWith('.md')) paths.push(`docs/${entry}`)
  }
  for (const rel of ['README.md', 'README.en.md', 'CONTRIBUTING.md']) if (existsSync(path.join(ROOT, rel))) paths.push(rel)
  return paths
}

function parseArgs(argv) {
  const options = { paths: null, strict: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--paths') {
      const value = argv[index + 1]
      if (value === undefined) {
        console.error(`--paths requires a value\n\n${USAGE}`)
        process.exit(2)
      }
      options.paths = value.split(',').map((item) => item.trim()).filter(Boolean)
      index += 1
    } else if (arg === '--strict') options.strict = true
    else if (arg === '--json') options.json = true
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  return options
}

export function currentVersions() {
  const versions = {}
  for (const [key, rel] of Object.entries(VERSION_SOURCES)) {
    versions[key] = JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8')).version
  }
  return versions
}

/** Parse "waker=^0.8.0 hub=^0.7.21 owner=docs" into {waker, hub, owner}. */
export function parseSignature(line) {
  const match = /^<!--\s*drift:\s*(.*?)\s*-->/.exec(line.trim())
  if (!match) return null
  const signature = {}
  for (const token of match[1].split(/\s+/)) {
    const [key, value] = token.split('=')
    if (key && value) signature[key] = value
  }
  return signature.owner ? signature : null
}

/** Does range contain version? Supports *, ^x.y.z, ~x.y.z and exact. */
export function rangeContains(range, version) {
  if (!range || !version) return false
  if (range === '*') return true
  const parse = (text) => text.replace(/^[\^~]/, '').split('.').map(Number)
  const target = parse(version)
  const base = parse(range)
  if (target.some(Number.isNaN) || base.some(Number.isNaN)) return false
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0)
    return 0
  }
  if (compare(target, base) < 0) return false
  if (range.startsWith('^')) {
    if (target[0] !== base[0]) return false
    // npm caret for 0.x pins the minor: ^0.7.0 is >=0.7.0 <0.8.0
    return base[0] !== 0 || target[1] === base[1]
  }
  if (range.startsWith('~')) return target[0] === base[0] && target[1] === base[1]
  return compare(target, base) === 0
}

function classify(rel, versions) {
  if (EXEMPT.some((pattern) => pattern.test(rel))) return { path: rel, status: 'exempt', signature: null, owner: null }
  const absolute = path.join(ROOT, rel)
  if (!existsSync(absolute)) return { path: rel, status: 'unsigned', signature: null, owner: null, missing: true }
  const firstLine = readFileSync(absolute, 'utf8').split(/\r?\n/, 1)[0] ?? ''
  const signature = parseSignature(firstLine)
  if (!signature) return { path: rel, status: 'unsigned', signature: null, owner: null }
  const declared = {}
  let drifted = false
  for (const key of Object.keys(VERSION_SOURCES)) {
    if (signature[key] === undefined) continue
    declared[key] = signature[key]
    if (!rangeContains(signature[key], versions[key])) drifted = true
  }
  return {
    path: rel,
    status: drifted ? 'drift' : 'ok',
    signature: firstLine.trim(),
    owner: signature.owner,
    declared,
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const paths = options.paths ?? defaultPaths()
  const versions = currentVersions()
  const files = paths.map((rel) => classify(rel, versions))
  const okCount = files.filter((file) => file.status === 'ok').length
  const driftCount = files.filter((file) => file.status === 'drift').length
  const unsignedCount = files.filter((file) => file.status === 'unsigned').length
  const exemptCount = files.filter((file) => file.status === 'exempt').length

  const report = {
    versionSources: VERSION_SOURCES,
    versions,
    checkedCount: files.length,
    okCount,
    driftCount,
    unsignedCount,
    exemptCount,
    driftedFiles: files.filter((file) => file.status === 'drift').map((file) => file.path),
    unsignedFiles: files.filter((file) => file.status === 'unsigned').map((file) => file.path),
    files,
    ok: driftCount === 0,
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const header = '文件'.padEnd(34) + '署名'.padEnd(40) + '当前'.padEnd(26) + '负责人'.padEnd(8) + '状态'
    console.log(header)
    for (const file of files) {
      const signature = file.declared
        ? Object.entries(file.declared).map(([key, value]) => `${key} ${value}`).join(' ')
        : '—'
      const current = file.declared
        ? Object.keys(file.declared).map((key) => `${key} ${versions[key]}`).join(' ')
        : '—'
      console.log(
        file.path.padEnd(34) + signature.padEnd(40) + current.padEnd(26) + (file.owner ?? '—').padEnd(8) + file.status.toUpperCase(),
      )
    }
    console.log('-'.repeat(96))
    console.log(`checked=${files.length}  ok=${okCount}  drift=${driftCount}  unsigned=${unsignedCount}  exempt=${exemptCount}`)
    if (driftCount) console.log(`drifted: ${report.driftedFiles.join(', ')}`)
    if (unsignedCount) console.log(`unsigned: ${report.unsignedFiles.join(', ')}`)
  }
  process.exit(options.strict && driftCount ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
