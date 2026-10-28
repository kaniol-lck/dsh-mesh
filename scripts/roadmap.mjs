#!/usr/bin/env node
/**
 * roadmap.mjs — summarize .worklog/todo/*.md into the auto-generated block of
 * ../ROADMAP.md, and render a self-contained local HTML view.
 *
 * Source of truth: .worklog/todo/<session>.md (local, never committed).
 * Only the text between <!-- AUTO:TODO START --> and <!-- AUTO:TODO END -->
 * is replaced; everything outside the markers is preserved byte-for-byte.
 *
 * Usage:
 *   node scripts/roadmap.mjs --write       rewrite ROADMAP auto block + .worklog/roadmap.html
 *   node scripts/roadmap.mjs --check       compare only (default): 0 match, 1 drift/parse error, 2 bad config
 *   node scripts/roadmap.mjs --json        dump the parsed model to stdout
 *   node scripts/roadmap.mjs --html-only   rerender the HTML only
 *
 * Options: --roadmap <path> (default <repo>/../ROADMAP.md), --repo <path> (default cwd).
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const PRIORITIES = ['P0', 'P1', 'P2']
const STATUSES = ['未开始', '进行中', '已完成']
const MARK_START = '<!-- AUTO:TODO START -->'
const MARK_END = '<!-- AUTO:TODO END -->'
const GENERATED_PREFIX = '<!-- generated:'
const USAGE = `roadmap.mjs — generate the ROADMAP todo block from .worklog/todo/*.md

Usage:
  node scripts/roadmap.mjs --write [--roadmap <path>] [--repo <path>]
  node scripts/roadmap.mjs --check [--roadmap <path>] [--repo <path>]
  node scripts/roadmap.mjs --json [--repo <path>]
  node scripts/roadmap.mjs --html-only [--repo <path>]

Exit codes: 0 = OK, 1 = drift or parse error, 2 = usage / missing markers / repo.`

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { mode: 'check', json: false, htmlOnly: false, repo: process.cwd(), roadmap: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = () => {
      const value = argv[index + 1]
      if (value === undefined) fail(2, `${arg} requires a value\n\n${USAGE}`)
      index += 1
      return value
    }
    switch (arg) {
      case '--write': options.mode = 'write'; break
      case '--check': options.mode = 'check'; break
      case '--json': options.json = true; break
      case '--html-only': options.htmlOnly = true; break
      case '--repo': options.repo = takeValue(); break
      case '--roadmap': options.roadmap = takeValue(); break
      case '-h':
      case '--help':
        console.log(USAGE)
        process.exit(0)
        break
      default:
        fail(2, `unknown argument: ${arg}\n\n${USAGE}`)
    }
  }
  return options
}

function nowStamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function ownerCompare(left, right) {
  if (left.owner === right.owner) return 0
  return left.owner < right.owner ? -1 : 1
}

function priorityCompare(left, right) {
  return PRIORITIES.indexOf(left.priority) - PRIORITIES.indexOf(right.priority)
}

function sortForDisplay(entries) {
  // Array#sort is stable: within the same priority+owner the file order is kept.
  return [...entries].sort((left, right) => priorityCompare(left, right) || ownerCompare(left, right))
}

function countEntries(entries) {
  const counts = { total: entries.length, P0: 0, P1: 0, P2: 0, done: 0 }
  for (const entry of entries) {
    counts[entry.priority] += 1
    if (entry.status === '已完成') counts.done += 1
  }
  return counts
}

function parseHeader(line) {
  const match = /^<!--\s*session:\s*(\S+)\s*·\s*updated:\s*(\d{4}-\d{2}-\d{2})\s*-->$/.exec(String(line).trim())
  if (!match) return null
  return { session: match[1], updated: match[2] }
}

function parseEntry(line, sessionName, file, lineNumber, errors) {
  const match = /^- \[(P[0-2])\] (.+)$/.exec(line)
  if (!match) {
    errors.push({ file, line: lineNumber, message: 'not a todo line: expected "- [P0|P1|P2] <标题> —— <说明>；验收：…；状态：…"' })
    return null
  }
  const [, priority, rest] = match
  const segments = rest.split('；')
  const fields = { acceptance: null, status: null, owner: null }
  const descriptionParts = [segments[0]]
  for (const segment of segments.slice(1)) {
    const field = /^(验收|状态|归属)：(.+)$/.exec(segment)
    if (!field) {
      // A "；" inside the description is not a field separator.
      descriptionParts.push(segment)
      continue
    }
    const [, key, value] = field
    if (key === '验收') fields.acceptance = value.trim()
    else if (key === '状态') fields.status = value.trim()
    else fields.owner = value.trim()
  }
  const head = descriptionParts.join('；')
  // The separator is "——"; tolerate missing spaces around it (real, already-committed entries omit them).
  const splitAt = head.indexOf('——')
  const problems = []
  if (splitAt < 0) problems.push('missing " —— " between title and description')
  const title = splitAt < 0 ? '' : head.slice(0, splitAt).trim()
  const description = splitAt < 0 ? '' : head.slice(splitAt + 2).trim()
  if (!title) problems.push('empty title')
  if (!fields.acceptance) problems.push('missing 验收：')
  if (!fields.status) problems.push('missing 状态：')
  else if (!STATUSES.includes(fields.status)) problems.push(`invalid 状态 "${fields.status}" (expected ${STATUSES.join('|')})`)
  if (problems.length) {
    errors.push({ file, line: lineNumber, message: problems.join('; ') })
    return null
  }
  return {
    priority,
    title,
    description,
    acceptance: fields.acceptance,
    status: fields.status,
    owner: fields.owner ?? sessionName,
    file,
    line: lineNumber,
    source: `${file}:${lineNumber}`,
    duplicateOf: null,
  }
}

async function parseTodos(todoDir) {
  let names
  try {
    names = (await readdir(todoDir)).filter((name) => name.endsWith('.md')).sort()
  } catch (error) {
    fail(2, `cannot read ${todoDir}: ${error.message}`)
  }
  const entries = []
  const errors = []
  for (const file of names) {
    const text = await readFile(path.join(todoDir, file), 'utf8')
    const lines = text.split(/\r?\n/)
    const header = parseHeader(lines[0] ?? '')
    if (!header) {
      errors.push({ file, line: 1, message: 'missing or malformed session header: <!-- session: <名> · updated: YYYY-MM-DD -->' })
    }
    const sessionName = header?.session ?? file.replace(/\.md$/, '')
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index].trimEnd()
      if (!line.startsWith('- ')) continue
      const entry = parseEntry(line, sessionName, file, index + 1, errors)
      if (entry) entries.push(entry)
    }
  }
  return { entries, errors }
}

function normalizeTitle(title) {
  return title
    .replace(/（需[^）]*）/g, '')
    .replace(/\(需[^)]*\)/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
}

function bigrams(text) {
  const counts = new Map()
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

function dice(left, right) {
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
  const a = bigrams(left)
  const b = bigrams(right)
  let overlap = 0
  let total = 0
  for (const [gram, count] of a) {
    total += count
    const other = b.get(gram)
    if (other !== undefined) overlap += Math.min(count, other)
  }
  for (const count of b.values()) total += count
  return total === 0 ? 0 : (2 * overlap) / total
}

function markDuplicates(entries) {
  for (let i = 0; i < entries.length; i += 1) {
    const left = entries[i]
    const leftTitle = normalizeTitle(left.title)
    for (let j = i + 1; j < entries.length; j += 1) {
      const right = entries[j]
      if (left.file === right.file) continue
      const score = dice(leftTitle, normalizeTitle(right.title))
      if (score < 0.5) continue
      if (!left.duplicateOf) left.duplicateOf = right.owner
      if (!right.duplicateOf) right.duplicateOf = left.owner
    }
  }
}

function formatItem(entry) {
  const suffix = entry.duplicateOf ? ` ⚠ 疑似重复（${entry.duplicateOf}）` : ''
  return `- [${entry.owner}] ${entry.title} — ${entry.status}${suffix}`
}

function buildSegment(entries, generatedAt) {
  const counts = countEntries(entries)
  const lines = [
    `${GENERATED_PREFIX} ${generatedAt}; ${counts.total} items; src=.worklog/todo -->`,
    `共 ${counts.total} 条（P0 ${counts.P0} / P1 ${counts.P1} / P2 ${counts.P2}，已完成 ${counts.done}）· 来源 .worklog/todo/*.md`,
  ]
  for (const priority of PRIORITIES) {
    const group = entries.filter((entry) => entry.priority === priority).sort(ownerCompare)
    lines.push('', `### ${priority}（${group.length}）`)
    for (const entry of group) lines.push(formatItem(entry))
  }
  const done = entries.filter((entry) => entry.status === '已完成').sort(ownerCompare)
  if (done.length) {
    lines.push('', `### 已完成（${done.length}）`)
    for (const entry of done) lines.push(formatItem(entry))
  }
  return lines.join('\n')
}

function stripGenerated(text) {
  const lines = text.split('\n').map((line) => line.replace(/\s+$/, ''))
  return lines.filter((line) => !line.startsWith(GENERATED_PREFIX)).join('\n').trim()
}

function locateMarkers(text) {
  const start = text.indexOf(MARK_START)
  const end = text.indexOf(MARK_END)
  if (start < 0 || end < 0) return { ok: false, missing: start < 0 ? MARK_START : MARK_END }
  if (end < start) return { ok: false, missing: `${MARK_END} before ${MARK_START}` }
  return { ok: true, start, end }
}

async function readRoadmap(roadmapPath) {
  try {
    return await readFile(roadmapPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') fail(2, `ROADMAP not found: ${roadmapPath}\npass --roadmap <path> or create the file with the AUTO markers.`)
    fail(2, `cannot read ROADMAP: ${error.message}`)
  }
}

async function checkRoadmap(roadmapPath, entries, generatedAt) {
  const original = await readRoadmap(roadmapPath)
  const markers = locateMarkers(original)
  if (!markers.ok) fail(2, `missing marker ${markers.missing} in ${roadmapPath}`)
  const actual = stripGenerated(original.slice(markers.start + MARK_START.length, markers.end))
  const expected = stripGenerated(buildSegment(entries, generatedAt))
  if (actual === expected) {
    console.log(`OK: ROADMAP auto section matches .worklog/todo (${entries.length} items)`)
    return
  }
  const actualLines = actual.split('\n')
  const expectedLines = expected.split('\n')
  const limit = Math.max(actualLines.length, expectedLines.length)
  let difference = null
  for (let index = 0; index < limit; index += 1) {
    if (actualLines[index] !== expectedLines[index]) {
      difference = { line: index + 1, actual: actualLines[index] ?? '(missing)', expected: expectedLines[index] ?? '(missing)' }
      break
    }
  }
  console.error('drift detected between ROADMAP auto section and .worklog/todo:')
  if (difference) {
    console.error(`  line ${difference.line}`)
    console.error(`  ROADMAP: ${difference.actual}`)
    console.error(`  todos:   ${difference.expected}`)
  }
  console.error('run: node scripts/roadmap.mjs --write')
  process.exit(1)
}

async function writeRoadmap(roadmapPath, entries, generatedAt) {
  const original = await readRoadmap(roadmapPath)
  const markers = locateMarkers(original)
  if (!markers.ok) fail(2, `missing marker ${markers.missing} in ${roadmapPath}`)
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const segment = buildSegment(entries, generatedAt).replace(/\n/g, newline)
  const next =
    original.slice(0, markers.start + MARK_START.length) +
    newline +
    segment +
    newline +
    original.slice(markers.end)
  await writeFile(roadmapPath, next, 'utf8')
  return next
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function statusClass(status) {
  if (status === '已完成') return 'done'
  if (status === '进行中') return 'doing'
  return 'todo'
}

function renderCard(entry) {
  const duplicate = entry.duplicateOf
    ? `      <span class="dup" title="与 ${escapeHtml(entry.duplicateOf)} 的条目疑似重复">⚠</span>\n`
    : ''
  const search = escapeHtml(`${entry.title} ${entry.description} ${entry.acceptance}`.toLowerCase())
  return `    <details class="card" data-prio="${entry.priority}" data-owner="${escapeHtml(entry.owner)}" data-status="${escapeHtml(entry.status)}" data-search="${search}">
      <summary>
        <span class="prio ${entry.priority.toLowerCase()}">${entry.priority}</span>
        <span class="owner">${escapeHtml(entry.owner)}</span>
        <span class="title">${escapeHtml(entry.title)}</span>
        <span class="badge ${statusClass(entry.status)}">${escapeHtml(entry.status)}</span>
${duplicate}      </summary>
      <div class="detail">
        <dl>
          <dt>说明</dt><dd>${escapeHtml(entry.description)}</dd>
          <dt>验收</dt><dd>${escapeHtml(entry.acceptance)}</dd>
          <dt>归属</dt><dd>${escapeHtml(entry.owner)}</dd>
          <dt>源文件</dt><dd>${escapeHtml(entry.source)}</dd>
        </dl>
      </div>
    </details>`
}

function renderHtml(entries, generatedAt) {
  const counts = countEntries(entries)
  const sorted = sortForDisplay(entries)
  const owners = [...new Set(sorted.map((entry) => entry.owner))].sort()
  const priorityChips = PRIORITIES.map(
    (priority) =>
      `        <button type="button" class="chip" data-prio-filter="${priority}">${priority}（${counts[priority]}）</button>`,
  ).join('\n')
  const ownerChips = owners
    .map((owner) => `        <button type="button" class="chip" data-owner-filter="${escapeHtml(owner)}">${escapeHtml(owner)}</button>`)
    .join('\n')
  const cards = sorted.map(renderCard).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-mesh 待办 · .worklog</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1d1f24; }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  .meta { margin: 0 0 16px; color: #667; font-size: 13px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
  .stat { min-width: 104px; padding: 10px 14px; border-radius: 10px; background: #fff; border: 1px solid #e2e4ea; }
  .stat span { display: block; color: #667; font-size: 12px; }
  .stat b { font-size: 20px; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 16px; padding: 12px; border-radius: 10px; background: #fff; border: 1px solid #e2e4ea; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { padding: 4px 10px; border: 1px solid #ccd; border-radius: 999px; background: #fff; cursor: pointer; font: inherit; }
  .chip.on { background: #2f5bd3; border-color: #2f5bd3; color: #fff; }
  select, input[type="search"] { padding: 6px 10px; border: 1px solid #ccd; border-radius: 8px; font: inherit; background: #fff; }
  input[type="search"] { min-width: 260px; }
  .count { margin-left: auto; color: #667; }
  .card { margin-bottom: 8px; border: 1px solid #e2e4ea; border-left: 5px solid #9aa3b5; border-radius: 10px; background: #fff; }
  .card[data-prio="P0"] { border-left-color: #c62828; }
  .card[data-prio="P1"] { border-left-color: #d98a00; }
  .card[data-prio="P2"] { border-left-color: #2f5bd3; }
  .card > summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; list-style: none; }
  .card > summary::-webkit-details-marker { display: none; }
  .prio { padding: 1px 8px; border-radius: 999px; color: #fff; font-size: 12px; }
  .prio.p0 { background: #c62828; }
  .prio.p1 { background: #d98a00; }
  .prio.p2 { background: #2f5bd3; }
  .owner { color: #556; font-size: 13px; }
  .title { flex: 1 1 320px; font-weight: 600; }
  .badge { padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid transparent; }
  .badge.todo { background: #eef1f6; color: #445; }
  .badge.doing { background: #fff4dd; color: #8a5a00; border-color: #f0d9a8; }
  .badge.done { background: #e7f6ec; color: #1d6b3a; border-color: #bfe4cb; }
  .dup { color: #c62828; cursor: help; }
  .detail { padding: 0 14px 12px; border-top: 1px dashed #e2e4ea; }
  dl { display: grid; grid-template-columns: 64px 1fr; gap: 6px 12px; margin: 10px 0 0; }
  dt { color: #667; }
  dd { margin: 0; white-space: pre-wrap; word-break: break-word; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>dsh-mesh 待办汇总</h1>
  <p class="meta">生成时间 ${escapeHtml(generatedAt)} · 来源 .worklog/todo/*.md（本地日志，不入库）</p>
  <div class="stats">
    <div class="stat"><span>总数</span><b>${counts.total}</b></div>
    <div class="stat"><span>P0</span><b>${counts.P0}</b></div>
    <div class="stat"><span>P1</span><b>${counts.P1}</b></div>
    <div class="stat"><span>P2</span><b>${counts.P2}</b></div>
    <div class="stat"><span>已完成</span><b>${counts.done}</b></div>
  </div>
</header>
<section class="filters">
  <div class="chips">
${priorityChips}
  </div>
  <div class="chips">
${ownerChips}
  </div>
  <select id="status-filter" aria-label="按状态筛选">
    <option value="">全部状态</option>
    <option value="未开始">未开始</option>
    <option value="进行中">进行中</option>
    <option value="已完成">已完成</option>
  </select>
  <input id="search" type="search" placeholder="搜索标题 / 说明 / 验收" aria-label="搜索">
  <span class="count" id="visible-count">显示 ${counts.total} / ${counts.total}</span>
</section>
<main id="list">
${cards}
</main>
<script>
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll('details.card'));
  var state = { priorities: {}, owners: {}, status: '', query: '' };
  var countEl = document.getElementById('visible-count');
  function apply() {
    var priorityKeys = Object.keys(state.priorities).filter(function (key) { return state.priorities[key]; });
    var ownerKeys = Object.keys(state.owners).filter(function (key) { return state.owners[key]; });
    var visible = 0;
    cards.forEach(function (card) {
      var cardPriority = card.getAttribute('data-prio');
      var cardOwner = card.getAttribute('data-owner');
      var cardStatus = card.getAttribute('data-status');
      var haystack = card.getAttribute('data-search') || '';
      var priorityOk = priorityKeys.length === 0 || priorityKeys.indexOf(cardPriority) !== -1;
      var ownerOk = ownerKeys.length === 0 || ownerKeys.indexOf(cardOwner) !== -1;
      var statusOk = !state.status || cardStatus === state.status;
      var queryOk = !state.query || haystack.indexOf(state.query) !== -1;
      var show = priorityOk && ownerOk && statusOk && queryOk;
      card.hidden = !show;
      if (show) visible += 1;
    });
    countEl.textContent = '显示 ' + visible + ' / ' + cards.length;
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-prio-filter]'), function (button) {
    button.addEventListener('click', function () {
      var key = button.getAttribute('data-prio-filter');
      state.priorities[key] = !state.priorities[key];
      button.classList.toggle('on', state.priorities[key]);
      apply();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-owner-filter]'), function (button) {
    button.addEventListener('click', function () {
      var key = button.getAttribute('data-owner-filter');
      state.owners[key] = !state.owners[key];
      button.classList.toggle('on', state.owners[key]);
      apply();
    });
  });
  document.getElementById('status-filter').addEventListener('change', function (event) {
    state.status = event.target.value;
    apply();
  });
  document.getElementById('search').addEventListener('input', function (event) {
    state.query = event.target.value.trim().toLowerCase();
    apply();
  });
  apply();
})();
</script>
</body>
</html>
`
}

async function writeHtml(htmlPath, entries, generatedAt) {
  await writeFile(htmlPath, renderHtml(entries, generatedAt), 'utf8')
}

async function assertRepo(repo) {
  const agents = path.join(repo, 'AGENTS.md')
  const todo = path.join(repo, '.worklog', 'todo')
  const agentsOk = await stat(agents).then((info) => info.isFile()).catch(() => false)
  if (!agentsOk) fail(2, `not a dsh-mesh repo root (missing AGENTS.md): ${repo}\npass --repo <repo root>`)
  const todoOk = await stat(todo).then((info) => info.isDirectory()).catch(() => false)
  if (!todoOk) fail(2, `missing .worklog/todo under ${repo}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repo = path.resolve(options.repo)
  await assertRepo(repo)
  const todoDir = path.join(repo, '.worklog', 'todo')
  const roadmapPath = options.roadmap ? path.resolve(options.roadmap) : path.resolve(repo, '..', 'ROADMAP.md')
  const htmlPath = path.join(repo, '.worklog', 'roadmap.html')

  const { entries, errors } = await parseTodos(todoDir)
  markDuplicates(entries)

  if (options.json) {
    console.log(JSON.stringify({ repo, roadmap: roadmapPath, counts: countEntries(entries), errors, entries }, null, 2))
    process.exit(errors.length ? 1 : 0)
  }

  if (errors.length) {
    for (const error of errors) console.error(`${error.file}:${error.line}: ${error.message}`)
    console.error(`\n${errors.length} parse error(s); fix .worklog/todo/*.md first.`)
    process.exit(1)
  }

  const generatedAt = nowStamp()

  if (options.htmlOnly) {
    await writeHtml(htmlPath, entries, generatedAt)
    console.log(`wrote HTML -> ${htmlPath}`)
    return
  }

  if (options.mode === 'check') {
    await checkRoadmap(roadmapPath, entries, generatedAt)
    return
  }

  await writeRoadmap(roadmapPath, entries, generatedAt)
  const counts = countEntries(entries)
  console.log(`wrote ROADMAP: ${counts.total} items (P0 ${counts.P0} / P1 ${counts.P1} / P2 ${counts.P2}, done ${counts.done}) -> ${roadmapPath}`)
  try {
    await writeHtml(htmlPath, entries, generatedAt)
    console.log(`wrote HTML -> ${htmlPath}`)
  } catch (error) {
    console.warn(`warning: HTML render failed (ROADMAP was written): ${error.message}`)
  }
}

main().catch((error) => fail(1, `roadmap: ${error?.message ?? error}`))
