#!/usr/bin/env node
/**
 * check-changelog.mjs — standing invariant: the three CHANGELOG files share one format.
 *
 * Checked per product (hub/, plugins/mesh-waker/, plugins/mesh-approval/):
 *   1. `CHANGELOG.md` exists and `CHANGES.md` does not;
 *   2. first line `# Changelog`; a description line with the Keep a Changelog link and SemVer;
 *   3. every `##` heading is `## [未发布]` or `## [x.y.z] - YYYY-MM-DD`;
 *   4. released versions strictly decrease and never repeat;
 *   5. each released section has a legal `###` category and at least one bullet;
 *   6. `## [未发布]` may be empty only via an explicit `暂无变更。` line, otherwise it
 *      needs a category heading too.
 *
 * Exit codes: 0 all good, 1 violations (file:line: problem), 2 usage error.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

let ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRODUCTS = ['hub', 'plugins/mesh-waker', 'plugins/mesh-approval']
const CATEGORIES = new Set(['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Known limitations'])
const RELEASED = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/
const USAGE = `check-changelog.mjs — Keep a Changelog rules for the three products

Usage:
  node check-changelog.mjs [--root <dir>] [--json]
  node check-changelog.mjs --help

Exit codes: 0 all good, 1 violations, 2 usage error.`

function parseArgs(argv) {
  const options = { json: false, root: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--root') {
      options.root = argv[index + 1]
      if (options.root === undefined) {
        console.error('--root requires a value\n\n' + USAGE)
        process.exit(2)
      }
      index += 1
    }
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

function compareSemver(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function lintChangelog(text) {
  const problems = []
  const lines = text.split(/\r?\n/)
  const report = (line, message) => problems.push({ line, message })

  if ((lines[0] ?? '').trim() !== '# Changelog') report(1, '首行必须是 "# Changelog"')
  const intro = lines.slice(1, 5).join(' ')
  if (!/keepachangelog\.com/i.test(intro)) report(2, '缺少 Keep a Changelog 链接（https://keepachangelog.com/）')
  if (!/SemVer/i.test(intro)) report(2, '缺少 SemVer 说明')

  let current = null
  let currentStart = 0
  let categories = 0
  let bullets = 0
  let emptyMarker = false
  let lastVersion = null
  const seenVersions = new Set()

  const checkSection = () => {
    if (!current) return
    if (current.kind === 'unreleased') {
      if (categories === 0 && !emptyMarker) report(currentStart, '「未发布」小节必须有分类标题（或写「暂无变更。」）')
      return
    }
    if (categories === 0) report(currentStart, `版本 ${current.version} 没有三级分类标题`)
    if (bullets === 0) report(currentStart, `版本 ${current.version} 没有任何 bullet`)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^## \[未发布\]\s*$/.test(line)) {
      checkSection()
      current = { kind: 'unreleased' }
      currentStart = index + 1
      categories = 0
      bullets = 0
      emptyMarker = false
      continue
    }
    if (/^## 早期版本/.test(line)) {
      // Historical archive below the released list: outside the per-release format.
      checkSection()
      current = null
      break
    }
    if (/^## /.test(line)) {
      checkSection()
      const match = RELEASED.exec(line)
      if (!match) {
        report(index + 1, `二级标题格式非法："${line}"（应为 "## [未发布]" 或 "## [x.y.z] - YYYY-MM-DD"）`)
        current = { kind: 'released', version: null }
        currentStart = index + 1
        categories = 0
        bullets = 0
        emptyMarker = false
        continue
      }
      const version = match[1]
      if (lastVersion !== null && compareSemver(version, lastVersion) >= 0) {
        report(index + 1, `版本顺序错误：${version} 出现在 ${lastVersion} 之后（应新版本在上、严格递减）`)
      }
      if (seenVersions.has(version)) report(index + 1, `版本重复：${version}`)
      seenVersions.add(version)
      lastVersion = version
      current = { kind: 'released', version }
      currentStart = index + 1
      categories = 0
      bullets = 0
      emptyMarker = false
      continue
    }
    if (!current) continue
    const category = /^### (.+)$/.exec(line)
    if (category) {
      const name = category[1].trim()
      if (!CATEGORIES.has(name)) report(index + 1, `非法分类 "${name}"（只允许 ${[...CATEGORIES].join(' / ')}）`)
      else categories += 1
      continue
    }
    if (/^\s*[-*]\s+\S/.test(line)) bullets += 1
    if (/暂无变更/.test(line)) emptyMarker = true
  }
  checkSection()
  return problems
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.root) ROOT = path.resolve(options.root)
  const results = []
  let violations = 0
  for (const product of PRODUCTS) {
    const changelog = path.join(ROOT, product, 'CHANGELOG.md')
    const legacy = path.join(ROOT, product, 'CHANGES.md')
    const entry = { product, file: `${product}/CHANGELOG.md`, missing: false, problems: [] }
    if (existsSync(legacy)) entry.problems.push({ line: 1, message: `${product}/CHANGES.md 仍存在（已统一为 CHANGELOG.md）` })
    if (!existsSync(changelog)) {
      entry.missing = true
      entry.problems.push({ line: 1, message: `MISSING: ${product}/CHANGELOG.md` })
    } else {
      entry.problems.push(...lintChangelog(readFileSync(changelog, 'utf8')))
    }
    violations += entry.problems.length
    results.push(entry)
  }

  if (options.json) {
    console.log(JSON.stringify({ products: results, violations, ok: violations === 0 }, null, 2))
  } else {
    for (const entry of results) {
      if (!entry.problems.length) {
        console.log(`ok ${entry.file}`)
        continue
      }
      for (const problem of entry.problems) console.log(`${entry.file}:${problem.line}: ${problem.message}`)
    }
    if (violations === 0) console.log('ok 三处 CHANGELOG 均符合 Keep a Changelog 规则')
  }
  process.exit(violations ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
