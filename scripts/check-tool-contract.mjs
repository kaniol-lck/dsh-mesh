#!/usr/bin/env node
/**
 * check-tool-contract.mjs — 让工具契约页保持「高效、不过期、覆盖真实失败」。
 *
 * 检查四件事：
 *   1) 结构：docs/tool-contract.md 必含 5 个章节，且 ≤160 行；
 *   2) 时效：`维护：YYYY-MM-DD` 不超过 120 天；
 *   3) 引用：AGENTS.md 指向契约页；skills/mesh/SKILL.md 写全工具名 + 自发送边界；
 *   4) 覆盖：失败台账（fail-log-guide/.failures.json）里 count≥3 的签名，必须在 §4 有对应行。
 *
 * 用法：
 *   node scripts/check-tool-contract.mjs [--json] [--failures <path>] [--no-failures]
 *   -h, --help   本说明（零副作用）
 *
 * 退出码：0 = 通过（可能有 WARN）；1 = 有错误；2 = 用法错误。
 */
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const CONTRACT = path.join(REPO, 'docs', 'tool-contract.md')
const AGENTS = path.join(REPO, 'AGENTS.md')
const MESH_SKILL = path.join(REPO, 'skills', 'mesh', 'SKILL.md')
const DEFAULT_FAILURES = path.join(os.homedir(), '.dsh', 'skills', 'fail-log-guide', '.failures.json')

const MAX_LINES = 160
const MAX_AGE_DAYS = 120
const MIN_COUNT = 3

const HEADINGS = [
  '## 1. 写文件（edit / write）',
  '## 2. 命令（pwsh）',
  '## 3. 工具名（精确）',
  '## 4. 错误 → 下一步',
  '## 5. 维护',
]

// 失败签名 → 契约里必须出现的字样
const RULES = [
  { id: 'edit-old-string-missing', re: /old_string was not found/, need: ['old_string was not found'] },
  { id: 'edit-must-differ', re: /old_string and new_string must differ/, need: ['old_string and new_string must differ'] },
  { id: 'edit-multiple-match', re: /old_string matched \d+ times/, need: ['old_string matched N times'] },
  { id: 'write-without-read', re: /without reading it first/, need: ['without reading it first'] },
  { id: 'write-parent-path', re: /parent path segment is not a directory/, need: ['parent path segment is not a directory'] },
  { id: 'file-changed', re: /file changed since it was read/, need: ['file changed since it was read'] },
  { id: 'read-not-found', re: /cannot read .*not found|: binary file/, need: ['cannot read'] },
  { id: 'unknown-tool-ps', re: /unknown tool "ps"/, need: ['unknown tool "ps"'] },
  { id: 'unknown-tool-mesh-send', re: /unknown tool "mesh_send"/, need: ['unknown tool "mesh_send"'] },
  { id: 'unknown-tool-mesh-namespaced', re: /unknown tool "mcp__mesh__/, need: ['mcp__mesh__mesh_send'] },
  { id: 'mesh-self-send', re: /refusing to send a message to yourself/, need: ['refusing to send a message to yourself'] },
  { id: 'invalid-escalation', re: /invalid escalation/, need: ['invalid escalation'] },
  { id: 'input-not-object', re: /must be an object/, need: ['input must be an object'] },
  { id: 'mesh-ask-timeout', re: /mesh_ask.*timeout|aborted due to timeout/, need: ['mesh_ask'] },
  { id: 'tool-aborted', re: /tool call aborted/, need: ['tool call aborted'] },
  { id: 'fetch-failed', re: /fetch failed|web fetch failed/, need: ['fetch failed'] },
]

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const val = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

if (has('-h') || has('--help')) {
  console.log(`check-tool-contract.mjs — 工具契约页的结构 / 时效 / 失败覆盖检查

用法：
  node scripts/check-tool-contract.mjs [--json] [--failures <path>] [--no-failures]

  --json             机器可读输出
  --failures <path>  失败台账路径（默认 ~/.dsh/skills/fail-log-guide/.failures.json）
  --no-failures      跳过失败台账覆盖检查（CI 无该文件时用）
  -h, --help         本说明（零副作用）

退出码：0 = 通过（可能有 WARN）；1 = 有错误；2 = 用法错误。`)
  process.exit(0)
}

const errors = []
const warnings = []
const stats = {}

function fail(message) { errors.push(message) }
function warn(message) { warnings.push(message) }

if (!existsSync(CONTRACT)) {
  fail(`契约页不存在：${path.relative(REPO, CONTRACT)}`)
} else {
  const text = readFileSync(CONTRACT, 'utf8')
  const lines = text.split(/\r?\n/)
  stats.lines = lines.length
  if (lines.length > MAX_LINES) fail(`契约页 ${lines.length} 行 > ${MAX_LINES}（先删冗余再加条目）`)
  for (const heading of HEADINGS) {
    if (!text.includes(heading)) fail(`缺章节：${heading}`)
  }

  const reviewed = /维护：(\d{4}-\d{2}-\d{2})/.exec(text)
  if (!reviewed) {
    fail('缺「维护：YYYY-MM-DD」行')
  } else {
    const reviewedAt = Date.parse(`${reviewed[1]}T00:00:00Z`)
    const ageDays = Math.max(0, Math.floor((Date.now() - reviewedAt) / 86400000))
    stats.ageDays = ageDays
    if (!Number.isFinite(ageDays) || ageDays > MAX_AGE_DAYS) {
      fail(`契约页已 ${ageDays} 天未复查（上限 ${MAX_AGE_DAYS}）：更新「维护：」并核对失败台账`)
    }
  }
}

if (!existsSync(AGENTS)) {
  // AGENTS.md 是本地专用文件（gitignored），CI 检出里没有；本地必须存在且指向契约页。
  warn('AGENTS.md 不存在（本地专用文件），跳过引用检查')
} else if (!readFileSync(AGENTS, 'utf8').includes('docs/tool-contract.md')) {
  fail('AGENTS.md 没有指向 docs/tool-contract.md')
}

if (!existsSync(MESH_SKILL)) {
  warn('skills/mesh/SKILL.md 不存在，跳过工具名检查')
} else {
  const skill = readFileSync(MESH_SKILL, 'utf8')
  if (!skill.includes('mcp__mesh__mesh_send')) fail('skills/mesh/SKILL.md 未写全工具名 mcp__mesh__mesh_send')
  if (!skill.includes('不要发给自己')) fail('skills/mesh/SKILL.md 缺「不要发给自己」边界')
}

const failuresPath = has('--no-failures')
  ? null
  : (val('--failures') ? path.resolve(val('--failures')) : DEFAULT_FAILURES)

if (failuresPath && !existsSync(failuresPath)) {
  warn(`失败台账不存在，跳过覆盖检查：${failuresPath}`)
} else if (failuresPath) {
  let entries = {}
  try {
    const parsed = JSON.parse(readFileSync(failuresPath, 'utf8'))
    entries = parsed.entries ?? {}
  } catch (error) {
    fail(`失败台账解析失败：${error.message}`)
  }

  const text = existsSync(CONTRACT) ? readFileSync(CONTRACT, 'utf8') : ''
  const totals = new Map()
  const unmatched = new Map()
  for (const entry of Object.values(entries)) {
    const message = String(entry?.message ?? '')
    const count = Number(entry?.count ?? 0)
    if (!message || count <= 0) continue
    const rule = RULES.find((candidate) => candidate.re.test(message))
    if (rule) {
      totals.set(rule.id, (totals.get(rule.id) ?? 0) + count)
    } else {
      const key = message.slice(0, 80)
      unmatched.set(key, (unmatched.get(key) ?? 0) + count)
    }
  }

  stats.failureCoverage = []
  for (const rule of RULES) {
    const count = totals.get(rule.id) ?? 0
    if (count < MIN_COUNT) continue
    const missing = rule.need.filter((needle) => !text.includes(needle))
    stats.failureCoverage.push({ id: rule.id, count, covered: missing.length === 0 })
    if (missing.length) fail(`失败签名 ${rule.id}（×${count}）未覆盖：契约 §4 缺 ${missing.join(' / ')}`)
  }

  for (const [key, count] of unmatched) {
    if (count >= MIN_COUNT) fail(`未归类的失败签名（×${count}）：${key} —— 先在 §4 补一行，再更新 RULES`)
  }
}

if (has('--json')) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, stats }, null, 2))
} else {
  for (const warning of warnings) console.log(`WARN ${warning}`)
  for (const error of errors) console.log(`FAIL ${error}`)
  if (errors.length === 0) {
    const coverage = stats.failureCoverage?.filter((row) => row.count >= MIN_COUNT).length ?? 0
    console.log(`OK tool-contract: ${stats.lines ?? '?'} 行 / 复查龄 ${stats.ageDays ?? '?'} 天 / 覆盖签名 ${coverage}`)
  }
}

process.exitCode = errors.length === 0 ? 0 : 1
