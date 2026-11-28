#!/usr/bin/env node
/**
 * T7 判据红检：`check-team.mjs` 的「角色投影是否过期」真的会红吗？
 *
 * 为什么单独一条：T7 依赖**运行中的** waker（或一个假的），所以在 CI 里跑不了，
 * 只能本地跑。而「依赖运行实例」的检查最容易变成「永远只会说查不了」——2026-11-28
 * 第一次写的时候我就踩到两个：`sourceUpdatedAt: 0` 被 `String(0)` 洗白、
 * `Number(['dead'])` 得 NaN 让 unresolved 永远不报。**修复后再没验过行为**，
 * 所以把它固化成脚本，任何改 T7 的提交都能重跑。
 *
 * 做法：起一个假 waker 端点（只答 `/mesh/status`），喂不同 `roleProjection`，
 * 断言 T7 落在 PASS / WARN / FAIL 哪一档。**不碰真 waker、不写任何文件。**
 *
 * 用法：node scripts/check-team-t7-redcheck.mjs [--verbose]
 * 退出：0 全部符合预期；1 有偏差；2 环境问题（check-team 不存在等）
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const CHECK_TEAM = join(REPO, '.worklog', 'bin', 'check-team.mjs')
const TEAM = join(REPO, '.worklog', 'team.json')

if (!existsSync(CHECK_TEAM) || !existsSync(TEAM)) {
  console.error('找不到 check-team.mjs 或 team.json，无法红检')
  process.exit(2)
}

const teamUpdatedAt = JSON.parse(readFileSync(TEAM, 'utf8')).updatedAt
const verbose = process.argv.includes('--verbose')

// 期望档位就是判据本身，改一行就要想清楚它为什么该红/该绿
const CASES = [
  ['一致 → 绿', { pushedAt: 1, sourceUpdatedAt: teamUpdatedAt, unresolved: [] }, 'PASS'],
  ['字符串不等 → 红', { pushedAt: 1, sourceUpdatedAt: '2026-01-01', unresolved: [] }, 'FAIL'],
  // 推过但值坏了：投影内容不可信，必须红（不能因为「能读到一个值」就放过）
  ['旧版坏值 0（推过）→ 红', { pushedAt: 1, sourceUpdatedAt: 0, unresolved: [] }, 'FAIL'],
  // 从没推过 ≠ 过期：这是「还没开始用」，属于要提示但不必判红
  ['从未推送 → WARN', { pushedAt: 0, sourceUpdatedAt: null, unresolved: [] }, 'WARN'],
  ['有失效 sessionId（数组）→ 红', { pushedAt: 1, sourceUpdatedAt: teamUpdatedAt, unresolved: ['session-dead'] }, 'FAIL'],
  ['unresolved 是数字 → 红', { pushedAt: 1, sourceUpdatedAt: teamUpdatedAt, unresolved: 2 }, 'FAIL'],
  ['数字串一致 → 绿', { pushedAt: 1, sourceUpdatedAt: String(teamUpdatedAt), unresolved: [] }, 'PASS'],
]

let bad = 0
for (const [label, projection, expect] of CASES) {
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/mesh/status')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ roleProjection: projection }))
    } else {
      res.writeHead(404).end('{}')
    }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`

  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CHECK_TEAM], { env: { ...process.env, MESH_WAKER_URL: url } })
    let text = ''
    p.stdout.on('data', (d) => (text += d))
    p.stderr.on('data', (d) => (text += d))
    p.on('close', (code) => resolve({ code, text }))
  })
  srv.close()

  const line = out.text.split(/\r?\n/).find((l) => l.includes('T7')) ?? '(T7 无输出)'
  const actual = /\[FAIL\] T7/.test(line) ? 'FAIL' : /\[WARN\] T7/.test(line) ? 'WARN' : 'PASS'
  const pass = actual === expect
  if (!pass) bad += 1
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} 期望=${String(expect).padEnd(4)} 实际=${actual}`)
  if (verbose || !pass) console.log(`        ${line.trim().slice(0, 140)}`)
}

console.log('')
console.log(bad ? `T7 红检：${bad} 条不符合预期` : 'T7 红检：全部符合预期')
process.exitCode = bad ? 1 : 0
