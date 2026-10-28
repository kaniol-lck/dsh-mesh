#!/usr/bin/env node
/**
 * defects.mjs — turn recurring problems into numbers, not more prose.
 *
 * Sources, kept apart on purpose:
 *   - confirmed:  DEFECT: lines in .worklog/WORKLOG.md
 *   - confirmed:  cross-session duplicate pairs marked by scripts/roadmap.mjs --json
 *   - inferred:   WORKLOG lines matching 修复|漂移|坑|失败|超时|不一致 (low confidence, marked "?")
 *   - confirmed:  fail-log-guide's structured records (~/.dsh/**), read-only, as tool-failure
 *
 * Nothing here edits conventions: hitting the threshold only prints READY FOR PATCH.
 *
 * Usage:
 *   node scripts/defects.mjs --scan [--threshold 3] [--repo <path>]
 *   node scripts/defects.mjs --json
 *   node scripts/defects.mjs --taxonomy
 *
 * Exit codes: 0 normal, 2 bad repo root or missing WORKLOG.
 */

import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const TAXONOMY = {
  'encoding-ps51': 'PowerShell 5.1 / 编码：多行文本被收成 [object Object] 或乱码',
  'tool-failure': '工具调用失败：read/edit/pwsh 契约类、任务找不到等',
  'doc-vs-reality': '文档与实现/环境漂移：版本、地址、行为对不上',
  'convention-conflict': '约定自相矛盾，或两份文档并行维护同一规则',
  'dup-todo': '跨会话重复待办（roadmap 标记的疑似重复）',
  'flaky-network': '网络/超时/连接抖动',
  'release-gap': '发布/部署流程缺口：缺 checklist、缺 owner 确认记录',
  other: '暂未归类（人工补词表）',
}

// Inferred trigger keywords (order matters: first match wins).
const KEYWORD_RULES = [
  ['超时', 'flaky-network'],
  ['失败', 'tool-failure'],
  ['不一致', 'doc-vs-reality'],
  ['漂移', 'doc-vs-reality'],
  ['坑', 'convention-conflict'],
  ['修复', 'other'],
]

const SUGGESTIONS = {
  'encoding-ps51': '把「用 Node fetch 派活」写进派活/收尾约定，并给一次失败样例',
  'tool-failure': '补失败重试/换路约定或工具用法示例，减少同类契约错误',
  'doc-vs-reality': '在文档收口清单里加版本/地址核对步骤，并指出核对命令',
  'convention-conflict': '收敛成单一权威页，另一处只留引用',
  'dup-todo': '合并或去重跨会话条目，保留一个归属',
  'flaky-network': '记录换路方案（代理/超时/重试）与判定标准',
  'release-gap': '补发布 checklist，含 owner 确认行与复核命令',
  other: '人工归类后补进词表与关键词映射',
}

const USAGE = `defects.mjs — local defect ledger (writes .worklog/defects.md)

Usage:
  node scripts/defects.mjs --scan [--threshold 3] [--repo <path>]
  node scripts/defects.mjs --json [--threshold 3] [--repo <path>]
  node scripts/defects.mjs --taxonomy

Exit codes: 0 normal, 2 bad repo root or missing .worklog/WORKLOG.md.`

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { mode: 'scan', threshold: 3, repo: process.cwd(), json: false, taxonomy: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = () => {
      const value = argv[index + 1]
      if (value === undefined) fail(2, `${arg} requires a value\n\n${USAGE}`)
      index += 1
      return value
    }
    switch (arg) {
      case '--scan': options.mode = 'scan'; break
      case '--json': options.json = true; break
      case '--taxonomy': options.taxonomy = true; break
      case '--threshold': options.threshold = Number(takeValue()); break
      case '--repo': options.repo = takeValue(); break
      case '-h':
      case '--help':
        console.log(USAGE)
        process.exit(0)
        break
      default:
        fail(2, `unknown argument: ${arg}\n\n${USAGE}`)
    }
  }
  if (!Number.isInteger(options.threshold) || options.threshold < 1) fail(2, '--threshold must be a positive integer')
  return options
}

function nowStamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

async function assertRepo(repo) {
  const agents = await stat(path.join(repo, 'AGENTS.md')).then((info) => info.isFile()).catch(() => false)
  if (!agents) fail(2, `not a dsh-mesh repo root (missing AGENTS.md): ${repo}\npass --repo <repo root>`)
  const todo = await stat(path.join(repo, '.worklog', 'todo')).then((info) => info.isDirectory()).catch(() => false)
  if (!todo) fail(2, `missing .worklog/todo under ${repo}`)
}

function sliceOrQuestion(value) {
  const text = String(value ?? '').trim()
  return text || '?'
}

function dateOf(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? '').trim())
  return match ? match[1] : '?'
}

function parseDefectLine(line) {
  const parts = line.slice('DEFECT:'.length).split('·').map((part) => part.trim())
  return {
    signature: sliceOrQuestion(parts[0]),
    domain: sliceOrQuestion(parts[1]),
    evidence: sliceOrQuestion(parts[2]),
    blocking: sliceOrQuestion(parts[3]),
  }
}

function classifyInferred(line) {
  for (const [keyword, signature] of KEYWORD_RULES) {
    if (line.includes(keyword)) return { keyword, signature }
  }
  return null
}

function makeCollector() {
  const bySignature = new Map()
  const pending = []

  function add(finding) {
    let bucket = bySignature.get(finding.signature)
    if (!bucket) {
      bucket = { signature: finding.signature, count: 0, first: null, last: null, domains: new Set(), confidence: '推断?', evidence: [] }
      bySignature.set(finding.signature, bucket)
    }
    bucket.count += finding.weight ?? 1
    for (const date of [finding.first, finding.last]) {
      if (!date || date === '?') continue
      if (!bucket.first || date < bucket.first) bucket.first = date
      if (!bucket.last || date > bucket.last) bucket.last = date
    }
    if (finding.domain && finding.domain !== '?') bucket.domains.add(finding.domain)
    if (finding.confidence === '确定') bucket.confidence = '确定'
    if (finding.evidence) bucket.evidence.push(`${finding.evidence} ${finding.snippet ?? ''}`.trim())
  }

  return {
    add,
    pending,
    summary() {
      const rows = [...bySignature.values()].sort((left, right) => right.count - left.count || (left.signature < right.signature ? -1 : 1))
      const total = rows.reduce((sum, row) => sum + row.count, 0)
      return { rows, total }
    },
  }
}

function normalizeSignature(raw) {
  return Object.prototype.hasOwnProperty.call(TAXONOMY, raw) ? raw : 'other'
}

async function parseWorklog(worklogPath, collector) {
  const text = await readFile(worklogPath, 'utf8')
  const lines = text.split(/\r?\n/)
  let defectLines = 0
  let inferredLines = 0
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (!line) return
    const evidence = `.worklog/WORKLOG.md:${index + 1}`
    if (line.startsWith('DEFECT:')) {
      defectLines += 1
      const defect = parseDefectLine(line)
      const signature = normalizeSignature(defect.signature)
      if (signature === 'other' && defect.signature !== 'other') {
        collector.pending.push({ raw: defect.signature, evidence, snippet: defect.evidence })
      }
      collector.add({
        signature,
        domain: defect.domain,
        confidence: '确定',
        evidence,
        snippet: defect.evidence === '?' ? '' : defect.evidence,
      })
      return
    }
    const inferred = classifyInferred(line)
    if (!inferred) return
    inferredLines += 1
    const worklogParts = line.split('·').map((part) => part.trim())
    collector.add({
      signature: inferred.signature,
      domain: sliceOrQuestion(worklogParts[1]),
      confidence: '推断?',
      evidence,
      snippet: `[${inferred.keyword}] ${line.slice(0, 60)}`,
      first: dateOf(worklogParts[0]),
      last: dateOf(worklogParts[0]),
    })
    if (inferred.signature === 'other') {
      collector.pending.push({ raw: `inferred:${inferred.keyword}`, evidence, snippet: line.slice(0, 60) })
    }
  })
  return { lines: lines.length, defectLines, inferredLines }
}

async function collectRoadmapDuplicates(repo, collector) {
  const roadmapScript = path.join(repo, 'scripts', 'roadmap.mjs')
  const exists = await stat(roadmapScript).then((info) => info.isFile()).catch(() => false)
  if (!exists) return { available: false }
  let parsed
  try {
    const stdout = execFileSync(process.execPath, [roadmapScript, '--json'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    parsed = JSON.parse(stdout)
  } catch (error) {
    return { available: false, error: error.message }
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  const duplicates = entries.filter((entry) => entry.duplicateOf)
  for (const entry of duplicates) {
    collector.add({
      signature: 'dup-todo',
      domain: entry.owner,
      confidence: '确定',
      evidence: `.worklog/todo/${entry.source}`,
      snippet: `${entry.displayTitle ?? entry.title}（对端 ${entry.duplicateOf}）`,
    })
  }
  return { available: true, duplicates: duplicates.length, hash: parsed.hash }
}

async function listFailLogFiles() {
  const home = os.homedir()
  const skillDir = path.join(home, '.dsh', 'skills', 'fail-log-guide')
  const files = []
  for (const name of ['.failures.json', 'failures.json', 'fail-log.json', 'failures.jsonl', '.failures.jsonl']) {
    const candidate = path.join(skillDir, name)
    if (await stat(candidate).then((info) => info.isFile()).catch(() => false)) files.push(candidate)
  }
  if (files.length) return files
  try {
    const skillsRoot = path.join(home, '.dsh', 'skills')
    for (const name of await readdir(skillsRoot)) {
      if (!/fail[-_]?log/i.test(name)) continue
      const dir = path.join(skillsRoot, name)
      for (const file of await readdir(dir)) {
        if (!/fail/i.test(file) || !/\.(json|jsonl)$/i.test(file)) continue
        files.push(path.join(dir, file))
      }
    }
  } catch {
    /* no fail-log records on this machine */
  }
  return files
}

function recordsFromFailLog(file, raw) {
  if (file.endsWith('.jsonl')) {
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return Object.values(parsed.entries)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') return [parsed]
  } catch {
    /* unsupported shape */
  }
  return []
}

async function collectFailLog(collector) {
  const files = await listFailLogFiles()
  let records = 0
  for (const file of files) {
    const raw = await readFile(file, 'utf8').catch(() => '')
    for (const record of recordsFromFailLog(file, raw)) {
      records += 1
      const count = Number(record.count) > 0 ? Number(record.count) : 1
      const first = dateOf(record.first ?? record.firstSeen ?? record.timestamp)
      const last = dateOf(record.last ?? record.lastSeen ?? record.timestamp ?? record.first ?? record.firstSeen)
      const message = String(record.message ?? record.signature ?? record.tool ?? JSON.stringify(record)).slice(0, 80)
      collector.add({
        signature: 'tool-failure',
        domain: 'tool',
        confidence: '确定',
        evidence: `${path.basename(file)}:${String(record.kind ?? 'entry')}`,
        snippet: message,
        weight: count,
        first,
        last,
      })
    }
  }
  return { files: files.length, records }
}

function renderLedger(generatedAt, total, options, rows, ready, pending) {
  const lines = [
    `<!-- generated: ${generatedAt}; total=${total}; src=worklog+roadmap -->`,
    '# 缺陷台账',
    '',
    `## READY FOR PATCH（≥${options.threshold}）`,
  ]
  if (ready.length === 0) lines.push('（无）')
  for (const row of ready) {
    const evidence = row.evidence[0] ?? '?'
    lines.push(`- ${row.signature}（${row.count}）—— 证据：${evidence}；建议：${SUGGESTIONS[row.signature] ?? '人工判断'}`)
  }
  lines.push('', '## 计数', '| 签名 | 次数 | 首见 | 末见 | 域 | 置信 |', '|---|---|---|---|---|---|')
  for (const row of rows) {
    lines.push(`| ${row.signature} | ${row.count} | ${row.first ?? '?'} | ${row.last ?? '?'} | ${[...row.domains].join(' / ') || '?'} | ${row.confidence} |`)
  }
  lines.push('', '## 待归类')
  if (pending.length === 0) lines.push('（无）')
  for (const item of pending) lines.push(`- ${item.raw}（${item.evidence}）${item.snippet ? `：${item.snippet}` : ''}`)
  return `${lines.join('\n')}\n`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.taxonomy) {
    for (const [signature, description] of Object.entries(TAXONOMY)) console.log(`${signature.padEnd(20)} ${description}`)
    return
  }

  const repo = path.resolve(options.repo)
  await assertRepo(repo)
  const worklogPath = path.join(repo, '.worklog', 'WORKLOG.md')
  const worklogOk = await stat(worklogPath).then((info) => info.isFile()).catch(() => false)
  if (!worklogOk) fail(2, `missing source file: ${worklogPath}`)

  const collector = makeCollector()
  const worklog = await parseWorklog(worklogPath, collector)
  const roadmap = await collectRoadmapDuplicates(repo, collector)
  const failLog = await collectFailLog(collector)
  const { rows, total } = collector.summary()
  const ready = rows.filter((row) => row.count >= options.threshold)
  const generatedAt = nowStamp()

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt,
          repo,
          threshold: options.threshold,
          total,
          sources: { worklog, roadmap, failLog },
          taxonomy: TAXONOMY,
          counts: rows.map((row) => ({
            signature: row.signature,
            count: row.count,
            first: row.first ?? '?',
            last: row.last ?? '?',
            domains: [...row.domains],
            confidence: row.confidence,
            evidence: row.evidence.slice(0, 3),
            ready: row.count >= options.threshold,
          })),
          ready: ready.map((row) => row.signature),
          pending: collector.pending,
        },
        null,
        2,
      ),
    )
    return
  }

  const ledgerPath = path.join(repo, '.worklog', 'defects.md')
  await writeFile(ledgerPath, renderLedger(generatedAt, total, options, rows, ready, collector.pending), 'utf8')
  const readyText = ready.length ? ready.map((row) => `${row.signature}（${row.count}）`).join(' / ') : 'none'
  console.log(`defects: total=${total} · signatures=${rows.length} · READY=${readyText}`)
  console.log(`ledger -> ${ledgerPath}`)
}

main().catch((error) => fail(1, `defects: ${error?.message ?? error}`))
