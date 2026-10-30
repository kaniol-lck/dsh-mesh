#!/usr/bin/env node
/**
 * One-command deployment check for a dsh-mesh install.
 *
 *   node scripts/ops-check.mjs                    # human readable
 *   node scripts/ops-check.mjs --json             # machine readable
 *   node scripts/ops-check.mjs --base http://hub:8790 --waker http://127.0.0.1:8795
 *
 * Typical output:
 *   PASS  hub reachable            http://<HUB-HOST>:8790 (v0.7.15)
 *   WARN  unpushed commits         2 commit(s) ahead of upstream
 *   summary: 9 PASS / 2 WARN / 0 FAIL / 1 SKIP
 *
 * Exit codes: 0 = no FAIL, 1 = at least one FAIL, 2 = bad arguments.
 * Uses only Node built-ins; never prints credentials (the probe endpoints are public).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GIB = 1024 ** 3

const USAGE = `usage: node scripts/ops-check.mjs [options]

  --base <url>       hub base URL (default: MESH_HUB, loopback:8790, or the waker's hubConsoleUrl)
  --waker <url>      waker base URL (default: MESH_WAKER or http://127.0.0.1:8795)
  --edge <url>       optional public ingress base URL to probe (unreachable -> WARN)
  --volume <path>    filesystem path to check for free space (repeatable, <1 GiB -> WARN)
  --timeout <ms>     per-request timeout (default 5000)
  --json             print a JSON report instead of one line per check
  --help             show this text`

function badArgs(message) {
  console.error(`ops-check: ${message}`)
  console.error(USAGE)
  process.exit(2)
}

function parseArgs(argv) {
  const options = {
    base: process.env.MESH_HUB || null,
    waker: process.env.MESH_WAKER || 'http://127.0.0.1:8795',
    edge: null,
    volumes: [],
    json: false,
    timeout: 5000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined]
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[++index]
      if (next === undefined) badArgs(`${flag} needs a value`)
      return next
    }
    const url = (input) => {
      try {
        const parsed = new URL(input)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') badArgs(`${flag} must be http(s)`)
        return parsed.origin + parsed.pathname.replace(/\/+$/, '')
      } catch {
        badArgs(`${flag} is not a valid URL: ${input}`)
      }
    }
    if (flag === '--base') options.base = url(value())
    else if (flag === '--waker') options.waker = url(value())
    else if (flag === '--edge') options.edge = url(value())
    else if (flag === '--volume') options.volumes.push(value())
    else if (flag === '--timeout') {
      const parsed = Number(value())
      if (!Number.isInteger(parsed) || parsed < 100 || parsed > 60000) badArgs('--timeout must be an integer 100..60000')
      options.timeout = parsed
    } else if (flag === '--json') options.json = true
    else if (flag === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else badArgs(`unknown option: ${raw}`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const checks = []
const add = (id, title, level, detail) => checks.push({ id, title, level, detail })

async function getJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeout) })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* non-JSON body */ }
    return { ok: true, status: response.status, body }
  } catch (error) {
    return { ok: false, status: null, error: error.code ?? error.message }
  }
}

function portOpen(host, port) {
  return new Promise((resolvePort) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePort(value)
    }
    socket.setTimeout(options.timeout, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function isLocal(url) {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

function originOf(url) {
  try { return new URL(url).origin } catch { return url }
}

async function readHubSources() {
  const sources = { server: null, packageVersion: null }
  try {
    sources.server = await fs.readFile(join(ROOT, 'hub/server.mjs'), 'utf8')
  } catch { /* not a full checkout */ }
  try {
    sources.packageVersion = JSON.parse(await fs.readFile(join(ROOT, 'hub/package.json'), 'utf8')).version ?? null
  } catch { /* not a full checkout */ }
  return sources
}

async function runNodeScript(relative) {
  const path = join(ROOT, relative)
  if (!existsSync(path)) return null
  const result = spawnSync(process.execPath, [path, '--check'], { cwd: ROOT, encoding: 'utf8' })
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

function findPython() {
  // Prefer a real install; the Windows Store aliases (python3) can open the Store instead
  // of running, so try them last and never wait forever.
  const candidates = [process.env.PYTHON, 'python', 'py', 'python3'].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000 })
    if (probe.status === 0) return candidate
  }
  return null
}

// ---------------------------------------------------------------- waker probe
const wakerStatus = await getJson(`${options.waker}/mesh/status`)
const wakerBody = wakerStatus.ok && wakerStatus.status === 200 ? wakerStatus.body : null

// Resolve the hub when no --base/MESH_HUB was given: loopback first, then whatever the
// waker reports (the hub usually lives on another box).
let base = options.base
if (!base) {
  for (const candidate of ['http://127.0.0.1:8790']) {
    const probe = await getJson(`${candidate}/health`)
    if (probe.ok && probe.status === 200) { base = candidate; break }
  }
  const reported = wakerBody?.hubConsoleUrl
  if (!base && typeof reported === 'string') {
    try { base = new URL(reported).origin } catch { /* ignore malformed */ }
  }
  if (!base) base = 'http://127.0.0.1:8790'
}

const hubHealth = await getJson(`${base}/health`)
const hubUp = hubHealth.ok && hubHealth.status === 200
add('hub', 'hub reachable', hubUp ? 'PASS' : 'FAIL', hubUp ? `${originOf(base)} (v${hubHealth.body?.version ?? '?'})` : `${originOf(base)} unreachable (${hubHealth.error ?? `HTTP ${hubHealth.status}`})`)

const sources = await readHubSources()
if (!hubUp) {
  add('hub-version', 'hub version matches package.json', 'SKIP', 'hub unreachable')
} else if (!sources.packageVersion) {
  add('hub-version', 'hub version matches package.json', 'SKIP', 'hub/package.json not found')
} else {
  const version = hubHealth.body?.version ?? null
  add('hub-version', 'hub version matches package.json', version === sources.packageVersion ? 'PASS' : 'FAIL', `running ${version ?? '?'} vs package ${sources.packageVersion}`)
}

if (!sources.server || !sources.packageVersion) {
  add('hub-const', 'HUB_VERSION matches package.json', 'SKIP', 'hub sources not found')
} else {
  const match = /const HUB_VERSION = '([^']+)'/.exec(sources.server)
  const declared = match?.[1] ?? null
  add('hub-const', 'HUB_VERSION matches package.json', declared === sources.packageVersion ? 'PASS' : 'FAIL', `HUB_VERSION ${declared ?? '?'} vs package ${sources.packageVersion}`)
}

// ---------------------------------------------------------------- optional edge
if (!options.edge) {
  add('edge', 'public ingress health', 'SKIP', 'no --edge given')
} else {
  const edge = await getJson(`${options.edge}/health`)
  const ok = edge.ok && edge.status === 200
  add('edge', 'public ingress health', ok ? 'PASS' : 'WARN', ok ? `${originOf(options.edge)}` : `${originOf(options.edge)} unreachable (${edge.error ?? `HTTP ${edge.status}`})`)
}

// ---------------------------------------------------------------- waker checks
if (!wakerStatus.ok || wakerStatus.status !== 200) {
  add('waker', 'waker status reachable', 'FAIL', `${originOf(options.waker)} unreachable (${wakerStatus.error ?? `HTTP ${wakerStatus.status}`})`)
  add('waker-version', 'waker plugin reported', 'SKIP', 'waker unreachable')
  add('waker-stale', 'waker disk/process versions match', 'SKIP', 'waker unreachable')
  add('waker-registered', 'waker registered with hub', 'SKIP', 'waker unreachable')
  add('waker-backlog', 'waker pending tasks low', 'SKIP', 'waker unreachable')
} else {
  const versions = wakerBody?.pluginVersions ?? {}
  add('waker', 'waker status reachable', 'PASS', `${originOf(options.waker)} (plugin ${versions.process ?? '?'})`)
  add('waker-version', 'waker plugin reported', versions.process ? 'PASS' : 'WARN', `process ${versions.process ?? '?'} / disk ${versions.disk ?? '?'}`)
  add('waker-stale', 'waker disk/process versions match', versions.stale === false ? 'PASS' : 'WARN', versions.stale === false ? 'stale=false' : 'stale=true; restart the waker to load the disk build')
  add('waker-registered', 'waker registered with hub', wakerBody?.registered === true && wakerBody?.lastError === null ? 'PASS' : 'WARN', `registered=${wakerBody?.registered} lastError=${wakerBody?.lastError ?? 'null'}`)
  const pending = Number(wakerBody?.pendingTasks ?? 0)
  add('waker-backlog', 'waker pending tasks low', pending > 10 ? 'WARN' : 'PASS', `${pending} pending task(s)`)
}

// ---------------------------------------------------------------- local ports
if (isLocal(base)) {
  const open = await portOpen('127.0.0.1', 8790)
  add('port-hub', 'local hub port 8790', open ? 'PASS' : 'WARN', open ? 'listening' : 'not listening')
} else {
  add('port-hub', 'local hub port 8790', 'SKIP', '--base points at a remote hub')
}
if (isLocal(options.waker)) {
  const open = await portOpen('127.0.0.1', 8795)
  add('port-waker', 'local waker port 8795', open ? 'PASS' : 'WARN', open ? 'listening' : 'not listening')
} else {
  add('port-waker', 'local waker port 8795', 'SKIP', '--waker points at a remote host')
}

// ---------------------------------------------------------------- repo gates
const roadmapPath = ['.worklog/bin/roadmap.mjs', 'scripts/roadmap.mjs'].map((p) => join(ROOT, p)).find((p) => existsSync(p))
if (!roadmapPath || !existsSync(join(ROOT, '.worklog'))) {
  add('roadmap', 'roadmap --check', 'SKIP', '.worklog not present')
} else {
  const result = spawnSync(process.execPath, [roadmapPath, '--check'], { cwd: ROOT, encoding: 'utf8' })
  const code = result.status ?? 1
  add('roadmap', 'roadmap --check', code === 0 ? 'PASS' : 'FAIL', code === 0 ? 'clean' : `exit ${code}: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0]}`)
}

if (!existsSync(join(ROOT, 'scripts/check-paths.mjs'))) {
  add('paths', 'check-paths', 'SKIP', 'scripts/check-paths.mjs not found')
} else {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/check-paths.mjs')], { cwd: ROOT, encoding: 'utf8' })
  const code = result.status ?? 1
  add('paths', 'check-paths', code === 0 ? 'PASS' : 'FAIL', code === 0 ? 'clean' : `exit ${code}: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0]}`)
}

if (!existsSync(join(ROOT, 'scripts/check-secrets.py'))) {
  add('secrets', 'check-secrets', 'SKIP', 'scripts/check-secrets.py not found')
} else {
  const python = findPython()
  if (!python) {
    add('secrets', 'check-secrets', 'SKIP', 'no python interpreter found')
  } else {
    const result = spawnSync(python, [join(ROOT, 'scripts/check-secrets.py')], { cwd: ROOT, encoding: 'utf8' })
    const code = result.status ?? 1
    add('secrets', 'check-secrets', code === 0 ? 'PASS' : 'FAIL', code === 0 ? 'clean' : `exit ${code}: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0]}`)
  }
}

if (!existsSync(join(ROOT, '.worklog/bin/defects.mjs'))) {
  add('defects', 'defects --scan', 'SKIP', '.worklog/bin/defects.mjs not found')
} else {
  const result = spawnSync(process.execPath, [join(ROOT, '.worklog/bin/defects.mjs'), '--scan', '--threshold', '3'], { cwd: ROOT, encoding: 'utf8' })
  const code = result.status ?? 1
  const lastLine = `${result.stdout ?? ''}`.trim().split('\n').filter(Boolean).pop() ?? ''
  add('defects', 'defects --scan', code === 0 ? 'PASS' : 'WARN', code === 0 ? (lastLine || 'scanned') : `exit ${code}: ${lastLine}`)
}

// ---------------------------------------------------------------- git & disk
const unpushed = spawnSync('git', ['log', '--oneline', '@{u}..HEAD'], { cwd: ROOT, encoding: 'utf8' })
if (unpushed.status !== 0) {
  add('unpushed', 'unpushed commits', 'SKIP', 'no upstream configured')
} else {
  const count = `${unpushed.stdout ?? ''}`.split('\n').filter(Boolean).length
  add('unpushed', 'unpushed commits', count > 0 ? 'WARN' : 'PASS', count > 0 ? `${count} commit(s) ahead of upstream` : 'up to date')
}

if (options.volumes.length === 0) {
  add('volumes', 'free disk space', 'SKIP', 'no --volume given')
} else {
  for (const volume of options.volumes) {
    try {
      const stats = await fs.statfs(volume)
      const free = Number(stats.bavail) * Number(stats.bsize)
      const gib = (free / GIB).toFixed(1)
      add(`volume:${volume}`, `free space ${volume}`, free < GIB ? 'WARN' : 'PASS', `${gib} GiB free`)
    } catch (error) {
      const reason = error.code === 'UNKNOWN' ? 'path not found or unreadable' : (error.code ?? error.message)
      add(`volume:${volume}`, `free space ${volume}`, 'WARN', `cannot read: ${reason}`)
    }
  }
}

// ---------------------------------------------------------------- report
const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 }
for (const check of checks) counts[check.level] += 1
const exitCode = counts.FAIL > 0 ? 1 : 0
const report = {
  ok: exitCode === 0,
  exitCode,
  targets: { base: originOf(base), waker: originOf(options.waker), edge: options.edge ? originOf(options.edge) : null, volumes: options.volumes },
  summary: counts,
  checks,
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const check of checks) {
    const detail = check.detail ? `  ${check.detail}` : ''
    console.log(`${check.level.padEnd(4)}  ${check.title.padEnd(32)}${detail}`)
  }
  console.log(`\nsummary: ${counts.PASS} PASS / ${counts.WARN} WARN / ${counts.FAIL} FAIL / ${counts.SKIP} SKIP`)
}
process.exit(exitCode)
