#!/usr/bin/env node
/**
 * check-duplicates.mjs — standing invariant: one tool, one implementation.
 *
 * Scans scripts/, skills/*\/scripts/, plugins/*\/, hub/, test/ and .worklog/bin/
 * for the same basename in two different directories. A group is allowed only
 * when at least one copy is a thin shell: <= 30 lines, forwards through
 * spawnSync/execFileSync, and names another copy (path string or path segments).
 *
 * Exit codes: 0 all groups are shells, 1 a real duplicate exists, 2 usage error.
 * `--json` prints { groups: [{ basename, files, shells, ok, reason }], ok }.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_ROOTS = ['scripts', 'skills', 'plugins', 'hub', 'test', '.worklog/bin']
const EXTENSIONS = new Set(['.mjs', '.js', '.py', '.ps1'])
const SHELL_MAX_LINES = 30

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
  const roots = [
    ...SCAN_ROOTS.filter((root) => root !== 'skills'),
    ...readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `skills/${entry.name}/scripts`)
      .filter((rel) => {
        try {
          return statSync(path.join(ROOT, rel)).isDirectory()
        } catch {
          return false
        }
      }),
  ]
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
  const json = process.argv.includes('--json')
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
    console.log(JSON.stringify({ groups, ok: failed.length === 0 }, null, 2))
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
