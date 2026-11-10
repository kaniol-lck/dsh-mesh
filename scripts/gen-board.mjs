#!/usr/bin/env node
/**
 * gen-board.mjs — read-only task board for this workspace's ledgers.
 *
 * Reads:   .worklog/todo/*.md, .worklog/dispatch/queue.md, .worklog/ops/triage/*.json
 * Fetches: GET /mesh/status, /mesh/sessions?limit=200, /mesh/workspaces (loopback waker)
 * Writes:  nothing unless --out <file> is given (single self-contained HTML file).
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
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKLOG = process.env.MESH_WORKLOG_DIR ?? path.join(ROOT, '.worklog')
const TODO_DIR = path.join(WORKLOG, 'todo')
const QUEUE_FILE = path.join(WORKLOG, 'dispatch', 'queue.md')
const TRIAGE_DIR = path.join(WORKLOG, 'ops', 'triage')
const DEFAULT_WAKER = process.env.MESH_WAKER_URL ?? 'http://127.0.0.1:8795'

const USAGE = `gen-board.mjs — read-only task board generated from the workspace ledgers

Usage:
  node scripts/gen-board.mjs                    print stats only (no file written)
  node scripts/gen-board.mjs --out <file>       write the self-contained HTML board
  node scripts/gen-board.mjs --offline          skip waker fetches (ledgers only)
  node scripts/gen-board.mjs --waker-url <url>  waker base URL (default ${DEFAULT_WAKER})

Inputs (relative to this repo): .worklog/todo/*.md, .worklog/dispatch/queue.md,
.worklog/ops/triage/*.json. With a reachable waker it also reads /mesh/status,
/mesh/sessions?limit=200 and /mesh/workspaces; if the waker is down the board is
still generated and marked offline. --help prints this text and writes nothing.`

function parseArgs(argv) {
  const options = { out: null, offline: false, wakerUrl: DEFAULT_WAKER, help: false }
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
      const field = (name) => {
        const found = new RegExp(`${name}：([^；]*)`).exec(rest)
        return found ? found[1].trim() : ''
      }
      const status = field('状态') || '待办'
      entries.push({
        id: `todo:${name}:${index + 1}`,
        priority,
        title: titlePart.trim(),
        status,
        role: field('归属') || ownerFile,
        feature: field('功能'),
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

async function fetchJson(base, route) {
  try {
    const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, data: await response.json() }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

async function readWaker(base) {
  const [status, sessions, workspaces] = await Promise.all([
    fetchJson(base, '/mesh/status'),
    fetchJson(base, '/mesh/sessions?limit=200'),
    fetchJson(base, '/mesh/workspaces'),
  ])
  const sessionList = sessions.ok ? sessions.data.sessions ?? [] : []
  const workspaceMap = workspaces.ok ? workspaces.data.workspaces ?? {} : {}
  const coordinatorIds = new Set()
  for (const workspace of Object.values(workspaceMap)) {
    if (workspace?.coordinator) coordinatorIds.add(workspace.coordinator)
    for (const entry of workspace?.coordinators ?? []) {
      if (entry?.sessionId) coordinatorIds.add(entry.sessionId)
    }
  }
  return {
    online: status.ok || sessions.ok || workspaces.ok,
    errors: [status, sessions, workspaces].filter((item) => !item.ok).map((item) => item.error),
    pendingTasks: status.ok ? status.data.pendingTasks ?? null : null,
    tasksPoll: status.ok ? status.data.tasksPoll ?? null : null,
    sessions: sessionList.map((session) => ({
      id: session.id,
      title: session.title ?? '(untitled)',
      live: Boolean(session.live),
      archived: Boolean(session.archived),
      lastActive: session.last_active ?? null,
      isCoordinator: coordinatorIds.has(session.id),
    })),
    coordinatorIds: [...coordinatorIds],
    workspaces: Object.entries(workspaceMap).map(([slug, workspace]) => ({
      slug,
      cwd: workspace?.cwd ?? '',
      coordinator: workspace?.coordinator ?? null,
      coordinators: (workspace?.coordinators ?? []).map((entry) => entry.sessionId).filter(Boolean),
      workers: Object.keys(workspace?.workers ?? {}),
    })),
  }
}

function summarize(todos, queue, triage, waker) {
  const countBy = (status) => todos.filter((todo) => todo.status === status).length
  const liveSessions = waker.sessions.filter((session) => session.live && !session.archived)
  return {
    todoCount: todos.length,
    doingCount: countBy('进行中'),
    doneCount: countBy('已完成'),
    blockedCount: countBy('阻塞'),
    queueCount: queue.length,
    onlineSessionCount: liveSessions.length,
    coordinatorCount: waker.coordinatorIds.length,
    triageCount: Object.keys(triage).length,
    pendingTasks: waker.pendingTasks,
    wakerOnline: waker.online,
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function statusChip(status) {
  const value = String(status ?? '')
  if (value.includes('已完成') || value.includes('done') || value.includes('deployed')) return 'chip done'
  if (value.includes('进行中') || value.includes('started') || value.includes('committed')) return 'chip doing'
  if (value.includes('阻塞') || value.includes('blocked')) return 'chip blocked'
  return 'chip todo'
}

function renderHtml(model) {
  const { generatedAt, stats, todos, queue, triage, waker } = model
  const payload = JSON.stringify({ todos, queue, triage, waker, stats }).replace(/</g, '\\u003c')
  const roles = [...new Set(todos.map((todo) => todo.role))].sort()
  const recentQueue = [...queue].slice(-15).reverse()
  const recentTriage = Object.values(triage)
    .sort((left, right) => String(right.checkedAt ?? '').localeCompare(String(left.checkedAt ?? '')))
    .slice(0, 10)
  const sessions = [...waker.sessions].sort((left, right) => Number(right.live) - Number(left.live) || Number(right.lastActive ?? 0) - Number(left.lastActive ?? 0))

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
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:18px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .stat b { display:block; font-size:22px; }
  .stat span { color:var(--muted); font-size:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:16px; }
  .card h2 { font-size:14px; margin:0 0 10px; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
  button { border:1px solid var(--line); background:var(--card); color:var(--text); border-radius:999px; padding:5px 12px; font-size:12px; cursor:pointer; }
  button.active { border-color:#93c5fd; background:#eff6ff; color:#1d4ed8; }
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
  .split { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  ul.plain { list-style:none; margin:0; padding:0; }
  ul.plain li { padding:5px 0; border-bottom:1px dashed var(--line); font-size:12.5px; }
  @media (max-width: 760px) { .split { grid-template-columns:1fr; } th, td { padding:6px 4px; } td.accept { display:none; } th.accept { display:none; } }
</style>
</head>
<body>
<main>
  <h1>任务板 · dsh-mesh</h1>
  <div class="sub">生成于 ${escapeHtml(generatedAt)} · 数据源：todo / queue / triage${waker.online ? '' : ' · waker 离线（仅账本）'}</div>
  <section class="grid" id="stats">
    <div class="stat"><b>${stats.todoCount}</b><span>待办条目</span></div>
    <div class="stat"><b>${stats.doingCount}</b><span>进行中</span></div>
    <div class="stat"><b>${stats.doneCount}</b><span>已完成</span></div>
    <div class="stat"><b>${stats.queueCount}</b><span>派单</span></div>
    <div class="stat"><b>${stats.onlineSessionCount}</b><span>在线会话</span></div>
    <div class="stat"><b>${stats.coordinatorCount}</b><span>协调</span></div>
  </section>

  <section class="card">
    <h2>任务（${todos.length}）</h2>
    <div class="filters" id="roleFilters"><button data-role="全部" class="active">全部</button>${roles.map((role) => `<button data-role="${escapeHtml(role)}">${escapeHtml(role)}</button>`).join('')}</div>
    <div class="filters" id="statusFilters"><button data-status="全部" class="active">全部状态</button><button data-status="待办">待办</button><button data-status="进行中">进行中</button><button data-status="已完成">已完成</button></div>
    <table>
      <thead><tr><th>编号</th><th>归属</th><th>状态</th><th>标题</th><th class="accept">验收</th><th>行</th></tr></thead>
      <tbody id="todoBody"></tbody>
    </table>
    <div class="empty" id="todoEmpty" hidden>没有匹配的条目</div>
  </section>

  <div class="split">
    <section class="card">
      <h2>协调与会话</h2>
      <ul class="plain" id="memberList"></ul>
    </section>
    <section class="card">
      <h2>最近活动</h2>
      <ul class="plain" id="activityList"></ul>
    </section>
  </div>
</main>
<script>
const DATA = ${payload};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const chipClass = (status) => {
  const value = String(status ?? '');
  if (value.includes('已完成') || value.includes('done') || value.includes('deployed')) return 'chip done';
  if (value.includes('进行中') || value.includes('started') || value.includes('committed')) return 'chip doing';
  if (value.includes('阻塞') || value.includes('blocked')) return 'chip blocked';
  return 'chip todo';
};
let activeRole = '全部';
let activeStatus = '全部';
function renderTodos() {
  const rows = DATA.todos.filter((todo) =>
    (activeRole === '全部' || todo.role === activeRole) &&
    (activeStatus === '全部' || todo.status === activeStatus));
  document.getElementById('todoBody').innerHTML = rows.map((todo) => '<tr>' +
    '<td class="num">' + esc(todo.priority) + '</td>' +
    '<td>' + esc(todo.role) + '</td>' +
    '<td><span class="' + chipClass(todo.status) + '">' + esc(todo.status) + '</span></td>' +
    '<td>' + esc(todo.title) + '</td>' +
    '<td class="accept muted">' + esc((todo.acceptance || '').slice(0, 120)) + '</td>' +
    '<td class="num">' + esc(todo.file.split('/').pop()) + ':' + todo.line + '</td></tr>').join('');
  document.getElementById('todoEmpty').hidden = rows.length > 0;
}
function bindFilters() {
  document.querySelectorAll('#roleFilters button').forEach((button) => button.addEventListener('click', () => {
    activeRole = button.dataset.role;
    document.querySelectorAll('#roleFilters button').forEach((item) => item.classList.toggle('active', item === button));
    renderTodos();
  }));
  document.querySelectorAll('#statusFilters button').forEach((button) => button.addEventListener('click', () => {
    activeStatus = button.dataset.status;
    document.querySelectorAll('#statusFilters button').forEach((item) => item.classList.toggle('active', item === button));
    renderTodos();
  }));
}
function renderMembers() {
  const items = DATA.waker.sessions.slice(0, 40).map((session) =>
    '<li>' + (session.isCoordinator ? '🟦 ' : '') + esc(session.title) +
    ' <span class="muted">· ' + (session.live ? 'live' : 'idle') + (session.archived ? ' · archived' : '') +
    (session.lastActive ? ' · ' + new Date(session.lastActive).toLocaleString() : '') + '</span></li>');
  document.getElementById('memberList').innerHTML = items.join('') || '<li class="muted">waker 离线，无会话数据</li>';
}
function renderActivity() {
  const queueItems = DATA.queue.slice(-8).reverse().map((row) =>
    '<li><span class="muted">' + esc(row.taskId) + '</span> ' + esc(row.subject) +
    ' <span class="' + chipClass(row.status) + '">' + esc(row.status) + '</span></li>');
  const triageItems = Object.values(DATA.triage).slice(-5).map((stamp) =>
    '<li><span class="muted">triage</span> ' + esc(stamp.taskId) + ' · ' + esc(stamp.verdict) +
    (stamp.needsReview ? ' · needsReview' : '') + '</li>');
  document.getElementById('activityList').innerHTML = [...queueItems, ...triageItems].join('') || '<li class="muted">暂无活动</li>';
}
bindFilters();
renderTodos();
renderMembers();
renderActivity();
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
  const emptyWaker = { online: false, errors: [], pendingTasks: null, tasksPoll: null, sessions: [], coordinatorIds: [], workspaces: [] }
  return (async () => {
    const waker = options.offline ? emptyWaker : await readWaker(options.wakerUrl)
    const stats = summarize(todos, queue, triage, waker)
    const summary = `todo=${stats.todoCount} doing=${stats.doingCount} done=${stats.doneCount} queue=${stats.queueCount} onlineSessions=${stats.onlineSessionCount} coordinators=${stats.coordinatorCount} waker=${stats.wakerOnline ? 'online' : 'offline'}`
    if (!options.out) {
      console.log(summary)
      return 0
    }
    const model = {
      generatedAt: new Date().toISOString(),
      stats,
      todos,
      queue,
      triage,
      waker,
    }
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
