#!/usr/bin/env node
/**
 * probes/no-workspace-prefix-spawn.mjs — L2 行为探针（第二个创建入口）
 *
 * 规格：identity.no-workspace-prefix-in-title
 * spawn 技能同样会建会话，因此同样必须被这条规格覆盖。
 *
 * 做法：起假 waker → 真跑 `spawn.mjs --apply`（标题由调用方给）→ 截获 `/mesh/sessions/create`
 * 的 payload → 断言 title 不含 `<工作区> · <角色>` 形态、不含 `协调`/`coordinator`。
 *
 * 注意：spawn 的标题是**使用者传入**的，所以这条探针真正检查的是「spawn 有没有主动拦下
 * 一个违反命名规约的标题」——即它是否在创建前校验 title。若它照单全收，探针判红。
 *
 * 用法：node qa/probes/no-workspace-prefix-spawn.mjs [--json]
 * 退出码：0 = 符合；1 = 违反；2 = 探针自身故障。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SKILL = path.join(os.homedir(), '.dsh', 'skills', 'spawn', 'scripts', 'spawn.mjs')
const REPO_SPAWN = path.join(REPO, 'skills', 'spawn', 'scripts', 'spawn.mjs')
const TITLE = 'qa-fixture · 协调 1'
const FORBIDDEN_PATTERNS = [/^.+\s·\s.+$/]
const FORBIDDEN_SUBSTRINGS = ['协调', 'coordinator']

const asJson = process.argv.includes('--json')
const script = SKILL

function startWaker() {
  const calls = { createPayloads: [] }
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    if (url === '/mesh/sessions') {
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
        response.end(JSON.stringify({ ok: true, sessionId: 'session-qa-spawn', title: payload.title ?? null }))
      })
      return
    }
    if (url === '/mesh/inject' && request.method === 'POST') {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, taskId: 'T-QA' }))
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
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function main() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'qa-spawn-title-'))
  const brief = path.join(workspace, 'brief.md')
  writeFileSync(brief, '# QA probe\n\n目标：验证 spawn 是否校验标题。\n', 'utf8')

  const waker = await startWaker()
  try {
    const result = await runSpawn(
      { MESH_WAKER_URL: waker.base, DSH_SESSION_ID: 'session-qa-parent' },
      ['--title', TITLE, '--brief', brief, '--apply', '--json'],
      workspace,
    )

    const titles = waker.calls.createPayloads.map((payload) => String(payload.title ?? ''))
    if (titles.length === 0) {
      const refused = result.code !== 0
      const detail = {
        probe: 'no-workspace-prefix-spawn',
        spec: 'identity.no-workspace-prefix-in-title',
        ok: refused,
        outcome: refused ? 'entry-refused' : 'probe-broken',
        attemptedTitle: TITLE,
        exitCode: result.code,
        stderr: result.stderr.slice(0, 600),
      }
      console.log(JSON.stringify(detail, null, 2))
      process.exitCode = refused ? 0 : 2
      return
    }

    const violations = []
    for (const title of titles) {
      for (const pattern of FORBIDDEN_PATTERNS) if (pattern.test(title)) violations.push(`匹配 <工作区> · <角色>：${pattern}`)
      for (const needle of FORBIDDEN_SUBSTRINGS) if (title.includes(needle)) violations.push(`含废弃角色词：${needle}`)
    }
    const detail = {
      probe: 'no-workspace-prefix-spawn',
      spec: 'identity.no-workspace-prefix-in-title',
      ok: violations.length === 0,
      attemptedTitle: TITLE,
      observedTitles: titles,
      violations,
      exitCode: result.code,
    }
    if (asJson) console.log(JSON.stringify(detail, null, 2))
    else {
      console.log(`${detail.ok ? 'OK  ' : 'RED '} attempted=${JSON.stringify(TITLE)} observed=${JSON.stringify(titles)}`)
      for (const violation of violations) console.log(`      - ${violation}`)
    }
    process.exitCode = violations.length === 0 ? 0 : 1
  } finally {
    await new Promise((resolve) => waker.server.close(resolve))
    rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ probe: 'no-workspace-prefix-spawn', ok: false, error: error?.message ?? String(error) }, null, 2))
  process.exitCode = 2
})
