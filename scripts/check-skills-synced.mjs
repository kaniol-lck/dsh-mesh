#!/usr/bin/env node
/**
 * check-skills-synced.mjs — 已安装的技能副本是否落后于仓库源？
 *
 * 为什么需要它（2026-11-28）：`skills/` 是**可独立发布的包**（`dsh-mesh-skills`），
 * 但一直只有 `check-version-sync` 保证 `package.json` ↔ `CHANGELOG` 内部一致，
 * **没有任何东西检查装出去的副本**。结果：
 *   · 本机 `~/.dsh/skills/mesh` 停在 11-18（比仓库旧 4 天、差 11 行）
 *   · NAS 上**连 `~/.dsh/skills/` 都没有**
 *   · 而 `0.2.x` 三个版本只写了 CHANGELOG、从未 `npm publish` —— 「发版后同步」在源头就是空转
 * 这三件事**同时存在且互不覆盖**，正是「源改了，副本不知道」的形状（同 `check-docs-drift`、镜像 package.json 冻结）。
 *
 * 为什么不能进 CI：它要看**本机** `~/.dsh/skills`（文件系统状态，不是仓库内容）。
 * CI 里跑只会 SKIP —— 所以本地跑，并在 CI 里保持 SKIP 而不是假通过。
 *
 * 判据：**比哈希，不比行数**。`Measure-Object -Line` / `wc -l` 对末尾换行处理不同，
 * 同一份 24,871 字节的文件会分别报 268 行和 383 行（2026-11-28 我一度以为 NAS 装错版本）。
 *
 * 用法：node scripts/check-skills-synced.mjs [--dest <dir>] [--json]
 * 退出：0 一致（或目标目录不存在 → 视为「未安装」，给 WARN 不判红）；1 有不一致；2 参数错误
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SKILLS_SRC = join(REPO, 'skills')

const argv = process.argv.slice(2)
const jsonOut = argv.includes('--json')
const destIdx = argv.indexOf('--dest')
const DEST = destIdx >= 0 ? argv[destIdx + 1] : join(homedir(), '.dsh', 'skills')

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 递归收集相对路径 → 哈希（跳过 __pycache__ / .pyc）。 */
function walk(root) {
  const out = new Map()
  if (!existsSync(root)) return out
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const nextRel = rel ? join(rel, entry.name) : entry.name
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) continue
      if (entry.isDirectory()) stack.push(nextRel)
      else if (entry.isFile()) out.set(nextRel, sha(join(root, nextRel)))
    }
  }
  return out
}

// 只在仓库里 `skills/<name>/` 存在的技能才算要同步的（bin/、package.json 等不比对）
const names = readdirSync(SKILLS_SRC, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SKILLS_SRC, e.name, 'SKILL.md')))
  .map((e) => e.name)
  .sort()

const rows = []
let missing = 0
let drift = 0
for (const name of names) {
  const src = walk(join(SKILLS_SRC, name))
  const dstRoot = join(DEST, name)
  if (!existsSync(dstRoot)) {
    rows.push({ skill: name, state: 'not-installed', files: src.size, extra: [], differing: [], missing: [] })
    missing += 1
    continue
  }
  const dst = walk(dstRoot)
  const differing = []
  const missingFiles = []
  for (const [rel, hash] of src) {
    if (!dst.has(rel)) missingFiles.push(rel)
    else if (dst.get(rel) !== hash) differing.push(rel)
  }
  // 只报「源里没有、目标里多出来的」还不够严：技能目录本来就不该有额外文件
  const extra = [...dst.keys()].filter((rel) => !src.has(rel))
  const bad = differing.length || missingFiles.length || extra.length
  if (bad) {
    drift += 1
    rows.push({ skill: name, state: 'drift', files: src.size, differing, missing: missingFiles, extra })
  } else {
    rows.push({ skill: name, state: 'ok', files: src.size, differing: [], missing: [], extra: [] })
  }
}

const ok = drift === 0

if (jsonOut) {
  console.log(JSON.stringify({ ok, dest: DEST, skills: names.length, notInstalled: missing, drifted: drift, rows }, null, 2))
} else {
  console.log(`check-skills-synced · 目标 ${DEST}`)
  for (const r of rows) {
    if (r.state === 'ok') console.log(`  OK    ${r.skill.padEnd(9)} ${r.files} 个文件一致`)
    else if (r.state === 'not-installed') console.log(`  WARN  ${r.skill.padEnd(9)} 未安装（${r.files} 个文件）——跑 bin/install.mjs`)
    else {
      console.log(`  DRIFT ${r.skill.padEnd(9)} ${r.files} 个文件；不同 ${r.differing.length}、缺失 ${r.missing.length}、多余 ${r.extra.length}`)
      for (const f of r.differing.slice(0, 5)) console.log(`         ≠ ${f}`)
      for (const f of r.missing.slice(0, 5)) console.log(`         - ${f}`)
      for (const f of r.extra.slice(0, 5)) console.log(`         + ${f}`)
    }
  }
  console.log('')
  if (!ok) {
    console.log(`有 ${drift} 个技能落后于仓库 —— 用发布物重装（runbook 第二节），不要手工拷：`)
    console.log('  npm i dsh-mesh-skills@<v> && node node_modules/dsh-mesh-skills/bin/install.mjs --force')
  } else if (missing) {
    console.log(`全部已安装的技能一致；${missing} 个技能本机未装（WARN，不算失败）`)
  } else {
    console.log('全部技能与仓库一致')
  }
}

process.exitCode = ok ? 0 : 1
