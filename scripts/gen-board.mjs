#!/usr/bin/env node
/**
 * gen-board.mjs — read-only task board for this workspace's ledgers.
 *
 * Reads:   .worklog/todo/*.md, .worklog/dispatch/queue.md, .worklog/ops/triage/*.json
 * Fetches: GET /mesh/status, /mesh/sessions?limit=200, /mesh/workspaces (loopback waker)
 * Writes:  nothing unless --out <file> is given (single self-contained HTML file).
 *
 * The page has three tabs — 路线图 / 会话列表 / 派单列表 — plus the top counters.
 * Sessions are claimed by DSH session identity: coordinators[] -> 协调, workers[role] ->
 * that role, everything else -> 未登记. Archived, stopped (live=false) and unregistered
 * sessions are hidden by default; a toggle reveals them and their task history.
 *
 * Usage:
 *   node scripts/gen-board.mjs                    # print stats only (read-only)
 *   node scripts/gen-board.mjs --out .worklog/board.html
 *   node scripts/gen-board.mjs --offline          # skip the waker fetches
 *   node scripts/gen-board.mjs --waker-url http://127.0.0.1:8795
 *
 * No npm dependencies, no CDN: the HTML embeds JSON + plain CSS/JS.
 * Exit codes: 0 ok (also when the waker is unreachable — the board is marked offline), 1 read/write error.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKLOG = process.env.MESH_WORKLOG_DIR ?? path.join(ROOT, '.worklog')
const TODO_DIR = path.join(WORKLOG, 'todo')
const QUEUE_FILE = path.join(WORKLOG, 'dispatch', 'queue.md')
const TRIAGE_DIR = path.join(WORKLOG, 'ops', 'triage')
const DEFAULT_WAKER = process.env.MESH_WAKER_URL ?? 'http://127.0.0.1:8795'
const DEFAULT_MESH_HOME = process.env.MESH_HOME ?? path.join(os.homedir(), '.dsh', 'mesh-waker')
const DEFAULT_QUEUE_THRESHOLD = 10
const DEFAULT_WAIT_THRESHOLD_MIN = 30

const USAGE = `gen-board.mjs — read-only task board generated from the workspace ledgers

Usage:
  node scripts/gen-board.mjs                    print stats only (no file written)
  node scripts/gen-board.mjs --out <file>       write the self-contained HTML board
  node scripts/gen-board.mjs --offline          skip waker fetches (ledgers only)
  node scripts/gen-board.mjs --waker-url <url>  waker base URL (default ${DEFAULT_WAKER})
  node scripts/gen-board.mjs --mesh-home <dir>  waker home for tasks.jsonl (default ${DEFAULT_MESH_HOME})
  node scripts/gen-board.mjs --queue-threshold <n>   red row when pending+started > n (default 10)
  node scripts/gen-board.mjs --wait-threshold <min>  red row when oldest wait > min (default 30)

Inputs (relative to this repo): .worklog/todo/*.md, .worklog/dispatch/queue.md,
.worklog/ops/triage/*.json. With a reachable waker it also reads /mesh/status,
/mesh/sessions?limit=200 and /mesh/workspaces; if the waker is down the board is
still generated (sessions tab shows 离线) and marked offline.

Tabs: 路线图 (grouped by 功能), 会话列表 (claimed by DSH session; archived/stopped/
unregistered hidden by default), 派单列表 (all queue rows with status/role filters).
The queue columns come from <mesh-home>/ws/*/tasks.jsonl: one line per state change,
so counts use the LAST line per taskId (pending+started = queued, oldest wait =
now-createdAt, ETA = median settled durationMs x queue length).
--help prints this text and writes nothing.`

function parseArgs(argv) {
  const options = {
    out: null,
    offline: false,
    wakerUrl: DEFAULT_WAKER,
    meshHome: DEFAULT_MESH_HOME,
    queueThreshold: DEFAULT_QUEUE_THRESHOLD,
    waitThreshold: DEFAULT_WAIT_THRESHOLD_MIN,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      if (argv[index + 1] === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      return argv[index]
    }
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--offline') options.offline = true
    else if (arg === '--out') options.out = value()
    else if (arg === '--waker-url') options.wakerUrl = value().replace(/\/+$/, '')
    else if (arg === '--mesh-home') options.meshHome = value()
    else if (arg === '--queue-threshold') options.queueThreshold = Number(value())
    else if (arg === '--wait-threshold') options.waitThreshold = Number(value())
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function readTodoEntries() {
  if (!existsSync(TODO_DIR)) return []
  const entries = []
  for (const name of readdirSync(TODO_DIR).filter((file) => file.endsWith('.md')).sort()) {
    const ownerFile = name.replace(/\.md$/, '')
    const lines = readFileSync(path.join(TODO_DIR, name), 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const match = /^-\s*\[(P\d)\]\s*(.+)$/.exec(line.trim())
      if (!match) return
      const [, priority, body] = match
      const [titlePart, ...restParts] = body.split('——')
      const rest = restParts.join('——')
      const field = (label) => {
        const found = new RegExp(`${label}：([^；]*)`).exec(rest)
        return found ? found[1].trim() : ''
      }
      const status = field('状态') || '待办'
      entries.push({
        id: `todo:${name}:${index + 1}`,
        priority,
        title: titlePart.trim(),
        status,
        role: field('归属') || ownerFile,
        feature: field('功能') || '未分类',
        acceptance: field('验收'),
        progress: field('进展'),
        file: `.worklog/todo/${name}`,
        line: index + 1,
      })
    })
  }
  return entries
}

function readQueueRows() {
  if (!existsSync(QUEUE_FILE)) return []
  const rows = []
  const lines = readFileSync(QUEUE_FILE, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!/^\|\s*[A-Za-z0-9]/.test(line)) return
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 6) return
    rows.push({
      taskId: cells[0],
      role: cells[1],
      subject: cells[2],
      dispatchedAt: cells[3],
      expectation: cells[4],
      status: cells[5],
      line: index + 1,
    })
  })
  return rows
}

function readTriage() {
  if (!existsSync(TRIAGE_DIR)) return {}
  const triage = {}
  for (const name of readdirSync(TRIAGE_DIR).filter((file) => file.endsWith('.json'))) {
    try {
      const payload = JSON.parse(readFileSync(path.join(TRIAGE_DIR, name), 'utf8'))
      if (payload?.taskId) triage[payload.taskId] = payload
    } catch {
      /* one broken stamp must not hide the rest */
    }
  }
  return triage
}

/**
 * Queue depth from <mesh-home>/ws/<workspace>/tasks.jsonl.
 *
 * The file is an append-only log of STATE CHANGES (one taskId can appear as
 * pending -> started -> settled), so every count below uses the LAST line per
 * taskId; counting lines would overstate the queue (e.g. 22 lines ~= 11 tasks).
 * ETA = median durationMs of the last 20 settled tasks for that target x queue length.
 */
function readQueueState(meshHome) {
  const empty = {
    available: false,
    tasks: 0,
    pending: 0,
    started: 0,
    queued: 0,
    oldestWaitMin: null,
    sessions: {},
    unknownTargets: {},
  }
  if (!meshHome || !existsSync(meshHome)) return empty
  const wsRoot = path.join(meshHome, 'ws')
  if (!existsSync(wsRoot)) return empty
  const lastByTask = new Map()
  for (const workspace of readdirSync(wsRoot)) {
    const file = path.join(wsRoot, workspace, 'tasks.jsonl')
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry?.taskId) lastByTask.set(entry.taskId, entry)
      } catch {
        /* a torn line must not hide the rest */
      }
    }
  }
  const now = Date.now()
  const byTarget = new Map()
  const unknown = { pending: 0, started: 0, queued: 0, oldestWaitMin: null }
  const settledDurations = new Map()
  let pending = 0
  let started = 0
  let oldestWaitMin = null
  for (const entry of lastByTask.values()) {
    const target = entry.targetSessionId ?? entry.targetTitle ?? null
    if (entry.status === 'pending' || entry.status === 'started') {
      const waitMin = entry.createdAt ? (now - Number(entry.createdAt)) / 60000 : 0
      if (!target) {
        unknown[entry.status] += 1
        unknown.queued += 1
        unknown.oldestWaitMin = Math.max(unknown.oldestWaitMin ?? 0, waitMin)
      } else {
        if (!byTarget.has(target)) byTarget.set(target, { pending: 0, started: 0, queued: 0, oldestWaitMin: 0 })
        const bucket = byTarget.get(target)
        bucket[entry.status] += 1
        bucket.queued += 1
        bucket.oldestWaitMin = Math.max(bucket.oldestWaitMin, waitMin)
      }
      if (entry.status === 'pending') pending += 1
      else started += 1
      oldestWaitMin = Math.max(oldestWaitMin ?? 0, waitMin)
    } else if (entry.status === 'settled' && target && Number.isFinite(Number(entry.durationMs))) {
      if (!settledDurations.has(target)) settledDurations.set(target, [])
      settledDurations.get(target).push(Number(entry.durationMs))
    }
  }
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right)
    if (!sorted.length) return null
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
  }
  const sessions = {}
  for (const [target, bucket] of byTarget) {
    const durations = (settledDurations.get(target) ?? []).slice(-20)
    const medianDuration = median(durations)
    sessions[target] = {
      ...bucket,
      oldestWaitMin: Math.round(bucket.oldestWaitMin * 10) / 10,
      etaMin: medianDuration === null ? null : Math.round((medianDuration * bucket.queued) / 60000),
      sampleCount: durations.length,
    }
  }
  return {
    available: true,
    tasks: lastByTask.size,
    pending,
    started,
    queued: pending + started,
    oldestWaitMin: oldestWaitMin === null ? null : Math.round(oldestWaitMin * 10) / 10,
    sessions,
    unknownTargets: unknown,
  }
}

function attachQueue(waker, queueState) {
  for (const session of waker.sessions) {
    const bucket = queueState.sessions[session.id] ?? null
    session.queue = bucket
      ? { queued: bucket.queued, pending: bucket.pending, started: bucket.started, oldestWaitMin: bucket.oldestWaitMin, etaMin: bucket.etaMin }
      : { queued: 0, pending: 0, started: 0, oldestWaitMin: null, etaMin: null }
  }
  waker.queue = {
    available: queueState.available,
    tasks: queueState.tasks,
    queued: queueState.queued,
    oldestWaitMin: queueState.oldestWaitMin,
    unknownTargets: queueState.unknownTargets,
  }
  return waker
}

async function fetchJson(base, route) {
  try {
    const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, data: await response.json() }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/** sessionId -> role, from workspaces.json semantics (coordinators[] / legacy coordinator / workers). */
function buildRoleMap(workspaceMap) {
  const roleMap = new Map()
  for (const workspace of Object.values(workspaceMap ?? {})) {
    for (const entry of workspace?.coordinators ?? []) {
      if (entry?.sessionId) roleMap.set(entry.sessionId, '协调')
    }
    if (workspace?.coordinator) roleMap.set(workspace.coordinator, '协调')
    for (const [role, worker] of Object.entries(workspace?.workers ?? {})) {
      if (worker?.sessionId) roleMap.set(worker.sessionId, role)
    }
  }
  return roleMap
}

async function readWaker(base) {
  const [status, sessions, workspaces] = await Promise.all([
    fetchJson(base, '/mesh/status'),
    fetchJson(base, '/mesh/sessions?limit=200'),
    fetchJson(base, '/mesh/workspaces'),
  ])
  const sessionList = sessions.ok ? sessions.data.sessions ?? [] : []
  const workspaceMap = workspaces.ok ? workspaces.data.workspaces ?? {} : {}
  const roleMap = buildRoleMap(workspaceMap)
  const workspaceByCwd = new Map()
  for (const [slug, workspace] of Object.entries(workspaceMap)) {
    if (workspace?.cwd) workspaceByCwd.set(path.resolve(workspace.cwd).toLowerCase(), slug)
  }
  const enriched = sessionList.map((session) => {
    const role = roleMap.get(session.id) ?? '未登记'
    const slug = workspaceByCwd.get(path.resolve(session.cwd ?? '').toLowerCase()) ?? null
    return {
      id: session.id,
      title: session.title ?? '(untitled)',
      cwd: session.cwd ?? '',
      workspace: slug ?? session.workspace ?? null,
      live: Boolean(session.live),
      archived: Boolean(session.archived),
      lastActive: session.last_active ?? null,
      role,
      registered: role !== '未登记',
      hidden: Boolean(session.archived) || !session.live || role === '未登记',
    }
  })
  return {
    online: status.ok || sessions.ok || workspaces.ok,
    errors: [status, sessions, workspaces].filter((item) => !item.ok).map((item) => item.error),
    pendingTasks: status.ok ? status.data.pendingTasks ?? null : null,
    tasksPoll: status.ok ? status.data.tasksPoll ?? null : null,
    sessions: enriched,
    hiddenSessionCount: enriched.filter((session) => session.hidden).length,
    coordinators: enriched.filter((session) => session.role === '协调'),
    workspaces: Object.entries(workspaceMap).map(([slug, workspace]) => ({
      slug,
      cwd: workspace?.cwd ?? '',
      coordinator: workspace?.coordinator ?? null,
      coordinators: (workspace?.coordinators ?? []).map((entry) => entry.sessionId).filter(Boolean),
      workers: Object.keys(workspace?.workers ?? {}),
    })),
  }
}

const EMPTY_WAKER = {
  online: false,
  errors: [],
  pendingTasks: null,
  tasksPoll: null,
  sessions: [],
  hiddenSessionCount: 0,
  coordinators: [],
  workspaces: [],
}

function summarize(todos, queue, triage, waker) {
  const countBy = (status) => todos.filter((todo) => todo.status === status).length
  return {
    todoCount: todos.length,
    doingCount: countBy('进行中'),
    doneCount: countBy('已完成'),
    blockedCount: countBy('阻塞'),
    queueCount: queue.length,
    onlineSessionCount: waker.sessions.filter((session) => session.live && !session.archived).length,
    coordinatorCount: waker.coordinators.length,
    hiddenSessionCount: waker.hiddenSessionCount,
    queuePendingStarted: waker.queue?.queued ?? null,
    queueOldestWaitMin: waker.queue?.oldestWaitMin ?? null,
    queueAvailable: Boolean(waker.queue?.available),
    triageCount: Object.keys(triage).length,
    pendingTasks: waker.pendingTasks,
    wakerOnline: waker.online,
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function renderHtml(model) {
  const { generatedAt, stats, todos, queue, triage, waker, thresholds } = model
  const payload = JSON.stringify({ todos, queue, triage, waker, stats, thresholds }).replace(/</g, '\\u003c')
  const roles = [...new Set(todos.map((todo) => todo.role))].sort()

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>任务板 · dsh-mesh</title>
<style>
  :root { color-scheme: light; --bg:#f6f7f9; --card:#fff; --line:#e5e7eb; --text:#111827; --muted:#6b7280;
          --green:#15803d; --green-bg:#dcfce7; --blue:#1d4ed8; --blue-bg:#dbeafe; --gray:#4b5563; --gray-bg:#f3f4f6;
          --amber:#b45309; --amber-bg:#fef3c7; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width:1180px; margin:0 auto; padding:20px 16px 48px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:12px; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:18px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .stat b { display:block; font-size:22px; }
  .stat span { color:var(--muted); font-size:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:16px; }
  .card h2 { font-size:14px; margin:0 0 10px; }
  .tabs { display:flex; gap:6px; margin:0 0 14px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .tab { border:1px solid transparent; border-bottom:none; background:transparent; border-radius:10px 10px 0 0; padding:8px 14px; font-size:13px; color:var(--muted); cursor:pointer; }
  .tab.active { background:var(--card); border-color:var(--line); color:var(--text); font-weight:600; margin-bottom:-1px; }
  .panel { display:none; }
  .panel.active { display:block; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; align-items:center; }
  button { border:1px solid var(--line); background:var(--card); color:var(--text); border-radius:999px; padding:5px 12px; font-size:12px; cursor:pointer; }
  button.active { border-color:#93c5fd; background:#eff6ff; color:#1d4ed8; }
  .toggle { margin-left:auto; font-size:12px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; font-size:12.5px; }
  th { color:var(--muted); font-weight:600; font-size:11.5px; white-space:nowrap; }
  td.num { white-space:nowrap; color:var(--muted); }
  .chip { display:inline-block; border-radius:999px; padding:1px 8px; font-size:11px; white-space:nowrap; }
  .chip.done { color:var(--green); background:var(--green-bg); }
  .chip.doing { color:var(--blue); background:var(--blue-bg); }
  .chip.todo { color:var(--gray); background:var(--gray-bg); }
  .chip.blocked { color:var(--amber); background:var(--amber-bg); }
  .muted { color:var(--muted); }
  .empty { color:var(--muted); font-size:12px; padding:8px 0; }
  .feature { margin:14px 0 6px; font-size:13px; font-weight:600; }
  .feature span { color:var(--muted); font-weight:400; font-size:12px; }
  .session-row { cursor:pointer; }
  .session-row:hover { background:#fafafa; }
  .session-row.hot td { background:#fef2f2; }
  .history { background:#fafafa; }
  .history ul { list-style:none; margin:6px 0; padding:0 0 0 12px; border-left:2px solid var(--line); }
  .history li { padding:3px 0; font-size:12px; }
  @media (max-width: 760px) { th, td { padding:6px 4px; } td.accept, th.accept { display:none; } }
</style>
</head>
<body>
<main>
  <h1>任务板 · dsh-mesh</h1>
  <div class="sub">生成于 ${escapeHtml(generatedAt)} · 数据源：todo / queue / triage${waker.online ? '' : ' · waker 离线（仅账本）'}</div>
  <section class="grid">
    <div class="stat"><b>${stats.todoCount}</b><span>待办条目</span></div>
    <div class="stat"><b>${stats.doingCount}</b><span>进行中</span></div>
    <div class="stat"><b>${stats.doneCount}</b><span>已完成</span></div>
    <div class="stat"><b>${stats.queueCount}</b><span>派单</span></div>
    <div class="stat"><b>${stats.onlineSessionCount}</b><span>在线会话</span></div>
    <div class="stat"><b>${stats.coordinatorCount}</b><span>协调</span></div>
    <div class="stat"><b>${stats.hiddenSessionCount}</b><span>隐藏会话</span></div>
    <div class="stat"><b>${stats.queuePendingStarted ?? '—'}</b><span>排队 pending+started</span></div>
    <div class="stat"><b>${stats.queueOldestWaitMin === null || stats.queueOldestWaitMin === undefined ? '—' : stats.queueOldestWaitMin + 'm'}</b><span>最老等待</span></div>
  </section>

  <nav class="tabs">
    <button class="tab active" data-tab="roadmap">路线图</button>
    <button class="tab" data-tab="sessions">会话列表</button>
    <button class="tab" data-tab="queue">派单列表</button>
  </nav>

  <section class="panel active" id="panel-roadmap">
    <div class="card">
      <h2>路线图（${todos.length} 条，按功能分组）</h2>
      <div class="filters" id="roleFilters"><button data-role="全部" class="active">全部</button>${roles.map((role) => `<button data-role="${escapeHtml(role)}">${escapeHtml(role)}</button>`).join('')}</div>
      <div id="roadmapBody"></div>
      <div class="empty" id="roadmapEmpty" hidden>没有匹配的条目</div>
    </div>
  </section>

  <section class="panel" id="panel-sessions">
    <div class="card">
      <h2>会话列表（${waker.sessions.length} 个，隐藏 ${stats.hiddenSessionCount}）</h2>
      <div class="filters">
        <button id="showAllSessions">显示全部会话</button>
        <span class="toggle" id="sessionHint">默认隐藏 archived / 停用 / 未登记（被轮换）会话</span>
      </div>
      <div id="sessionsBody"></div>
    </div>
  </section>

  <section class="panel" id="panel-queue">
    <div class="card">
      <h2>派单列表（${queue.length} 条）</h2>
      <div class="filters" id="queueStatusFilters">
        <button data-status="全部" class="active">全部</button>
        <button data-status="done">done</button>
        <button data-status="dispatched">dispatched</button>
        <button data-status="committed">committed</button>
        <button data-status="其他">其他</button>
      </div>
      <div class="filters" id="queueRoleFilters"><button data-role="全部" class="active">全部角色</button>${[...new Set(queue.map((row) => row.role))].sort().map((role) => `<button data-role="${escapeHtml(role)}">${escapeHtml(role)}</button>`).join('')}</div>
      <table>
        <thead><tr><th>编号</th><th>会话</th><th>任务</th><th>时间</th><th>状态</th></tr></thead>
        <tbody id="queueBody"></tbody>
      </table>
      <div class="empty" id="queueEmpty" hidden>没有匹配的派单</div>
    </div>
  </section>
</main>
<script>
const DATA = ${payload};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STATUS_ORDER = ['进行中', '待办', '未开始', '已完成'];
const statusRank = (status) => {
  const index = STATUS_ORDER.findIndex((item) => String(status).includes(item));
  return index === -1 ? 2 : index;
};
const chipClass = (status) => {
  const value = String(status ?? '');
  if (value.includes('已完成') || value.includes('done') || value.includes('deployed')) return 'chip done';
  if (value.includes('进行中') || value.includes('started') || value.includes('committed')) return 'chip doing';
  if (value.includes('阻塞') || value.includes('blocked')) return 'chip blocked';
  return 'chip todo';
};
const relTime = (value) => {
  if (!value) return '—';
  const delta = Date.now() - Number(value);
  if (Number.isNaN(delta)) return '—';
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.floor(hours / 24) + ' 天前';
};
const cwdTail = (cwd) => String(cwd ?? '').split(/[\\\\/]/).filter(Boolean).slice(-2).join('/') || '—';

let activeRole = '全部';
let activeQueueStatus = '全部';
let activeQueueRole = '全部';
let showAllSessions = false;

function renderRoadmap() {
  const rows = DATA.todos.filter((todo) => activeRole === '全部' || todo.role === activeRole);
  const groups = new Map();
  for (const todo of rows) {
    const key = todo.feature || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(todo);
  }
  const html = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh')).map(([feature, items]) => {
    const sorted = [...items].sort((left, right) => statusRank(left.status) - statusRank(right.status));
    const done = sorted.filter((item) => item.status === '已完成').length;
    return '<div class="feature">' + esc(feature) + ' <span>· ' + sorted.length + ' 条（已完成 ' + done + '）</span></div>' +
      '<table><tbody>' + sorted.map((todo) =>
        '<tr><td class="num">' + esc(todo.priority) + '</td><td>' + esc(todo.role) + '</td>' +
        '<td><span class="' + chipClass(todo.status) + '">' + esc(todo.status) + '</span></td>' +
        '<td>' + esc(todo.title) + '</td>' +
        '<td class="accept muted">' + esc((todo.acceptance || '').slice(0, 110)) + '</td></tr>').join('') + '</tbody></table>';
  }).join('');
  document.getElementById('roadmapBody').innerHTML = html;
  document.getElementById('roadmapEmpty').hidden = rows.length > 0;
}

function queueHistoryFor(session) {
  if (session.role === '未登记') return [];
  return DATA.queue.filter((row) => row.role === session.role).slice(-15).reverse();
}

function renderSessions() {
  const rows = DATA.waker.sessions
    .filter((session) => showAllSessions || !session.hidden)
    .sort((left, right) => Number(right.live) - Number(left.live) || Number(right.lastActive ?? 0) - Number(left.lastActive ?? 0));
  document.getElementById('sessionsBody').innerHTML = rows.length === 0
    ? '<div class="empty">waker 离线或没有会话数据</div>'
    : '<table><thead><tr><th>会话</th><th>角色</th><th>状态</th><th>最近活跃</th><th>排队</th><th>最老等待</th><th>ETA</th><th>cwd</th></tr></thead><tbody>' +
      rows.map((session) => {
        const history = queueHistoryFor(session);
        const queue = session.queue || {};
        const queued = Number(queue.queued || 0);
        const waitMin = queue.oldestWaitMin === null || queue.oldestWaitMin === undefined ? null : Number(queue.oldestWaitMin);
        const etaMin = queue.etaMin === null || queue.etaMin === undefined ? null : Number(queue.etaMin);
        const hot = queued > DATA.thresholds.queueThreshold || (waitMin !== null && waitMin > DATA.thresholds.waitThreshold);
        const queueCell = queued ? String(queued) : '—';
        const waitCell = waitMin === null ? '—' : waitMin + 'm';
        const etaCell = etaMin === null ? '—' : '~' + etaMin + 'm';
        const historyHtml = '<tr class="history" hidden><td colspan="8"><ul>' +
          (history.length ? history.map((row) => '<li><span class="muted">' + esc(row.taskId) + '</span> ' + esc(row.subject) +
            ' <span class="' + chipClass(row.status) + '">' + esc(row.status) + '</span></li>').join('')
            : '<li class="muted">无关联派单记录</li>') +
          '</ul></td></tr>';
        return '<tr class="session-row' + (hot ? ' hot' : '') + '" data-session="' + esc(session.id) + '">' +
          '<td>' + esc(session.title) + ' <span class="muted">' + esc(session.id.replace(/^session-/, '').slice(0, 8)) + '</span></td>' +
          '<td>' + esc(session.role) + '</td>' +
          '<td>' + (session.live ? 'live' : 'idle') + (session.archived ? ' · archived' : '') + (session.registered ? '' : ' · 未登记') + '</td>' +
          '<td>' + relTime(session.lastActive) + '</td>' +
          '<td>' + queueCell + '</td><td>' + waitCell + '</td><td>' + etaCell + '</td>' +
          '<td class="muted">' + esc(cwdTail(session.cwd)) + '</td></tr>' + historyHtml;
      }).join('') + '</tbody></table>';
  document.querySelectorAll('.session-row').forEach((row) => row.addEventListener('click', () => {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('history')) next.hidden = !next.hidden;
  }));
}

function queueStatusBucket(status) {
  const value = String(status ?? '').toLowerCase();
  if (value.includes('done')) return 'done';
  if (value.includes('dispatched')) return 'dispatched';
  if (value.includes('committed')) return 'committed';
  return '其他';
}

function renderQueue() {
  const rows = DATA.queue.filter((row) =>
    (activeQueueStatus === '全部' || queueStatusBucket(row.status) === activeQueueStatus) &&
    (activeQueueRole === '全部' || row.role === activeQueueRole));
  document.getElementById('queueBody').innerHTML = rows.map((row) =>
    '<tr><td class="num">' + esc(row.taskId) + '</td><td>' + esc(row.role) + '</td><td>' + esc(row.subject) + '</td>' +
    '<td class="num">' + esc(row.dispatchedAt) + '</td>' +
    '<td><span class="' + chipClass(row.status) + '">' + esc(row.status) + '</span></td></tr>').join('');
  document.getElementById('queueEmpty').hidden = rows.length > 0;
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'panel-' + tab.dataset.tab));
  }));
  document.querySelectorAll('#roleFilters button').forEach((button) => button.addEventListener('click', () => {
    activeRole = button.dataset.role;
    document.querySelectorAll('#roleFilters button').forEach((item) => item.classList.toggle('active', item === button));
    renderRoadmap();
  }));
  document.querySelectorAll('#queueStatusFilters button').forEach((button) => button.addEventListener('click', () => {
    activeQueueStatus = button.dataset.status;
    document.querySelectorAll('#queueStatusFilters button').forEach((item) => item.classList.toggle('active', item === button));
    renderQueue();
  }));
  document.querySelectorAll('#queueRoleFilters button').forEach((button) => button.addEventListener('click', () => {
    activeQueueRole = button.dataset.role;
    document.querySelectorAll('#queueRoleFilters button').forEach((item) => item.classList.toggle('active', item === button));
    renderQueue();
  }));
  document.getElementById('showAllSessions').addEventListener('click', () => {
    showAllSessions = !showAllSessions;
    document.getElementById('showAllSessions').classList.toggle('active', showAllSessions);
    document.getElementById('showAllSessions').textContent = showAllSessions ? '隐藏未登记/停用会话' : '显示全部会话';
    renderSessions();
  });
}

bindTabs();
renderRoadmap();
renderSessions();
renderQueue();
</script>
</body>
</html>
`
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const todos = readTodoEntries()
  const queue = readQueueRows()
  const triage = readTriage()
  return (async () => {
    const waker = options.offline ? EMPTY_WAKER : await readWaker(options.wakerUrl)
    attachQueue(waker, options.offline ? readQueueState(null) : readQueueState(options.meshHome))
    const stats = summarize(todos, queue, triage, waker)
    const thresholds = { queueThreshold: options.queueThreshold, waitThreshold: options.waitThreshold }
    const summary = `todo=${stats.todoCount} doing=${stats.doingCount} done=${stats.doneCount} queue=${stats.queueCount} sessions=${waker.sessions.length} hiddenSessions=${stats.hiddenSessionCount} coordinators=${stats.coordinatorCount} pendingStarted=${stats.queuePendingStarted ?? '—'} oldestWaitMin=${stats.queueOldestWaitMin ?? '—'} waker=${stats.wakerOnline ? 'online' : 'offline'}`
    if (!options.out) {
      console.log(summary)
      return 0
    }
    const model = { generatedAt: new Date().toISOString(), stats, todos, queue, triage, waker, thresholds }
    const out = path.resolve(options.out)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, renderHtml(model), 'utf8')
    console.log(`${summary}\nboard=${out}`)
    return 0
  })()
}

Promise.resolve()
  .then(main)
  .then((code) => {
    process.exitCode = code ?? 0
  })
  .catch((error) => {
    console.error(`ERROR ${error.message}`)
    process.exitCode = 1
  })
