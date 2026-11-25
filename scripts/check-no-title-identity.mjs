#!/usr/bin/env node
/**
 * check-no-title-identity.mjs — keep session titles out of identity decisions.
 *
 * Why this gate exists: on 2026-11-19 `.worklog/WORKLOG.md:594` recorded that `coord-scope`
 * selected sessions by title (`/mesh\s*·\s*协调/`) and reported "0 out of bounds" forever once
 * the session was renamed. Only that one script was fixed. `lib/receipt-flow.mjs` used the same
 * regex, and four days later a long-dead session (`session-7fa21aa4`, title `mesh · 协调`,
 * unarchived) received every unattributed receipt. One fix, one file, no gate — so the class
 * came back. This is the gate.
 *
 * A title is user-renamable and proves nothing. The workspace registry
 * (`~/.dsh/mesh-waker/workspaces.json`: `coordinators[]`, `workers{}`, `roles`) is the source of
 * truth. Titles may still be used for *display* or as an explicitly labelled *fallback* — but a
 * call site that turns a title into an identity must say so in the same function body.
 *
 * Usage:
 *   node scripts/check-no-title-identity.mjs [--json] [--help]
 *
 * Exit: 0 clean, 1 at least one unexplained call site.
 * Zero side effects: reads only, never writes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SELF = 'scripts/check-no-title-identity.mjs'
const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_ROOT = path.join(ROOT, 'plugins', 'mesh-waker')
const SCAN_EXTENSIONS = new Set(['.js', '.mjs'])

/**
 * The functions that turn a title into a judgement. Matching one of these by name is the red
 * signal; the allow markers below decide whether that particular call site is legitimate.
 */
const TITLE_IDENTITY_CALLS = ['isCoordinatorTitle(', 'classifyRoleCandidates(', 'titleRoleCandidate(']

/**
 * A call site is allowed when its enclosing function body (or the comment block directly above
 * it) contains one of these markers. Each marker has a meaning, not just a spelling:
 *
 *   accounting  — the title is only *counted/reported*, never used to pick a session.
 *   display     — the title is rendered for a human; the value never feeds a decision.
 *   fallback    — the title is the LAST resort, reached only after the registry had nothing to
 *                 say, and the caller logs that it took this path.
 */
const ALLOW_MARKERS = ['accounting', 'display', 'fallback']

/**
 * Whole-file allowlist. Every entry needs a one-line reason; a silent exemption would defeat the
 * gate. Keys are repo-relative POSIX paths.
 */
const FILE_ALLOWLIST = new Map([
  // The module that DEFINES the title classifiers. It has to name them; the gate would otherwise
  // flag its own definition site and the exports list.
  ['plugins/mesh-waker/lib/session.mjs', 'defines titleRoleCandidate/isCoordinatorTitle/classifyRoleCandidates'],
  // The plugin entry re-exports those helpers for compatibility (a public API surface, not a use).
  ['plugins/mesh-waker/index.js', 're-exports the helpers on the public surface; individual uses are checked'],
])

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
      if (entry.name === 'node_modules' || entry.name === '.git') continue
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
 * Find the enclosing function of `lineIndex` and return its 1..n line range, so the caller can
 * inspect the whole body for an allow marker.
 *
 * Brace matching, not indentation: a title call often sits inside a multi-line `.filter(...)`
 * callback, and an indentation heuristic stops at the callback instead of the function that owns
 * the policy (that produced a false positive on receipt-flow's documented fallback).
 */
function enclosingBlock(lines, lineIndex) {
  const isFunctionStart = (text) =>
    /^\s*(export\s+)?(async\s+)?function\b/.test(text) ||
    /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/.test(text) ||
    /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?function\b/.test(text)

  let start = -1
  for (let index = lineIndex; index >= 0; index -= 1) {
    if (isFunctionStart(lines[index])) {
      start = index
      break
    }
  }
  if (start < 0) return { start: Math.max(0, lineIndex - 3), end: lineIndex + 3 }

  // Count braces from the opening line to its match, ignoring braces in string/comment tails is
  // unnecessary here: the scan only needs a conservative outer bound.
  let depth = 0
  let opened = false
  for (let index = start; index < lines.length; index += 1) {
    const text = lines[index]
    for (const char of text) {
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

function commentBlockAbove(lines, start) {
  const collected = []
  for (let index = start - 1; index >= 0; index -= 1) {
    const text = lines[index].trim()
    if (!text) {
      if (collected.length) break
      continue
    }
    if (text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')) {
      collected.push(text)
      continue
    }
    break
  }
  return collected.reverse().join('\n')
}

function scanFile(file) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = text.split(/\r?\n/)
  const hits = []
  lines.forEach((line, index) => {
    // Ignore pure comment lines: prose about titles is documentation, not a decision.
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
    const call = TITLE_IDENTITY_CALLS.find((name) => line.includes(name))
    if (!call) return
    const { start, end } = enclosingBlock(lines, index)
    const body = lines.slice(start, end + 1).join('\n')
    const context = `${commentBlockAbove(lines, start)}\n${body}`.toLowerCase()
    const marker = ALLOW_MARKERS.find((name) => context.includes(name))
    if (marker) return
    hits.push({
      file: relative,
      line: index + 1,
      call: call.replace('(', ''),
      reason: 'title used as identity without an accounting/display/fallback marker in the same block',
      snippet: trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed,
    })
  })
  return hits
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'usage: node scripts/check-no-title-identity.mjs [--json]',
        '',
        'Scans plugins/mesh-waker/**/*.{js,mjs} for identity decisions made from a session title.',
        '',
        'Red when a line calls one of:',
        ...TITLE_IDENTITY_CALLS.map((name) => `  ${name}…)`),
        'and the enclosing function (or the comment directly above it) contains none of:',
        ...ALLOW_MARKERS.map((name) => `  ${name}`),
        '',
        'Marker meanings:',
        '  accounting  the title is only counted/reported, never used to pick a session',
        '  display     the title is rendered for a human; it feeds no decision',
        '  fallback    the title is the last resort after the registry said nothing, and the',
        '              caller logs that it took this path',
        '',
        'File-level exemptions live in FILE_ALLOWLIST and each carries a reason.',
        'Exit: 0 clean, 1 hits. Read-only: never writes.',
      ].join('\n'),
    )
    process.exit(0)
  }
  return { json: argv.includes('--json') }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const files = listFiles(SCAN_ROOT)
  const issues = []
  let scanned = 0
  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/')
    if (relative === SELF) continue
    if (FILE_ALLOWLIST.has(relative)) continue
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (size === 0) continue
    scanned += 1
    issues.push(...scanFile(file))
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: issues.length === 0, scanned, allowedFiles: [...FILE_ALLOWLIST.keys()], issues }, null, 2))
    process.exit(issues.length === 0 ? 0 : 1)
  }

  for (const issue of issues) {
    console.log(`${issue.file}:${issue.line}: ${issue.reason}（${issue.call}）`)
    console.log(`  ${issue.snippet}`)
  }
  if (issues.length === 0) {
    console.log(`check-no-title-identity: OK（${scanned} files）`)
    return
  }
  console.log(`check-no-title-identity: ${issues.length} hit(s) — a title is not an identity; read the registry`)
  process.exit(1)
}

main()
