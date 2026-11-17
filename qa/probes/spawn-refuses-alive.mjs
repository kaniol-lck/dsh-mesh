#!/usr/bin/env node
/**
 * probes/spawn-refuses-alive.mjs — L2 行为探针
 *
 * 规格：session-model.spawn-refuses-alive
 * 「已有一个存活的派生会话时，默认不得再派生；只有显式 --force 才放行。」
 *
 * 做法（真调入口，不看源码）：
 *   1) 在临时工作区放一行 registry（child=session-alive，dispatched，刚刚）；
 *   2) 假 waker 的 /mesh/sessions 说 session-alive 仍 live；
 *   3) 真跑 spawn --apply（**不带** --force）→ 必须拒绝，且**不发出**创建请求；
 *   4) 再跑一次带 --force → 必须放行并真的创建。
 *
 * 为什么不用 grep：存活判据的实现细节会变（字段名、窗口大小），但「活着就不让再开」是契约。
 *
 * 用法：node qa/probes/spawn-refuses-alive.mjs [--json]
 * 退出码：0 = 符合；1 = 违反；2 = 探针自身故障。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INSTALLED = path.join(os.homedir(), '.dsh', 'skills', 'spawn', 'scripts', 'spawn.mjs')
const IN_REPO = path.join(REPO, 'skills', 'spawn', 'scripts', 'spawn.mjs')
const SCRIPT = existsSync(INSTALLED) ? INSTALLED : IN_REPO

const asJson = process.argv.includes('--json')
const ALIVE = 'session-alive-fixture'
const PARENT = 'session-qa-parent'

function startWaker(now) {
  const calls = { createPayloads: [] }
  const sessions = [{ id: ALIVE, title: '既有派生会话', live: true, archived: false, last_active: now - 30_000 }]
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    if (url.startsWith('/mesh/sessions?') || url === '/mesh/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, sessions }))
      return
    }
    if (url === '/mesh/sessions/create' && request.method === 'POST') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        let payload = {}
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* keep empty */ }
        calls.createPayloads.push(payload)
        // 让新建会话出现在列表里，spawn 的索引等待才能结束
        sessions.push({ id: 'session-created-fixture', title: payload.title ?? null, live: true, archived: false, last_active: Date.now() })
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, sessionId: 'session-created-fixture', title: payload.title ?? null, workspacePath: payload.workspacePath ?? null }))
      })
      return
    }
    if (url === '/mesh/inject' && request.method === 'POST') {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, taskId: 'T-QA-ALIVE' }))
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

function runSpawn(env, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function main() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'qa-spawn-alive-'))
  const brief = path.join(workspace, 'brief.md')
  writeFileSync(brief, '# QA probe\n\n目标：验证存活判据。\n', 'utf8')
  const dispatchDir = path.join(workspace, '.worklog', 'dispatch')
  mkdirSync(dispatchDir, { recursive: true })
  writeFileSync(
    path.join(dispatchDir, 'derived-sessions.jsonl'),
    `${JSON.stringify({
      parent: PARENT,
      child: ALIVE,
      title: '既有派生会话',
      taskId: 'T-EXISTING',
      cwd: workspace,
      status: 'dispatched',
      createdAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  )

  const waker = await startWaker(Date.now())
  try {
    const env = { MESH_WAKER_URL: waker.base, DSH_SESSION_ID: PARENT }
    const blocked = await runSpawn(env, ['--title', '重构讨论：发言架构', '--brief', brief, '--apply', '--json'], workspace)
    const createsWhileBlocked = waker.calls.createPayloads.length
    const blockedOk = blocked.code !== 0 && createsWhileBlocked === 0

    const forced = await runSpawn(env, ['--title', '重构讨论：发言架构', '--brief', brief, '--apply', '--force', '--json'], workspace)
    const createsWhileForced = waker.calls.createPayloads.length
    const forcedOk = forced.code === 0 && createsWhileForced > createsWhileBlocked

    const problems = []
    if (blocked.code === 0) problems.push('存活派生会话存在时，默认调用没有拒绝（退出码 0）')
    if (createsWhileBlocked !== 0) problems.push(`拒绝路径仍然发出了 ${createsWhileBlocked} 次创建请求`)
    if (forced.code !== 0) problems.push(`--force 未能放行（退出码 ${forced.code}）：${(forced.stderr || '').slice(0, 200)}`)
    if (createsWhileForced <= createsWhileBlocked) problems.push('--force 放行后没有真正创建会话')

    const detail = {
      probe: 'spawn-refuses-alive',
      spec: 'session-model.spawn-refuses-alive',
      ok: problems.length === 0,
      blockedExitCode: blocked.code,
      blockedStderr: (blocked.stderr || '').slice(0, 300),
      createsWhileBlocked,
      forcedExitCode: forced.code,
      createsWhileForced,
      problems,
    }
    if (asJson) console.log(JSON.stringify(detail, null, 2))
    else {
      console.log(`${detail.ok ? 'OK  ' : 'RED '} blocked.create=${createsWhileBlocked} forced.create=${createsWhileForced}`)
      for (const problem of problems) console.log(`      - ${problem}`)
    }
    process.exitCode = detail.ok ? 0 : 1
  } finally {
    await new Promise((resolve) => waker.server.close(resolve))
    rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ probe: 'spawn-refuses-alive', ok: false, error: error?.message ?? String(error) }, null, 2))
  process.exitCode = 2
})
