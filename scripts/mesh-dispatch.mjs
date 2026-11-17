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
const INDEX = process.env.MESH_SESSIONS_INDEX ?? path.join(os.homedir(), '.dsh', 'mesh-waker', 'sessions-index.json')
const BASE = process.env.MESH_WAKER_URL ?? 'http://127.0.0.1:8795'
const WAKE_PREFIX = /^\[WAKE\]/
const DEBOUNCE_MS = 60_000
const USAGE = `mesh-dispatch — dispatch via the waker plugin CLI (single implementation)

Usage:
  node scripts/mesh-dispatch.mjs --session <id> --file task.txt
  node scripts/mesh-dispatch.mjs --target <session-id> --thread TH-1 --text "..."
  node scripts/mesh-dispatch.mjs --coordinator <slug> --wake --text "[WAKE] ..."
  node scripts/mesh-dispatch.mjs --session <id> --text "..." --dry-run

Local extensions (not part of the plugin CLI):
  --coordinator <s>  resolve the workspace <s> routing session from the registry field 'coordinator'
                     field (a session id); --role is an alias. Titles are never matched.
  --wake             send directly to the waker inject API; text must start with "[WAKE]"
  --dry-run          with --wake: print target + dedupe key + 未投递, send nothing
  --repo <path>      workspace used by --coordinator and the wake dedupe file (default: cwd)
  --expect-branch <b>  expected branch of the target workspace (forwarded as meta.expectBranch).
                     Dispatch with "dev" in this repo by default — main only takes release merges.
                     The script sets no default: omitted means nothing is sent (assign.mjs adds dev
                     by convention). Responses/receipts carry git.branch (settlement snapshot);
                     a mismatch only adds a "branch mismatch: ..." warning in warnings and never
                     blocks delivery; workers must not "git switch" on their own.

Wake target: explicit --session/--target/--thread/--coordinator/--role is used as-is; title addressing is removed.
With no target, --wake exits 2 with the explicit options. --create is removed: the generic
coordinator-session model is retired (owner 2026-11-17), and titles are display-only — never
"<workspace> · <role>". Need a new session? Derive one from L1 with the spawn skill.
Everything else is forwarded unchanged
(--target/--thread/--task/--receipt/--requester/--file/--text/--mode/--batch/--deadline/--dry-run/--json).
`

function normalize(value) {
  const resolved = path.resolve(String(value))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function readIndex() {
  if (!existsSync(INDEX)) throw new Error(`sessions index not found: ${INDEX}`)
  return JSON.parse(readFileSync(INDEX, 'utf8'))
}

/** archived/live flags live in the waker, not in the local index (GET only, never inject). */
async function sessionMeta() {
  const response = await fetch(`${BASE}/mesh/sessions`)
  if (!response.ok) throw new Error(`GET /mesh/sessions -> HTTP ${response.status}; pass --session <id> instead of resolving by title`)
  const payload = await response.json()
  const map = new Map()
  for (const session of payload.sessions ?? []) map.set(session.id, session)
  return map
}

function describeCandidate(id, session, meta) {
  const live = meta.get(id) ?? {}
  return `${id}  title=${JSON.stringify(session.title)}  archived=${live.archived ?? '?'}  live=${live.live ?? '?'}  mtime=${session.mtime ?? '?'}`
}

function wakeTargetFile() {
  return process.env.MESH_WAKE_TARGET ?? path.join(ROOT, '.worklog', 'dispatch', 'wake-target.txt')
}

function recordedWakeTarget(activeIds) {
  const file = wakeTargetFile()
  if (!existsSync(file)) return null
  const id = readFileSync(file, 'utf8').trim()
  return activeIds.includes(id) ? id : null
}

function pickActive(title, active, archived, meta, hint) {
  if (!active.length) {
    if (archived.length) {
      throw new Error(
        `title ${JSON.stringify(title)} only matches archived session(s):\n  ${archived
          .map(([id, session]) => describeCandidate(id, session, meta))
          .join('\n  ')}\nuse --session <id> (current coordinator id: ${wakeTargetFile()})`,
      )
    }
    throw new Error(
      `no active session titled ${JSON.stringify(title)}${hint ? ` (${hint})` : ''}; ` +
        `pass --session <id> (current coordinator id: ${wakeTargetFile()})`,
    )
  }
  if (active.length === 1) return active[0][0]
  const recorded = recordedWakeTarget(active.map(([id]) => id))
  if (recorded) return recorded
  throw new Error(
    `title ${JSON.stringify(title)} matches ${active.length} active sessions:\n  ${active
      .map(([id, session]) => describeCandidate(id, session, meta))
      .join('\n  ')}\npass --session <id> or --coordinator <slug>`,
  )
}

async function resolveTitle(title, repo) {
  const index = readIndex()
  const wanted = normalize(repo ?? process.cwd())
  const meta = await sessionMeta()
  const candidates = Object.entries(index).filter(
    ([, session]) =>
      session && session.title && (session.title === title || session.title.startsWith(`${title} `)) &&
      session.cwd && normalize(session.cwd) === wanted,
  )
  const isArchived = ([id]) => meta.get(id)?.archived === true || meta.get(id)?.live === false
  const active = candidates.filter((entry) => !isArchived(entry))
  const archived = candidates.filter((entry) => isArchived(entry))
  return pickActive(title, active, archived, meta, `repo ${wanted}`)
}

/**
 * 按 slug 解析该工作区的路由会话：**读注册表的 coordinator 字段（session id）**，
 * 不再按标题前缀猜（标题只做显示；`<工作区> · 协调` 已废弃，见 owner 2026-11-17）。
 */
async function resolveCoordinator(slug, repo) {
  const wanted = normalize(repo ?? process.cwd())
  try {
    const response = await fetch(`${BASE}/mesh/workspaces`)
    if (response.ok) {
      const payload = await response.json()
      const workspace = payload.workspaces?.[slug]
      const sessionId = workspace?.coordinator
      if (typeof sessionId === 'string' && /^session-[A-Za-z0-9-]+$/.test(sessionId)) {
        if (!workspace?.cwd || normalize(workspace.cwd) === wanted) return sessionId
      }
    }
  } catch {
    /* fall through to the explicit error below */
  }
  throw new Error(
    `工作区 "${slug}" 没有登记可用的 coordinator（注册表 coordinator 字段）；` +
      '按标题猜协调会话的做法已废弃——请改用 --session <id>。',
  )
}

function valueOf(argv, index) {
  return argv[index + 1] !== undefined && !String(argv[index + 1]).startsWith('--') ? argv[index + 1] : undefined
}

async function workspaceSlug(repo) {
  const wanted = normalize(repo)
  try {
    const response = await fetch(`${BASE}/mesh/workspaces`)
    if (response.ok) {
      const payload = await response.json()
      for (const [slug, workspace] of Object.entries(payload.workspaces ?? {})) {
        if (workspace?.cwd && normalize(workspace.cwd) === wanted) return slug
      }
    }
  } catch {
    /* fall back to the directory name below */
  }
  return path.basename(path.resolve(repo))
}

/**
 * 通用协调会话模型已废弃（owner 2026-11-17）：不再按 `<工作区> · 协调 <n>` 建会话。
 * 需要唤醒一个还没起的会话时，用显式 `--session <id>`，或先由 L1 派生专项会话
 * （`spawn` 技能）。这里保留函数只为给出可执行的报错，不再创建任何东西。
 */
async function refuseLegacyCreate() {
  console.error(
    '--create 已移除：通用协调会话模型已废弃，且不再按 "<工作区> · <角色>" 生成标题。\n' +
      '改用：--session <session-id>（已存在的会话）；需要新会话时由 L1 用 spawn 技能派生。',
  )
  process.exit(2)
}

async function wake(argv) {
  const titleIndex = argv.indexOf('--title')
  const repoIndex = argv.indexOf('--repo')
  const sessionIndex = argv.indexOf('--session')
  const coordinatorIndex = argv.indexOf('--coordinator')
  const roleIndex = argv.indexOf('--role')
  const targetIndex = argv.indexOf('--target')
  const threadIndex = argv.indexOf('--thread')
  const title = titleIndex >= 0 ? valueOf(argv, titleIndex) : undefined
  const session = sessionIndex >= 0 ? valueOf(argv, sessionIndex) : undefined
  const coordinator = coordinatorIndex >= 0 ? valueOf(argv, coordinatorIndex) : roleIndex >= 0 ? valueOf(argv, roleIndex) : undefined
  const explicitTarget = targetIndex >= 0 ? valueOf(argv, targetIndex) : undefined
  const thread = threadIndex >= 0 ? valueOf(argv, threadIndex) : undefined
  const repo = repoIndex >= 0 ? valueOf(argv, repoIndex) : process.cwd()
  const dryRun = argv.includes('--dry-run')
  const create = argv.includes('--create')
  const textIndex = argv.indexOf('--text')
  const fileIndex = argv.indexOf('--file')
  const text = textIndex >= 0 ? valueOf(argv, textIndex) : fileIndex >= 0 ? readFileSync(path.resolve(valueOf(argv, fileIndex)), 'utf8') : undefined
  if (text === undefined) throw new Error('--wake needs --text or --file')
  if (!WAKE_PREFIX.test(text.replace(/^\uFEFF/, ''))) {
    throw new Error('wake payload must start with "[WAKE] <one-line summary>"')
  }
  let target
  if (session) {
    target = session
  } else if (coordinator) {
    target = await resolveCoordinator(coordinator, repo)
  } else if (explicitTarget) {
    target = explicitTarget.startsWith('session-') ? explicitTarget : await resolveTitle(explicitTarget, repo)
  } else if (thread) {
    throw new Error('--wake cannot follow a thread binding; pass --session <id> or --coordinator <slug>')
  } else if (title) {
    target = await resolveTitle(title, repo)
  } else if (create) {
    await refuseLegacyCreate()
    return
  } else {
    console.error(
      '--wake needs an explicit target: --session <id> | --coordinator <slug>。' +
        '（--create 已移除：通用协调会话模型废弃；新会话由 L1 用 spawn 技能派生）',
    )
    process.exit(2)
  }
  const dedupeFile = path.join(path.resolve(repo), '.worklog', 'dispatch', '.wake-dedupe.json')
  const key = `${target}|${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
  const createdFlag = ''
  if (dryRun) {
    console.log(`dry-run: session=${target} dedupeKey=${key} chars=${text.length} wake=yes 未投递（未写去重文件）${createdFlag}`)
    return
  }
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
  console.log(`sent session=${target} chars=${text.length} wake=yes${createdFlag}`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('-h') || argv.includes('--help')) { console.log(USAGE); return 0 }
  if (argv.includes('--title')) {
    console.error('--title 已移除：标题只做显示；请用 --session <id>、--role <role> 或 --coordinator <slug>')
    return 2
  }
  if (argv.includes('--wake')) { await wake(argv); return 0 }
  const forwarded = []
  let title
  let coordinator
  let repo
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--title') { title = argv[index + 1]; index += 1; continue }
    if (arg === '--coordinator') { coordinator = argv[index + 1]; index += 1; continue }
    if (arg === '--repo') { repo = argv[index + 1]; index += 1; continue }
    if (arg === '--target') {
      const value = argv[index + 1]
      if (!argv.includes('--create') && !/^session-[A-Za-z0-9-]+$/.test(String(value ?? ''))) {
        console.error('--target 只接受 session id（标题寻址已移除）；按角色用 --role，按协调用 --coordinator')
        return 2
      }
      forwarded.push('--target', value)
      index += 1
      continue
    }
    if (arg === '--session') { forwarded.push('--target', argv[index + 1]); index += 1; continue }
    forwarded.push(arg)
  }
  if ((title !== undefined || coordinator !== undefined) && !forwarded.includes('--target') && !forwarded.includes('--thread')) {
    try {
      forwarded.push('--target', coordinator !== undefined ? await resolveCoordinator(coordinator, repo) : await resolveTitle(title, repo))
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
