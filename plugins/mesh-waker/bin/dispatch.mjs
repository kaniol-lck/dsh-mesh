#!/usr/bin/env node
/**
 * dsh-mesh-dispatch — send a task to a local DSH session through the waker's loopback API.
 *
 * Ships with the dsh-mesh-waker plugin, so any project can dispatch work between sessions
 * without this repository's scripts/. Node 20+ only: built-in fetch, no other dependencies.
 *
 * Usage:
 *   dsh-mesh-dispatch --target "mesh · hub" --file task.txt
 *   dsh-mesh-dispatch --target session-abc --text "fix x" --task --batch B-1
 *   dsh-mesh-dispatch --target "new worker" --create --text "bootstrap" --json
 */
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const USAGE = `dsh-mesh-dispatch — dispatch a task into a local DSH session (waker :8795)

Usage:
  dsh-mesh-dispatch --target <id|title> (--text <s> | --file <path>) [options]

Options:
  --target <s>       session id, full title, or a unique title substring
  --text <s>         task text (exactly one of --text / --file)
  --file <path>      UTF-8 task file (exactly one of --text / --file)
  --mode <m>         queue (default) or steer
  --task [id]        receipt task id; "--task" alone generates T-<base36 timestamp>
  --batch [id]       batch barrier id; "--batch" alone generates B-<base36 timestamp>
  --receipt <m>      file | queue | wake (waker default when omitted)
  --deadline <d>     batch deadline such as 30m / 2h / 600s
  --create           create the session (titled with --target) when it does not resolve
  --json             print the structured result
  --waker <url>      waker base URL (default http://127.0.0.1:8795)
  -h, --help         show this help
`

const DEFAULT_WAKER = 'http://127.0.0.1:8795'

function fail(message) {
  const error = new Error(`${message}\n\n${USAGE}`)
  error.usage = true
  throw error
}

/** "30m" / "2h" / "600s" / "500ms" -> milliseconds. */
export function durationMs(value) {
  const match = /^(\d+)(ms|s|m|h)$/i.exec(String(value ?? '').trim())
  if (!match) fail(`--deadline must look like 600s, 90m or 2h (got ${value})`)
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2].toLowerCase()]
}

/** Parse argv into options; throws an Error whose message includes usage text. */
export function parseArgs(argv) {
  const options = {
    target: undefined,
    text: undefined,
    file: undefined,
    mode: 'queue',
    task: undefined,
    batch: undefined,
    receipt: undefined,
    deadline: undefined,
    deadlineMs: undefined,
    create: false,
    json: false,
    waker: DEFAULT_WAKER,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = () => {
      const value = argv[index + 1]
      if (value === undefined || String(value).startsWith('--')) fail(`${arg} requires a value`)
      index += 1
      return value
    }
    switch (arg) {
      case '--target': options.target = takeValue(); break
      case '--text': options.text = takeValue(); break
      case '--file': options.file = takeValue(); break
      case '--mode': options.mode = takeValue(); break
      case '--task': {
        const next = argv[index + 1]
        options.task = next !== undefined && !String(next).startsWith('--') ? String(next) : ''
        if (options.task) index += 1
        break
      }
      case '--batch': {
        const next = argv[index + 1]
        options.batch = next !== undefined && !String(next).startsWith('--') ? String(next) : ''
        if (options.batch) index += 1
        break
      }
      case '--receipt': options.receipt = takeValue(); break
      case '--deadline': options.deadline = takeValue(); break
      case '--create': options.create = true; break
      case '--json': options.json = true; break
      case '--waker': options.waker = takeValue(); break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        fail(`unknown argument: ${arg}`)
    }
  }
  if (options.help) return options
  if (!options.target) fail('pass --target')
  const hasText = options.text !== undefined
  const hasFile = options.file !== undefined
  if (hasText === hasFile) fail('pass exactly one of --text or --file')
  if (!['queue', 'steer'].includes(options.mode)) fail('--mode must be queue or steer')
  if (options.receipt !== undefined && !['file', 'queue', 'wake'].includes(options.receipt)) {
    fail('--receipt must be file, queue or wake')
  }
  if (options.deadline !== undefined) options.deadlineMs = durationMs(options.deadline)
  // Asking for a receipt destination or a batch implies task tracking.
  if (options.receipt !== undefined && options.task === undefined) options.task = ''
  if (options.batch !== undefined && options.task === undefined) options.task = ''
  return options
}

async function postJson(url, body, timeoutMs = 15000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* keep text for the error */
  }
  return { status: res.status, json, text }
}

/** Dispatch one task; returns the waker's result (plus created flag when it made a session). */
export async function run(options, fetchImpl = fetch) {
  const base = String(options.waker ?? DEFAULT_WAKER).replace(/\/+$/, '')
  const text = options.file !== undefined ? await readFile(String(options.file), 'utf8') : String(options.text ?? '')
  if (!text.trim()) fail('task text is empty')
  const taskId = options.task === undefined ? null : options.task || `T-${Date.now().toString(36)}`
  const batchId = options.batch === undefined ? null : options.batch || `B-${Date.now().toString(36)}`
  const meta = taskId
    ? {
        taskId,
        ...(options.receipt ? { receipt: options.receipt } : {}),
        ...(batchId ? { batchId } : {}),
        ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
      }
    : undefined
  const payload = (session) => ({
    ...(session ? { session } : { session: options.target, title: options.target }),
    text,
    mode: options.mode,
    ...(meta ? { meta } : {}),
  })

  let created = false
  let sent = await postJson(`${base}/mesh/inject`, payload(null))
  if (sent.status !== 200 && options.create) {
    const made = await postJson(`${base}/mesh/sessions/create`, { title: options.target, cwd: process.cwd() })
    if (made.status !== 201 || !made.json?.sessionId) {
      throw new Error(`创建会话失败：HTTP ${made.status} ${made.text.slice(0, 300)}`)
    }
    created = true
    sent = await postJson(`${base}/mesh/inject`, payload(made.json.sessionId))
  }
  if (sent.status !== 200 || sent.json?.ok === false) {
    throw new Error(`投递失败：HTTP ${sent.status} ${sent.text.slice(0, 300)}`)
  }
  return { ...sent.json, target: options.target, created }
}

async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  if (options.help) {
    console.log(USAGE)
    return
  }
  let result
  try {
    result = await run(options)
  } catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/i.test(String(error.message))) {
      console.error(`waker 未运行或未监听 ${DEFAULT_WAKER}（${error.message}）`)
      process.exit(2)
    }
    console.error(error.message)
    process.exit(1)
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const parts = [`sent session=${result.sessionId}`, `task=${result.taskId ?? '-'}`]
  if (result.batchId) parts.push(`batch=${result.batchId}`)
  if (result.created) parts.push('created=yes')
  console.log(parts.join(' '))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
