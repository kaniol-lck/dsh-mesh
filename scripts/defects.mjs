#!/usr/bin/env node
/**
 * defects.mjs — local defect ledger: count recurring problems, never edit conventions.
 *
 * Counting lanes are kept separate on purpose:
 *   confirmed (can make READY):  DEFECT: lines in .worklog/WORKLOG.md
 *                                + cross-session duplicate pairs from scripts/roadmap.mjs --json
 *   inferred (never READY):      WORKLOG lines matching 修复|漂移|坑|失败|超时|不一致, marked "?"
 *   reference (never READY):     fail-log-guide records, only with --with-fail-log,
 *                                deduped by normalized error text
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
  'tool-failure': '工具调用失败（统计归 fail-log-guide，默认不纳入台账）',
  'doc-vs-reality': '文档与实现/环境漂移：版本、地址、行为对不上',
  'convention-conflict': '约定自相矛盾，或两份文档并行维护同一规则',
  'dup-todo': '跨会话重复待办（roadmap 标记的疑似重复对）',
  'flaky-network': '网络/超时/连接抖动（推断源，仅供参考）',
  'release-gap': '发布/部署流程缺口：缺 checklist、缺 owner 确认记录',
  other: '暂未归类（人工补词表）',
}

// Inferred trigger keywords (order matters: first match wins). These never decide READY.
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
  'tool-failure': '归 fail-log-guide 统计；台账只参考，不要据此改约定',
  'doc-vs-reality': '在文档收口清单里加版本/地址核对步骤，并指出核对命令',
  'convention-conflict': '收敛成单一权威页，另一处只留引用',
  'dup-todo': '合并或去重跨会话条目，保留一个归属',
  'flaky-network': '记录换路方案（代理/超时/重试）与判定标准',
  'release-gap': '补发布 checklist，含 owner 确认行与复核命令',
  other: '人工归类后补进词表与关键词映射',
}

const USAGE = `defects.mjs — local defect ledger (writes .worklog/defects.md)

Usage:
  node scripts/defects.mjs --scan [--threshold 3] [--with-fail-log] [--repo <path>]
  node scripts/defects.mjs --json [--threshold 3] [--with-fail-log] [--repo <path>]
  node scripts/defects.mjs --taxonomy

READY is decided by confirmed sources only (DEFECT: lines + duplicate pairs).
fail-log-guide records are reference material, only read with --with-fail-log.

Exit codes: 0 normal, 2 bad repo root or missing .worklog/WORKLOG.md.`

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { mode: 'scan', threshold: 3, repo: process.cwd(), json: false, taxonomy: false, withFailLog: false }
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
      case '--with-fail-log': options.withFailLog = true; break
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
  return String(value ?? '').trim() || '?'
}

function dateOf(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? '').trim())
  return match ? match[1] : '?'
}

function normalizeTitle(title) {
  return title
    .replace(/（需[^）]*）/g, '')
    .replace(/\(需[^)]*\)/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
}

function bigrams(text) {
  const counts = new Map()
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

function dice(left, right) {
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
  const a = bigrams(left)
  const b = bigrams(right)
  let overlap = 0
  let total = 0
  for (const [gram, count] of a) {
    total += count
    const other = b.get(gram)
    if (other !== undefined) overlap += Math.min(count, other)
  }
  for (const count of b.values()) total += count
  return total === 0 ? 0 : (2 * overlap) / total
}

function createCollector() {
  const buckets = new Map()
  const pending = []
  return {
    pending,
    add(finding) {
      let bucket = buckets.get(finding.signature)
      if (!bucket) {
        bucket = { signature: finding.signature, count: 0, first: null, last: null, domains: new Set(), evidence: [] }
        buckets.set(finding.signature, bucket)
      }
      bucket.count += 1
      for (const date of [finding.first, finding.last]) {
        if (!date || date === '?') continue
        if (!bucket.first || date < bucket.first) bucket.first = date
        if (!bucket.last || date > bucket.last) bucket.last = date
      }
      if (finding.domain && finding.domain !== '?') bucket.domains.add(finding.domain)
      if (finding.evidence) bucket.evidence.push(`${finding.evidence} ${finding.snippet ?? ''}`.trim())
    },
    rows() {
      return [...buckets.values()].sort((left, right) => right.count - left.count || (left.signature < right.signature ? -1 : 1))
    },
    total() {
      return [...buckets.values()].reduce((sum, bucket) => sum + bucket.count, 0)
    },
  }
}

function normalizeSignature(raw) {
  return Object.prototype.hasOwnProperty.call(TAXONOMY, raw) ? raw : 'other'
}

async function parseWorklog(worklogPath, confirmed, inferred) {
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
      const parts = line.slice('DEFECT:'.length).split('·').map((part) => part.trim())
      const rawSignature = sliceOrQuestion(parts[0])
      const signature = normalizeSignature(rawSignature)
      if (signature === 'other' && rawSignature !== 'other') {
        confirmed.pending.push({ raw: rawSignature, evidence, snippet: sliceOrQuestion(parts[2]) })
      }
      confirmed.add({ signature, domain: sliceOrQuestion(parts[1]), evidence, snippet: sliceOrQuestion(parts[2]) })
      return
    }
    const match = KEYWORD_RULES.find(([keyword]) => line.includes(keyword))
    if (!match) return
    inferredLines += 1
    const [keyword, signature] = match
    const worklogParts = line.split('·').map((part) => part.trim())
    inferred.add({
      signature,
      domain: sliceOrQuestion(worklogParts[1]),
      evidence,
      snippet: `[${keyword}] ${line.slice(0, 60)}`,
      first: dateOf(worklogParts[0]),
      last: dateOf(worklogParts[0]),
    })
    if (signature === 'other') inferred.pending.push({ raw: `inferred:${keyword}`, evidence, snippet: line.slice(0, 60) })
  })
  return { defectLines, inferredLines }
}

async function todoFileDate(repo, file) {
  const full = path.join(repo, '.worklog', 'todo', file)
  try {
    const info = await stat(full)
    return info.mtime.toISOString().slice(0, 10)
  } catch {
    return '?'
  }
}

async function collectRoadmapDuplicates(repo, confirmed) {
  const roadmapScript = path.join(repo, 'scripts', 'roadmap.mjs')
  const exists = await stat(roadmapScript).then((info) => info.isFile()).catch(() => false)
  if (!exists) return { available: false, pairs: 0 }
  let parsed
  try {
    const stdout = execFileSync(process.execPath, [roadmapScript, '--json'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    parsed = JSON.parse(stdout)
  } catch (error) {
    return { available: false, pairs: 0, error: error.message }
  }
  const marked = (Array.isArray(parsed.entries) ? parsed.entries : []).filter((entry) => entry.duplicateOf)
  // roadmap marks both sides of a pair; walk them greedily and count each pair once.
  const used = new Set()
  const pairs = []
  for (let i = 0; i < marked.length; i += 1) {
    if (used.has(i)) continue
    let best = -1
    let bestScore = 0
    for (let j = i + 1; j < marked.length; j += 1) {
      if (used.has(j) || marked[j].file === marked[i].file) continue
      const score = dice(normalizeTitle(marked[i].displayTitle ?? marked[i].title), normalizeTitle(marked[j].displayTitle ?? marked[j].title))
      if (score > bestScore) {
        bestScore = score
        best = j
      }
    }
    used.add(i)
    if (best >= 0 && bestScore >= 0.5) {
      used.add(best)
      pairs.push([marked[i], marked[best]])
    } else {
      // A one-sided mark (counterpart edited away): still count it, don't fabricate a pair.
      pairs.push([marked[i], null])
    }
  }
  for (const pair of pairs) {
    const [left, right] = pair
    if (!right) {
      confirmed.add({
        signature: 'dup-todo',
        domain: left.owner,
        evidence: `${left.file}:${left.line}（对端已不一致）`,
        snippet: left.displayTitle ?? left.title,
        first: await todoFileDate(repo, left.file),
        last: await todoFileDate(repo, left.file),
      })
      continue
    }
    const first = await todoFileDate(repo, left.file)
    const last = await todoFileDate(repo, right.file)
    const domain = left.owner === right.owner ? left.owner : `${left.owner}/${right.owner}`
    confirmed.add({
      signature: 'dup-todo',
      domain,
      evidence: `${left.file}:${left.line} + ${right.file}:${right.line}`,
      snippet: `${left.displayTitle ?? left.title} ↔ ${right.displayTitle ?? right.title}`,
      first,
      last,
    })
  }
  return { available: true, marked: marked.length, pairs: pairs.length }
}

// Coarse failure signatures: same kind of failure counts once, no matter which path/id it names.
const FAILURE_SIGNATURE_RULES = [
  ['file-contract', /file has not been read|file changed since it was read|old_string was not found|old_string and new_string must differ|read the file, then retry/],
  ['file-io', /cannot read .*not found|cannot read .*binary|offset .*out of range|cannot edit .*not found|is out of range/],
  ['sandbox', /sandbox: file access denied|SetNamedSecurityInfoW/],
  ['mesh-session', /unknown or expired session|unknown tool "mcp__mesh/],
  ['network', /fetch failed|POSTing to endpoint|timed out|tool call aborted|private-ip|non-public IP/],
  ['search', /search failed|Exa anonymous|exceeded .* bytes/],
  ['image', /image:|Unsupported or malformed image/],
  ['plugin', /Cordis|rejected input|not a declared property/],
  ['team', /Team member limit/],
  ['job', /unknown job/],
]

function normalizeFailureText(message) {
  return String(message)
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/[^\s"']+/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

function classifyFailureSignature(message) {
  const normalized = normalizeFailureText(message)
  for (const [signature, pattern] of FAILURE_SIGNATURE_RULES) {
    if (pattern.test(normalized) || pattern.test(String(message))) return signature
  }
  return `other:${normalized.slice(0, 48)}`
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

async function collectFailLog() {
  const files = await listFailLogFiles()
  const signatures = new Map()
  let records = 0
  for (const file of files) {
    const raw = await readFile(file, 'utf8').catch(() => '')
    for (const record of recordsFromFailLog(file, raw)) {
      records += 1
      const occurrences = Number(record.count) > 0 ? Number(record.count) : 1
      const message = String(record.message ?? record.signature ?? record.tool ?? JSON.stringify(record))
      const signature = classifyFailureSignature(message)
      let entry = signatures.get(signature)
      if (!entry) {
        entry = { signature, occurrences: 0, first: '?', last: '?', sample: message.replace(/\s+/g, ' ').slice(0, 100) }
        signatures.set(signature, entry)
      }
      entry.occurrences += occurrences
      for (const date of [dateOf(record.first ?? record.firstSeen), dateOf(record.last ?? record.lastSeen)]) {
        if (date === '?') continue
        if (entry.first === '?' || date < entry.first) entry.first = date
        if (entry.last === '?' || date > entry.last) entry.last = date
      }
    }
  }
  const rows = [...signatures.values()].sort((left, right) => right.occurrences - left.occurrences)
  return { files: files.length, records, signatureCount: rows.length, occurrences: rows.reduce((sum, row) => sum + row.occurrences, 0), rows }
}

function renderLedger(generatedAt, totals, options, confirmedRows, inferredRows, confirmedPending, inferredPending, failLog) {
  const lines = [
    `<!-- generated: ${generatedAt}; confirmed=${totals.confirmed}; inferred=${totals.inferred} -->`,
    '# 缺陷台账',
    '',
    `共 ${totals.confirmed + totals.inferred} 条（确定 ${totals.confirmed} + 推断 ${totals.inferred}，推断不计入 READY）`,
    '',
    `## READY FOR PATCH（≥${options.threshold}，只看确定源）`,
  ]
  const ready = confirmedRows.filter((row) => row.count >= options.threshold)
  if (ready.length === 0) lines.push('（无）')
  for (const row of ready) {
    const evidence = row.evidence[0] ?? '?'
    lines.push(`- ${row.signature}（${row.count}）—— 证据：${evidence}；建议：${SUGGESTIONS[row.signature] ?? '人工判断'}`)
  }
  lines.push('', '## 计数', '| 签名 | 次数 | 首见 | 末见 | 域 | 置信 |', '|---|---|---|---|---|---|')
  for (const row of [...confirmedRows, ...inferredRows].sort((left, right) => right.count - left.count || (left.signature < right.signature ? -1 : 1))) {
    const confidence = confirmedRows.includes(row) ? '确定' : '推断?'
    lines.push(`| ${row.signature} | ${row.count} | ${row.first ?? '?'} | ${row.last ?? '?'} | ${[...row.domains].join(' / ') || '?'} | ${confidence} |`)
  }
  if (options.withFailLog) {
    lines.push('', '## 工具失败（参考，不计入 READY）')
    if (failLog.signatureCount === 0) lines.push('（无 fail-log-guide 记录）')
    for (const row of failLog.rows) lines.push(`- ${row.signature}（occurrences=${row.occurrences}，首见 ${row.first}／末见 ${row.last}）—— 例：${row.sample}`)
  }
  lines.push('', '## 待归类')
  const pending = [...confirmedPending, ...inferredPending]
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

  const confirmed = createCollector()
  const inferred = createCollector()
  const worklog = await parseWorklog(worklogPath, confirmed, inferred)
  const roadmap = await collectRoadmapDuplicates(repo, confirmed)
  const failLog = options.withFailLog ? await collectFailLog() : null
  const confirmedRows = confirmed.rows()
  const inferredRows = inferred.rows()
  const totals = { confirmed: confirmed.total(), inferred: inferred.total() }
  const generatedAt = nowStamp()

  if (options.json) {
    const ready = confirmedRows.filter((row) => row.count >= options.threshold)
    console.log(
      JSON.stringify(
        {
          generatedAt,
          repo,
          threshold: options.threshold,
          withFailLog: options.withFailLog,
          totals: { confirmed: totals.confirmed, inferred: totals.inferred, total: totals.confirmed + totals.inferred },
          confirmed: {
            count: totals.confirmed,
            defectLines: worklog.defectLines,
            dupPairs: roadmap.pairs ?? 0,
            ready: ready.map((row) => row.signature),
            rows: confirmedRows.map((row) => ({
              signature: row.signature,
              count: row.count,
              first: row.first ?? '?',
              last: row.last ?? '?',
              domains: [...row.domains],
              evidence: row.evidence.slice(0, 3),
            })),
          },
          inferred: {
            count: totals.inferred,
            lines: worklog.inferredLines,
            rows: inferredRows.map((row) => ({
              signature: row.signature,
              count: row.count,
              first: row.last ?? '?',
              domains: [...row.domains],
              evidence: row.evidence.slice(0, 3),
            })),
            pending: inferred.pending,
          },
          ready: ready.map((row) => row.signature),
          pending: [...confirmed.pending, ...inferred.pending],
          toolFailures: failLog
            ? { signatureCount: failLog.signatureCount, occurrences: failLog.occurrences, rows: failLog.rows }
            : null,
        },
        null,
        2,
      ),
    )
    return
  }

  const ledgerPath = path.join(repo, '.worklog', 'defects.md')
  const ledger = renderLedger(generatedAt, totals, options, confirmedRows, inferredRows, confirmed.pending, inferred.pending, failLog)
  await writeFile(ledgerPath, ledger, 'utf8')
  const ready = confirmedRows.filter((row) => row.count >= options.threshold)
  const readyText = ready.length ? ready.map((row) => `${row.signature}（${row.count}）`).join(' / ') : 'none'
  console.log(`defects: confirmed=${totals.confirmed}（DEFECT ${worklog.defectLines} 条 + dup-todo ${roadmap.pairs ?? 0} 对）· inferred=${totals.inferred} · READY=${readyText}`)
  if (failLog) console.log(`fail-log: signatures=${failLog.signatureCount}（occurrences=${failLog.occurrences}，参考，不进 READY）`)
  console.log(`ledger -> ${ledgerPath}`)
}

main().catch((error) => fail(1, `defects: ${error?.message ?? error}`))
