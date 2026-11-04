#!/usr/bin/env node
/**
 * check-todo-owners.mjs — every `归属：` in .worklog/todo/*.md must be a role slug.
 *
 * The owner field is filtered by in ROADMAP.html, so free-form values (session
 * titles like "mesh · waker", or a sentence accidentally swallowed into the
 * field) split one role into many chips and break the filter.
 *
 * Allowed values come from .worklog/roles.json: waker | docs | hub | ops | 协调.
 * Read-only; --json and text are built from the same violation list.
 * Missing .worklog/todo (CI, fresh clone) prints SKIP and exits 0.
 *
 * Exit codes: 0 all valid or skipped, 1 invalid owner value, 2 usage/config error.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `check-todo-owners.mjs — 归属 must be a role slug

Usage:
  node check-todo-owners.mjs [--todo-dir <dir>] [--roles <file>] [--json] [--help]

Rule:
  Every "归属：<value>" in .worklog/todo/*.md must be one of the slugs listed in
  .worklog/roles.json (default: waker | docs | hub | ops | 协调). Session titles
  such as "mesh · waker" and sentences are rejected: they split ROADMAP.html's
  owner filter.

Options:
  --todo-dir <dir>   directory with todo markdown (default: .worklog/todo)
  --roles <file>     role list (default: .worklog/roles.json)
  --json             machine-readable output
  -h, --help         show this help

Exit codes: 0 valid or skipped, 1 invalid owner value, 2 usage/config error.`

function parseArgs(argv) {
  const options = {
    todoDir: path.join(ROOT, '.worklog', 'todo'),
    roles: path.join(ROOT, '.worklog', 'roles.json'),
    json: false,
  }
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
    if (arg === '--todo-dir') options.todoDir = value()
    else if (arg === '--roles') options.roles = value()
    else if (arg === '--json') options.json = true
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

/** All owner occurrences plus the violations against the allowed slug set. */
export function scanOwners(linesByFile, allowed) {
  const allowedSet = new Set(allowed)
  const violations = []
  let checked = 0
  for (const [file, lines] of Object.entries(linesByFile)) {
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/归属：([^；\n]+)/g)) {
        checked += 1
        const value = match[1].trim()
        if (!allowedSet.has(value)) violations.push({ file, line: index + 1, value })
      }
    })
  }
  return { checked, violations }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.todoDir)) {
    if (options.json) console.log(JSON.stringify({ skipped: true, reason: 'no-todo-dir', ok: true }, null, 2))
    else console.log('SKIP（无 .worklog/todo，CI/新 clone 不适用）')
    process.exit(0)
  }
  if (!existsSync(options.roles)) {
    console.error(`MISSING: ${path.relative(ROOT, options.roles)}（角色表缺失，先创建 {"owners": [...]})`)
    process.exit(2)
  }
  const allowed = JSON.parse(readFileSync(options.roles, 'utf8')).owners
  if (!Array.isArray(allowed) || !allowed.length) {
    console.error(`${path.relative(ROOT, options.roles)} 里没有 owners 数组`)
    process.exit(2)
  }
  const linesByFile = {}
  for (const entry of readdirSync(options.todoDir)) {
    if (!entry.endsWith('.md')) continue
    linesByFile[entry] = readFileSync(path.join(options.todoDir, entry), 'utf8').split(/\r?\n/)
  }
  const { checked, violations } = scanOwners(linesByFile, allowed)
  const report = { rolesFile: path.relative(ROOT, options.roles), allowed, checked, violations, ok: violations.length === 0 }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`归属：${checked} 处，合法 ${checked - violations.length} / 非法 ${violations.length}（允许：${allowed.join(' | ')}）`)
    for (const violation of violations) console.log(`  FAIL ${violation.file}:${violation.line}: 归属：${violation.value}`)
    if (!violations.length) console.log('OK 所有归属值都是角色 slug')
  }
  process.exit(violations.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
