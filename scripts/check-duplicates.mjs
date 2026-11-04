#!/usr/bin/env node
/**
 * check-duplicates.mjs — standing invariant: one tool, one implementation.
 *
 * Three ways a second implementation can hide:
 *   1. same basename in two directories (scripts/foo.mjs + test/foo.mjs);
 *   2. different names, same responsibility (registered semantic tools below:
 *      scripts/mesh-dispatch.mjs vs plugins/mesh-waker/bin/dispatch.mjs);
 *   3. a renamed byte-identical copy (content hash), which no name registry sees.
 *
 * A group is allowed only when every non-canonical copy is a thin shell: either
 * <= 30 lines, or a spawnSync/execFileSync forwarder that names another member.
 * The canonical (single implementation) is the one non-shell; two or more
 * non-shells fail.
 *
 * Defaults to the repository this script lives in; --root scans another checkout
 * (so downstream projects can call this implementation instead of copying it).
 *
 * Exit codes: 0 all good, 1 a real duplicate exists, 2 usage error.
 * `--json` prints semanticTools / groups / contentDuplicates with self-describing names.
 */
import { createHash } from 'node:crypto'
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

Checks:
  same basename in two directories
  registered semantic tools (different names, same responsibility)
  renamed byte-identical copies (content hash)

A copy is allowed when it is a thin shell: <= ${SHELL_MAX_LINES} lines, or a
spawnSync/execFileSync forwarder naming another member. Exactly one non-shell
implementation is allowed per tool.

Options:
  --root <dir>   repository to scan (default: the repo this script lives in)
  --json         machine-readable output
  -h, --help     show this help

Exit codes: 0 all good, 1 a real duplicate exists, 2 usage error.`

/**
 * Tools that are one responsibility under different filenames. Registry entry is
 * mandatory: a file that is not registered here is either a genuinely different
 * tool or a renamed copy (caught by the content-hash rule).
 */
const SEMANTIC_TOOLS = [
  {
    name: 'mesh-dispatch',
    reason: '把任务正文派发进本地 DSH 会话并收集回执',
    paths: ['scripts/mesh-dispatch.mjs', 'plugins/mesh-waker/bin/dispatch.mjs', '.worklog/bin/mesh-dispatch.mjs'],
  },
]

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

function namesOther(file, others) {
  const basename = path.posix.basename(file.path)
  for (const other of others) {
    if (other.path === file.path) continue
    if (file.text.includes(other.path)) return true
    const segments = (other.dir ?? path.posix.dirname(other.path)).split('/').filter(Boolean)
    if (segments.length && segments.every((segment) => file.text.includes(`'${segment}'`)) && file.text.includes(basename)) return true
  }
  return false
}

function isShell(file, others) {
  if (!/spawnSync|execFileSync/.test(file.text)) return false
  if (file.lines <= SHELL_MAX_LINES) return true
  // Longer local adapters are still shells when they explicitly forward to another member.
  return namesOther(file, others)
}

/** Pure classification for a registered semantic group. Exported for tests. */
export function semanticStatus(members) {
  if (!members.length) return { ok: true, canonical: null, shells: [], implementations: [], reasons: [] }
  const shells = members.filter((member) => isShell(member, members))
  const implementations = members.filter((member) => !shells.includes(member))
  const ok = implementations.length <= 1
  const reasons = []
  if (!ok) reasons.push(`${implementations.length} 份实现：保留一份，其余改成 ≤${SHELL_MAX_LINES} 行的转发壳或删除`)
  return {
    ok,
    canonical: ok && implementations.length === 1 ? implementations[0].path : null,
    shells: shells.map((member) => member.path),
    implementations: implementations.map((member) => member.path),
    reasons,
  }
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

  const allFiles = collect().map(info)
  const byPath = new Map(allFiles.map((file) => [file.path, file]))

  // 1) registered semantic tools (different names, same responsibility)
  const semanticTools = []
  const semanticPaths = new Set()
  for (const tool of SEMANTIC_TOOLS) {
    const members = tool.paths.map((rel) => byPath.get(rel)).filter(Boolean)
    if (members.length < 2) continue
    for (const member of members) semanticPaths.add(member.path)
    const status = semanticStatus(members)
    semanticTools.push({
      semanticTool: tool.name,
      reason: tool.reason,
      implementations: members.map((member) => ({
        path: member.path,
        lines: member.lines,
        role: status.shells.includes(member.path) ? 'shell' : 'implementation',
      })),
      canonical: status.canonical,
      shells: status.shells,
      reasons: status.reasons,
      ok: status.ok,
    })
  }

  // 2) same basename in different directories (skip members already reported semantically)
  const byName = new Map()
  for (const file of allFiles) {
    if (semanticPaths.has(file.path)) continue
    const base = path.posix.basename(file.path)
    if (!byName.has(base)) byName.set(base, [])
    byName.get(base).push(file)
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

  // 3) renamed byte-identical copies (content hash, different basenames)
  const byHash = new Map()
  for (const file of allFiles) {
    const hash = createHash('sha256').update(file.text.replace(/\r\n/g, '\n')).digest('hex')
    if (!byHash.has(hash)) byHash.set(hash, [])
    byHash.get(hash).push(file)
  }
  const contentDuplicates = []
  for (const [hash, files] of byHash) {
    const basenames = new Set(files.map((file) => path.posix.basename(file.path)))
    if (files.length < 2 || basenames.size < 2) continue
    contentDuplicates.push({
      sha256: hash.slice(0, 16),
      files: files.map((file) => ({ path: file.path, lines: file.lines })),
      ok: false,
      suggestion: `内容完全相同但文件名不同：保留 ${files[0].path}，其余删除或改成转发壳（若是不同工具请登记到 SEMANTIC_TOOLS 并说明判据）`,
    })
  }

  const failed =
    semanticTools.filter((tool) => !tool.ok).length + groups.filter((group) => !group.ok).length + contentDuplicates.length

  if (json) {
    console.log(JSON.stringify({ root: ROOT, semanticTools, groups, contentDuplicates, ok: failed === 0 }, null, 2))
  } else {
    for (const tool of semanticTools) {
      if (tool.ok) {
        console.log(`ok ${tool.semanticTool}：${tool.implementations.length} 份（同职责：${tool.reason}）`)
        for (const member of tool.implementations) {
          const label = member.role === 'shell' ? '壳      ' : '唯一实现'
          console.log(`   ${label} ${member.path}（${member.lines} 行）`)
        }
      } else {
        console.log(`FAIL ${tool.semanticTool}：${tool.implementations.length} 份，${tool.implementations.filter((m) => m.role === 'implementation').length} 份实现`)
        for (const member of tool.implementations) console.log(`   ${member.role === 'shell' ? '壳' : '实现'}  ${member.path}（${member.lines} 行）`)
        for (const reason of tool.reasons) console.log(`   建议：${reason}`)
      }
    }
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
    for (const duplicate of contentDuplicates) {
      console.log(`FAIL 改名副本（内容相同，sha256 ${duplicate.sha256}…）：`)
      for (const file of duplicate.files) console.log(`  - ${file.path}（${file.lines} 行）`)
      console.log(`  建议：${duplicate.suggestion}`)
    }
    if (!semanticTools.length && !groups.length && !contentDuplicates.length) console.log('ok 无重复工具')
  }
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
