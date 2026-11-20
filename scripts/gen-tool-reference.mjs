#!/usr/bin/env node
/**
 * gen-tool-reference.mjs — 从**工具 schema 源码**生成 `docs/tools-reference.md`。
 *
 * 为什么需要它（owner 2026-11-20「同步文档不应该是需要我来催的事情，特别是用于生产的文档」）：
 * 工具参数原本只存在于 `lib/tools.mjs` 里，文档各自手抄，于是：
 *   - `mesh_dispatch.mode`（steer）**一处文档都没有**，而同一概念的 `mesh_send.delivery` 写了两处；
 *   - 三个入口（dispatch / send / inject）的 steer 参数名各不相同，没有横向对照；
 *   - 参数改了，文档不会跟着改，也没有任何门禁能发现。
 * 手抄必然漂移，所以这里**不手写参数**，只从 schema 读；文档顶部标明生成来源，
 * 由 `check-tool-docs.mjs` 在 CI/门禁里比对「文档是否与 schema 同步」。
 *
 * 用法：
 *   node scripts/gen-tool-reference.mjs            # 写 docs/tools-reference.md
 *   node scripts/gen-tool-reference.mjs --check    # 只比对，不写盘；不一致 exit 1
 *   node scripts/gen-tool-reference.mjs --stdout   # 打到标准输出
 *
 * 退出码：0 成功/一致；1 --check 发现漂移；2 源码读不到。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'docs', 'tools-reference.md')
const TOOLS_SRC = path.join(ROOT, 'plugins', 'mesh-waker', 'lib', 'tools.mjs')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)

if (has('--help') || has('-h')) {
  console.log(`gen-tool-reference.mjs — 从工具 schema 生成参数参考（单一来源，杜绝手抄漂移）

用法:
  node scripts/gen-tool-reference.mjs            # 写 docs/tools-reference.md
  node scripts/gen-tool-reference.mjs --check    # 只比对不写盘；漂移 exit 1
  node scripts/gen-tool-reference.mjs --stdout   # 输出到 stdout

数据源: plugins/mesh-waker/lib/tools.mjs（工具的 parameters 定义）
`)
  process.exit(0)
}

if (!readFileSync(TOOLS_SRC, 'utf8')) {
  console.error(`读不到工具定义: ${TOOLS_SRC}`)
  process.exit(2)
}

// 动态 import 拿真实 schema，而不是正则解析源码——那是另一种手抄。
const mod = await import(pathToFileURL(TOOLS_SRC).href)
const toolExports = Object.entries(mod).filter(([, v]) => v && typeof v === 'object' && v.name && v.parameters)

/** 一行说明一个参数的枚举/类型，够用即可，别把 JSON Schema 全搬。 */
function typeLabel(spec) {
  if (!spec || typeof spec !== 'object') return 'any'
  if (spec.enum) return spec.enum.map((v) => `\`${v}\``).join(' \\| ')
  if (spec.type === 'array') return 'array'
  return spec.type ?? 'any'
}

// schema 的 description 里可能出现某台机器的绝对路径（实测：`workspacePath` 的例子写死了
// 一个盘符路径）。忠实搬进文档会被 `check-paths` 判红（它拦盘符绝对路径），而文档本身不该
// 固化某台机器的路径。这里替换成占位符并**大声告警**，让源头被发现；正确修法是在
// `lib/tools.mjs` 里把例子改成中性写法（归 waker，见 todo）。
const ABS_PATH = /\b[A-Za-z]:\\[^\s)`"']*/g
const sanitizedFields = []

function neutralize(text, fieldName) {
  const cleaned = String(text).replace(ABS_PATH, (hit) => {
    sanitizedFields.push(`${fieldName}: ${hit}`)
    return '<workspace>'
  })
  return cleaned
}

const lines = []
// drift 签名必须是**生成物的一部分**：手工加一行会让「文件 == 生成结果」不再成立，
// 于是 check-tool-docs 立刻判红（2026-11-20 踩过一次）。用 `*` 表示概念文档不随版本漂移，
// 它的时效性由 check-tool-docs 直接对 schema 保证，而不是靠版本号。
lines.push('<!-- drift: waker=* hub=* owner=docs -->')
lines.push('# 工具参数参考（自动生成）')
lines.push('')
lines.push('> **本文件由 `node scripts/gen-tool-reference.mjs` 生成，不要手工编辑。**')
lines.push('> 数据源：`plugins/mesh-waker/lib/tools.mjs`。改参数 → 跑一次生成器 → 否则 `check-tool-docs` 判红。')
lines.push('>')
lines.push('> 为什么生成而不是手写：owner 2026-11-20 指出「同步文档不该靠催」。此前 `mesh_dispatch.mode`')
lines.push('> （steer 的派活入口）**在任何文档里都不存在**，而同一概念的 `mesh_send.delivery` 写了两处——')
lines.push('> 因为参数只活在代码里、文档靠手抄。手抄必漂移，所以只认代码。')
lines.push('')

for (const [exportName, tool] of toolExports.sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  lines.push(`## \`${tool.name}\``)
  lines.push('')
  const desc = neutralize(String(tool.description ?? '').split('\n')[0].trim(), `${tool.name}.description`)
  if (desc) {
    lines.push(`> ${desc}`)
    lines.push('')
  }
  const params = tool.parameters ?? {}
  const required = Array.isArray(tool.required) ? tool.required : []
  const names = Object.keys(params)
  if (!names.length) {
    lines.push('（无参数）')
    lines.push('')
    continue
  }
  lines.push('| 参数 | 类型 / 取值 | 必填 | 说明 |')
  lines.push('|---|---|---|---|')
  for (const name of names) {
    const spec = params[name] ?? {}
    const d = neutralize(String(spec.description ?? '').replace(/\s+/g, ' ').trim(), `${tool.name}.${name}`)
    lines.push(`| \`${name}\` | ${typeLabel(spec)} | ${required.includes(name) ? '是' : ''} | ${d.replaceAll('|', '\\|')} |`)
  }
  lines.push('')
  globalThis.__seen = globalThis.__seen ?? new Set()
  globalThis.__seen.add(tool.name)
}

const text = lines.join('\n') + '\n'
const UNIQUE_SANITIZED = [...new Set(sanitizedFields)]
// 占位符替换必须有痕：默认静默替换会让人以为 schema 本来就这么写。
if (UNIQUE_SANITIZED.length) {
  console.error(`WARN 已把下列字段说明里的本机绝对路径替换为 <workspace>：${UNIQUE_SANITIZED.join('; ')}`)
  console.error('     根治：在 plugins/mesh-waker/lib/tools.mjs 里改成中性写法（归 waker）。')
}

if (has('--stdout')) {
  process.stdout.write(text)
  process.exit(0)
}

if (has('--check')) {
  let existing = ''
  try {
    existing = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`✗ ${path.relative(ROOT, OUT)} 不存在；跑 node scripts/gen-tool-reference.mjs 生成`)
    process.exit(1)
  }
  if (existing !== text) {
    console.error(`✗ ${path.relative(ROOT, OUT)} 与工具 schema 不一致（参数改过但没重新生成）`)
    console.error('  修法: node scripts/gen-tool-reference.mjs')
    process.exit(1)
  }
  console.log(`ok tool-reference: 与 ${path.relative(ROOT, TOOLS_SRC)} 一致（${toolExports.length} 个工具）`)
  process.exit(0)
}

writeFileSync(OUT, text, 'utf8')
console.log(`wrote ${path.relative(ROOT, OUT)} (${toolExports.length} tools, ${text.split('\n').length} lines)`)
