#!/usr/bin/env node
/**
 * check-duplicates.mjs — standing invariant: one tool, one implementation.
 *
 * Scans scripts/, skills/*\/scripts/, plugins/*\/, hub/, test/ and .worklog/bin/
 * for the same basename in two different directories. A group is allowed only
 * when at least one copy is a thin shell: <= 30 lines, forwards through
 * spawnSync/execFileSync, and names another copy (path string or path segments).
 *
 * Defaults to the repository this script lives in; --root scans another checkout
 * (so downstream projects can call this implementation instead of copying it).
 *
 * Exit codes: 0 all groups are shells, 1 a real duplicate exists, 2 usage error.
 * `--json` prints { groups: [{ basename, files, shells, ok, reason }], ok }.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

let ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_ROOTS = ['scripts', 'skills', 'plugins', 'hub', 'test', '.worklog/bin']
const EXTENSIONS = new Set(['.mjs', '.js', '.py', '.ps1'])
const SHELL_MAX_LINES = 30
const USAGE = `check-duplicates.mjs — one tool, one implementation

Usage:
  node check-duplicates.mjs [--root <dir>] [--json]

Options:
  --root <dir>   repository to scan (default: the repo this script lives in)
  --json         machine-readable output
  -h, --help     show this help

Exit codes: 0 all groups are thin shells, 1 a real duplicate exists, 2 usage
error (bad --root, unknown flag).`

function parseArgs(argv) {
  const options = { root: null, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
    } else if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined) {
        console.error(`--root requires a value\n\n${USAGE}`)
        process.exit(2)
      }
      options.root = value
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

function walk(relDir, out) {
  const abs = path.join(ROOT, relDir)
  let entries
  try {
    entries = readdirSync(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const rel = `${relDir.split(path.sep).join('/')}/${entry.name}`
    if (entry.isDirectory()) {
      walk(rel, out)
      continue
    }
    if (EXTENSIONS.has(path.extname(entry.name))) out.push(rel)
  }
}

function collect() {
  const roots = [...SCAN_ROOTS.filter((root) => root !== 'skills')]
  try {
    for (const entry of readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const rel = `skills/${entry.name}/scripts`
      try {
        if (statSync(path.join(ROOT, rel)).isDirectory()) roots.push(rel)
      } catch {
        /* skill without scripts/ */
      }
    }
  } catch {
    /* no skills/ */
  }
  const files = []
  for (const root of roots) {
    try {
      if (!statSync(path.join(ROOT, root)).isDirectory()) continue
    } catch {
      continue
    }
    // .worklog/bin is the coordinator's local tool area: only its direct children
    // are part of the mechanism surface (subdirectories are private tooling copies).
    if (root === '.worklog/bin') {
      for (const entry of readdirSync(path.join(ROOT, root), { withFileTypes: true })) {
        if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(root + '/' + entry.name)
      }
      continue
    }
    walk(root, files)
  }
  return files
}

function info(rel) {
  const abs = path.join(ROOT, rel)
  const text = readFileSync(abs, 'utf8')
  return { path: rel, lines: text.split(/\r?\n/).length, text, dir: path.posix.dirname(rel) }
}

function isShell(file, others) {
  if (file.lines > SHELL_MAX_LINES) return false
  if (!/spawnSync|execFileSync/.test(file.text)) return false
  const basename = path.posix.basename(file.path)
  for (const other of others) {
    if (other.path === file.path) continue
    if (file.text.includes(other.path)) return true
    const segments = other.dir.split('/').filter(Boolean)
    if (segments.length && segments.every((segment) => file.text.includes(`'${segment}'`)) && file.text.includes(basename)) return true
  }
  return false
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const json = options.json
  if (options.root) {
    ROOT = path.resolve(options.root)
    let isDir = false
    try {
      isDir = statSync(ROOT).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      console.error(`--root is not a directory: ${ROOT}`)
      process.exit(2)
    }
  }

  const byName = new Map()
  for (const rel of collect()) {
    const base = path.posix.basename(rel)
    if (!byName.has(base)) byName.set(base, [])
    byName.get(base).push(info(rel))
  }

  const groups = []
  for (const [basename, files] of byName) {
    const dirs = new Set(files.map((file) => file.dir))
    if (dirs.size < 2) continue
    const shells = files.filter((file) => isShell(file, files))
    const ok = shells.length > 0
    const group = {
      basename,
      files: files.map((file) => ({ path: file.path, lines: file.lines })),
      shells: shells.map((file) => file.path),
      ok,
    }
    if (!ok) group.suggestion = `保留 ${files[0].path}，删除其余副本，或把其余副本改成 ≤${SHELL_MAX_LINES} 行的 spawnSync 转发壳`
    groups.push(group)
  }

  const failed = groups.filter((group) => !group.ok)
  if (json) {
    console.log(JSON.stringify({ root: ROOT, groups, ok: failed.length === 0 }, null, 2))
  } else {
    for (const group of groups) {
      if (group.ok) {
        const names = group.files.map((file) => `${file.path}(${file.lines} 行)`).join(' + ')
        console.log(`ok ${group.basename}：${group.files.length} 份，壳形态放行（${names}）`)
      } else {
        console.log(`FAIL ${group.basename}：${group.files.length} 份，无壳形态`)
        for (const file of group.files) console.log(`  - ${file.path}（${file.lines} 行）`)
        console.log(`  建议：${group.suggestion}`)
      }
    }
    if (!groups.length) console.log('ok 无同名工具')
  }
  process.exit(failed.length ? 1 : 0)
}

main()
