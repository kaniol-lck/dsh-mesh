#!/usr/bin/env node
/**
 * roadmap.mjs — turn a worklog todo directory into a rendered ROADMAP block and a local HTML view.
 *
 * Layout it expects (all paths configurable):
 *   <worklog-dir>/todo/*.md      one file per owner/role; first line may be
 *                                <!-- session: <name> · updated: YYYY-MM-DD -->
 *   <worklog-dir>/gates.json     optional stage-gate definitions
 *   <out>                        target file with <!-- AUTO:TODO START/END --> markers
 *   <worklog-dir>/roadmap.html   rendered HTML view
 *
 * Todo line format:
 *   - [P0|P1|P2] <title> —— <description>；验收：…；状态：未开始|进行中|已完成
 *     [；归属：<role>][；进展：YYYY-MM-DD][；功能：<label>]
 *
 * Usage:
 *   node roadmap.mjs --write        rewrite the auto block + HTML
 *   node roadmap.mjs --check        compare only (default): 0 match, 1 drift/parse error, 2 bad config
 *   node roadmap.mjs --json         dump the parsed model
 *   node roadmap.mjs --html-only    rerender HTML only
 *
 * Options:
 *   --worklog-dir <dir>   default ./.worklog
 *   --out <file>          default ../ROADMAP.md
 *   --gates <file>        default <worklog-dir>/gates.json (missing = skip gate section)
 *   --version-file <file> optional: read a version constant from this source file
 *   --version-key <name>  constant name in --version-file (default HUB_VERSION)
 *   --version-package <file> optional package.json whose version must match
 *
 * Exit codes: 0 OK, 1 drift or parse error, 2 usage / missing markers.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const PRIORITIES = ['P0', 'P1', 'P2']
const STATUSES = ['未开始', '进行中', '已完成']
const UNCLASSIFIED = '未分类'
const DONE_LIST_CAP = 60
const MARK_START = '<!-- AUTO:TODO START -->'
const MARK_END = '<!-- AUTO:TODO END -->'
const GENERATED_PREFIX = '<!-- generated:'
const LOCK_STALE_MS = 10_000
const LOCK_RETRY_DELAY_MS = 300
const LOCK_RETRIES = 3
const USAGE = `roadmap.mjs — render a worklog todo directory into ROADMAP.md and roadmap.html

Usage:
  node roadmap.mjs --write [options]
  node roadmap.mjs --check [options]
  node roadmap.mjs --json [options]
  node roadmap.mjs --html-only [options]

Options:
  --worklog-dir <dir>        default ./.worklog
  --out <file>               default ../ROADMAP.md
  --gates <file>             default <worklog-dir>/gates.json
  --version-file <file>      optional source file holding a version constant
  --version-key <name>       constant name (default HUB_VERSION)
  --version-package <file>   optional package.json that must match the constant
  --run-checks               run {check} gate requirements (default: yes in --check/--json)
  --no-checks                skip {check} gate requirements
  --fail-on-check            exit 1 when a non-optional check fails

Exit codes: 0 = OK, 1 = drift or parse error (or failed check with --fail-on-check), 2 = usage / missing markers.`

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function parseArgs(argv) {
  const options = {
    mode: 'check',
    json: false,
    htmlOnly: false,
    worklogDir: './.worklog',
    out: null,
    gates: null,
    versionFile: null,
    versionKey: 'HUB_VERSION',
    versionPackage: null,
    featuresFile: null,
    noChecks: false,
    runChecks: null,
    failOnCheck: false,
  }
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
      case '--worklog-dir': options.worklogDir = takeValue(); break
      case '--out': options.out = takeValue(); break
      case '--gates': options.gates = takeValue(); break
      case '--version-file': options.versionFile = takeValue(); break
      case '--version-key': options.versionKey = takeValue(); break
      case '--version-package': options.versionPackage = takeValue(); break
      case '--features-file': options.featuresFile = takeValue(); break
      case '--no-checks': options.noChecks = true; break
      case '--run-checks': options.runChecks = true; break
      case '--fail-on-check': options.failOnCheck = true; break
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
  return [...entries].sort((left, right) => priorityCompare(left, right) || ownerCompare(left, right))
}

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

function countEntries(entries, today = new Date()) {
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
  return match ? { session: match[1], updated: match[2] } : null
}

function parseEntry(line, sessionName, file, lineNumber, errors, features, warnings) {
  const match = /^- \[(P[0-2])\] (.+)$/.exec(line)
  if (!match) {
    errors.push({ file, line: lineNumber, message: 'not a todo line: expected "- [P0|P1|P2] <title> —— <description>；验收：…；状态：…"' })
    return null
  }
  const [, priority, rest] = match
  const segments = rest.split('；')
  const fields = { acceptance: null, status: null, owner: null, progress: null, feature: null }
  const descriptionParts = [segments[0]]
  for (const segment of segments.slice(1)) {
    const field = /^(验收|状态|归属|进展|功能)：(.+)$/.exec(segment)
    if (!field) {
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
  // Some lines write "…；验收：…。功能：X；归属：…" (the 功能 marker follows a period, not a
  // semicolon), so the field parser sees it as part of 验收. Pull it out explicitly.
  if (!fields.feature && fields.acceptance) {
    const inline = /功能：([^；。\n]+)/.exec(fields.acceptance)
    if (inline) {
      fields.feature = inline[1].trim()
      fields.acceptance = fields.acceptance.slice(0, inline.index).replace(/[。；]$/, '').trim()
    }
  }
  const head = descriptionParts.join('；')
  const splitAt = head.indexOf('——')
  const problems = []
  if (splitAt < 0) problems.push('missing " —— " between title and description')
  const title = splitAt < 0 ? '' : head.slice(0, splitAt).trim()
  let description = splitAt < 0 ? '' : head.slice(splitAt + 2).trim()
  // The same marker can also land in the description when the line separates fields with 。
  if (!fields.feature) {
    const inline = /功能：([^；。\n]+)/.exec(description)
    if (inline) {
      fields.feature = inline[1].trim()
      description = description.slice(0, inline.index).replace(/[。；]$/, '').trim()
    }
  }
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
    displayTitle: stripAnnotation(title),
    description,
    acceptance: fields.acceptance,
    status: fields.status,
    owner: fields.owner ?? sessionName,
    explicitOwner: fields.owner !== null,
    progress: fields.progress ?? null,
    feature: resolveFeature(fields.feature, title, description, features, file, lineNumber, warnings),
    file,
    line: lineNumber,
    source: `${file}:${lineNumber}`,
    duplicateOf: null,
  }
}

async function parseTodos(todoDir, features, warnings) {
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
    const sessionName = header?.session ?? file.replace(/\.md$/, '')
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index].trimEnd()
      if (!line.startsWith('- ')) continue
      const entry = parseEntry(line, sessionName, file, index + 1, errors, features, warnings)
      if (entry) entries.push(entry)
    }
  }
  return { entries, errors }
}

async function loadFeatures(file) {
  if (!file) return { vocabulary: [], rules: [] }
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`提示：未找到功能规则 ${file}，仅按显式「功能：」归类`)
      return { vocabulary: [], rules: [] }
    }
    console.warn(`WARN: cannot read features (${file}): ${error.message}`)
    return { vocabulary: [], rules: [] }
  }
  try {
    const parsed = JSON.parse(raw)
    const vocabulary = Array.isArray(parsed.vocabulary) ? parsed.vocabulary : []
    const rules = (parsed.rules ?? []).map((rule) => [rule.name, new RegExp(rule.pattern, 'i')])
    return { vocabulary, rules }
  } catch (error) {
    console.warn(`WARN: bad features file (${file}): ${error.message}`)
    return { vocabulary: [], rules: [] }
  }
}

// Priority is explicit field > title keyword > description keyword > 未分类.
// The explicit 功能： field always wins: keyword inference is a fallback for lines that did
// not bother to classify themselves, and must never override a human decision.
function resolveFeature(raw, title, description, features, file, lineNumber, warnings) {
  if (raw) {
    if (features.vocabulary.length && !features.vocabulary.includes(raw)) {
      warnings.push({ file, line: lineNumber, message: `未知功能标签「${raw}」，已归未分类` })
      return UNCLASSIFIED
    }
    return raw
  }
  for (const [name, pattern] of features.rules) if (pattern.test(title)) return name
  for (const [name, pattern] of features.rules) if (pattern.test(description)) return name
  return UNCLASSIFIED
}

function stripAnnotation(title) {
  return title
    .replace(/（需[^）]*）/g, '')
    .replace(/\(需[^)]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function normalizeTitle(title) {
  return stripAnnotation(title).replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/[\s\u3000]+/g, '').toLowerCase()
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
      if (dice(leftTitle, normalizeTitle(right.displayTitle)) < 0.5) continue
      if (!left.duplicateOf) left.duplicateOf = right.owner
      if (!right.duplicateOf) right.duplicateOf = left.owner
    }
  }
}

function sourceHash(entries, version) {
  const canonical = {
    version: version ? { key: version.key, value: version.value, packageVersion: version.packageVersion } : null,
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

function featureNames(entries, features) {
  if (features.vocabulary.length) {
    const names = [...features.vocabulary]
    if (entries.some((entry) => entry.feature === UNCLASSIFIED) && !names.includes(UNCLASSIFIED)) names.push(UNCLASSIFIED)
    return names
  }
  const names = [...new Set(entries.map((entry) => entry.feature).filter((name) => name !== UNCLASSIFIED))].sort()
  if (entries.some((entry) => entry.feature === UNCLASSIFIED)) names.push(UNCLASSIFIED)
  return names
}

function featureStats(entries, features) {
  return featureNames(entries, features).map((name) => {
    const group = entries.filter((entry) => entry.feature === name)
    const open = group.filter((entry) => entry.status !== '已完成')
    const topPriority = PRIORITIES.find((priority) => open.some((entry) => entry.priority === priority)) ?? null
    const owners = [...new Set(group.filter((entry) => entry.explicitOwner).map((entry) => entry.owner))].sort()
    return { name, total: group.length, open: open.length, done: group.length - open.length, topPriority, owners }
  })
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

function gateRequireLabel(require) {
  if (require?.check) return require.check.label ?? require.check.command ?? 'check'
  return require?.match ?? require?.feature ?? '(empty)'
}

function gateRequireEntries(require, entries) {
  if (require?.feature) return entries.filter((entry) => entry.feature === require.feature)
  const needle = String(require?.match ?? '').toLowerCase()
  return entries.filter((entry) => entry.displayTitle.toLowerCase().includes(needle))
}

/** Run every {check} requirement once. exit 0 = satisfied; timeout counts as failure. */
function runGateChecks(gates, log = console.log) {
  const results = {}
  for (const gate of gates) {
    const list = []
    for (const require of gate.requires ?? []) {
      if (!require.check) continue
      const spec = require.check
      const label = gateRequireLabel(require)
      const command = String(spec.command ?? '')
      const timeout = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : 60_000
      const started = Date.now()
      let ok = false
      let code = null
      let outputTail = ''
      if (!command) {
        code = 'missing-command'
        outputTail = 'check requires a command'
      } else {
        const proc = spawnSync(command, { shell: true, cwd: process.cwd(), timeout, encoding: 'utf8' })
        code = proc.status ?? (proc.error?.code === 'ETIMEDOUT' ? 'timeout' : 'error')
        ok = code === 0
        outputTail = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim().slice(-800)
      }
      const ms = Date.now() - started
      const optional = spec.optional === true
      list.push({ label, ok, optional, code, ms, outputTail })
      if (ok) log(`ok check「${label}」(${ms}ms)`)
      else {
        const why = optional ? '（optional，不阻塞）' : ''
        log(`WARN check「${label}」失败（exit ${code}, ${ms}ms）${why}`)
        if (outputTail) for (const line of outputTail.split(/\r?\n/)) log(`  | ${line}`)
      }
    }
    if (list.length) results[gate.id] = list
  }
  return results
}

function evaluateGate(gate, entries, checkResults) {
  const met = []
  const seen = new Set()
  const blocking = []
  const capsules = []
  const capsuleSeen = new Set()
  const checks = []
  const pushBlocker = (key, title) => {
    if (seen.has(key)) return
    seen.add(key)
    blocking.push(title)
  }
  for (const require of gate.requires ?? []) {
    if (require.check) {
      const label = gateRequireLabel(require)
      const result = (checkResults?.[gate.id] ?? []).find((item) => item.label === label)
      if (!result) {
        pushBlocker(`check-missing:${label}`, `check:${label}(未运行)`)
        continue
      }
      checks.push(result)
      if (result.ok) {
        met.push(require)
        continue
      }
      if (result.optional) continue
      pushBlocker(`check:${label}`, `check:${label}`)
      continue
    }
    const matched = gateRequireEntries(require, entries)
    for (const entry of matched) {
      const key = `${entry.file}:${entry.line}`
      if (capsuleSeen.has(key)) continue
      capsuleSeen.add(key)
      capsules.push(entry)
    }
    const open = matched.filter((entry) => entry.status !== '已完成')
    if (matched.length > 0 && open.length === 0) {
      met.push(require)
      continue
    }
    if (matched.length === 0) pushBlocker(`missing:${gateRequireLabel(require)}`, `「${gateRequireLabel(require)}」无匹配`)
    else pushBlocker(`${open[0].file}:${open[0].line}`, open[0].displayTitle)
  }
  capsules.sort((left, right) => {
    const leftDone = left.status === '已完成' ? 1 : 0
    const rightDone = right.status === '已完成' ? 1 : 0
    return leftDone - rightDone || priorityCompare(left, right) || ownerCompare(left, right)
  })
  return {
    id: gate.id,
    name: gate.name,
    question: gate.question,
    satisfied: blocking.length === 0,
    met: met.length,
    total: (gate.requires ?? []).length,
    blocking,
    checks,
    capsules: capsules.map((entry) => ({ title: entry.displayTitle, status: entry.status, owner: entry.owner, feature: entry.feature })),
  }
}

/** Next-step digest: unfinished P1 grouped by owner (max 3 each, 12 total); P2 when no P1. */
function nextUp(entries) {
  const unfinished = entries.filter((entry) => entry.status !== '已完成')
  const pool = unfinished.filter((entry) => entry.priority === 'P1')
  const source = pool.length ? pool : unfinished.filter((entry) => entry.priority === 'P2')
  const byOwner = new Map()
  for (const entry of [...source].sort(ownerCompare)) {
    if (!byOwner.has(entry.owner)) byOwner.set(entry.owner, [])
    const list = byOwner.get(entry.owner)
    if (list.length < 3) list.push(entry)
  }
  return [...byOwner.values()].flat().slice(0, 12).map((entry) => ({
    priority: entry.priority,
    title: entry.displayTitle,
    owner: entry.owner,
    feature: entry.feature,
  }))
}

function gateRows(gates, entries, checkResults) {
  return gates.map((gate) => evaluateGate(gate, entries, checkResults))
}

function checksCachePath(worklogDir) {
  return path.join(worklogDir, 'checks.json')
}

async function loadChecksCache(worklogDir) {
  try {
    const parsed = JSON.parse(await readFile(checksCachePath(worklogDir), 'utf8'))
    return parsed.checks ?? {}
  } catch {
    return {}
  }
}

async function saveChecksCache(worklogDir, checks) {
  try {
    await atomicWrite(checksCachePath(worklogDir), JSON.stringify({ at: nowStamp(), checks }, null, 2) + '\n')
  } catch (error) {
    console.warn(`WARN: cannot cache check results: ${error.message}`)
  }
}

async function loadGates(file) {
  if (!file) return []
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`提示：未找到关口定义 ${file}，跳过关口段`)
      return []
    }
    console.warn(`WARN: cannot read gates (${file}): ${error.message}`)
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.gates) ? parsed.gates : []
  } catch (error) {
    console.warn(`WARN: bad gates file (${file}): ${error.message}`)
    return []
  }
}

function buildSegment(entries, generatedAt, hash, version, gates, sourceLabel, features, checkResults) {
  const counts = countEntries(entries)
  const unfinished = entries.filter((entry) => entry.status !== '已完成')
  const done = entries.filter((entry) => entry.status === '已完成')
  const openCount = counts.P0 + counts.P1 + counts.P2
  const lines = [
    `${GENERATED_PREFIX} ${generatedAt}; ${counts.total} items; src=${hash} -->`,
    `共 ${counts.total} 条 · P0 ${counts.P0} / P1 ${counts.P1} / P2 ${counts.P2}（未完成 ${openCount}）· 进行中 ${counts.inProgress} · 已完成 ${counts.done} · 来源 ${sourceLabel}/todo/*.md`,
  ]
  if (version) {
    const parts = [`${version.key} ${version.value}（${version.file}）`]
    if (version.packageVersion) parts.push(`package.json ${version.packageVersion}`)
    lines.push(`版本快照：${parts.join(' · ')} · 读取自代码，勿手改`)
  }
  const stats = featureStats(entries, features)
  if (stats.length) {
    lines.push('', '### 按功能聚合', '', '| 功能 | 未完成 | 已完成 | 最高优先级 | 涉及会话 |', '|---|---|---|---|---|')
    for (const row of stats) {
      lines.push(`| ${row.name} | ${row.open} | ${row.done} | ${row.topPriority ?? '—'} | ${row.owners.length ? row.owners.join(', ') : '—'} |`)
    }
  }
  const gateResult = gates.length ? gateRows(gates, entries, checkResults) : []
  if (gates.length) {
    lines.push('', '### 关口（阶段性验收）', '', '| 关口 | 问题 | 状态 | 还差什么 |', '|---|---|---|---|')
    const rows = gateResult
    for (const row of rows) {
      const status = row.satisfied ? '✅ 达成' : `⏳ ${row.met}/${row.total}`
      let remain = '—'
      if (!row.satisfied) {
        const circled = ['①', '②', '③']
        remain = row.blocking.slice(0, 3).map((title, index) => `${circled[index]}${title}`).join(' ')
        if (row.blocking.length > 3) remain += ` 等 ${row.blocking.length} 条`
      }
      lines.push(`| ${row.id} ${row.name} | ${row.question} | ${status} | ${remain} |`)
    }
    if (rows.length && rows.every((row) => row.satisfied)) lines.push('', '> 全部关口已达成。')
  }
  const unmet = gateResult.filter((row) => !row.satisfied)
  if (unmet.length) {
    lines.push('', '### 待办聚合', '', '按关口聚合（只列未达成关口；未完成项在前）：')
    for (const row of unmet) {
      lines.push('', `#### ${row.id} ${row.name}（⏳ ${row.met}/${row.total}）`, '', '| 状态 | 条目 | 归属 |', '|---|---|---|')
      for (const capsule of row.capsules) {
        lines.push(`| ${capsule.status === '已完成' ? '✅' : '⏳'} | ${capsule.title} | ${capsule.owner} |`)
      }
    }
    const next = nextUp(entries)
    if (next.length) {
      lines.push('', '#### 下一步 Top')
      for (const item of next) lines.push(`- [${item.feature}] ${item.title} — ${item.owner}`)
    }
  }
  for (const priority of PRIORITIES) {
    const group = unfinished.filter((entry) => entry.priority === priority).sort(ownerCompare)
    lines.push('', `### ${priority}（${group.length}）`)
    for (const entry of group) lines.push(formatItem(entry))
  }
  if (done.length) {
    const sortedDone = [...done].sort((left, right) => priorityCompare(left, right) || ownerCompare(left, right))
    lines.push('', '<details>', `<summary>已完成（${done.length}）—— 点击展开</summary>`, '')
    for (const entry of sortedDone.slice(0, DONE_LIST_CAP)) {
      lines.push(`- ${entry.feature} · [${entry.priority}] ${entry.displayTitle}（${entry.owner}）`)
    }
    if (sortedDone.length > DONE_LIST_CAP) {
      lines.push('', `- 其余 ${sortedDone.length - DONE_LIST_CAP} 条见 ${sourceLabel}/roadmap.html`)
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
    if (error.code === 'ENOENT') fail(2, `ROADMAP not found: ${roadmapPath}\npass --out <path> or create the file with the AUTO markers.`)
    fail(2, `cannot read ROADMAP: ${error.message}`)
  }
}

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireLock(worklogDir) {
  const lockPath = path.join(worklogDir, '.roadmap.lock')
  await mkdir(path.dirname(lockPath), { recursive: true })
  const stamp = `${process.pid} ${new Date().toISOString()}`
  const release = async () => {
    try {
      await unlink(lockPath)
    } catch {
      /* already released */
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
        /* lock disappeared, retry */
      }
      if (attempt < LOCK_RETRIES) await delay(LOCK_RETRY_DELAY_MS)
    }
  }
  console.log('WARN: roadmap lock busy, skipped write')
  return null
}

async function readVersionInfo(options) {
  if (!options.versionFile) return null
  const file = path.resolve(options.versionFile)
  let source
  try {
    source = await readFile(file, 'utf8')
  } catch (error) {
    fail(2, `cannot read ${file}: ${error.message}`)
  }
  const match = new RegExp(`${options.versionKey}\\s*=\\s*'([^']+)'`).exec(source)
  if (!match) fail(2, `${file}: cannot find ${options.versionKey} = '...'`)
  let packageVersion = null
  if (options.versionPackage) {
    const packageFile = path.resolve(options.versionPackage)
    try {
      const parsed = JSON.parse(await readFile(packageFile, 'utf8'))
      packageVersion = parsed.version ? String(parsed.version) : null
    } catch (error) {
      fail(2, `cannot read ${packageFile}: ${error.message}`)
    }
  }
  return { key: options.versionKey, value: match[1], packageVersion, file, packageFile: options.versionPackage }
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
  if (problem) console.log(`WARN: ${htmlPath} 过期，跑 --write (${problem})`)
}

function warnIfDemotedInProgress(entries, today = new Date()) {
  for (const entry of entries) {
    if (entry.status !== '进行中') continue
    const live = isLiveInProgress(entry, today)
    if (live.ok) continue
    console.log(`WARN: ${entry.file} 行 ${entry.line} 「进行中」但${live.reason}，按待办处理`)
  }
}

function warnIfGateMisses(entries, gates) {
  for (const gate of gates) {
    for (const require of gate.requires ?? []) {
      if (require.feature) {
        console.log(`WARN: 关口 ${gate.id} 使用 feature 判据，新增同功能条目会让它回退；建议改为 match 清单`)
        continue
      }
      if (gateRequireEntries(require, entries).length > 0) continue
      console.log(`WARN: 关口 ${gate.id} 的 require「${gateRequireLabel(require)}」没有匹配到任何 todo（标题改过？）`)
    }
  }
}

function statusClass(status) {
  if (status === '已完成') return 'done'
  if (status === '进行中') return 'doing'
  return 'todo'
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
  const search = escapeHtml(`${entry.displayTitle} ${entry.description} ${entry.acceptance} ${entry.feature}`.toLowerCase())
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
  const note = rows.length > 0 && rows.every((row) => row.satisfied) ? '<p class="gate-note">全部关口已达成。</p>' : ''
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

function renderHtml(entries, generatedAt, hash, gates = [], sourceLabel = '.worklog') {
  const counts = countEntries(entries)
  const sorted = sortForDisplay(entries)
  const owners = [...new Set(sorted.map((entry) => entry.owner))].sort()
  const gatesHtml = gates.length ? renderGatesHtml(gates, entries) : ''
  const priorityChips = PRIORITIES.map(
    (priority) => `        <button type="button" class="chip" data-prio-filter="${priority}">${priority}（${counts[priority]}）</button>`,
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
<title>待办汇总</title>
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
  <h1>待办汇总</h1>
  <p class="meta">生成时间 ${escapeHtml(generatedAt)} · 来源 ${escapeHtml(sourceLabel)}/todo/*.md</p>
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

async function writeHtml(htmlPath, entries, generatedAt, hash, gates, sourceLabel) {
  await atomicWrite(htmlPath, renderHtml(entries, generatedAt, hash, gates, sourceLabel))
}

async function assertWorklog(worklogDir) {
  const todo = path.join(worklogDir, 'todo')
  const ok = await stat(todo).then((info) => info.isDirectory()).catch(() => false)
  if (!ok) fail(2, `missing todo directory: ${todo}\npass --worklog-dir <dir> (expects <dir>/todo/*.md)`)
}

function hasFailingCheck(checkResults) {
  for (const list of Object.values(checkResults ?? {})) {
    for (const item of list) if (!item.ok && !item.optional) return true
  }
  return false
}

async function checkRoadmap(roadmapPath, htmlPath, entries, generatedAt, hash, version, gates, sourceLabel, features, checkResults, failOnCheck) {
  if (version && version.packageVersion && version.value !== version.packageVersion) {
    console.error(`ERROR: version drift: ${version.key}=${version.value} vs package.json=${version.packageVersion}`)
    console.error('align the version constant and package.json before checking the ROADMAP block')
    process.exit(1)
  }
  const original = await readRoadmap(roadmapPath)
  const markers = locateMarkers(original)
  if (!markers.ok) fail(2, `missing marker ${markers.missing} in ${roadmapPath}`)
  const actual = stripGenerated(original.slice(markers.start + MARK_START.length, markers.end))
  const expected = stripGenerated(buildSegment(entries, generatedAt, hash, version, gates, sourceLabel, features, checkResults))
  if (actual === expected) {
    console.log(`OK: ROADMAP auto section matches todo (${entries.length} items)`)
    await warnIfHtmlStale(htmlPath, hash)
    warnIfDemotedInProgress(entries)
    warnIfGateMisses(entries, gates)
    if (failOnCheck && hasFailingCheck(checkResults)) {
      console.error('ERROR: --fail-on-check: a non-optional check failed')
      process.exit(1)
    }
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
  console.error('drift detected between ROADMAP auto section and todo:')
  if (difference) {
    console.error(`  line ${difference.line}`)
    console.error(`  ROADMAP: ${difference.actual}`)
    console.error(`  todos:   ${difference.expected}`)
  }
  console.error('run: node roadmap.mjs --write')
  process.exit(1)
}

async function writeRoadmap(roadmapPath, entries, generatedAt, hash, version, gates, sourceLabel, features, checkResults) {
  const original = await readRoadmap(roadmapPath)
  const markers = locateMarkers(original)
  if (!markers.ok) fail(2, `missing marker ${markers.missing} in ${roadmapPath}`)
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const segment = buildSegment(entries, generatedAt, hash, version, gates, sourceLabel, features, checkResults).replace(/\n/g, newline)
  const next = original.slice(0, markers.start + MARK_START.length) + newline + segment + newline + original.slice(markers.end)
  await atomicWrite(roadmapPath, next)
  return next
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const worklogDir = path.resolve(options.worklogDir)
  const todoDir = path.join(worklogDir, 'todo')
  const roadmapPath = path.resolve(options.out || path.join(worklogDir, '..', 'ROADMAP.md'))
  const htmlPath = path.join(worklogDir, 'roadmap.html')
  const gatesPath = path.resolve(options.gates || path.join(worklogDir, 'gates.json'))
  const sourceLabel = options.worklogDir.replace(/^\.\//, '').replace(/\/$/, '') || '.worklog'

  await assertWorklog(worklogDir)
  const features = await loadFeatures(options.featuresFile)
  const warnings = []
  const { entries, errors } = await parseTodos(todoDir, features, warnings)
  for (const warning of warnings) console.log(`WARN: ${warning.file} 行 ${warning.line} ${warning.message}`)
  markDuplicates(entries)
  const gates = await loadGates(gatesPath)
  const shouldRunChecks =
    !options.noChecks &&
    (options.runChecks === true || (options.runChecks !== false && (options.mode === 'check' || options.json)))
  let checkResults
  if (shouldRunChecks && gates.length) {
    const log = options.json ? (...args) => console.error(...args) : console.log
    checkResults = runGateChecks(gates, log)
    await saveChecksCache(worklogDir, checkResults)
  } else {
    checkResults = await loadChecksCache(worklogDir)
  }
  const version = await readVersionInfo(options)
  const hash = sourceHash(entries, version)
  const generatedAt = nowStamp()

  if (options.json) {
    const model = {
      worklogDir,
      roadmap: roadmapPath,
      html: htmlPath,
      gatesPath,
      gates: gateRows(gates, entries, checkResults),
      nextUp: nextUp(entries),
      hash,
      version,
      counts: countEntries(entries),
      features: featureStats(entries, features),
      unclassified: entries.filter((entry) => entry.feature === UNCLASSIFIED).slice(0, 50).map((entry) => entry.displayTitle),
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
    console.error(`\n${errors.length} parse error(s); fix ${todoDir}/*.md first.`)
    process.exit(1)
  }

  if (options.htmlOnly) {
    const lock = await acquireLock(worklogDir)
    if (!lock) return
    try {
      await writeHtml(htmlPath, entries, generatedAt, hash, gates, sourceLabel)
      console.log(`wrote HTML -> ${htmlPath}`)
    } finally {
      await lock.release()
    }
    return
  }

  if (options.mode === 'check') {
    await checkRoadmap(roadmapPath, htmlPath, entries, generatedAt, hash, version, gates, sourceLabel, features, checkResults, options.failOnCheck)
    return
  }

  const lock = await acquireLock(worklogDir)
  if (!lock) return
  try {
    await writeRoadmap(roadmapPath, entries, generatedAt, hash, version, gates, sourceLabel, features, checkResults)
    const counts = countEntries(entries)
    console.log(`wrote ROADMAP: ${counts.total} items (P0 ${counts.P0} / P1 ${counts.P1} / P2 ${counts.P2}, done ${counts.done}) -> ${roadmapPath}`)
    try {
      await writeHtml(htmlPath, entries, generatedAt, hash, gates, sourceLabel)
      console.log(`wrote HTML -> ${htmlPath}`)
    } catch (error) {
      console.warn(`warning: HTML render failed (ROADMAP was written): ${error.message}`)
    }
    const unclassified = entries.filter((entry) => entry.feature === UNCLASSIFIED).length
    console.log(`未分类 ${unclassified} 条（如需归类请在 todo 里加「功能：…」）`)
  } finally {
    await lock.release()
  }
}

main().catch((error) => fail(1, `roadmap: ${error?.message ?? error}`))
