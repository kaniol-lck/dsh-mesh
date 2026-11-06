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
 *   dsh-mesh-dispatch --thread TH-1 --text "follow-up"   (target comes from the thread binding)
 */
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { normalizeThread } from '../lib/session.mjs'

export const USAGE = `dsh-mesh-dispatch — dispatch a task into a local DSH session (waker :8795)

Usage:
  dsh-mesh-dispatch --target <id|title> (--text <s> | --file <path>) [options]
  dsh-mesh-dispatch --coordinator <slug> (--text <s> | --file <path>) [options]
  dsh-mesh-dispatch --thread <id> (--text <s> | --file <path>) [options]

Options:
  --target <s>       session id, full title, or a unique title substring
  --role <role>      dispatch to the worker registered for that role in the workspace that
                     owns the current directory (workers come from /mesh/workspaces).
                     Exits 2 with candidates when the role is missing or its session is
                     stale. Not combinable with --target / --thread / --coordinator.
  --coordinator <slug> dispatch to that workspace's coordinator session (equivalent to
                     targeting the coordinator of that workspace; resolved from
                     /mesh/workspaces). Deprecated alias kept for existing scripts; --role is
                     the forward-looking addressing. Exits 2 when the workspace has no
                     coordinator or when its session is no longer on this machine. Not
                     combinable with --target / --thread / --role.
  --text <s>         task text (exactly one of --text / --file)
  --file <path>      UTF-8 task file (exactly one of --text / --file)
  --mode <m>         queue (default) or steer
  --thread <id>      follow-up thread id (at most 128 UTF-8 bytes); a known thread lets
                     you omit --target and keeps the binding on the same session
  --requester <s>    session id or title that should receive the receipt; when omitted the
                     waker infers the target workspace's coordinator, then falls back to
                     its receiptTo (queue/wake); file mode only writes receipts.jsonl
  --task [id]        receipt task id; "--task" alone generates T-<base36 timestamp>
  --batch [id]       batch barrier id; "--batch" alone generates B-<base36 timestamp>
  --receipt <m>      file | queue | wake (waker default when omitted)
  --deadline <d>     batch deadline such as 30m / 2h / 600s
  --create           create the session (titled with --target) when it does not resolve
  --dry-run          print the request that would be sent; send nothing
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

/** Addressing failures are not usage errors: the CLI already validated argv. Exit code 2. */
function addressFail(message) {
  const error = new Error(message)
  error.exitCode = 2
  throw error
}

/** "30m" / "2h" / "600s" / "500ms" -> milliseconds. */
export function durationMs(value) {
  const match = /^(\d+)(ms|s|m|h)$/i.exec(String(value ?? '').trim())
  if (!match) fail(`--deadline must look like 600s, 90m or 2h (got ${value})`)
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2].toLowerCase()]
}

/**
 * `--thread` follows the same rule as the tool and /mesh/inject (lib/session.mjs), so an
 * invalid id is rejected before any request is made instead of failing server-side.
 */
function normalizeCliThread(value) {
  try {
    const thread = normalizeThread(value)
    if (!thread) fail('--thread requires a non-empty id')
    return thread
  } catch (error) {
    if (error.usage) throw error
    fail(`invalid --thread: ${error.message}`)
  }
}

/** Parse argv into options; throws an Error whose message includes usage text. */
export function parseArgs(argv) {
  const options = {
    target: undefined,
    coordinator: undefined,
    role: undefined,
    text: undefined,
    file: undefined,
    mode: 'queue',
    thread: undefined,
    requester: undefined,
    task: undefined,
    batch: undefined,
    receipt: undefined,
    deadline: undefined,
    deadlineMs: undefined,
    create: false,
    dryRun: false,
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
      case '--coordinator': {
        const value = String(takeValue()).trim()
        if (!value) fail('--coordinator requires a non-empty slug')
        options.coordinator = value
        break
      }
      case '--role': {
        const value = String(takeValue()).trim()
        if (!value) fail('--role requires a non-empty role')
        options.role = value.toLowerCase()
        break
      }
      case '--text': options.text = takeValue(); break
      case '--file': options.file = takeValue(); break
      case '--mode': options.mode = takeValue(); break
      case '--thread': options.thread = takeValue(); break
      case '--requester': {
        const value = String(takeValue()).trim()
        if (!value) fail('--requester requires a non-empty value')
        options.requester = value
        break
      }
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
      case '--dry-run': options.dryRun = true; break
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
  if (options.thread !== undefined) options.thread = normalizeCliThread(options.thread)
  // Two addressing modes at once would be ambiguous: refuse instead of guessing.
  if (options.coordinator !== undefined && (options.target !== undefined || options.thread !== undefined)) {
    fail('--coordinator cannot be combined with --target or --thread')
  }
  if (options.role !== undefined && (options.target !== undefined || options.thread !== undefined || options.coordinator !== undefined)) {
    fail('--role cannot be combined with --target, --thread or --coordinator')
  }
  // A known thread resolves the target server-side, so --target may be omitted (T-296).
  if (!options.target && options.coordinator === undefined && options.role === undefined && options.thread === undefined) {
    fail('pass --target, --coordinator, --role or --thread for a known thread')
  }
  if (options.create && !options.target) fail('--create needs --target')
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

/**
 * Resolve --coordinator to the coordinator session through the waker's own registry. A missing
 * coordinator or a vanished session is an addressing error (exit 2), never a guess (T-355).
 */
export async function resolveCoordinator(base, slug, fetchImpl = fetch) {
  const registryRes = await fetchImpl(`${base}/mesh/workspaces`)
  let registry = null
  try {
    registry = await registryRes.json()
  } catch {
    registry = null
  }
  if (!registryRes.ok || !registry || registry.ok === false) {
    addressFail(`读取工作区注册表失败：HTTP ${registryRes.status}`)
  }
  const workspaces = registry.workspaces && typeof registry.workspaces === 'object' ? registry.workspaces : {}
  const entry = workspaces[slug]
  if (!entry) {
    const known = Object.keys(workspaces).sort().join(', ')
    addressFail(`工作区 "${slug}" 不在本机注册表里${known ? `（已登记：${known}）` : '（注册表为空）'}`)
  }
  const coordinator = String(entry.coordinator ?? '').trim()
  if (!coordinator) {
    const roles = Array.isArray(entry.roles) && entry.roles.length ? entry.roles.join(', ') : '无'
    addressFail(`工作区 "${slug}" 没有协调会话（workspaces.json 无 coordinator；角色：${roles}）；先在该工作区开一个协调会话，或改用 --target`)
  }
  const sessionsRes = await fetchImpl(`${base}/mesh/sessions?limit=500`)
  let sessions = null
  try {
    sessions = await sessionsRes.json()
  } catch {
    sessions = null
  }
  const list = Array.isArray(sessions?.sessions) ? sessions.sessions : null
  if (!list) addressFail(`读取会话列表失败：HTTP ${sessionsRes.status}`)
  const found = list.find((session) => session.id === coordinator)
  if (!found) {
    addressFail(`工作区 "${slug}" 的协调会话 ${coordinator} 不在这台机器的会话里（可能已归档或轮换）；去 /mesh/workspaces 核对，或改用 --target`)
  }
  return { coordinator, cwd: entry.cwd ?? null, roles: entry.roles ?? [] }
}

/**
 * Resolve --role through the registry (T-372): the workspace that owns the current directory
 * names the worker for that role. Missing / stale workers are addressing errors with the
 * candidates listed — never a guess.
 */
export async function resolveRoleTarget(base, role, fetchImpl = fetch) {
  const registryRes = await fetchImpl(`${base}/mesh/workspaces`)
  let registry = null
  try {
    registry = await registryRes.json()
  } catch {
    registry = null
  }
  if (!registryRes.ok || !registry || registry.ok === false) {
    addressFail(`读取工作区注册表失败：HTTP ${registryRes.status}`)
  }
  const workspaces = registry.workspaces && typeof registry.workspaces === 'object' ? registry.workspaces : {}
  const normalize = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const cwd = normalize(process.cwd())
  const slug = Object.keys(workspaces).find((key) => normalize(workspaces[key]?.cwd) === cwd)
  if (!slug) {
    const known = Object.entries(workspaces)
      .slice(0, 12)
      .map(([key, entry]) => `${key}=${entry?.cwd ?? '?'}`)
      .join(', ')
    addressFail(`当前目录 ${process.cwd()} 不对应任何已登记工作区（已登记：${known || '无'}）；在该目录启动一个会话，或改用 --coordinator / --target`)
  }
  const want = String(role ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '')
  const workers = workspaces[slug]?.workers && typeof workspaces[slug].workers === 'object' ? workspaces[slug].workers : {}
  const worker = workers[want]
  if (!worker || !worker.sessionId) {
    const known = Object.keys(workers).join(', ') || '无'
    addressFail(`工作区 ${slug} 没有 "${want}" worker（已登记角色：${known}）；先让该角色会话启动，或登记 worker，或改用 --coordinator / --target`)
  }
  if (worker.stale === true) {
    const sessionsRes = await fetchImpl(`${base}/mesh/sessions?limit=500`)
    let sessions = null
    try {
      sessions = await sessionsRes.json()
    } catch {
      sessions = null
    }
    const list = Array.isArray(sessions?.sessions) ? sessions.sessions : []
    const candidates = list
      .filter((session) => String(session.title ?? '').toLowerCase().includes(want))
      .slice(0, 5)
      .map((session) => `${session.id}(${session.title ?? '-'}${session.archived ? ', archived' : ''})`)
    addressFail(
      `工作区 ${slug} 的 "${want}" worker 会话 ${worker.sessionId} 已归档或不活跃；候选：${candidates.length ? candidates.join(', ') : '无（该角色没有其它会话）'}`,
    )
  }
  return { sessionId: worker.sessionId, slug, role: want }
}

/** Dispatch one task; returns the waker's result (plus created flag when it made a session). */
export async function run(options, fetchImpl = fetch) {
  const base = String(options.waker ?? DEFAULT_WAKER).replace(/\/+$/, '')
  let resolvedCoordinator = null
  if (options.coordinator !== undefined) {
    // Resolve before sending anything: a wrong address must never inject.
    resolvedCoordinator = await resolveCoordinator(base, options.coordinator, fetchImpl)
    options = { ...options, target: resolvedCoordinator.coordinator }
  }
  let resolvedRole = null
  if (options.role !== undefined) {
    resolvedRole = await resolveRoleTarget(base, options.role, fetchImpl)
    options = { ...options, target: resolvedRole.sessionId }
  }
  // How this task was addressed, recorded with the task so a later reader never has to guess.
  const routedTo =
    options.role !== undefined
      ? `role:${resolvedRole.slug}/${resolvedRole.role}`
      : options.coordinator !== undefined
        ? `workspace:${options.coordinator}`
        : options.thread !== undefined
          ? `thread:${options.thread}`
          : `session:${options.target}`
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
    ...(session ? { session } : options.target ? { session: options.target, title: options.target } : {}),
    text,
    mode: options.mode,
    // Where this dispatch was addressed (T-355): the waker persists it on the task row.
    routedTo,
    // Top level, exactly like the mesh_dispatch tool: /mesh/inject reads draft.thread.
    ...(options.thread ? { thread: options.thread } : {}),
    // Same place /mesh/inject reads the receipt target (draft.requester ?? meta.requester).
    ...(options.requester ? { requester: options.requester } : {}),
    ...(meta ? { meta } : {}),
  })

  if (options.dryRun) {
    return {
      dryRun: true,
      url: `${base}/mesh/inject`,
      routedTo,
      ...(resolvedCoordinator ? { resolvedCoordinator } : {}),
      ...(resolvedRole ? { resolvedRole } : {}),
      payload: payload(null),
    }
  }

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
    if (error?.exitCode) {
      console.error(error.message)
      process.exit(error.exitCode)
    }
    if (error?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/i.test(String(error.message))) {
      console.error(`waker 未运行或未监听 ${DEFAULT_WAKER}（${error.message}）`)
      process.exit(2)
    }
    console.error(error.message)
    process.exit(1)
  }
  if (options.dryRun) {
    const plan = result.payload ?? {}
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    const parts = ['dry-run']
    // The resolved coordinator lands in plan.session; --target would show the raw flag value.
    parts.push(plan.session ? `target=${plan.session}` : 'target=(via thread)')
    if (plan.title && plan.session && plan.title !== plan.session) parts.push(`title=${plan.title}`)
    if (result.routedTo) parts.push(`routedTo=${result.routedTo}`)
    parts.push(`requester=${plan.requester ?? '-'}`)
    parts.push(`task=${plan.meta?.taskId ?? '-'}`)
    if (plan.meta?.batchId) parts.push(`batch=${plan.meta.batchId}`)
    if (plan.thread) parts.push(`thread=${plan.thread}`)
    parts.push(`mode=${plan.mode ?? options.mode}`)
    parts.push(`textBytes=${Buffer.byteLength(String(plan.text ?? ''))}`)
    console.log(parts.join(' '))
    return
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
