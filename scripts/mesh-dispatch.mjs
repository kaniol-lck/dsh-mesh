#!/usr/bin/env node
/**
 * Send a task text to a DSH session through the waker's loopback API.
 *
 * Why this exists: on PowerShell 5.1, ConvertTo-Json serialises a multi-line
 * string as {"value":"..."}, which arrives at /mesh/inject as the 15-character
 * string "[object Object]". Node's fetch sends the file content as plain UTF-8
 * JSON, so the receiver gets the real text.
 *
 * Usage:
 *   node scripts/mesh-dispatch.mjs --title "mesh · hub" --file .worklog/dispatch/hub.txt
 *   node scripts/mesh-dispatch.mjs --session <id> --file task.txt --mode steer
 *   node scripts/mesh-dispatch.mjs --title "mesh · 协调" --wake --text "[WAKE] P0: TLS 示例误导"
 *   node scripts/mesh-dispatch.mjs --title "mesh · docs" --file .worklog/dispatch/docs.txt --dry-run
 *
 * Target resolution by title: only active sessions (archived:false) whose cwd is
 * the repo root are considered; if several match, the one with the newest
 * last_active wins. --repo overrides process.cwd().
 *
 * --wake is for waking the coordinator session (local only, never the hub):
 * the text must start with "[WAKE]", and the same target + payload is suppressed
 * for 60 seconds so a retry or a double-run does not ring twice.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const BASE = process.env.MESH_WAKER_URL ?? 'http://127.0.0.1:8795'
const WAKE_PREFIX = /^\[WAKE\]/
const WAKE_DEBOUNCE_MS = 60_000

const USAGE = `mesh-dispatch — send text to a local DSH session (waker :8795)

Usage:
  node scripts/mesh-dispatch.mjs --title "mesh · hub" --file .worklog/dispatch/hub.txt
  node scripts/mesh-dispatch.mjs --session <id> --file task.txt [--mode queue|steer]
  node scripts/mesh-dispatch.mjs --title "mesh · 协调" --wake --text "[WAKE] P0: ..."
  node scripts/mesh-dispatch.mjs --title "mesh · docs" --file .worklog/dispatch/docs.txt --dry-run

Options:
  --title <title>    target session by exact title
  --session <id>     target session by id (with or without "session-" prefix)
  --file <path>      UTF-8 task text (exactly one of --file / --text)
  --text <string>    task text inline (exactly one of --file / --text)
  --wake             coordinator wake-up: require the "[WAKE]" first line and
                     dedupe the same target+payload for 60s
  --mode <mode>      queue (default) or steer
  --repo <path>      repo root used to filter by cwd (default: process.cwd())
  --dry-run          resolve and print the target, send nothing
  -h, --help         show this help
`

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { mode: 'queue', dryRun: false, wake: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = () => {
      const value = argv[index + 1]
      if (value === undefined) fail(`${arg} requires a value`, 2)
      index += 1
      return value
    }
    switch (arg) {
      case '--title': options.title = takeValue(); break
      case '--session': options.session = takeValue(); break
      case '--file': options.file = takeValue(); break
      case '--text': options.text = takeValue(); break
      case '--repo': options.repo = takeValue(); break
      case '--mode': options.mode = takeValue(); break
      case '--wake': options.wake = true; break
      case '--dry-run': options.dryRun = true; break
      case '-h':
      case '--help':
        console.log(USAGE)
        process.exit(0)
        break
      default:
        fail(`unknown argument: ${arg}\n\n${USAGE}`, 2)
    }
  }
  const hasFile = options.file !== undefined
  const hasText = options.text !== undefined
  if (hasFile === hasText) fail('pass exactly one of --file or --text', 2)
  if (!options.title && !options.session) fail('pass --title or --session', 2)
  if (options.title && options.session) fail('--title and --session are mutually exclusive', 2)
  if (!['queue', 'steer'].includes(options.mode)) fail('--mode must be queue or steer', 2)
  return options
}

function normalizePath(value) {
  const resolved = path.resolve(String(value))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function describe(session) {
  return `${session.id}  ${session.title ?? '(no title)'}  live=${session.live}`
}

function dedupePath(repoPath) {
  return path.join(repoPath, '.worklog', 'dispatch', '.wake-dedupe.json')
}

async function readDedupe(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {}
  } catch {
    return {}
  }
}

async function saveDedupe(file, entries) {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ entries }), 'utf8')
  } catch {
    /* dedupe is best effort; never block a real wake on it */
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repoPath = path.resolve(options.repo ?? process.cwd())
  const repo = normalizePath(repoPath)
  const text = options.text !== undefined ? String(options.text) : await readFile(path.resolve(options.file), 'utf8')

  if (options.wake && !WAKE_PREFIX.test(text.replace(/^\uFEFF/, ''))) {
    fail(
      'wake payload must start with "[WAKE] <one-line summary>"; put the summary on the first line and details below',
      2,
    )
  }

  const response = await fetch(`${BASE}/mesh/sessions`)
  if (!response.ok) fail(`GET /mesh/sessions -> HTTP ${response.status}`)
  const payload = await response.json()
  if (!payload?.ok) fail(`GET /mesh/sessions -> unexpected body: ${JSON.stringify(payload).slice(0, 300)}`)

  const sessions = Array.isArray(payload.sessions) ? payload.sessions : []
  let target

  if (options.session) {
    const wanted = String(options.session).trim()
    target = sessions.find((session) => session.id === wanted || session.id === `session-${wanted}`)
    if (!target) fail(`session not found: ${wanted}`)
  } else {
    const candidates = sessions.filter(
      (session) =>
        session.archived !== true &&
        session.title === options.title &&
        session.cwd &&
        normalizePath(session.cwd) === repo,
    )
    if (candidates.length === 0) {
      const inRepo = sessions.filter(
        (session) => session.archived !== true && session.cwd && normalizePath(session.cwd) === repo,
      )
      fail(
        `no active session titled "${options.title}" in ${repo}\n` +
          `active sessions in this repo:\n${inRepo.map((session) => `  ${describe(session)}`).join('\n') || '  (none)'}`,
      )
    }
    candidates.sort((left, right) => Number(right.last_active) - Number(left.last_active))
    target = candidates[0]
    if (candidates.length > 1) console.error(`note: ${candidates.length} sessions match, using the most recent`)
  }

  const chars = text.length
  const wakeFlag = options.wake ? 'yes' : 'no'

  if (options.dryRun) {
    console.log(`dry-run: session=${target.id} chars=${chars} wake=${wakeFlag} (not sent)`)
    return
  }

  let dedupeFile = null
  let dedupeEntries = {}
  let dedupeKey = null
  if (options.wake) {
    dedupeFile = dedupePath(repoPath)
    dedupeEntries = await readDedupe(dedupeFile)
    const now = Date.now()
    dedupeKey = `${target.id}|${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
    const last = Number(dedupeEntries[dedupeKey] ?? 0)
    if (last && now - last < WAKE_DEBOUNCE_MS) {
      console.log('deduped: same payload within 60s')
      process.exit(0)
    }
  }

  const sent = await fetch(`${BASE}/mesh/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: target.id, text, mode: options.mode }),
  })
  const raw = await sent.text()
  let result
  try {
    result = JSON.parse(raw)
  } catch {
    fail(`POST /mesh/inject -> HTTP ${sent.status}: ${raw.slice(0, 300)}`)
  }
  if (sent.status !== 200 || result.ok === false) {
    fail(`POST /mesh/inject -> HTTP ${sent.status}: ${raw.slice(0, 300)}`)
  }

  if (dedupeFile && dedupeKey) {
    const now = Date.now()
    for (const [key, stamp] of Object.entries(dedupeEntries)) {
      if (now - Number(stamp) >= WAKE_DEBOUNCE_MS) delete dedupeEntries[key]
    }
    dedupeEntries[dedupeKey] = now
    await saveDedupe(dedupeFile, dedupeEntries)
  }

  console.log(`sent session=${target.id} chars=${chars} mode=${options.mode} wake=${wakeFlag}`)
}

main().catch((error) => fail(error?.message ?? String(error)))
