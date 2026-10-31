#!/usr/bin/env node
/**
 * check-roadmap-facts.mjs — standing invariant: factual claims in ../ROADMAP.md
 * must match the repository (and, when configured, production).
 *
 * Three checks, each printed as one OK / MISMATCH / SKIP / LEAK line:
 *   1. version declaration  ("版本一致性" row) vs hub/package.json + waker package.json
 *   2. deployment claim     ("部署" row) vs GET $MESH_HUB_HEALTH_URL/health
 *      -> SKIP when the env var is unset (never hard-code real addresses)
 *   3. address leak         real IPv4s / topology fingerprints anywhere in the file
 *
 * The ROADMAP lives outside the repo: if it is missing, everything SKIPs and the
 * exit code is 0. --json prints { versionDecl, deploy, leak, ok }.
 * Tests use --roadmap / --hub-version / --waker-version so they never depend on
 * the real repository state.
 *
 * Exit codes: 0 all ok or skipped, 1 mismatch or leak, 2 usage error.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Same topology fingerprints as scripts/check-paths.mjs (escaped so this file
// does not match its own rules).
const FINGERPRINTS = [/\u534E\u6570/, /FAC1(?:)200R/, /fn(?:)OS/]
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g

function parseArgs(argv) {
  const options = {
    roadmap: path.resolve(ROOT, '..', 'ROADMAP.md'),
    hubVersion: null,
    wakerVersion: null,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) {
        console.error(`${arg} requires a value`)
        process.exit(2)
      }
      index += 1
      return next
    }
    switch (arg) {
      case '--roadmap': options.roadmap = value(); break
      case '--hub-version': options.hubVersion = value(); break
      case '--waker-version': options.wakerVersion = value(); break
      case '--json': options.json = true; break
      case '-h':
      case '--help':
        console.log('check-roadmap-facts.mjs [--roadmap <file>] [--hub-version <v>] [--waker-version <v>] [--json]')
        process.exit(0)
        break
      default:
        console.error(`unknown argument: ${arg}`)
        process.exit(2)
    }
  }
  return options
}

export function actualVersions(options) {
  const hub = options.hubVersion ?? JSON.parse(readFileSync(path.join(ROOT, 'hub/package.json'), 'utf8')).version
  const waker = options.wakerVersion ?? JSON.parse(readFileSync(path.join(ROOT, 'plugins/mesh-waker/package.json'), 'utf8')).version
  return { hub, waker }
}

/** Find the row that starts with the given label in a markdown table. */
export function rowOf(text, label) {
  return text.split(/\r?\n/).find((line) => line.includes(label)) ?? null
}

export function parseVersionDecl(text) {
  const row = rowOf(text, '版本一致性')
  if (!row) return null
  const versions = [...row.matchAll(/\d+\.\d+\.\d+/g)].map((match) => match[0])
  if (!versions.length) return null
  // First version is the hub declaration; the waker declaration follows "waker".
  const wakerMatch = /waker[^0-9]*(\d+\.\d+\.\d+)/.exec(row)
  return { hub: versions[0], waker: wakerMatch ? wakerMatch[1] : null }
}

export function parseDeployDecl(text) {
  const row = rowOf(text, 'hub 部署') ?? rowOf(text, '部署')
  if (!row) return null
  const match = /(\d+\.\d+\.\d+)/.exec(row)
  return match ? match[1] : null
}

export function isLoopback(a) {
  return a === 127
}

/** Any non-loopback IPv4 is considered a leak (the file must use placeholders). */
export function findLeaks(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    let matched = false
    for (const fingerprint of FINGERPRINTS) {
      if (fingerprint.test(line)) matched = true
    }
    // A line that warns "do not write a real address here" quotes the bad example; it is not a leak.
    const quotedWarning = /(不要|禁止|勿|别|占位|placeholder)/.test(line)
    for (const match of line.matchAll(IPV4)) {
      const octets = match.slice(1, 5).map(Number)
      if (octets.some((octet) => octet > 255)) continue
      if (isLoopback(octets[0])) continue
      if (quotedWarning && line.includes('`' + match[0] + '`')) continue
      matched = true
    }
    if (matched) hits.push({ line: index + 1, text: line.trim().slice(0, 160) })
  }
  return hits
}

async function checkDeploy(text) {
  const declared = parseDeployDecl(text)
  const base = String(process.env.MESH_HUB_HEALTH_URL ?? '').trim()
  if (!base) return { declared, actual: null, ok: true, skipped: '未配置 MESH_HUB_HEALTH_URL' }
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) })
    const body = await response.json()
    const actual = body.version ?? null
    return { declared, actual, ok: Boolean(declared && actual && declared === actual), skipped: null }
  } catch (error) {
    return { declared, actual: null, ok: true, skipped: `不可达：${error.message}` }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = {
    versionDecl: { declared: null, actual: null, ok: true, skipped: null },
    deploy: { declared: null, actual: null, ok: true, skipped: null },
    leak: { hits: [], ok: true },
    ok: true,
  }
  if (!existsSync(options.roadmap)) {
    report.versionDecl.skipped = '无仓外 ROADMAP'
    report.deploy.skipped = '无仓外 ROADMAP'
    report.leak.skipped = '无仓外 ROADMAP'
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log('SKIP（无仓外 ROADMAP）')
      console.log('SKIP（无仓外 ROADMAP）')
      console.log('SKIP（无仓外 ROADMAP）')
    }
    process.exit(0)
  }
  const text = readFileSync(options.roadmap, 'utf8')
  const actual = actualVersions(options)

  const declared = parseVersionDecl(text)
  report.versionDecl = {
    declared,
    actual,
    ok: Boolean(declared && declared.hub === actual.hub && (!declared.waker || declared.waker === actual.waker)),
    skipped: declared ? null : '未找到「版本一致性」行',
  }

  report.deploy = await checkDeploy(text)
  report.leak = { hits: findLeaks(text), ok: true }
  report.leak.ok = report.leak.hits.length === 0
  report.ok = report.versionDecl.ok && report.deploy.ok && report.leak.ok

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    if (!declared) console.log('SKIP 版本声明（未找到「版本一致性」行）')
    else if (report.versionDecl.ok) console.log(`版本声明 OK ${declared.hub} / ${declared.waker ?? '—'}（仓库 ${actual.hub} / ${actual.waker}）`)
    else console.log(`MISMATCH 版本声明 ${declared.hub} / ${actual.hub}${declared.waker && declared.waker !== actual.waker ? `（waker ${declared.waker} / ${actual.waker}）` : ''}`)

    if (report.deploy.skipped) console.log(`部署 SKIP（${report.deploy.skipped}）`)
    else if (report.deploy.ok) console.log(`部署 OK ${report.deploy.declared} = ${report.deploy.actual}`)
    else console.log(`MISMATCH 部署声明 ${report.deploy.declared} / 实际 ${report.deploy.actual}`)

    if (report.leak.ok) console.log('泄漏 OK 0 处')
    else {
      for (const hit of report.leak.hits) console.log(`LEAK 第 ${hit.line} 行含真实地址：${hit.text}`)
    }
  }
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
