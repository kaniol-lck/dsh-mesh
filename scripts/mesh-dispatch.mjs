#!/usr/bin/env node
/**
 * mesh-dispatch — shell over the single implementation
 * (plugins/mesh-waker/bin/dispatch.mjs) plus two local-only extras.
 *
 * Line budget: ~30 lines of shell/forwarding, the rest is the two extensions the
 * plugin CLI cannot know about:
 *   --title  resolve a session title to an id via ~/.dsh/mesh-waker/sessions-index.json
 *   --wake   wake the local coordinator through the waker's inject API (60s dedupe)
 * --repo is only used by those two; every other flag (--target, --thread, --task,
 * --receipt, --requester, --file, --text, --mode, --batch, --deadline, --dry-run,
 * --json, --create, --session→--target) is passed through verbatim.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_CLI = path.join(ROOT, 'plugins', 'mesh-waker', 'bin', 'dispatch.mjs')
const INDEX = path.join(os.homedir(), '.dsh', 'mesh-waker', 'sessions-index.json')
const BASE = process.env.MESH_WAKER_URL ?? 'http://127.0.0.1:8795'
const WAKE_PREFIX = /^\[WAKE\]/
const DEBOUNCE_MS = 60_000
const USAGE = `mesh-dispatch — dispatch via the waker plugin CLI (single implementation)

Usage:
  node scripts/mesh-dispatch.mjs --title "<project> · <role>" --file task.txt
  node scripts/mesh-dispatch.mjs --target <id|title> --thread TH-1 --text "..."
  node scripts/mesh-dispatch.mjs --title "<project> · coordinator" --wake --text "[WAKE] ..."
  node scripts/mesh-dispatch.mjs --session <id> --text "..." --dry-run

Local extensions (not part of the plugin CLI):
  --title <s>   resolve title -> session id (sessions-index.json, filtered by --repo)
  --wake        send directly to the waker inject API; text must start with "[WAKE]"
  --repo <path> workspace used by --title and the wake dedupe file (default: cwd)
Everything else is forwarded unchanged (--target/--thread/--task/--receipt/
--requester/--file/--text/--mode/--batch/--deadline/--dry-run/--json/--create).
`

function normalize(value) {
  const resolved = path.resolve(String(value))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function resolveTitle(title, repo) {
  if (!existsSync(INDEX)) throw new Error(`sessions index not found: ${INDEX}`)
  const index = JSON.parse(readFileSync(INDEX, 'utf8'))
  const wanted = normalize(repo ?? process.cwd())
  const matches = Object.entries(index)
    .filter(([, session]) => session && session.title === title && session.cwd && normalize(session.cwd) === wanted)
    .sort((left, right) => Number(right[1].mtime ?? 0) - Number(left[1].mtime ?? 0))
  if (!matches.length) throw new Error(`no session titled "${title}" in ${wanted}`)
  return matches[0][0]
}

function valueOf(argv, index) {
  return argv[index + 1] !== undefined && !String(argv[index + 1]).startsWith('--') ? argv[index + 1] : undefined
}

async function wake(argv) {
  const titleIndex = argv.indexOf('--title')
  const repoIndex = argv.indexOf('--repo')
  const sessionIndex = argv.indexOf('--session')
  const title = titleIndex >= 0 ? valueOf(argv, titleIndex) : undefined
  const session = sessionIndex >= 0 ? valueOf(argv, sessionIndex) : undefined
  const repo = repoIndex >= 0 ? valueOf(argv, repoIndex) : process.cwd()
  const textIndex = argv.indexOf('--text')
  const fileIndex = argv.indexOf('--file')
  const text = textIndex >= 0 ? valueOf(argv, textIndex) : fileIndex >= 0 ? readFileSync(path.resolve(valueOf(argv, fileIndex)), 'utf8') : undefined
  if (text === undefined) throw new Error('--wake needs --text or --file')
  if (!WAKE_PREFIX.test(text.replace(/^\uFEFF/, ''))) {
    throw new Error('wake payload must start with "[WAKE] <one-line summary>"')
  }
  const target = session ?? resolveTitle(title ?? 'mesh · 协调', repo)
  const dedupeFile = path.join(path.resolve(repo), '.worklog', 'dispatch', '.wake-dedupe.json')
  const key = `${target}|${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
  let entries = {}
  try { entries = JSON.parse(readFileSync(dedupeFile, 'utf8')).entries ?? {} } catch { /* first run */ }
  const now = Date.now()
  if (entries[key] && now - entries[key] < DEBOUNCE_MS) { console.log('deduped: same payload within 60s'); return }
  const response = await fetch(`${BASE}/mesh/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: target, text, mode: 'queue' }),
  })
  const raw = await response.text()
  if (!response.ok) {
    console.error(`POST /mesh/inject -> HTTP ${response.status}: ${raw}`)
    process.exit(response.status >= 400 && response.status < 500 ? 2 : 1)
  }
  entries[key] = now
  for (const [oldKey, stamp] of Object.entries(entries)) if (now - Number(stamp) >= DEBOUNCE_MS) delete entries[oldKey]
  try { mkdirSync(path.dirname(dedupeFile), { recursive: true }); writeFileSync(dedupeFile, JSON.stringify({ entries }), 'utf8') } catch { /* best effort */ }
  console.log(`sent session=${target} chars=${text.length} wake=yes`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('-h') || argv.includes('--help')) { console.log(USAGE); return 0 }
  if (argv.includes('--wake')) { await wake(argv); return 0 }
  const forwarded = []
  let title
  let repo
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--title') { title = argv[index + 1]; index += 1; continue }
    if (arg === '--repo') { repo = argv[index + 1]; index += 1; continue }
    if (arg === '--session') { forwarded.push('--target', argv[index + 1]); index += 1; continue }
    forwarded.push(arg)
  }
  if (title !== undefined && !forwarded.includes('--target') && !forwarded.includes('--thread')) {
    try {
      forwarded.push('--target', resolveTitle(title, repo))
    } catch (error) {
      console.error(`ERROR ${error.message}`)
      return 1
    }
  }
  try {
    execFileSync(process.execPath, [PLUGIN_CLI, ...forwarded], { stdio: 'inherit' })
    return 0
  } catch (error) {
    return typeof error.status === 'number' ? error.status : 1
  }
}

main().then((code) => { process.exitCode = code }).catch((error) => { console.error(`ERROR ${error.message}`); process.exitCode = 1 })
