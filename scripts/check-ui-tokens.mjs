#!/usr/bin/env node
/**
 * check-ui-tokens.mjs — measure raw colours / raw font sizes vs design tokens.
 *
 * Scans (default) plugins/mesh-waker/client.js and hub/server.mjs for:
 *   rawColor     hex literals (#rgb, #rrggbb, #rrggbbaa)
 *   rawFontSize  `fontSize: <number>` or `font-size: <number>px`
 * and counts design-token references `--dsw-*`.
 *
 * Token/theme files (paths named ui-tokens*, theme*, tokens*) are allowed to contain
 * raw values and are skipped entirely.
 *
 * Default is measurement only: exit 0 always. --strict fails when a file exceeds
 * scripts/ui-token-baseline.json; --update-baseline rewrites that file (the only
 * writing mode). Text and --json are built from the same violation list.
 *
 * Exit codes: 0 ok (or measurement), 1 strict violation, 2 usage error.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PATHS = ['plugins/mesh-waker/client.js', 'hub/server.mjs']
const BASELINE = path.join(ROOT, 'scripts', 'ui-token-baseline.json')
const ALLOWED_TOKEN_FILE = /(^|\/)(ui-tokens|theme|tokens)[^/]*$/i
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b/g
const RAW_FONT_SIZE = /fontSize\s*:\s*\d+(?:\.\d+)?\b|font-size\s*:\s*\d+(?:\.\d+)?px\b/g
// A JS vocabulary object (`TOKENS.color.surface`) is the same contract for files that cannot
// import a token module; both forms count as token references.
const JSON_TOKEN_REF = /--dsw-[a-zA-Z0-9_-]+|TOKENS\.[a-zA-Z]+\.[a-zA-Z]+/g
// Declarations between these markers are the vocabulary itself — raw values allowed there.
const UI_TOKEN_REGION = /\/\/ BEGIN UI TOKENS[\s\S]*?\/\/ END UI TOKENS/g
// Raw control construction outside the ui constructors is the second drift source: one shape
// must have one entry point. `h('button', …)` and the multiline `h(\n 'button',` form both count.
const RAW_CONTROL = /\bh\(\s*'(button|input|select|textarea)'/g
const UI_CONTROL_REGION = /\/\/ BEGIN UI CONTROLS[\s\S]*?\/\/ END UI CONTROLS/g
const USAGE = `check-ui-tokens.mjs — raw colour / font-size vs design tokens

Usage:
  node check-ui-tokens.mjs [--paths a,b] [--strict] [--baseline <file>] [--json] [--update-baseline] [--help]

Checks (per file):
  rawColor     hex literal #rgb / #rrggbb / #rrggbbaa
  rawFontSize  "fontSize: <number>" or "font-size: <number>px"
  rawControl   h('button'|'input'|'select'|'textarea') outside the ui constructors
  tokenRef     --dsw-* and TOKENS.x.y references — counted, never a violation
Files named ui-tokens*, theme*, tokens* may contain raw values.
A block between "// BEGIN UI TOKENS" and "// END UI TOKENS" declares the vocabulary and is
exempt from the raw-value counts (line numbers elsewhere stay accurate).
A block between "// BEGIN UI CONTROLS" and "// END UI CONTROLS" is the control vocabulary and
is exempt from rawControl (the constructors themselves must call h('button') etc.).

Options:
  --paths <a,b>       files to scan (default: plugins/mesh-waker/client.js,hub/server.mjs)
  --strict            exit 1 when a file exceeds the baseline (default: measure only, exit 0)
  --baseline <file>   baseline path (default: scripts/ui-token-baseline.json)
  --json              machine-readable output (rawColorCount / distinctColorCount / ...)
  --update-baseline   rewrite the baseline from the current scan (default: no writes)
  -h, --help          show this help

Exit codes: 0 ok/measurement, 1 strict violation, 2 usage error.`

function parseArgs(argv) {
  const options = { paths: DEFAULT_PATHS, strict: false, json: false, updateBaseline: false, baseline: BASELINE }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) {
        console.error(`${arg} requires a value\n\n${USAGE}`)
        process.exit(2)
      }
      index += 1
      return next
    }
    if (arg === '--paths') options.paths = value().split(',').map((item) => item.trim()).filter(Boolean)
    else if (arg === '--strict') options.strict = true
    else if (arg === '--json') options.json = true
    else if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--baseline') options.baseline = value()
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  return options
}

/** Count violations and token refs in one pass so text and JSON cannot diverge. */
export function scanText(text) {
  const violations = []
  let rawColorCount = 0
  let rawFontSizeCount = 0
  let rawControlCount = 0
  let tokenRefCount = 0
  const colors = new Set()
  // A `// BEGIN UI TOKENS` … `// END UI TOKENS` block is the vocabulary itself: the literals
  // inside it are the single source of truth, not drift. Blank the block out but keep its
  // newlines so reported line numbers stay accurate.
  const scannable = text
    .replace(UI_TOKEN_REGION, (block) => block.replace(/[^\n]/g, ''))
    .replace(UI_CONTROL_REGION, (block) => block.replace(/[^\n]/g, ''))
  scannable.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(RAW_COLOR)) {
      rawColorCount += 1
      colors.add(match[0].toLowerCase())
      violations.push({ line: index + 1, kind: 'rawColor', value: match[0] })
    }
    for (const match of line.matchAll(RAW_FONT_SIZE)) {
      rawFontSizeCount += 1
      violations.push({ line: index + 1, kind: 'rawFontSize', value: match[0] })
    }
  })
  for (const match of scannable.matchAll(RAW_CONTROL)) {
    rawControlCount += 1
    violations.push({ line: scannable.slice(0, match.index).split('\n').length, kind: 'rawControl', value: match[0] })
  }
  // Token references: host `--dsw-*` aliases (counted in the whole text, including the
  // declaration block) plus JS vocabulary references like `TOKENS.color.surface`.
  for (const match of text.matchAll(JSON_TOKEN_REF)) tokenRefCount += 1
  return { rawColorCount, rawFontSizeCount, rawControlCount, distinctColorCount: colors.size, tokenRefCount, violations }
}

function relPath(file) {
  const absolute = path.resolve(ROOT, file)
  const relative = path.relative(ROOT, absolute)
  return relative.split(path.sep).join('/')
}

function scanFile(file) {
  const relative = relPath(file)
  if (ALLOWED_TOKEN_FILE.test(relative)) return { path: relative, allowed: true, rawColorCount: 0, rawFontSizeCount: 0, rawControlCount: 0, distinctColorCount: 0, tokenRefCount: 0, violations: [] }
  const absolute = path.resolve(ROOT, file)
  if (!existsSync(absolute)) {
    console.error(`missing file: ${relative}`)
    process.exit(2)
  }
  return { path: relative, allowed: false, ...scanText(readFileSync(absolute, 'utf8')) }
}

function readBaseline(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const files = options.paths.map(scanFile)
  const totals = files.reduce(
    (acc, file) => ({
      rawColorCount: acc.rawColorCount + file.rawColorCount,
      rawFontSizeCount: acc.rawFontSizeCount + file.rawFontSizeCount,
      rawControlCount: acc.rawControlCount + file.rawControlCount,
      tokenRefCount: acc.tokenRefCount + file.tokenRefCount,
    }),
    { rawColorCount: 0, rawFontSizeCount: 0, rawControlCount: 0, tokenRefCount: 0 },
  )
  const allViolations = files.flatMap((file) => file.violations.map((violation) => ({ ...violation, path: file.path })))
  const byLine = new Map()
  for (const violation of allViolations) {
    const key = `${violation.path}:${violation.line}`
    const entry = byLine.get(key) ?? { path: violation.path, line: violation.line, values: [], count: 0 }
    entry.values.push(violation.value)
    entry.count += 1
    byLine.set(key, entry)
  }
  const topSpots = [...byLine.values()].sort((left, right) => right.count - left.count).slice(0, 5)

  if (options.updateBaseline) {
    const body = {
      generatedAt: new Date().toISOString(),
      files: Object.fromEntries(
        files.map((file) => [file.path, { rawColor: file.rawColorCount, rawFontSize: file.rawFontSizeCount, rawControl: file.rawControlCount }]),
      ),
    }
    writeFileSync(options.baseline, JSON.stringify(body, null, 2) + '\n', 'utf8')
    console.log(`baseline updated: ${path.relative(ROOT, options.baseline)} (${files.length} files)`)
    process.exit(0)
  }

  const baseline = readBaseline(options.baseline)
  let exceeded = []
  if (options.strict) {
    if (!baseline) {
      console.error(`--strict needs a baseline: ${path.relative(ROOT, options.baseline)} is missing (run --update-baseline)`)
      process.exit(2)
    }
    for (const file of files) {
      const allowed = baseline.files?.[file.path] ?? { rawColor: 0, rawFontSize: 0, rawControl: 0 }
      if (file.rawColorCount > allowed.rawColor || file.rawFontSizeCount > allowed.rawFontSize || file.rawControlCount > (allowed.rawControl ?? 0)) {
        exceeded.push({
          path: file.path,
          rawColor: file.rawColorCount,
          rawColorBaseline: allowed.rawColor,
          rawFontSize: file.rawFontSizeCount,
          rawFontSizeBaseline: allowed.rawFontSize,
          rawControl: file.rawControlCount,
          rawControlBaseline: allowed.rawControl ?? 0,
        })
      }
    }
  }

  const report = {
    paths: files.map((file) => file.path),
    files: files.map((file) => ({
      path: file.path,
      allowedTokenFile: file.allowed,
      rawColorCount: file.rawColorCount,
      distinctColorCount: file.distinctColorCount,
      rawFontSizeCount: file.rawFontSizeCount,
      rawControlCount: file.rawControlCount,
      tokenRefCount: file.tokenRefCount,
    })),
    totals: { ...totals, distinctColorCount: files.reduce((sum, file) => sum + file.distinctColorCount, 0) },
    topSpots,
    strict: options.strict,
    exceeded,
    ok: exceeded.length === 0,
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const file of files) {
      const name = path.basename(file.path).padEnd(12)
      const color = `裸色 ${file.rawColorCount}（${file.distinctColorCount} 种）`
      const font = `裸字号 ${file.rawFontSizeCount}`
      const control = `裸控件 ${file.rawControlCount}`
      console.log(`${name}${color} / ${font} / ${control}   令牌引用 ${file.tokenRefCount}${file.allowed ? '（令牌文件，跳过）' : ''}`)
    }
    console.log('-'.repeat(60))
    console.log(`合计 裸色 ${totals.rawColorCount} / 裸字号 ${totals.rawFontSizeCount} / 裸控件 ${totals.rawControlCount} / 令牌引用 ${totals.tokenRefCount}`)
    if (topSpots.length) {
      console.log('\n最集中的 5 处：')
      for (const spot of topSpots) console.log(`  ${spot.path}:${spot.line}  ${[...new Set(spot.values)].join(' ')}`)
    }
    if (options.strict) {
      if (!exceeded.length) console.log('\nstrict: OK（未超出基线）')
      else for (const item of exceeded) console.log(`\nstrict: FAIL ${item.path} 裸色 ${item.rawColor}/${item.rawColorBaseline} 裸字号 ${item.rawFontSize}/${item.rawFontSizeBaseline}`)
    }
  }
  process.exit(exceeded.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
