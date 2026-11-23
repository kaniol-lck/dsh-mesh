#!/usr/bin/env node
/**
 * check-ledger.mjs — standing invariant: code commits must be referenced by the ledger.
 *
 * For every commit in the last N days (default 7) that touches code scope
 * (plugins/mesh-waker/, hub/, plugins/mesh-approval/, scripts/, skills/, test/),
 * its short hash must appear in one of:
 *   .worklog/todo/*.md, .worklog/WORKLOG.md, .worklog/dispatch/queue.md
 * Commits that only touch docs/ or .worklog/ or root-level *.md are ignored.
 *
 * Historical commits are exempted through .worklog/ledger-baseline.json
 * {"exempt": ["abc1234", ...], "since": "YYYY-MM-DD"}; only commits on/after
 * `since` (and not exempt) can fail the gate. --update-baseline records today's
 * unaccounted commits and is the only writing mode.
 *
 * The ledger lives in .worklog/, which is gitignored: this gate can only run in a
 * local checkout, not in CI. Run it after committing (or before a handoff).
 *
 * Exit codes: 0 all accounted, 1 unaccounted commits, 2 usage error.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKLOG = process.env.MESH_WORKLOG_DIR ?? path.join(ROOT, '.worklog')
const BASELINE = path.join(WORKLOG, 'ledger-baseline.json')
const TRIAGE_DIR = path.join(WORKLOG, 'ops', 'triage')
const QUEUE_SHARD_DIR = path.join(WORKLOG, 'dispatch', 'queue')
const TRIAGE_SINCE = '2026-11-04'
const DONE_STATUS = /done|deployed|已完成|verified/i
const CODE_PREFIXES = ['plugins/mesh-waker/', 'hub/', 'plugins/mesh-approval/', 'scripts/', 'skills/', 'test/']
const USAGE = `check-ledger.mjs — code commits must be referenced by the ledger

Usage:
  node check-ledger.mjs [--days N] [--json] [--update-baseline] [--help]

Options:
  --days N            look back N days (default 7)
  --json              machine-readable output
  --update-baseline   record currently unaccounted commits as exempt (writes
                      .worklog/ledger-baseline.json; default is dry-run)
  -h, --help          show this help

Triage rule (since 2026-11-04):
  A queue.md row whose status is done / deployed / 已完成 / verified must have a
  .worklog/ops/triage/<taskId>.json stamp from progress-watch --task. Rows dated
  before 2026-11-04 are exempt. A stamp with needsReview=true is accepted but
  listed, so red-triage closures stay visible.

Exit codes: 0 all accounted, 1 unaccounted commits or missing triage stamps,
2 usage error.`

function parseArgs(argv) {
  const options = { days: 7, json: false, updateBaseline: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--days') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value <= 0) {
        console.error('--days requires a positive number\n\n' + USAGE)
        process.exit(2)
      }
      options.days = value
      index += 1
    } else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  return options
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

/** [{ full, short, subject, files }] for commits in the window, newest first. */
export function recentCommits(days) {
  const output = git(['log', `--since=${days} days ago`, '--date=short', '--format=@@%H%x09%h%x09%ad%x09%s', '--name-only'])
  const commits = []
  let current = null
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      if (current) commits.push(current)
      const [full, short, date, subject] = line.slice(2).split('\t')
      current = { full, short, date, subject: subject ?? '', files: [] }
    } else if (current && line.trim()) {
      current.files.push(line.trim())
    }
  }
  if (current) commits.push(current)
  return commits
}

export function inCodeScope(files) {
  if (!files.length) return false
  const touchesCode = files.some((file) => CODE_PREFIXES.some((prefix) => file.startsWith(prefix)))
  const docOnly = files.every(
    (file) => file.startsWith('docs/') || file.startsWith('.worklog/') || !file.includes('/'),
  )
  return touchesCode && !docOnly
}

function ledgerText() {
  const parts = []
  const todoDir = path.join(WORKLOG, 'todo')
  if (existsSync(todoDir)) {
    for (const entry of readdirSync(todoDir)) {
      if (entry.endsWith('.md')) parts.push(readFileSync(path.join(todoDir, entry), 'utf8'))
    }
  }
  for (const rel of ['WORKLOG.md', 'dispatch/queue.md']) {
    const file = path.join(WORKLOG, rel)
    if (existsSync(file)) parts.push(readFileSync(file, 'utf8'))
  }
  return parts.join('\n')
}

/**
 * 每条账本的**归属角色**（README 的「归属：」slug → todo 文件名）。
 *
 * 为什么需要（2026-11-23 L2-20261123-01）：本脚本原先只做全文子串匹配，于是
 * 「谁在诊断里提到这个哈希」就等于「谁记了账」。实测 `2933fc8` 是 docs 的活，
 * 却只出现在 `todo/l2.md` 的诊断行里 —— gate 判绿，而真正该记账的 `docs.md` 命中 0。
 * 同类已第 3 次（11-18 L2 诊断误绿、11-20 散文凑绿、11-23 再次）。
 *
 * 判据分层（不搞一刀切，否则会把「L1 代记」这类合法实践判红）：
 *   - 命中**归属角色**的 todo，或命中 `WORKLOG.md` / `dispatch/queue.md` → 记账成立
 *   - 只命中**别的角色**的 todo → 记账不成立，但降级 WARN 并点名（可能是诊断文本）
 *   - 哪儿都没有 → 保持 FAIL
 */
const OWNER_PREFIXES = [
  ['plugins/mesh-waker/', 'waker'],
  ['hub/', 'hub'],
  ['plugins/mesh-approval/', 'hub'],
  ['scripts/', 'docs'],
  ['test/', 'docs'],
  ['skills/', 'docs'],
]

export function ownerFor(files) {
  const hits = []
  for (const [prefix, slug] of OWNER_PREFIXES) {
    if (files.some((file) => file.startsWith(prefix))) hits.push(slug)
  }
  return hits.length ? [...new Set(hits)] : []
}

/** todo/<slug>.md 的正文，按 slug 索引；用于「是不是记在了自己名下」。 */
function todoTextByRole() {
  const map = new Map()
  const todoDir = path.join(WORKLOG, 'todo')
  if (!existsSync(todoDir)) return map
  for (const entry of readdirSync(todoDir)) {
    if (!entry.endsWith('.md')) continue
    map.set(entry.replace(/\.md$/, ''), readFileSync(path.join(todoDir, entry), 'utf8'))
  }
  return map
}

/** WORKLOG + queue 属于「叙事账本」，任何角色都可记，命中即成立。 */
function narrativeText() {
  const parts = []
  for (const rel of ['WORKLOG.md', 'dispatch/queue.md']) {
    const file = path.join(WORKLOG, rel)
    if (existsSync(file)) parts.push(readFileSync(file, 'utf8'))
  }
  return parts.join('\n')
}

/**
 * 叙事账本（WORKLOG / queue）里，这个提交是否被**按记账格式**写过。
 *
 * 背景（2026-11-23 L2-20261123-01）：本脚本原先只做全文子串匹配，于是「谁在诊断里
 * 提到这个哈希」就等于「谁记了账」——L2 把自己的诊断写进 todo/l2.md 与 WORKLOG
 * 之后，gate 就假绿了，而真正该记账的 docs.md 命中 0。同类第 3 次。
 *
 * **走过的弯路（留作教训，别再试）**：想靠「假红/自曝/诊断」这类**语气词**区分
 * 记账与谈论，试了三版都失败——整行否决会误伤 Long 的记账行；只看哈希附近 60 字会漏
 * （措辞在下一句）；`验收证据 + commit` 又会被「要求补进验收证据」这种**批评记账缺失**
 * 的句子命中。语气词既误伤也漏判，不可靠。
 *
 * 所以只认**结构**：记账有几条固定写法，其余一律不算记账（降级 WARN，由人判断）。
 * 宁可让人看一眼 WARN，也不让 gate 假装绿。
 */
const NARRATIVE_ACCOUNTING = [
  /commit\s+`?[0-9a-f]{7,40}/, // commit <hash>
  /CI success\s*@\s*`?[0-9a-f]{7,40}/, // CI success @ <hash>
  /已?\s*push[^。；\n]{0,30}[0-9a-f]{7,40}/, // 已 push <hash> / push a..b
  /验收(?:证据)?[:：][^。\n]{0,40}[0-9a-f]{7,40}/, // 验收：…<hash>
]

function narrativeAccounts(text, short, full) {
  return text.split(/\r?\n/).some((line) => {
    if (!line.includes(short) && !line.includes(full)) return false
    return NARRATIVE_ACCOUNTING.some((re) => re.test(line))
  })
}

/** 某角色 todo 里是否把它当作账记过。todo 行天然是「条目」，不做语气区分。 */
function todoAccounts(text, short, full) {
  return text.includes(short) || text.includes(full)
}

function readBaseline() {
  if (!existsSync(BASELINE)) return { exempt: [], since: null }
  try {
    const parsed = JSON.parse(readFileSync(BASELINE, 'utf8'))
    return { exempt: Array.isArray(parsed.exempt) ? parsed.exempt : [], since: parsed.since ?? null }
  } catch {
    return { exempt: [], since: null }
  }
}

/**
 * The same taskId written by two originating sessions means one shard will silently
 * shadow the other when the ledger is read by taskId. Report each conflict with
 * file:line so the writer can be found.
 */
export function duplicateQueueTaskIds(queueDir = QUEUE_SHARD_DIR) {
  if (!existsSync(queueDir)) return []
  const byTask = new Map()
  for (const name of readdirSync(queueDir)) {
    if (!name.endsWith('.md')) continue
    const file = path.join(queueDir, name)
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (!/^\|\s*[A-Za-z0-9]/.test(line)) return
      const cells = line.split('|').map((cell) => cell.trim())
      const taskId = cells[1]
      if (!taskId) return
      if (!byTask.has(taskId)) byTask.set(taskId, [])
      byTask.get(taskId).push({ file: name, line: index + 1 })
    })
  }
  return [...byTask.entries()]
    .filter(([, rows]) => new Set(rows.map((row) => row.file)).size > 1)
    .map(([taskId, rows]) => ({ taskId, rows }))
}

/** Rows marked done since TRIAGE_SINCE must carry a progress-watch stamp. */
export function queueTriage(queueFile = path.join(WORKLOG, 'dispatch', 'queue.md'), triageDir = TRIAGE_DIR) {
  const missing = []
  const reviewed = []
  if (!existsSync(queueFile)) return { missing, reviewed }
  const lines = readFileSync(queueFile, 'utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^\|\s*[A-Za-z0-9][A-Za-z0-9-]*\s*\|/.test(line)) continue
    const cells = line.split('|').map((cell) => cell.trim())
    const taskId = cells[1]
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(cells[4] ?? '')?.[1]
    const status = cells[cells.length - 2] ?? ''
    if (!taskId || !date || date < TRIAGE_SINCE || !DONE_STATUS.test(status)) continue
    const stamp = path.join(triageDir, `${taskId}.json`)
    if (!existsSync(stamp)) {
      missing.push({ taskId, line: index + 1 })
      continue
    }
    let needsReview = false
    try {
      needsReview = JSON.parse(readFileSync(stamp, 'utf8')).needsReview === true
    } catch {
      /* unreadable stamp counts as present but not red */
    }
    if (needsReview) reviewed.push({ taskId, line: index + 1, needsReview: true })
  }
  return { missing, reviewed }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const baseline = readBaseline()
  const today = new Date().toISOString().slice(0, 10)
  const exempt = new Set(baseline.exempt)

  const commits = recentCommits(options.days)
  const candidates = commits.filter((commit) => inCodeScope(commit.files))
  const byRole = todoTextByRole()
  const narrative = narrativeText()
  const unaccounted = []
  const weakAccounted = []
  for (const commit of candidates) {
    if (exempt.has(commit.short) || exempt.has(commit.full)) continue
    if (baseline.since && commit.date && commit.date < baseline.since) continue
    const hitTodo = (text) => todoAccounts(text, commit.short, commit.full)
    const owners = ownerFor(commit.files)
    const inNarrative = narrativeAccounts(narrative, commit.short, commit.full)
    const inOwnTodo = owners.some((slug) => hitTodo(byRole.get(slug) ?? ''))
    if (inNarrative || inOwnTodo) continue
    const otherRoles = [...byRole.entries()]
      .filter(([slug, text]) => !owners.includes(slug) && hitTodo(text))
      .map(([slug]) => slug)
    if (otherRoles.length) {
      // 只出现在别人的 todo 里：可能是诊断文本，也可能是 L1 代记。降级 WARN 不判红，
      // 但要点名——让记账人自己判断「这算不算记在了该记的地方」。
      weakAccounted.push({ ...commit, owners, otherRoles })
      continue
    }
    unaccounted.push(commit)
  }

  if (options.updateBaseline) {
    const merged = [...new Set([...baseline.exempt, ...unaccounted.map((commit) => commit.short)])]
    const body = { exempt: merged, since: baseline.since ?? today }
    writeFileSync(BASELINE, JSON.stringify(body, null, 2) + '\n', 'utf8')
    if (options.json) {
      console.log(JSON.stringify({ updated: true, baseline: body, added: unaccounted.length }, null, 2))
    } else {
      console.log(`baseline updated: +${unaccounted.length} exempt (total ${merged.length}), since ${body.since}`)
    }
    process.exit(0)
  }

  const triage = queueTriage()
  const queueConflicts = duplicateQueueTaskIds()
  const report = {
    days: options.days,
    commits: commits.length,
    codeCommits: candidates.length,
    exempt: baseline.exempt.length,
    since: baseline.since,
    unaccounted: unaccounted.map((commit) => ({ hash: commit.short, subject: commit.subject })),
    weakAccounted: weakAccounted.map((commit) => ({
      hash: commit.short,
      subject: commit.subject,
      owners: commit.owners,
      mentionedIn: commit.otherRoles,
    })),
    triage: {
      since: TRIAGE_SINCE,
      missingStamp: triage.missing,
      needsReviewStamps: triage.reviewed,
    },
    queueConflicts,
    ok: unaccounted.length === 0 && triage.missing.length === 0 && queueConflicts.length === 0,
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`ledger: ${candidates.length} 个代码提交（${options.days} 天内），未记账 ${unaccounted.length}`)
    for (const commit of unaccounted) console.log(`  UNLEDGERED ${commit.short} ${commit.subject}`)
    if (!unaccounted.length) console.log('OK 所有代码提交都在账本里')
    else console.log('hint: 在 .worklog/todo/<角色>.md 或 dispatch/queue.md 引用短哈希；历史遗留可 --update-baseline')
    // 只命中别的角色 todo：可能是诊断文本而非记账。不判红，但点名，防「假绿」。
    for (const commit of weakAccounted) {
      console.log(
        `  WEAK ${commit.short} 归属=${commit.owners.join('/') || '?'} 但只在 ${commit.otherRoles.join(',')} 的 todo 里出现 —— 确认这是记账而不是诊断文本`,
      )
    }
    console.log(`triage: ${TRIAGE_SINCE} 起已完结单缺初筛戳 ${triage.missing.length}`)
    for (const item of triage.missing) console.log(`  MISSING ${item.taskId}（queue.md:${item.line}）—— 先跑 progress-watch --task ${item.taskId}`)
    for (const item of triage.reviewed) console.log(`  REVIEWED ${item.taskId}（queue.md:${item.line}）needsReview=true（带红结论收单，已知悉）`)
    if (!triage.missing.length) console.log('OK 已完结单都有初筛戳')
    for (const conflict of queueConflicts) {
      console.log(`CONFLICT ${conflict.taskId}：${conflict.rows.map((row) => `${row.file}:${row.line}`).join(' 与 ')}`)
    }
    if (!queueConflicts.length) console.log('OK 分片里没有同 taskId 跨会话重复')
  }
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
