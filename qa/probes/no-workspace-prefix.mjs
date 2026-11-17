#!/usr/bin/env node
/**
 * probes/no-workspace-prefix.mjs — L2 行为探针
 *
 * 规格：identity.no-workspace-prefix-in-title
 * 「任何本机创建入口产出的会话标题，都不得用 `<工作区> · <角色>` 形式承载身份」
 *
 * 做法（**行为取证，不读源码**）：
 *   起一个假 waker → 真跑 `scripts/mesh-dispatch.mjs --wake --create` → 截获它 POST 到
 *   `/mesh/sessions/create` 的 payload → 断言 title 不含 `· <角色>` 形态、不含 `协调`/`coordinator`。
 *
 * 为什么不用 grep：2026-11-17 事故里所有静态检查都是绿的，错在「跑起来产出的标题」。
 *
 * 用法：node qa/probes/no-workspace-prefix.mjs [--json]
 * 退出码：0 = 符合规格；1 = 违反（判红）；2 = 探针自身跑不起来。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DISPATCH = path.join(REPO, 'scripts', 'mesh-dispatch.mjs')
const FORBIDDEN_PATTERNS = [/^.+\s·\s.+$/]
const FORBIDDEN_SUBSTRINGS = ['协调', 'coordinator']

const asJson = process.argv.includes('--json')

function evidence(extra) {
  return { probe: 'no-workspace-prefix', ...extra }
}

function judge(title) {
  const violations = []
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(title)) violations.push(`匹配 <工作区> · <角色> 形态：${pattern}`)
  }
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (title.includes(needle)) violations.push(`含废弃角色词：${needle}`)
  }
  return violations
}

/** Fake waker: records the create payload, answers everything else minimally. */
function startWaker() {
  const calls = { createPayloads: [], sessions: 0, workspaces: 0 }
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    if (url === '/mesh/workspaces') {
      calls.workspaces += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, workspaces: {} }))
      return
    }
    if (url === '/mesh/sessions') {
      calls.sessions += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, sessions: [] }))
      return
    }
    if (url === '/mesh/sessions/create' && request.method === 'POST') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        let payload = {}
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* keep empty */ }
        calls.createPayloads.push(payload)
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          ok: true,
          sessionId: 'session-qa-probe',
          title: payload.title ?? null,
          workspacePath: payload.workspacePath ?? null,
        }))
      })
      return
    }
    if (url === '/mesh/inject') {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function runDispatch(env, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DISPATCH, ...args], { cwd, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function main() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'qa-spawn-prefix-'))
  const indexFile = path.join(workspace, 'sessions-index.json')
  const wakeTarget = path.join(workspace, 'wake-target.txt')
  writeFileSync(indexFile, JSON.stringify({}), 'utf8')
  writeFileSync(wakeTarget, '', 'utf8')

  const waker = await startWaker()
  try {
    const result = await runDispatch(
      { MESH_WAKER_URL: waker.base, MESH_SESSIONS_INDEX: indexFile, MESH_WAKE_TARGET: wakeTarget },
      ['--wake', '--create', '--text', '[WAKE] qa probe no-workspace-prefix', '--repo', workspace],
      workspace,
    )

    if (waker.calls.createPayloads.length === 0) {
      // 没有创建请求有两种含义，必须区分：
      //   a) 入口拒绝创建（规范已删除该路径）→ 符合规格，且这是更强的结果；
      //   b) 探针自己坏掉（脚本不存在、参数写错）→ 判为探针故障，不能算通过。
      const refused = result.code !== 0 && /--create 已移除|已移除/.test(result.stderr)
      const detail = evidence({
        ok: refused,
        spec: 'identity.no-workspace-prefix-in-title',
        outcome: refused ? 'entry-refused' : 'probe-broken',
        detail: refused
          ? '创建入口已移除：不产生任何标题，因此不可能产出废弃标题'
          : 'no create request observed and no refusal message — probe cannot verify',
        exitCode: result.code,
        stdout: result.stdout.slice(0, 800),
        stderr: result.stderr.slice(0, 800),
      })
      console.log(JSON.stringify(detail, null, 2))
      process.exitCode = refused ? 0 : 2
      return
    }

    const titles = waker.calls.createPayloads.map((payload) => String(payload.title ?? ''))
    const report = titles.map((title) => ({ title, violations: judge(title) }))
    const failed = report.filter((row) => row.violations.length > 0)
    const payload = evidence({
      ok: failed.length === 0,
      spec: 'identity.no-workspace-prefix-in-title',
      observedTitles: titles,
      violations: failed,
      exitCode: result.code,
    })
    if (asJson) console.log(JSON.stringify(payload, null, 2))
    else {
      for (const row of report) {
        console.log(`${row.violations.length ? 'RED ' : 'OK  '} title=${JSON.stringify(row.title)}`)
        for (const violation of row.violations) console.log(`      - ${violation}`)
      }
      console.log(payload.ok ? 'probe passed' : 'probe FAILED')
    }
    process.exitCode = failed.length === 0 ? 0 : 1
  } finally {
    await new Promise((resolve) => waker.server.close(resolve))
    rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.log(JSON.stringify(evidence({ ok: false, error: error?.message ?? String(error) }), null, 2))
  process.exitCode = 2
})
