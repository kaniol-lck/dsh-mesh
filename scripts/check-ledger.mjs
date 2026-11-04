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
const WORKLOG = path.join(ROOT, '.worklog')
const BASELINE = path.join(WORKLOG, 'ledger-baseline.json')
const TRIAGE_DIR = path.join(WORKLOG, 'ops', 'triage')
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

function readBaseline() {
  if (!existsSync(BASELINE)) return { exempt: [], since: null }
  try {
    const parsed = JSON.parse(readFileSync(BASELINE, 'utf8'))
    return { exempt: Array.isArray(parsed.exempt) ? parsed.exempt : [], since: parsed.since ?? null }
  } catch {
    return { exempt: [], since: null }
  }
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
  const ledger = ledgerText()

  const commits = recentCommits(options.days)
  const candidates = commits.filter((commit) => inCodeScope(commit.files))
  const unaccounted = []
  for (const commit of candidates) {
    if (exempt.has(commit.short) || exempt.has(commit.full)) continue
    if (baseline.since && commit.date && commit.date < baseline.since) continue
    if (ledger.includes(commit.short) || ledger.includes(commit.full)) continue
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
  const report = {
    days: options.days,
    commits: commits.length,
    codeCommits: candidates.length,
    exempt: baseline.exempt.length,
    since: baseline.since,
    unaccounted: unaccounted.map((commit) => ({ hash: commit.short, subject: commit.subject })),
    triage: {
      since: TRIAGE_SINCE,
      missingStamp: triage.missing,
      needsReviewStamps: triage.reviewed,
    },
    ok: unaccounted.length === 0 && triage.missing.length === 0,
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`ledger: ${candidates.length} 个代码提交（${options.days} 天内），未记账 ${unaccounted.length}`)
    for (const commit of unaccounted) console.log(`  UNLEDGERED ${commit.short} ${commit.subject}`)
    if (!unaccounted.length) console.log('OK 所有代码提交都在账本里')
    else console.log('hint: 在 .worklog/todo/<角色>.md 或 dispatch/queue.md 引用短哈希；历史遗留可 --update-baseline')
    console.log(`triage: ${TRIAGE_SINCE} 起已完结单缺初筛戳 ${triage.missing.length}`)
    for (const item of triage.missing) console.log(`  MISSING ${item.taskId}（queue.md:${item.line}）—— 先跑 progress-watch --task ${item.taskId}`)
    for (const item of triage.reviewed) console.log(`  REVIEWED ${item.taskId}（queue.md:${item.line}）needsReview=true（带红结论收单，已知悉）`)
    if (!triage.missing.length) console.log('OK 已完结单都有初筛戳')
  }
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
