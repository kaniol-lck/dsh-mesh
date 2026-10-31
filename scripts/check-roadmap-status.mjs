#!/usr/bin/env node
/**
 * check-roadmap-status.mjs — standing invariant: the hand-written ROADMAP summary
 * must not contradict the mechanical gate results.
 *
 * Declared  = the "本阶段焦点" paragraph of ../ROADMAP.md: "八关口 **N 个达成**（G1 … / …）"
 * Actual    = gates[] from the worklog roadmap (spawned, or supplied via --gates-json)
 *
 * Exit codes: 0 consistent or no ROADMAP (SKIP), 1 mismatch, 2 usage error.
 * `--json` prints { declared:{count,ids}, actual:{count,ids}, ok }.
 *
 * Tests use --roadmap / --gates-json so they never touch the real repository files.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = {
    roadmap: path.resolve(ROOT, '..', 'ROADMAP.md'),
    gatesJson: null,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) {
        console.error(`${arg} requires a value`)
        process.exit(2)
      }
      index += 1
      return next
    }
    switch (arg) {
      case '--roadmap': options.roadmap = value(); break
      case '--gates-json': options.gatesJson = value(); break
      case '--json': options.json = true; break
      case '-h':
      case '--help':
        console.log('check-roadmap-status.mjs [--roadmap <file>] [--gates-json <file>] [--json]')
        process.exit(0)
        break
      default:
        console.error(`unknown argument: ${arg}`)
        process.exit(2)
    }
  }
  return options
}

/** Extract the 本阶段焦点 section (until the next top-level heading). */
export function focusSection(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+本阶段焦点/.test(line.trim()))
  if (start < 0) return null
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break
    body.push(lines[index])
  }
  return body.join('\n')
}

/** Declared status: a count plus the gate ids listed in the 达成 parenthesis. */
export function parseDeclared(text) {
  const section = focusSection(text)
  if (!section) return { count: null, ids: [], found: false }
  const countMatch = /(\d+)\s*个达成/.exec(section)
  if (!countMatch) return { count: null, ids: [], found: false }
  const count = Number(countMatch[1])
  // first parenthesis after the count phrase holds the gate list
  const after = section.slice(countMatch.index)
  const paren = /（([^）]*)）/.exec(after)
  const ids = paren ? [...new Set([...paren[1].matchAll(/\bG(\d+)\b/g)].map((match) => `G${match[1]}`))] : []
  return { count, ids, found: true }
}

export function compare(declared, actualIds) {
  const declaredSet = new Set(declared.ids)
  const actualSet = new Set(actualIds)
  const extraInDeclared = [...declaredSet].filter((id) => !actualSet.has(id))
  const missingInDeclared = [...actualSet].filter((id) => !declaredSet.has(id))
  const countOk = declared.count === actualSet.size
  const setsOk = extraInDeclared.length === 0 && missingInDeclared.length === 0
  return { ok: countOk && setsOk, countOk, extraInDeclared, missingInDeclared }
}

function loadActual(options) {
  if (options.gatesJson) {
    const model = JSON.parse(readFileSync(options.gatesJson, 'utf8'))
    const gates = Array.isArray(model) ? model : model.gates
    return gates.filter((gate) => gate.satisfied === true).map((gate) => gate.id)
  }
  // --no-checks: this script itself runs as one of the gate checks, so the nested
  // roadmap call must not run checks again (it would recurse until the timeout).
  // Gate status therefore uses the cached check results from the last --check run.
  const child = spawnSync(
    process.execPath,
    [path.join(ROOT, 'skills/worklog/scripts/roadmap.mjs'), '--json', '--no-checks', '--worklog-dir', path.join(ROOT, '.worklog'), '--gates', path.join(ROOT, '.worklog/gates.json')],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (child.status !== 0) throw new Error('roadmap --json failed: ' + String(child.stderr ?? '').slice(0, 400))
  const model = JSON.parse(child.stdout)
  return model.gates.filter((gate) => gate.satisfied === true).map((gate) => gate.id)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.roadmap)) {
    if (options.json) console.log(JSON.stringify({ skipped: true, reason: 'no-roadmap', ok: true }, null, 2))
    else console.log('SKIP（无仓外 ROADMAP）')
    process.exit(0)
  }
  const declared = parseDeclared(readFileSync(options.roadmap, 'utf8'))
  const actualIds = loadActual(options).sort()
  const actual = { count: actualIds.length, ids: actualIds }
  if (!declared.found) {
    const report = { declared: { count: null, ids: [] }, actual, ok: false, reason: 'no-declaration' }
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else console.log('MISMATCH 本阶段焦点里找不到「N 个达成」声明；请补写或修正格式')
    process.exit(1)
  }
  const result = compare({ count: declared.count, ids: [...new Set(declared.ids)].sort() }, actualIds)
  const report = {
    declared: { count: declared.count, ids: [...new Set(declared.ids)].sort() },
    actual,
    ok: result.ok,
  }
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`ROADMAP 手写：${declared.count} 个达成（${report.declared.ids.join(',') || '—'}）`)
    console.log(`gates.json：${actual.count} 个达成（${actual.ids.join(',') || '—'}）`)
    if (result.ok) console.log('OK 一致')
    else {
      const parts = []
      if (!result.countOk) parts.push(`手写 ${declared.count} 个 / 实际 ${actual.count} 个`)
      if (result.extraInDeclared.length) parts.push(`手写多出：${result.extraInDeclared.join(',')}`)
      if (result.missingInDeclared.length) parts.push(`手写缺少：${result.missingInDeclared.join(',')}`)
      console.log(`MISMATCH ${parts.join('；')}`)
    }
  }
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
