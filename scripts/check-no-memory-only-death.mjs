#!/usr/bin/env node
/**
 * check-no-memory-only-death.mjs — a task is not dead just because this process forgot it.
 *
 * Why this gate exists (T-mwxjfvwn, the third time this class bit us): `reconcileOrphanTasks()`
 * decided a task was `lost` from one fact — the new process had no in-memory handle for the row.
 * That is a statement about MEMORY. The task's fate belongs to the SESSION, and a DSH session is
 * persisted: after a restart it is still there and can still finish the work. T-MWXHO5U1 was
 * declared lost at 12:30:02 with the receipt line "session restarted before this task finished;
 * resend if still needed", while its session was still active at 12:35:39. The receipt was a
 * false statement that cost a real resend.
 *
 * So: code that writes a death verdict (`status: 'lost'`) must show how it knows the task is
 * actually dead — a liveness signal read from the host, or an explicit, reasoned marker.
 *
 * Red when a line assigns `status: 'lost'` (or 'stalled') and the same function body contains no
 * liveness evidence and no marker on/above the line:
 *
 *     // death-allowed: <non-empty reason>
 *
 * Accepted liveness evidence in the same function: `live`, `lastActivityAt`, `turnOpen`,
 * `sessionLive`, `listLocalSessions`, `probeSessions`, `recheckVerdict`, `bootVerdict`.
 *
 * Deliberately line-and-function scoped, and there is NO file allowlist — the previous gate in
 * this repo shipped with a whole-file exemption and never scanned the main entry at all
 * (T-mwwfvvzw). Every exemption here is a marker that sits next to the line it justifies.
 *
 * Usage:
 *   node scripts/check-no-memory-only-death.mjs [--json] [--root <dir>] [--help]
 *
 * `--root` exists for the gate's own tests. Exit: 0 clean, 1 unexplained verdict. Read-only.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SELF = 'scripts/check-no-memory-only-death.mjs'
const REPO_ROOT = path.resolve(import.meta.dirname, '..')

/** A death verdict: the line that puts a row into a terminal "it never happened" state. */
const VERDICT = /status\s*:\s*['"](?:lost|stalled)['"]/

/**
 * A verdict only counts when it is written to a ROW. `buildReceipt({ status: 'lost' })` is the
 * receipt describing a verdict someone else already reached, so flagging it would be noise —
 * and noise is how a gate stops being read. Walk up to the nearest call that owns this object
 * literal and decide from its name.
 */
const ROW_WRITERS = ['updateTaskRow(', 'settleTask(', 'appendTaskRow(']
const RECEIPT_BUILDERS = ['buildReceipt(']

function verdictBelongsToRow(lines, index) {
  for (let cursor = index; cursor >= 0 && cursor > index - 60; cursor -= 1) {
    const text = lines[cursor]
    if (RECEIPT_BUILDERS.some((name) => text.includes(name))) return false
    if (ROW_WRITERS.some((name) => text.includes(name))) return true
  }
  return true // unknown shape: report it rather than silently skip
}

/**
 * Evidence that the verdict was reached from the session's state, not from our memory.
 * Matched with word boundaries: a substring test made "no liveness API yet" inside a comment
 * count as evidence, so a marker with a distant line number silently passed (caught by the
 * gate's own red-check).
 */
const LIVENESS_EVIDENCE = [
  'live',
  'lastActivityAt',
  'turnOpen',
  'sessionLive',
  'listLocalSessions',
  'probeSessions',
  'bootVerdict',
  'recheckVerdict',
  'sessionLooksAlive',
  'sessionAlive',
]

/** Comments must not satisfy the evidence rule: prose is not a liveness check. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => {
      const index = line.indexOf('//')
      return index >= 0 ? line.slice(0, index) : line
    })
    .join('\n')
}

const MARKER = /death-allowed\s*:\s*(\S.*?)\s*$/i

const SCAN_EXTENSIONS = new Set(['.js', '.mjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

function listFiles(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      listFiles(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    out.push(full)
  }
  return out
}

/**
 * The function that owns this line: walk up to the nearest declaration, then brace-match to its
 * end. Brace matching rather than indentation, because verdicts sit inside callbacks and an
 * indentation heuristic stops at the callback instead of the policy (same fix as T-mwwfvvzw).
 */
function enclosingFunction(lines, lineIndex) {
  const isFunctionStart = (text) =>
    /^\s*(export\s+)?(async\s+)?function\b/.test(text) ||
    /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\(|function\b)/.test(text)

  let start = -1
  for (let index = lineIndex; index >= 0; index -= 1) {
    if (isFunctionStart(lines[index])) {
      start = index
      break
    }
  }
  if (start < 0) return { start: 0, end: lines.length - 1 }

  let depth = 0
  let opened = false
  for (let index = start; index < lines.length; index += 1) {
    for (const char of lines[index]) {
      if (char === '{') {
        depth += 1
        opened = true
      } else if (char === '}') {
        depth -= 1
      }
    }
    if (opened && depth <= 0) return { start, end: index }
  }
  return { start, end: lines.length - 1 }
}

/** A marker counts on the verdict line or on the line directly above it. */
function markerNear(lines, index) {
  const here = MARKER.exec(lines[index] ?? '')
  if (here) return here[1].trim()
  const above = MARKER.exec(lines[index - 1] ?? '')
  if (above) return above[1].trim()
  return null
}

function isCommentOnly(text) {
  const trimmed = text.trim()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}

function scanFile(file, root) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { issues: [], verdicts: 0, justified: 0 }
  }
  const lines = text.split(/\r?\n/)
  const issues = []
  let verdicts = 0
  let justified = 0

  lines.forEach((line, index) => {
    if (isCommentOnly(line)) return
    if (!VERDICT.test(line)) return
    if (!verdictBelongsToRow(lines, index)) return
    verdicts += 1
    const marker = markerNear(lines, index)
    if (marker) {
      justified += 1
      return
    }
    const { start, end } = enclosingFunction(lines, index)
    const body = stripComments(lines.slice(start, end + 1).join('\n'))
    const evidence = LIVENESS_EVIDENCE.find((token) => new RegExp(`\\b${token}\\b`).test(body))
    if (evidence) {
      justified += 1
      return
    }
    issues.push({
      file: relative,
      line: index + 1,
      functionLine: start + 1,
      reason:
        'death verdict with no liveness evidence in the same function and no `death-allowed: <reason>` marker — memory is not the session',
      snippet: line.trim().length > 160 ? `${line.trim().slice(0, 157)}...` : line.trim(),
    })
  })

  return { issues, verdicts, justified }
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'usage: node scripts/check-no-memory-only-death.mjs [--json] [--root <dir>]',
        '',
        'A restart makes this process forget a task. It does not make the task dead: a DSH',
        'session is persisted and can still finish the work. T-MWXHO5U1 was declared lost while',
        'its session was still active, and the dispatcher was told to resend a task that was',
        'being worked on.',
        '',
        'Red when a line writes `status: \'lost\'` or `status: \'stalled\'` and neither of these',
        'holds:',
        '  - the enclosing function reads liveness evidence:',
        ...LIVENESS_EVIDENCE.map((token) => `      ${token}`),
        '  - the verdict line, or the line directly above it, carries',
        '      death-allowed: <non-empty reason>',
        '',
        'There is no file-level exemption; every justification sits next to the line it excuses.',
        '',
        '--root <dir>  scan another tree (the gate\'s own tests use it; CI never does)',
        '--json        same data as the text report, machine readable',
        'Exit: 0 clean, 1 unexplained verdict. Read-only: never writes.',
      ].join('\n'),
    )
    process.exit(0)
  }
  let root = REPO_ROOT
  const rootIndex = argv.indexOf('--root')
  if (rootIndex >= 0) {
    const value = argv[rootIndex + 1]
    if (!value) {
      console.error('check-no-memory-only-death: --root needs a directory')
      process.exit(2)
    }
    root = path.resolve(value)
  }
  return { json: argv.includes('--json'), root }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const scanRoot = path.join(options.root, 'plugins', 'mesh-waker')
  const files = listFiles(scanRoot)
  const issues = []
  let scanned = 0
  let verdicts = 0
  let justified = 0
  for (const file of files) {
    const relative = path.relative(options.root, file).split(path.sep).join('/')
    if (relative === SELF) continue
    try {
      if (statSync(file).size === 0) continue
    } catch {
      continue
    }
    scanned += 1
    const result = scanFile(file, options.root)
    issues.push(...result.issues)
    verdicts += result.verdicts
    justified += result.justified
  }

  const payload = {
    ok: issues.length === 0,
    scanned,
    deathVerdicts: `${verdicts} verdict lines`,
    justifiedVerdicts: `${justified} with evidence`,
    unexplainedVerdicts: `${issues.length} unexplained`,
    issues,
  }

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2))
    process.exit(issues.length === 0 ? 0 : 1)
  }

  for (const issue of issues) {
    console.log(`${issue.file}:${issue.line}: ${issue.reason}`)
    console.log(`  ${issue.snippet}`)
    console.log(`  (enclosing function starts at line ${issue.functionLine})`)
  }
  if (issues.length === 0) {
    console.log(
      `check-no-memory-only-death: OK（${scanned} files, ${verdicts} verdict lines, ${justified} with evidence）`,
    )
    return
  }
  console.log(
    `check-no-memory-only-death: ${issues.length} unexplained death verdict(s) — memory is not the session`,
  )
  process.exit(1)
}

main()
