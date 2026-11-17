#!/usr/bin/env node
/**
 * spawn.mjs — 从一个 L1/主导会话派生一层「专项会话」（重构讨论 / 方案对比 / 独立排查）
 *
 * 为什么：长上下文会注意力稀释、会幻觉，每次压缩都是不可逆失真。大主题不留在主线，
 * 派生一个只装这件事的会话，主线只留结论 + 报告路径。
 *
 * 做三件事（--apply 才执行）：
 *   1) POST <waker>/mesh/sessions/create（标题、cwd）
 *   2) POST <waker>/mesh/inject 把 brief 作为首单投给它（meta.taskId 显式，requester = 父会话）
 *   3) 追加一行父子关系到 <cwd>/.worklog/dispatch/derived-sessions.jsonl
 *
 * 不做标题查重：标题只是显示，身份走 session id（本项目收敛过，title 不参与任何判断）。
 * 防重复靠的是「上一个派生会话是否还活着」——`/mesh/sessions` 的 live/archived/last_active。
 *
 * 用法：
 *   node spawn.mjs --title "<标题>" --brief <brief.md> [--apply] [--json]
 *   node spawn.mjs --help
 *
 * 退出码：0 = 成功/dry-run；1 = 拒绝或失败；2 = 用法错误
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const BASE = process.env.MESH_WAKER_URL ?? 'http://127.0.0.1:8795'
const RECENT_MS = 2 * 60 * 60 * 1000
const ACTIVE_LIMIT = 3
const INDEX_WAIT_ATTEMPTS = 40
const INDEX_WAIT_MS = 250

const USAGE = `spawn.mjs — 派生一个专项会话（重构讨论 / 方案对比 / 独立排查）

用法：
  node spawn.mjs --title "<专项标题>" --brief <brief.md> [options] [--apply] [--json]

必填：
  --title <text>        新会话标题（≤60）
  --brief <file>        专项 brief 文件（空文件拒绝）

可选：
  --parent <id>         父会话 id（默认 $DSH_SESSION_ID），回执回到它
  --cwd <path>          新会话工作目录（默认当前目录）
  --role-card <path>    角色卡路径（相对 cwd；默认自动探测 .worklog/roles/special.md 或 l1-special.md）
  --report-dir <path>   期望产物目录（只写进 brief 提示，不创建；默认自动探测）
  --task-prefix <text>  taskId 前缀（默认 T）
  --task <id>           显式 taskId（覆盖前缀）
  --allow-nested        允许从派生会话再派生（默认只允许一层）
  --force               跳过「仍有存活派生会话」与并发上限的检查
  --apply               真正执行（默认 dry-run，零副作用）
  --json                机器可读输出
  -h, --help            本说明（零副作用）

环境：
  MESH_WAKER_URL        本机 waker 地址（默认 ${BASE}）
`

const ROLE_CANDIDATES = ['.worklog/roles/special.md', '.worklog/roles/l1-special.md', '.worklog/roles/l1.md']
const REPORT_CANDIDATES = ['.worklog/specs', '.worklog/reports']

/**
 * 标题命名规约（owner 2026-11-17）：标题只做显示，身份走 session id。
 * 不得用 `<工作区> · <角色>` 承载身份，也不得再用「协调 / coordinator」这类已废弃角色词。
 * 这条校验在创建之前执行——宁可拒绝，也不要生成一个违反规约的会话。
 */
const TITLE_LEGACY_PATTERN = /^.+\s·\s.+$/
const TITLE_LEGACY_WORDS = ['协调', 'coordinator']

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const val = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

class Refusal extends Error {
  constructor(message, code = 1) {
    super(message)
    this.exitCode = code
    /** Set once the message reached stderr, so the catch handler does not print it twice. */
    this.printed = false
  }
}

function refuse(message, code = 1) {
  // 拒绝理由必须打到 stderr：调用方要看见「已存在哪个会话 id」，否则只能猜。
  console.error(message)
  const error = new Refusal(message, code)
  error.printed = true
  // 不要用 process.exit()：fetch 之后硬退出会撞 libuv 断言（UV_HANDLE_CLOSING）。
  throw error
}

async function jsonFetch(pathname, init) {
  const response = await fetch(`${BASE}${pathname}`, init)
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { /* keep raw text for the error */ }
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
  return body
}

function detectFirst(cwd, candidates) {
  for (const candidate of candidates) {
    if (existsSync(path.join(cwd, candidate))) return candidate
  }
  return null
}

function readRegistry(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

async function waitUntilIndexed(sessionId) {
  for (let attempt = 0; attempt < INDEX_WAIT_ATTEMPTS; attempt += 1) {
    const listing = await jsonFetch('/mesh/sessions?limit=500').catch(() => null)
    if (listing?.sessions?.some((session) => session.id === sessionId)) return true
    await new Promise((resolve) => setTimeout(resolve, INDEX_WAIT_MS))
  }
  return false
}

/**
 * Pure part of the liveness check: which recent derived sessions are still running.
 *
 * Deliberately does NOT compare titles. A title is display text, an id is identity, and this
 * project converged on never deriving identity from the title. The question answered here is
 * "is the last derived session still running", from host facts only: `live` / `archived`.
 * A receipt that says `lost` proves nothing about the session — that misreading is exactly
 * how a duplicate same-topic session got spawned while the original was mid-analysis.
 *
 * `unknown` lists rows whose session no longer appears in the listing.
 */
export function pickAliveSessions(rows, sessions, { now = Date.now(), cwd = null, windowMs = RECENT_MS } = {}) {
  const recent = rows.filter((row) => {
    if (row.status !== 'dispatched') return false
    if (cwd !== null && row.cwd !== cwd) return false
    const created = Date.parse(row.createdAt)
    if (!Number.isFinite(created)) return false
    return now - created < windowMs
  })
  const byId = new Map((sessions ?? []).map((session) => [session.id, session]))
  const alive = []
  const unknown = []
  for (const row of recent) {
    const session = byId.get(row.child)
    if (!session) { unknown.push(row.child); continue }
    if (session.archived) continue
    if (session.live === false) continue
    const lastActiveMs = Number(session.last_active) || 0
    alive.push({ child: row.child, lastActiveMs, idleMs: lastActiveMs ? now - lastActiveMs : null })
  }
  return { alive, unknown }
}

/** Fetch the session list and apply pickAliveSessions. */
async function liveDerived(rows, cwd) {
  const recent = rows.some(
    (row) => row.status === 'dispatched' && row.cwd === cwd && Date.now() - Date.parse(row.createdAt) < RECENT_MS,
  )
  if (!recent) return { alive: [], unknown: [] }
  const listing = await jsonFetch('/mesh/sessions?limit=500').catch(() => null)
  if (!listing?.sessions) return { alive: [], unknown: [] }
  return pickAliveSessions(rows, listing.sessions, { cwd })
}

async function main() {
  if (has('-h') || has('--help')) {
    console.log(USAGE)
    return 0
  }

  const title = String(val('--title') ?? '').trim()
  const briefPath = val('--brief')
  if (!title || !briefPath) {
    console.error(USAGE)
    return 2
  }

  const parent = String(val('--parent') ?? process.env.DSH_SESSION_ID ?? '').trim()
  const cwd = path.resolve(val('--cwd') ?? process.cwd())
  const explicitTask = val('--task')
  const taskPrefix = String(val('--task-prefix') ?? 'T')
  const taskId = String(explicitTask ?? `${taskPrefix}-${Date.now().toString(36).toUpperCase()}`)
  const roleCard = String(val('--role-card') ?? detectFirst(cwd, ROLE_CANDIDATES) ?? '')
  const reportDir = String(val('--report-dir') ?? detectFirst(cwd, REPORT_CANDIDATES) ?? '.worklog/reports')
  const apply = has('--apply')
  const asJson = has('--json')

  if (title.length > 60) refuse(`标题过长：${title.length} > 60`, 2)
  if (TITLE_LEGACY_PATTERN.test(title)) {
    refuse(
      `标题 "${title}" 使用了已废弃的 <工作区> · <角色> 形式。\n` +
        '标题只做显示，身份走 session id；请用描述这件事本身的名字（如「重构讨论：发言架构」）。',
      2,
    )
  }
  for (const word of TITLE_LEGACY_WORDS) {
    if (title.toLowerCase().includes(word.toLowerCase())) {
      refuse(
        `标题 "${title}" 含已废弃角色词「${word}」：通用协调会话模型已废弃，不再按角色命名会话。\n` +
          '请用描述这件事本身的名字。',
        2,
      )
    }
  }

  const briefFile = path.resolve(briefPath)
  if (!existsSync(briefFile)) refuse(`brief 不存在：${briefFile}`, 1)
  const brief = readFileSync(briefFile, 'utf8').trim()
  if (!brief) refuse(`brief 为空：${briefFile}`, 1)
  if (!parent) refuse('拿不到父会话 id：传 --parent 或设置 DSH_SESSION_ID', 1)

  const registryFile = path.join(cwd, '.worklog', 'dispatch', 'derived-sessions.jsonl')
  const rows = readRegistry(registryFile)

  if (rows.some((row) => row.child === parent) && !has('--allow-nested')) {
    refuse(`父会话 ${parent} 本身是派生会话；默认只允许一层，确需嵌套加 --allow-nested`, 1)
  }
  const active = rows.filter((row) => row.status === 'dispatched' && Date.now() - Date.parse(row.createdAt) < RECENT_MS)
  if (active.length >= ACTIVE_LIMIT && !has('--force')) {
    refuse(`在飞派生会话已有 ${active.length} 个（上限 ${ACTIVE_LIMIT}）；先收报告或加 --force`, 1)
  }

  // 防重复开的真正判据：上一个派生会话**还活着**（宿主给的 live/archived/last_active），
  // 不是标题像不像，也不是回执是不是 lost。回执 lost 只说明这一单的投递没闭环，
  // 完全不能证明会话已停——那次事故就是这么来的。
  const { alive, unknown } = await liveDerived(rows, cwd)
  if (alive.length > 0 && !has('--force')) {
    const detail = alive
      .map((item) => {
        const idle = item.idleMs === null ? '活跃时间未知' : `${Math.round(item.idleMs / 60000)} 分钟无活动`
        return `  - ${item.child}（${idle}）`
      })
      .join('\n')
    refuse(
      `已有 ${alive.length} 个派生会话仍存活，默认不再开新的：\n${detail}\n` +
        '先确认它是不是还在处理（GET /mesh/sessions，看 live/last_active）；确需再开一个加 --force。',
      1,
    )
  }

  const header = roleCard ? `角色卡：先读 \`${roleCard}\` 并遵守；本单边界以下文为准。\n\n` : ''
  const footer = `\n\n---\n产物落 \`${reportDir}/\`；回执给父会话，细节放报告，不超过 10 行结论。`
  const text = brief.startsWith('角色卡：') ? brief : `${header}${brief}${footer}`

  const plan = {
    dryRun: !apply,
    parent,
    title,
    cwd,
    taskId,
    roleCard: roleCard || '(未探测到，brief 不加角色卡首行)',
    reportDir,
    briefBytes: Buffer.byteLength(text, 'utf8'),
    activeDerived: active.length,
    aliveDerived: alive.map((item) => ({ session: item.child, idleMinutes: item.idleMs === null ? null : Math.round(item.idleMs / 60000) })),
    unknownDerived: unknown,
  }

  if (!apply) {
    if (asJson) {
      console.log(JSON.stringify(plan, null, 2))
    } else {
      console.log(`dry-run: 将派生专项会话「${title}」`)
      console.log(`  parent=${parent}`)
      console.log(`  cwd=${cwd}`)
      console.log(`  task=${taskId} brief=${plan.briefBytes}B 在飞派生=${active.length}`)
      console.log(`  role-card=${plan.roleCard}`)
      console.log(`  report-dir=${reportDir}`)
      if (alive.length > 0) console.log(`  仍存活的派生会话：${alive.map((item) => item.child).join(', ')}（--force 才放行）`)
      console.log('  加 --apply 才建会话并派首单')
    }
    return 0
  }

  let created
  try {
    created = await jsonFetch('/mesh/sessions/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, workspacePath: cwd }),
    })
  } catch (error) {
    refuse(`建会话失败：${error.message}`, 1)
  }
  const child = created?.sessionId
  if (!child) refuse(`建会话返回无 sessionId：${JSON.stringify(created)}`, 1)

  const indexed = await waitUntilIndexed(child)
  if (!indexed) refuse(`会话 ${child} 建好后未在 10 秒内进索引，未投递；可稍后手工重投`, 1)

  try {
    await jsonFetch('/mesh/inject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session: child,
        text,
        mode: 'queue',
        requester: parent,
        subject: title.slice(0, 60),
        meta: { taskId, receipt: 'queue' },
      }),
    })
  } catch (error) {
    refuse(`首单派发失败（会话 ${child} 已建，可手工重投）：${error.message}`, 1)
  }

  mkdirSync(path.dirname(registryFile), { recursive: true })
  appendFileSync(registryFile, `${JSON.stringify({
    parent,
    child,
    title,
    taskId,
    cwd,
    roleCard: roleCard || null,
    status: 'dispatched',
    createdAt: new Date().toISOString(),
  })}\n`)

  const result = { ok: true, child, taskId, title, parent, reportDir }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`spawned: ${title}`)
    console.log(`  child=${child}`)
    console.log(`  task=${taskId} parent=${parent}`)
    console.log(`  报告落 ${reportDir}/，回执回父会话（子会话首回合排在父回合之后，不是同步调用）`)
  }
  return 0
}

// Only run as a CLI: importing this module (tests, tooling) must not create sessions.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main()
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      if (!error?.printed) console.error(error?.message ?? error)
      process.exitCode = error?.exitCode ?? 1
    })
}
