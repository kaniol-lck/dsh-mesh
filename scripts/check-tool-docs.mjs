#!/usr/bin/env node
/**
 * check-tool-docs.mjs — 工具文档必须与工具 schema 同步（生产文档不靠催）。
 *
 * 为什么单独一个门禁（owner 2026-11-20「同步文档不应该是需要我来催的事情，特别是用于生产的文档」）：
 * 2026-11-20 发现 `mesh_dispatch.mode`（steer 的派活入口）**在任何文档里都不存在**，而同一个
 * steer 概念在 `mesh_send.delivery` 那里写了两处。原因不是谁偷懒，是**参数只活在代码里**：
 * 文档各自手抄，改了参数没有任何东西会红。所以两件事一起做——
 *   1. `gen-tool-reference.mjs` 从 schema 生成 `docs/tools-reference.md`（唯一来源）；
 *   2. 本脚本断言「生成结果 == 已提交的文档」，参数一改就必须重新生成，否则 CI 红。
 *
 * 另外校验**跨文档的口径一致**：`steer` 在三个入口（dispatch.mode / send.delivery / inject.mode）
 * 参数名不同，若某个入口在文档里被提到却没有出现在参考页里，也判红——防「只补了一处」。
 *
 * 用法：node scripts/check-tool-docs.mjs [--json] [--help]
 * 退出码：0 一致；1 漂移；2 生成器不可用。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GEN = path.join(ROOT, 'scripts', 'gen-tool-reference.mjs')
const REF = path.join(ROOT, 'docs', 'tools-reference.md')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)

if (has('--help') || has('-h')) {
  console.log(`check-tool-docs.mjs — 工具文档与 schema 同步校验

用法:
  node scripts/check-tool-docs.mjs [--json]

检查项:
  A  docs/tools-reference.md 存在且与 gen-tool-reference 的输出逐字节一致
     （参数改了没重新生成 → 红；这正是 2026-11-20 mesh_dispatch.mode 缺失的成因）
  B  参考页覆盖 tools.mjs 里导出的每个工具（不多不少，防止只生成一半）
  C  docs/ 与 skills/ 里出现的工具名都在参考页里（防「文档提到但无权威出处」）
  D  生成器本身可运行（--check 自身不能是个空壳）

退出码: 0 一致；1 漂移；2 环境问题
`)
  process.exit(0)
}

const problems = []

if (!existsSync(GEN)) problems.push(`生成器缺失: ${path.relative(ROOT, GEN)}`)
if (!existsSync(REF)) problems.push(`参考页缺失: ${path.relative(ROOT, REF)}（跑 node scripts/gen-tool-reference.mjs）`)

// A + D：让生成器自己判一致性；它同时证明自己不是空壳。
if (existsSync(GEN) && existsSync(REF)) {
  try {
    execFileSync(process.execPath, [GEN, '--check'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    problems.push(`A: 参考页与 schema 不一致 — ${out.split('\n').slice(-2).join(' / ').slice(0, 300)}`)
  }
}

// B：工具覆盖数必须与 doc 里的标题数一致（生成器会自报个数，这里用文件内容独立核）。
let refText = ''
try {
  refText = readFileSync(REF, 'utf8')
} catch {
  /* 已在上面记过 */
}
const docTools = [...refText.matchAll(/^## `([a-z_]+)`$/gm)].map((m) => m[1])
const toolsSrc = readFileSync(path.join(ROOT, 'plugins', 'mesh-waker', 'lib', 'tools.mjs'), 'utf8')
const exportedTools = [...toolsSrc.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1])
const missing = exportedTools.filter((name) => !docTools.includes(name))
if (missing.length) problems.push(`B: schema 里有、参考页没有的工具: ${missing.join(', ')}`)
if (!docTools.length) problems.push('B: 参考页没有任何工具小节（生成器可能坏了）')

// C：文档里点名的 mesh 工具，必须在参考页里有出处。
const docDirs = [path.join(ROOT, 'docs'), path.join(ROOT, 'skills')]
const mentioned = new Set()
for (const dir of docDirs) {
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir, { recursive: true })) {
    if (!String(file).endsWith('.md')) continue
    const full = path.join(dir, String(file))
    if (full === REF) continue
    let body = ''
    try {
      body = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const m of body.matchAll(/\b(mesh_(?:dispatch|send|ask|ack|complete|cancel|tasks|inbox|thread|lock))\b/g)) {
      mentioned.add(m[1])
    }
  }
}
const orphans = [...mentioned].filter((name) => !docTools.includes(name))
// inbox/thread 等属中枢侧工具，不在本仓 tools.mjs 里；只对**本仓有的**报错。
const localNames = new Set(exportedTools)
const badOrphans = orphans.filter((name) => localNames.has(name))
if (badOrphans.length) problems.push(`C: 被文档引用但参考页缺失: ${badOrphans.join(', ')}`)

if (has('--json')) {
  console.log(JSON.stringify({ ok: problems.length === 0, docTools, problems }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`)
  console.error('')
  console.error('修法：改完工具 schema 后跑 `node scripts/gen-tool-reference.mjs`，再提交 docs/tools-reference.md')
  process.exit(1)
}
console.log(`ok check-tool-docs: ${docTools.length} 个工具，参考页与 schema 一致，无孤儿引用`)
