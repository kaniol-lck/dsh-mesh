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
 * truth.
 *
 * Rules, deliberately line-scoped (T-mwwfvvzw — v1 of this gate was a false green):
 *
 *   - A call to one of the classifiers is a USE unless it sits on its own declaration line.
 *     Definitions must be allowed or the module could not define them.
 *   - A USE is allowed only when the call line, or the single line immediately above it, carries
 *     `title-identity-allowed: <reason>`. The reason must be non-empty.
 *   - Nothing else exempts a call: no whole-file allowlist, no "somewhere in this function there
 *     is the word fallback". v1 did both, so `index.js` — which holds two real uses — was never
 *     scanned at all, and a 300-line function with one `fallback` comment waved through
 *     everything inside it.
 *
 * Usage:
 *   node scripts/check-no-title-identity.mjs [--json] [--root <dir>] [--help]
 *
 * `--root` exists for the gate's own tests (point it at a fixture tree). CI never passes it.
 * Exit: 0 clean, 1 at least one unexplained use. Read-only: no side effects.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SELF = 'scripts/check-no-title-identity.mjs'
const REPO_ROOT = path.resolve(import.meta.dirname, '..')

/** Classifier calls that turn a title into a judgement. */
const CLASSIFIERS = ['isCoordinatorTitle', 'classifyRoleCandidates', 'titleRoleCandidate']

/** The only thing that excuses a USE: a marker on the call line or the line right above it. */
const MARKER = /title-identity-allowed\s*:\s*(\S.*?)\s*$/i

const SCAN_EXTENSIONS = new Set(['.js', '.mjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

function callRegex(name) {
  // Word-boundary + optional whitespace before the paren. `\b` keeps `notIsCoordinatorTitle(`
  // out, but a definition line legitimately matches and is filtered by isDefinitionLine().
  return new RegExp(`\\b${name}\\s*\\(`)
}

const CALL_PATTERNS = CLASSIFIERS.map((name) => ({ name, re: callRegex(name) }))

function escapeForRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when this line DECLARES the classifier rather than calling it. Covers
 * `function x(`, `export function x(`, `export default function x(`, `async function x(`,
 * and `const x = (` / `const x = async (function)? (`.
 */
function isDefinitionLine(text, name) {
  const n = escapeForRegex(name)
  const patterns = [
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\s*\\(`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\()`),
  ]
  return patterns.some((re) => re.test(text))
}

/** A marker counts only on the call line or on the line directly above it. */
function markerNear(lines, index) {
  const here = MARKER.exec(lines[index] ?? '')
  if (here) return here[1].trim()
  const above = MARKER.exec(lines[index - 1] ?? '')
  if (above) return above[1].trim()
  return null
}

/**
 * Tracks `export { ... }` blocks: an occurrence inside one is a public-surface declaration, not
 * a decision. Returns a predicate for "line index is inside an export list".
 */
function exportListLines(lines) {
  const inside = new Set()
  let open = -1
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]
    if (open < 0) {
      if (/^\s*export\s*\{/.test(text) && !/\}\s*(from\b|$)/.test(text)) open = index
      else if (/^\s*export\s*\{[^}]*\}/.test(text)) inside.add(index)
      continue
    }
    inside.add(index)
    if (/\}/.test(text)) open = -1
  }
  return inside
}

function isCommentOnly(text) {
  const trimmed = text.trim()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}

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

function scanFile(file, root) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { issues: [], definitions: 0, markedUses: 0 }
  }
  const lines = text.split(/\r?\n/)
  const exportLines = exportListLines(lines)
  const issues = []
  let definitions = 0
  let markedUses = 0

  lines.forEach((line, index) => {
    if (isCommentOnly(line)) return
    const hit = CALL_PATTERNS.find((pattern) => pattern.re.test(line))
    if (!hit) return
    if (isDefinitionLine(line, hit.name)) {
      definitions += 1
      return
    }
    if (exportLines.has(index)) {
      definitions += 1
      return
    }
    const reason = markerNear(lines, index)
    if (reason) {
      markedUses += 1
      return
    }
    issues.push({
      file: relative,
      line: index + 1,
      call: hit.name,
      reason: 'title used as identity with no `title-identity-allowed: <reason>` on this line or the one above',
      snippet: line.trim().length > 160 ? `${line.trim().slice(0, 157)}...` : line.trim(),
    })
  })

  return { issues, definitions, markedUses }
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'usage: node scripts/check-no-title-identity.mjs [--json] [--root <dir>]',
        '',
        'A session title is not an identity: it is user-renamable display text. The workspace',
        'registry (coordinators[] / workers{} / roles) is the source of truth.',
        '',
        'This gate flags a CALL to any of:',
        ...CLASSIFIERS.map((name) => `  ${name}(`),
        'unless one of these holds:',
        '  - the line DECLARES that function (function x( / const x = ()',
        '  - the line is inside an `export { ... }` list',
        '  - the call line, or the line directly above it, carries',
        '      title-identity-allowed: <non-empty reason>',
        '',
        'Scoping is deliberately per line. A whole-file exemption, or "the enclosing function',
        'mentions fallback somewhere", both produced a gate that never looked at index.js.',
        '',
        '--root <dir>  scan another tree (the gate\'s own tests use it; CI never does)',
        '--json        same data as the text report, machine readable',
        'Exit: 0 clean, 1 unexplained use(s). Read-only: never writes.',
      ].join('\n'),
    )
    process.exit(0)
  }
  let root = REPO_ROOT
  const rootIndex = argv.indexOf('--root')
  if (rootIndex >= 0) {
    const value = argv[rootIndex + 1]
    if (!value) {
      console.error('check-no-title-identity: --root needs a directory')
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
  let definitions = 0
  let markedUses = 0
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
    definitions += result.definitions
    markedUses += result.markedUses
  }

  const payload = {
    ok: issues.length === 0,
    scanned,
    definitions: `${definitions} declarations/exports`,
    markedUses: `${markedUses} marked uses`,
    unexplainedUses: `${issues.length} unexplained uses`,
    issues,
  }

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2))
    process.exit(issues.length === 0 ? 0 : 1)
  }

  for (const issue of issues) {
    console.log(`${issue.file}:${issue.line}: ${issue.reason}（${issue.call}）`)
    console.log(`  ${issue.snippet}`)
  }
  if (issues.length === 0) {
    console.log(
      `check-no-title-identity: OK（${scanned} files, ${definitions} declarations, ${markedUses} marked uses）`,
    )
    return
  }
  console.log(
    `check-no-title-identity: ${issues.length} unexplained use(s) of ${scanned} files — a title is not an identity; read the registry`,
  )
  process.exit(1)
}

main()
