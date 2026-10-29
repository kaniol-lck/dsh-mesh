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

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const PRIORITIES = ['P0', 'P1', 'P2']
const STATUSES = ['未开始', '进行中', '已完成']
/** Fixed vocabulary — do not invent labels; unknown values fall back to 未分类 with a WARN. */
const FEATURES = ['接入体验', '收件箱', '协作编排', '传输安全', '运维交付', '控制台', '文档', '未分类']
/** Keyword fallback, first match wins (checked in this order). Title first, description second only. */
const FEATURE_RULES = [
  ['接入体验', /接入|新手|onboard|joinCode|bootstrap|自举|pull|轮询|standalone|注册码|设备码|配对|运行态|探测|\bT2\b/i],
  ['收件箱', /收件箱|inbox|消息|no_reply|silent|claim|排序|游标|已读|静默|黑板|\bboard\b|\bCAS\b|读隔离/i],
  [
    '协作编排',
    /批量|batch|回执|receipt|liveness|活力|派活|账本|屏障|里程碑|进度|\bdelete\b|端点|sessions|归档|会话|假成功|\blive\b|唤醒|--wake|防抖|绑定/i,
  ],
  ['控制台', /控制台|console|面板|页面|按钮|blobs|visible_to|MAX_BODY|\bpeers\b|时间字段|管理员/i],
  ['运维交付', /部署|发版|发布|巡检|门禁|脚本化|CI|tag|镜像|容器|版本|收口|漂移|CHANGELOG|package\.json|自检|预检|凭据|frpc|隧道|NAS|云/i],
  ['文档', /文档|README|docs|技能|示例|注释|ROADMAP|playbook|约定|口径|回填/i],
  ['传输安全', /TLS|证书|自签|scopes|allowed_cidrs|F-?orwarded|明文传输|轮换/i],
]
const DONE_LIST_CAP = 60
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

function countEntries(entries, today = new Date()) {
  // P0/P1/P2 count unfinished items only; completed ones live in `done` (a+b+c+d = total).
  // inProgress additionally requires a live claim (owner + fresh progress date).
  const counts = { total: entries.length, P0: 0, P1: 0, P2: 0, done: 0, inProgress: 0 }
  for (const entry of entries) {
    if (entry.status === '已完成') counts.done += 1
    else counts[entry.priority] += 1
    if (isLiveInProgress(entry, today).ok) counts.inProgress += 1
  }
  return counts
}

function parseHeader(line) {
  const match = /^<!--\s*session:\s*(\S+)\s*·\s*updated:\s*(\d{4}-\d{2}-\d{2})\s*-->$/.exec(String(line).trim())
  if (!match) return null
  return { session: match[1], updated: match[2] }
}

function inferFeature(title, description) {
  // Only the title decides by default: 说明/验收 almost always mention token/CA/审计,
  // which used to suck unrelated items into 传输安全.
  for (const [name, pattern] of FEATURE_RULES) if (pattern.test(title)) return name
  for (const [name, pattern] of FEATURE_RULES) if (pattern.test(description)) return name
  return '未分类'
}

/** Explicit 功能： wins; missing falls back to keywords; out-of-vocabulary is demoted with a WARN. */
function resolveFeature(raw, entry, where, warnings) {
  if (raw) {
    if (FEATURES.includes(raw)) return raw
    warnings.push({ ...where, message: `未知功能标签「${raw}」，已归未分类` })
    return '未分类'
  }
  return inferFeature(entry.title, entry.description)
}

function parseEntry(line, sessionName, file, lineNumber, errors, warnings) {
  const match = /^- \[(P[0-2])\] (.+)$/.exec(line)
  if (!match) {
    errors.push({ file, line: lineNumber, message: 'not a todo line: expected "- [P0|P1|P2] <标题> —— <说明>；验收：…；状态：…"' })
    return null
  }
  const [, priority, rest] = match
  const segments = rest.split('；')
  const fields = { acceptance: null, status: null, owner: null, progress: null, feature: null }
  const descriptionParts = [segments[0]]
  for (const segment of segments.slice(1)) {
    const field = /^(验收|状态|归属|进展|功能)：(.+)$/.exec(segment)
    if (!field) {
      // A "；" inside the description is not a field separator.
      descriptionParts.push(segment)
      continue
    }
    const [, key, value] = field
    if (key === '验收') fields.acceptance = value.trim()
    else if (key === '状态') fields.status = value.trim()
    else if (key === '进展') fields.progress = value.trim()
    else if (key === '功能') fields.feature = value.trim()
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
    displayTitle: stripOwnerSuffix(title),
    description,
    acceptance: fields.acceptance,
    status: fields.status,
    owner: fields.owner ?? sessionName,
    explicitOwner: fields.owner !== null,
    progress: fields.progress ?? null,
    feature: resolveFeature(fields.feature, { title, description }, { file, line: lineNumber }, warnings),
    file,
    line: lineNumber,
    source: `${file}:${lineNumber}`,
    duplicateOf: null,
  }
}

/**
 * "进行中" only counts when the item names its owner and carries a fresh progress date.
 * Missing/old progress would otherwise leave zombie in-progress rows on the board forever.
 */
function isLiveInProgress(entry, today = new Date()) {
  if (entry.status !== '进行中') return { ok: false, reason: null }
  if (!entry.explicitOwner) return { ok: false, reason: '缺归属' }
  if (!entry.progress) return { ok: false, reason: '缺进展' }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.progress)
  if (!match) return { ok: false, reason: '进展日期无效' }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const stamp = Date.UTC(year, month - 1, day)
  const probe = new Date(stamp)
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return { ok: false, reason: '进展日期无效' }
  }
  const todayStamp = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const ageDays = Math.floor((todayStamp - stamp) / 86_400_000)
  if (ageDays > 14) return { ok: false, reason: `进展已过期 ${ageDays} 天` }
  return { ok: true }
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
  const warnings = []
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
      const entry = parseEntry(line, sessionName, file, index + 1, errors, warnings)
      if (entry) entries.push(entry)
    }
  }
  return { entries, errors, warnings }
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

/** The owner suffix ("（需 hub 会话）" etc.) is redundant now that items carry "；归属：<会话>". */
function stripOwnerSuffix(title) {
  return title
    .replace(/（需[^）]*）/g, '')
    .replace(/\(需[^)]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Stable fingerprint of the parsed model (no timestamp): decides whether generated artifacts are stale. */
function sourceHash(entries, versions) {
  const canonical = {
    versions: { hub: versions.hubVersion, waker: versions.wakerVersion },
    entries: entries.map((entry) => ({
      priority: entry.priority,
      title: entry.title,
      description: entry.description,
      acceptance: entry.acceptance,
      status: entry.status,
      owner: entry.owner,
      progress: entry.progress,
      feature: entry.feature,
      file: entry.file,
      line: entry.line,
    })),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12)
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
    const leftTitle = normalizeTitle(left.displayTitle)
    for (let j = i + 1; j < entries.length; j += 1) {
      const right = entries[j]
      if (left.file === right.file) continue
      const score = dice(leftTitle, normalizeTitle(right.displayTitle))
      if (score < 0.5) continue
      if (!left.duplicateOf) left.duplicateOf = right.owner
      if (!right.duplicateOf) right.duplicateOf = left.owner
    }
  }
}

function formatItem(entry, today = new Date()) {
  const suffix = entry.duplicateOf ? ` ⚠ 疑似重复（${entry.duplicateOf}）` : ''
  let statusText = entry.status
  let demoted = ''
  if (entry.status === '进行中') {
    const live = isLiveInProgress(entry, today)
    if (!live.ok) {
      statusText = '待办'
      demoted = `（进行中·${live.reason}，按待办处理）`
    }
  }
  return `- [${entry.owner}] ${entry.displayTitle} — ${statusText}${demoted}${suffix}`
}

function featureStats(entries) {
  return FEATURES.map((name) => {
    const group = entries.filter((entry) => entry.feature === name)
    const open = group.filter((entry) => entry.status !== '已完成')
    const topPriority = PRIORITIES.find((priority) => open.some((entry) => entry.priority === priority)) ?? null
    const owners = [...new Set(group.filter((entry) => entry.explicitOwner).map((entry) => entry.owner))].sort()
    return { name, open: open.length, done: group.length - open.length, topPriority, owners }
  })
}

/** Stage gates live in scripts/roadmap.gates.json — declarative, no per-todo gate ids. */
async function loadGates(repo) {
  const file = path.join(repo, 'scripts', 'roadmap.gates.json')
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    console.warn(`WARN: cannot read gates config (${file}): ${error.message}`)
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.gates) ? parsed.gates : []
  } catch (error) {
    console.warn(`WARN: bad gates config (${file}): ${error.message}`)
    return []
  }
}

function gateRequireLabel(require) {
  return require?.match ?? require?.feature ?? '(empty)'
}

function gateRequireEntries(require, entries) {
  if (require?.feature) return entries.filter((entry) => entry.feature === require.feature)
  const needle = String(require?.match ?? '').toLowerCase()
  return entries.filter((entry) => `${entry.title} ${entry.displayTitle}`.toLowerCase().includes(needle))
}

function evaluateGate(gate, entries) {
  const met = []
  const blocking = []
  for (const require of gate.requires ?? []) {
    const matched = gateRequireEntries(require, entries)
    const open = matched.filter((entry) => entry.status !== '已完成')
    if (matched.length > 0 && open.length === 0) {
      met.push(require)
      continue
    }
    blocking.push(matched.length === 0 ? `「${gateRequireLabel(require)}」无匹配` : open[0].displayTitle)
  }
  return {
    id: gate.id,
    name: gate.name,
    question: gate.question,
    satisfied: blocking.length === 0,
    met: met.length,
    total: (gate.requires ?? []).length,
    blocking,
  }
}

function gateRows(gates, entries) {
  return gates.map((gate) => evaluateGate(gate, entries))
}

function buildSegment(entries, generatedAt, hash, versions, gates = []) {
  const counts = countEntries(entries)
  const unfinished = entries.filter((entry) => entry.status !== '已完成')
  const done = entries.filter((entry) => entry.status === '已完成')
  const openCount = counts.P0 + counts.P1 + counts.P2
  const lines = [
    `${GENERATED_PREFIX} ${generatedAt}; ${counts.total} items; src=${hash} -->`,
    `共 ${counts.total} 条 · P0 ${counts.P0} / P1 ${counts.P1} / P2 ${counts.P2}（未完成 ${openCount}）· 进行中 ${counts.inProgress} · 已完成 ${counts.done} · 来源 .worklog/todo/*.md`,
    `版本快照：hub ${versions.hubVersion}（hub/server.mjs + hub/package.json）/ waker ${versions.wakerVersion}（plugins/mesh-waker/package.json）· 读取自代码，勿手改`,
    '',
    '### 按功能聚合',
    '',
    '| 功能 | 未完成 | 已完成 | 最高优先级 | 涉及会话 |',
    '|---|---|---|---|---|',
  ]
  for (const stats of featureStats(entries)) {
    lines.push(`| ${stats.name} | ${stats.open} | ${stats.done} | ${stats.topPriority ?? '—'} | ${stats.owners.length ? stats.owners.join(', ') : '—'} |`)
  }
  if (gates.length) {
    lines.push('', '### 关口（阶段性验收）', '', '| 关口 | 问题 | 状态 | 还差什么 |', '|---|---|---|---|')
    const rows = gateRows(gates, entries)
    for (const row of rows) {
      const status = row.satisfied ? '✅ 达成' : `⏳ ${row.met}/${row.total}`
      let remain = '—'
      if (!row.satisfied) {
        const circled = ['①', '②', '③']
        remain = row.blocking
          .slice(0, 3)
          .map((title, index) => `${circled[index]}${title}`)
          .join(' ')
        if (row.blocking.length > 3) remain += ` 等 ${row.blocking.length} 条`
      }
      lines.push(`| ${row.id} ${row.name} | ${row.question} | ${status} | ${remain} |`)
    }
    if (rows.length && rows.every((row) => row.satisfied)) {
      lines.push('', '> 全部关口已达成：可以对外发布。')
    }
  }
  for (const priority of PRIORITIES) {
    const group = unfinished.filter((entry) => entry.priority === priority).sort(ownerCompare)
    lines.push('', `### ${priority}（${group.length}）`)
    for (const entry of group) lines.push(formatItem(entry))
  }
  if (done.length) {
    const sortedDone = [...done].sort(
      (left, right) =>
        FEATURES.indexOf(left.feature) - FEATURES.indexOf(right.feature) || priorityCompare(left, right) || ownerCompare(left, right),
    )
    lines.push('', '<details>', `<summary>已完成（${done.length}）—— 点击展开</summary>`, '')
    for (const entry of sortedDone.slice(0, DONE_LIST_CAP)) {
      lines.push(`- ${entry.feature} · [${entry.priority}] ${entry.displayTitle}（${entry.owner}）`)
    }
    if (sortedDone.length > DONE_LIST_CAP) {
      lines.push('', `- 其余 ${sortedDone.length - DONE_LIST_CAP} 条见 .worklog/roadmap.html`)
    }
    lines.push('', '</details>')
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

async function warnIfHtmlStale(htmlPath, hash) {
  let problem = null
  try {
    const html = await readFile(htmlPath, 'utf8')
    const match = /<!-- generated:[^>]*src=([0-9a-f]{12})/.exec(html)
    if (!match) problem = 'no src hash in HTML'
    else if (match[1] !== hash) problem = `src ${match[1]} != ${hash}`
  } catch {
    problem = 'missing file'
  }
  if (problem) console.log(`WARN: .worklog/roadmap.html 过期，跑 --write (${problem})`)
}

/** Cross-domain items should carry "；归属：<会话>"; missing it only warns, never blocks. */
function warnIfMissingOwner(entries) {
  for (const entry of entries) {
    if (entry.explicitOwner) continue
    if (!/[（(][^（）()]*会话[）)]/.test(entry.title)) continue
    console.log(`WARN: ${entry.source} 跨域条目缺 归属，不阻塞（${entry.displayTitle}）`)
  }
}

/** An in-progress row without a live claim (owner + fresh progress) is demoted to todo; warn only. */
function warnIfDemotedInProgress(entries, today = new Date()) {
  for (const entry of entries) {
    if (entry.status !== '进行中') continue
    const live = isLiveInProgress(entry, today)
    if (live.ok) continue
    console.log(`WARN: ${entry.file} 行 ${entry.line} 「进行中」但${live.reason}，按待办处理`)
  }
}

/** A gate require that matches no todo usually means a renamed title — warn, never block. */
function warnIfGateMisses(entries, gates) {
  for (const gate of gates) {
    for (const require of gate.requires ?? []) {
      if (gateRequireEntries(require, entries).length > 0) continue
      console.log(`WARN: 关口 ${gate.id} 的 require「${gateRequireLabel(require)}」没有匹配到任何 todo（标题改过？）`)
    }
  }
}

async function checkRoadmap(roadmapPath, htmlPath, entries, generatedAt, hash, versions, gates = []) {
  if (versions.hubVersion !== versions.hubPackageVersion) {
    console.error(
      `ERROR: version drift: hub/server.mjs HUB_VERSION=${versions.hubVersion} vs hub/package.json=${versions.hubPackageVersion}`,
    )
    console.error('align HUB_VERSION and hub/package.json before checking the ROADMAP auto section')
    process.exit(1)
  }
  const original = await readRoadmap(roadmapPath)
  const markers = locateMarkers(original)
  if (!markers.ok) fail(2, `missing marker ${markers.missing} in ${roadmapPath}`)
  const actual = stripGenerated(original.slice(markers.start + MARK_START.length, markers.end))
  const expected = stripGenerated(buildSegment(entries, generatedAt, hash, versions, gates))
  if (actual === expected) {
    console.log(`OK: ROADMAP auto section matches .worklog/todo (${entries.length} items)`)
    await warnIfHtmlStale(htmlPath, hash)
    warnIfMissingOwner(entries)
    warnIfDemotedInProgress(entries)
    warnIfGateMisses(entries, gates)
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

async function writeRoadmap(roadmapPath, entries, generatedAt, hash, versions, gates = []) {
  const original = await readRoadmap(roadmapPath)
  const markers = locateMarkers(original)
  if (!markers.ok) fail(2, `missing marker ${markers.missing} in ${roadmapPath}`)
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const segment = buildSegment(entries, generatedAt, hash, versions, gates).replace(/\n/g, newline)
  const next =
    original.slice(0, markers.start + MARK_START.length) +
    newline +
    segment +
    newline +
    original.slice(markers.end)
  await atomicWrite(roadmapPath, next)
  return next
}

const LOCK_STALE_MS = 10_000
const LOCK_RETRY_DELAY_MS = 300
const LOCK_RETRIES = 3

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Replace via a same-directory temp file + rename, so concurrent readers never see half a file. */
async function atomicWrite(file, content) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, file)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {
      /* temp already gone */
    }
    throw error
  }
}

/**
 * Best-effort mutex for generated artifacts. Five sessions may refresh at once; the loser
 * retries briefly, then gives up with a WARN (exit 0) so a busy lock never blocks a caller.
 * A lock older than 10s is assumed to be a crash leftover and is taken over.
 */
async function acquireLock(repo) {
  const lockPath = path.join(repo, '.worklog', 'roadmap.lock')
  await mkdir(path.dirname(lockPath), { recursive: true })
  const stamp = `${process.pid} ${new Date().toISOString()}`
  const release = async () => {
    try {
      await unlink(lockPath)
    } catch {
      /* already released or taken over */
    }
  }
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      await writeFile(lockPath, stamp, { flag: 'wx' })
      return { release }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          console.log('WARN: stale roadmap lock (older than 10s), taking over')
          await writeFile(lockPath, stamp)
          return { release }
        }
      } catch {
        /* lock disappeared between stat and now — retry */
      }
      if (attempt < LOCK_RETRIES) await delay(LOCK_RETRY_DELAY_MS)
    }
  }
  console.log('WARN: roadmap lock busy, skipped write')
  return null
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
  const live = isLiveInProgress(entry)
  const demoted = entry.status === '进行中' && !live.ok
  const statusShown = demoted ? '待办' : entry.status
  const duplicate = entry.duplicateOf
    ? `      <span class="dup" title="与 ${escapeHtml(entry.duplicateOf)} 的条目疑似重复">⚠</span>\n`
    : ''
  const demotion = demoted
    ? `      <span class="dup" title="进行中但${escapeHtml(live.reason)}，按待办处理">⚠</span>\n`
    : ''
  const search = escapeHtml(
    `${entry.displayTitle} ${entry.description} ${entry.acceptance} ${entry.feature} ${demoted ? live.reason : ''}`.toLowerCase(),
  )
  return `    <details class="card" data-prio="${entry.priority}" data-owner="${escapeHtml(entry.owner)}" data-feature="${escapeHtml(entry.feature)}" data-status="${escapeHtml(statusShown)}" data-search="${search}">
      <summary>
        <span class="prio ${entry.priority.toLowerCase()}">${entry.priority}</span>
        <span class="owner">${escapeHtml(entry.owner)}</span>
        <span class="feature">${escapeHtml(entry.feature)}</span>
        <span class="title">${escapeHtml(entry.displayTitle)}</span>
        <span class="badge ${statusClass(statusShown)}">${escapeHtml(statusShown)}</span>
${duplicate}${demotion}      </summary>
      <div class="detail">
        <dl>
          <dt>功能</dt><dd>${escapeHtml(entry.feature)}</dd>
          <dt>说明</dt><dd>${escapeHtml(entry.description)}</dd>
          <dt>验收</dt><dd>${escapeHtml(entry.acceptance)}</dd>
          <dt>归属</dt><dd>${escapeHtml(entry.owner)}</dd>
          ${entry.progress ? `<dt>进展</dt><dd>${escapeHtml(entry.progress)}</dd>` : ''}
          <dt>源文件</dt><dd>${escapeHtml(entry.source)}</dd>
        </dl>
      </div>
    </details>`
}

function renderGatesHtml(gates, entries) {
  const rows = gateRows(gates, entries)
  const body = rows
    .map((row) => {
      const status = row.satisfied
        ? '<span class="badge done">✅ 达成</span>'
        : `<span class="badge doing">⏳ ${row.met}/${row.total}</span>`
      const remain = row.satisfied
        ? '—'
        : `${escapeHtml(row.blocking.slice(0, 3).join('；'))}${row.blocking.length > 3 ? ` 等 ${row.blocking.length} 条` : ''}`
      return `<tr><td><b>${escapeHtml(row.id)}</b> ${escapeHtml(row.name)}</td><td>${escapeHtml(row.question)}</td><td>${status}</td><td>${remain}</td></tr>`
    })
    .join('\n')
  const note = rows.length > 0 && rows.every((row) => row.satisfied) ? '<p class="gate-note">全部关口已达成：可以对外发布。</p>' : ''
  return `<section class="gates">
<h2>关口（阶段性验收）</h2>
<table>
<thead><tr><th>关口</th><th>问题</th><th>状态</th><th>还差什么</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
${note}
</section>`
}

function renderHtml(entries, generatedAt, hash, gates = []) {
  const counts = countEntries(entries)
  const sorted = sortForDisplay(entries)
  const owners = [...new Set(sorted.map((entry) => entry.owner))].sort()
  const gatesHtml = gates.length ? renderGatesHtml(gates, entries) : ''
  const priorityChips = PRIORITIES.map(
    (priority) =>
      `        <button type="button" class="chip" data-prio-filter="${priority}">${priority}（${counts[priority]}）</button>`,
  ).join('\n')
  const ownerChips = owners
    .map((owner) => `        <button type="button" class="chip" data-owner-filter="${escapeHtml(owner)}">${escapeHtml(owner)}</button>`)
    .join('\n')
  const openCards = sorted.filter((entry) => entry.status !== '已完成')
  const doneCards = sorted.filter((entry) => entry.status === '已完成')
  const cards = openCards.map(renderCard).join('\n')
  const doneBlock = doneCards.length
    ? `<details class="done-block">\n<summary>已完成（${doneCards.length}）—— 点击展开</summary>\n${doneCards.map(renderCard).join('\n')}\n</details>`
    : ''
  return `<!doctype html>
<!-- generated: ${escapeHtml(generatedAt)}; ${counts.total} items; src=${hash} -->
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
  .feature { padding: 1px 8px; border-radius: 999px; background: #eef1f6; color: #556; font-size: 12px; }
  .gates { margin-bottom: 18px; }
  .gates h2 { margin: 0 0 8px; font-size: 16px; }
  .gates table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e4ea; border-radius: 10px; overflow: hidden; }
  .gates th, .gates td { padding: 8px 12px; border-bottom: 1px solid #eef0f2; text-align: left; vertical-align: top; font-size: 13px; }
  .gates tr:last-child td { border-bottom: none; }
  .gate-note { margin: 8px 0 0; color: #1d6b3a; font-weight: 600; }
  .done-block { margin-top: 18px; border: 1px dashed #ccd; border-radius: 10px; padding: 8px 12px; }
  .done-block > summary { cursor: pointer; color: #667; padding: 4px 2px; }
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
${gatesHtml}
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
${doneBlock}
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

async function writeHtml(htmlPath, entries, generatedAt, hash, gates = []) {
  await atomicWrite(htmlPath, renderHtml(entries, generatedAt, hash, gates))
}

async function assertRepo(repo) {
  const agents = path.join(repo, 'AGENTS.md')
  const todo = path.join(repo, '.worklog', 'todo')
  const agentsOk = await stat(agents).then((info) => info.isFile()).catch(() => false)
  if (!agentsOk) fail(2, `not a dsh-mesh repo root (missing AGENTS.md): ${repo}\npass --repo <repo root>`)
  const todoOk = await stat(todo).then((info) => info.isDirectory()).catch(() => false)
  if (!todoOk) fail(2, `missing .worklog/todo under ${repo}`)
}

async function readPackageVersion(file, label) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    fail(2, `cannot read ${label}: ${error.message}`)
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed.version) throw new Error('missing "version" field')
    return String(parsed.version)
  } catch (error) {
    fail(2, `${label}: ${error.message}`)
  }
}

/** Single source of truth for versions: hub/server.mjs HUB_VERSION + the two package.json files. */
async function readVersions(repo) {
  let source
  try {
    source = await readFile(path.join(repo, 'hub', 'server.mjs'), 'utf8')
  } catch (error) {
    fail(2, `cannot read hub/server.mjs: ${error.message}`)
  }
  const match = /HUB_VERSION\s*=\s*'([^']+)'/.exec(source)
  if (!match) fail(2, "hub/server.mjs: cannot find HUB_VERSION = '...'")
  return {
    hubVersion: match[1],
    hubPackageVersion: await readPackageVersion(path.join(repo, 'hub', 'package.json'), 'hub/package.json'),
    wakerVersion: await readPackageVersion(path.join(repo, 'plugins', 'mesh-waker', 'package.json'), 'plugins/mesh-waker/package.json'),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repo = path.resolve(options.repo)
  await assertRepo(repo)
  const todoDir = path.join(repo, '.worklog', 'todo')
  const roadmapPath = options.roadmap ? path.resolve(options.roadmap) : path.resolve(repo, '..', 'ROADMAP.md')
  const htmlPath = path.join(repo, '.worklog', 'roadmap.html')

  const { entries, errors, warnings } = await parseTodos(todoDir)
  for (const warning of warnings) {
    const text = `WARN: ${warning.file} 行 ${warning.line} ${warning.message}`
    if (options.json) console.error(text)
    else console.log(text)
  }
  markDuplicates(entries)
  const gates = await loadGates(repo)
  const versions = await readVersions(repo)
  const hash = sourceHash(entries, versions)
  const generatedAt = nowStamp()

  if (options.json) {
    const model = {
      repo,
      roadmap: roadmapPath,
      html: htmlPath,
      hash,
      versions: { ...versions, drift: versions.hubVersion !== versions.hubPackageVersion },
      counts: countEntries(entries),
      features: featureStats(entries),
      gates: gateRows(gates, entries),
      unclassified: entries.filter((entry) => entry.feature === '未分类').slice(0, 50).map((entry) => entry.displayTitle),
      errors,
      entries: entries.map((entry) => {
        const live = isLiveInProgress(entry)
        return { ...entry, completed: entry.status === '已完成', liveInProgress: live.ok, demoteReason: live.ok ? null : live.reason }
      }),
    }
    console.log(JSON.stringify(model, null, 2))
    process.exit(errors.length ? 1 : 0)
  }

  if (errors.length) {
    for (const error of errors) console.error(`${error.file}:${error.line}: ${error.message}`)
    console.error(`\n${errors.length} parse error(s); fix .worklog/todo/*.md first.`)
    process.exit(1)
  }

  // Fail before taking the lock: process.exit while holding it would leak the lock file.
  if (!options.htmlOnly && options.mode !== 'check') {
    const original = await readRoadmap(roadmapPath)
    const markers = locateMarkers(original)
    if (!markers.ok) fail(2, `missing marker ${markers.missing} in ${roadmapPath}`)
  }

  if (options.htmlOnly) {
    const lock = await acquireLock(repo)
    if (!lock) return
    try {
      await writeHtml(htmlPath, entries, generatedAt, hash, gates)
      console.log(`wrote HTML -> ${htmlPath}`)
    } finally {
      await lock.release()
    }
    return
  }

  if (options.mode === 'check') {
    await checkRoadmap(roadmapPath, htmlPath, entries, generatedAt, hash, versions, gates)
    return
  }

  const lock = await acquireLock(repo)
  if (!lock) return
  try {
    await writeRoadmap(roadmapPath, entries, generatedAt, hash, versions, gates)
    const counts = countEntries(entries)
    console.log(`wrote ROADMAP: ${counts.total} items (P0 ${counts.P0} / P1 ${counts.P1} / P2 ${counts.P2}, done ${counts.done}) -> ${roadmapPath}`)
    try {
      await writeHtml(htmlPath, entries, generatedAt, hash, gates)
      console.log(`wrote HTML -> ${htmlPath}`)
    } catch (error) {
      console.warn(`warning: HTML render failed (ROADMAP was written): ${error.message}`)
    }
    const unclassified = entries.filter((entry) => entry.feature === '未分类').length
    console.log(`未分类 ${unclassified} 条（如需归口请在 todo 里加「功能：…」）`)
  } finally {
    await lock.release()
  }
}

main().catch((error) => fail(1, `roadmap: ${error?.message ?? error}`))
