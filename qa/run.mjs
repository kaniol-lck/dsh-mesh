#!/usr/bin/env node
/**
 * run.mjs — QA 运行器：跑 `spec/*.json` 里定义的规格，出带证据的报告。
 *
 * 用法：
 *   node qa/run.mjs [--json] [--spec <id>] [--list]
 *
 * 行为：
 *   - 读 `qa/spec/*.json`，逐个执行对应 probe（子进程，隔离）；
 *   - 收集 stdout（探针自己输出 JSON 证据）、退出码；
 *   - 报告写 `qa/reports/<YYYY-MM-DD>/<HHmmss>-<tier>.md`，**含证据原文**；
 *   - 任一规格红 → 退出码 1；全部绿 → 0；运行器自身出错 → 2。
 *
 * 独立性（见 charter §4）：作者不得宣布通过；本运行器的输出才是结论。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const QA_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(QA_DIR, '..', '..')
const SPEC_DIR = path.join(QA_DIR, 'spec')

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const listOnly = argv.includes('--list')
const onlyIndex = argv.indexOf('--spec')
const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : null

function loadSpecs() {
  if (!existsSync(SPEC_DIR)) return []
  const specs = []
  for (const file of readdirSync(SPEC_DIR).filter((name) => name.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(path.join(SPEC_DIR, file), 'utf8'))
    for (const spec of parsed.specs ?? []) specs.push({ ...spec, file })
  }
  return specs
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  }
}

function runProbe(spec) {
  const probePaths = spec.probes ?? (spec.probe ? [spec.probe] : [])
  if (probePaths.length === 0) {
    return { exitCode: 2, stdout: '', stderr: 'spec defines no probe(s)', evidence: null, probes: [] }
  }
  const runs = probePaths.map((relative) => {
    const probePath = path.join(QA_DIR, relative)
    if (!existsSync(probePath)) {
      return { probe: relative, exitCode: 2, stdout: '', stderr: `probe not found: ${relative}`, evidence: null }
    }
    const result = spawnSync(process.execPath, [probePath, '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120_000,
    })
    let evidence = null
    try { evidence = JSON.parse(result.stdout || '') } catch { /* probe may print non-JSON */ }
    return {
      probe: relative,
      exitCode: result.status ?? 2,
      stdout: (result.stdout ?? '').slice(0, 4000),
      stderr: (result.stderr ?? '').slice(0, 2000),
      evidence,
    }
  })
  const failed = runs.filter((run) => run.exitCode !== 0)
  return {
    // 一条规格由多个探针共同证明：任一探针红，规格即红。
    exitCode: failed.length === 0 ? 0 : 1,
    stdout: runs.map((run) => run.stdout.trim()).join('\n'),
    stderr: runs.map((run) => run.stderr.trim()).filter(Boolean).join('\n'),
    evidence: runs.map((run) => run.evidence).filter(Boolean),
    probes: runs,
  }
}

function main() {
  const specs = loadSpecs().filter((spec) => (only ? spec.id === only : true))

  if (listOnly) {
    for (const spec of specs) console.log(`${spec.tier.padEnd(3)} ${spec.id}  (${spec.probe})`)
    return 0
  }
  if (specs.length === 0) {
    console.error(only ? `未找到规格：${only}` : '没有可运行的规格')
    return 2
  }

  const results = specs.map((spec) => ({ spec, ...runProbe(spec) }))
  const failed = results.filter((row) => row.exitCode !== 0)
  const { date, time } = stamp()

  const lines = [
    `# QA 报告 ${date} ${time}`,
    '',
    `- 运行器：\`qa/run.mjs\``,
    `- 规格数：${results.length}`,
    `- 结论：${failed.length === 0 ? '**全绿**' : `**判红 ${failed.length} 条**`}`,
    '',
    '| 规格 | tier | 退出码 | 结论 |',
    '|---|---|---|---|',
    ...results.map((row) => `| \`${row.spec.id}\` | ${row.spec.tier} | ${row.exitCode} | ${row.exitCode === 0 ? 'OK' : 'RED'} |`),
    '',
  ]

  for (const row of results) {
    lines.push(`## ${row.exitCode === 0 ? 'OK' : 'RED'} — ${row.spec.id}`, '')
    lines.push(`> ${row.spec.statement}`, '')
    if (row.spec.why) lines.push(`起因：${row.spec.why}`, '')
    for (const probe of row.probes ?? []) {
      lines.push(`### 探针 ${probe.probe} — ${probe.exitCode === 0 ? 'OK' : 'RED'}（退出码 ${probe.exitCode}）`, '')
      lines.push('```json', probe.stdout.trim() || '（空）', '```', '')
      if (probe.stderr.trim()) lines.push('stderr：', '', '```', probe.stderr.trim(), '```', '')
    }
  }

  const reportDir = path.join(QA_DIR, 'reports', date)
  mkdirSync(reportDir, { recursive: true })
  const reportFile = path.join(reportDir, `${time}-${failed.length === 0 ? 'green' : 'red'}.md`)
  writeFileSync(reportFile, `${lines.join('\n')}\n`, 'utf8')

  if (asJson) {
    console.log(JSON.stringify({
      ok: failed.length === 0,
      report: path.relative(REPO, reportFile),
      specs: results.map((row) => ({ id: row.spec.id, tier: row.spec.tier, exitCode: row.exitCode, evidence: row.evidence })),
    }, null, 2))
  } else {
    for (const row of results) {
      const mark = row.exitCode === 0 ? 'OK  ' : 'RED '
      const observed = row.evidence?.observedTitles ? ` observed=${JSON.stringify(row.evidence.observedTitles)}` : ''
      console.log(`${mark} ${row.spec.tier.padEnd(3)} ${row.spec.id}${observed}`)
    }
    console.log(`\n报告：${path.relative(REPO, reportFile)}`)
    console.log(failed.length === 0 ? 'QA: 全绿' : `QA: 判红 ${failed.length} 条`)
  }
  return failed.length === 0 ? 0 : 1
}

process.exitCode = main()
