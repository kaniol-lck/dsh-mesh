import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = path.join(import.meta.dirname, '..')
const ENTRY = path.join(REPO, 'plugins', 'mesh-waker', 'index.js')
process.env.MESH_WAKER_LOG = path.join(os.tmpdir(), `waker-consult-${process.pid}.log`)

const REQ = 'session-ca-req'
const WORKER = 'session-ca-worker'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 6000, stepMs = 50) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return false
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function request(base, route) {
  const res = await fetch(`${base}${route}`)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

async function startHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-consult-'))
  fs.mkdirSync(path.join(tmp, 'inbox'), { recursive: true })
  const sessionsRoot = path.join(tmp, 'sessions')
  const tokenDir = path.join(tmp, 'state')
  const home = path.join(tmp, 'home')
  const receiptFile = path.join(tmp, 'receipts.jsonl')
  const logFile = path.join(tmp, 'waker.log')
  for (const dir of [sessionsRoot, tokenDir, home]) fs.mkdirSync(dir, { recursive: true })
  const index = {}
  for (const seed of [
    { id: REQ, title: 'ca requester' },
    { id: WORKER, title: 'ca worker' },
  ]) {
    const dir = path.join(sessionsRoot, 'ws-test', seed.id)
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(log, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session/open', data: { cwd: path.join(tmp, 'inbox') } }) + '\n')))
    index[seed.id] = { mtime: fs.statSync(log).mtimeMs, title: seed.title, cwd: path.join(tmp, 'inbox') }
  }
  fs.writeFileSync(path.join(tokenDir, 'sessions-index.json'), JSON.stringify(index))
  const tokenFile = path.join(tokenDir, 'token')
  fs.writeFileSync(tokenFile, 'test-token')

  const state = { prompts: [], tools: [] }
  const previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    MESH_WAKER_SESSIONS_ROOT: process.env.MESH_WAKER_SESSIONS_ROOT,
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.MESH_WAKER_SESSIONS_ROOT = sessionsRoot
  const disposers = []
  const listeners = new Map()
  const toolsService = { register: (definition) => (state.tools.push(definition), () => {}) }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => (name === 'tools' ? toolsService : undefined),
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    commands: { register: () => () => {} },
    tools: toolsService,
    sessionController: {
      async create() {
        throw new Error('not used here')
      },
      async prompt(payload) {
        state.prompts.push(payload)
        return {}
      },
      async cancel() {},
      async rename() {},
    },
    agents: { get: () => undefined, resume: async () => {} },
    workspaceRegistry: {
      archivedSessionIds: () => new Set(),
      async archiveSession() {},
      async resolveByPath() {
        return null
      },
      async create(workspacePath) {
        return { id: 'ws-test', path: workspacePath }
      },
      async deleteKnown() {
        return false
      },
      sessionKnown() {
        return true
      },
    },
  }
  const port = await freePort()
  const { apply } = await import(pathToFileURL(ENTRY).href)
  await apply(ctx, {
    listenHost: '127.0.0.1',
    listenPort: port,
    tokenFile,
    workspacePath: path.join(tmp, 'inbox'),
    sessionCwd: path.join(tmp, 'inbox'),
    receiptFile,
    batchFile: path.join(tmp, 'batches.json'),
    catchUpOnStart: false,
    catchUpDelayMs: 600000,
    historySyncIntervalMs: 3600000,
    registerIntervalMs: 3600000,
    settleHookCommand: '',
    receiptDigest: 'off',
    receiptMode: 'queue',
    digestIdleDebounceMs: 500,
    logFile,
  })
  const base = `http://127.0.0.1:${port}`
  const tool = (name) => state.tools.find((entry) => entry.name === name)
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  const receiptRows = () =>
    fs.existsSync(receiptFile)
      ? fs.readFileSync(receiptFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
  const requesterPrompts = () => state.prompts.filter((prompt) => prompt.sessionId === REQ)
  const close = () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already closed */
      }
    }
    process.env.HOME = previousEnv.HOME
    process.env.USERPROFILE = previousEnv.USERPROFILE
    process.env.MESH_WAKER_SESSIONS_ROOT = previousEnv.MESH_WAKER_SESSIONS_ROOT
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  await sleep(100)
  return { base, state, tool, close, request, log, receiptRows, requesterPrompts }
}

// A realistic consultation answer: long enough that a 300-char summary cannot hold it.
const ANSWER = [
  'pixiv 图床该用哪个代理端口：',
  '1) 首选 10809（PassWall 的一级池出口，与 SP-WB 同一网段，实测 pixiv 直连成功率最高）。',
  '2) 回退链：10809 → 10818 → 10808，任一 502 就顺延，不要原地重试。',
  '3) 别用 SP-WB：它的出口被 Cloudflare 拦，pixiv 会拿到 403。',
  '4) 上传并发压到 2，否则 429。',
  '（以下为重复说明，用来把正文撑到 2KB 量级，模拟真实答复。）',
].join('\n') + '\n' + '补充说明：'.padEnd(4) + 'x'.repeat(1600)

const complete = (h, args) => h.tool('mesh_complete').execute(args, { sessionId: WORKER })
const dispatch = (h, taskId) =>
  h.tool('mesh_dispatch').execute({ target: 'ca worker', text: `consult ${taskId}`, taskId }, { sessionId: REQ })

// ── a. a long answer reaches the receipt and the dispatcher is pointed at it ──
test('consult answer: mesh_complete({answer}) stores the full text and tells the dispatcher where to read it (T-487)', async () => {
  const h = await startHarness()
  try {
    await dispatch(h, 'T-ca-long')
    await waitFor(() => /digest|pending/.test(h.log()))
    assert.ok(ANSWER.length > 300, 'the fixture must be longer than a summary')

    const result = await complete(h, {
      taskId: 'T-ca-long',
      status: 'done',
      summary: '推荐 10809，回退 10818/10808，别用 SP-WB',
      answer: ANSWER,
    })
    assert.equal(result.ok, true)
    assert.equal(result.answerChars, Array.from(ANSWER).length)

    const receipt = h.receiptRows().find((row) => row.taskId === 'T-ca-long')
    assert.ok(receipt, `expected a receipt row, saw ${JSON.stringify(h.receiptRows())}`)
    assert.equal(receipt.answer, ANSWER, 'the receipt carries the whole answer')
    assert.equal(receipt.answerChars, Array.from(ANSWER).length)
    assert.ok(Array.from(receipt.summary).length <= 300, 'summary stays the short signal')
    assert.equal(receipt.answerTruncated ?? false, false)

    // The answer is readable through the API, which is what the notice points at.
    const row = await h.request(h.base, '/mesh/tasks/T-ca-long')
    assert.equal(row.json?.task?.receiptAnswer, ANSWER)
    assert.equal(row.json?.task?.receiptAnswerChars, Array.from(ANSWER).length)

    // The dispatcher is notified, and the notice says where the full text lives.
    assert.ok(await waitFor(() => h.requesterPrompts().length > 0), 'the dispatcher must be notified')
    const notice = JSON.stringify(h.requesterPrompts()[0].content)
    assert.match(notice, /T-ca-long/)
    assert.match(notice, /完整答复/)
    assert.match(notice, /receiptAnswer/)
    assert.ok(!notice.includes('x'.repeat(200)), 'the notice must not carry the whole answer')
  } finally {
    h.close()
  }
})

// ── b. without an answer nothing changes (regression) ────────────────────────
test('consult answer: omitting answer keeps the receipt and notice exactly as before (T-487)', async () => {
  const h = await startHarness()
  try {
    await dispatch(h, 'T-ca-plain')
    await complete(h, { taskId: 'T-ca-plain', status: 'done', summary: 'ordinary work, no answer' })
    const receipt = h.receiptRows().find((row) => row.taskId === 'T-ca-plain')
    assert.ok(receipt)
    assert.equal(receipt.answer ?? null, null)
    assert.equal(receipt.answerChars ?? null, null)
    assert.equal(receipt.answerTruncated ?? null, null)
    assert.equal(receipt.summary, 'ordinary work, no answer')
    const row = await h.request(h.base, '/mesh/tasks/T-ca-plain')
    assert.equal(row.json?.task?.receiptAnswer ?? null, null)
    assert.ok(await waitFor(() => h.requesterPrompts().length > 0))
    const notice = JSON.stringify(h.requesterPrompts()[0].content)
    assert.doesNotMatch(notice, /完整答复/)
    assert.doesNotMatch(notice, /receiptAnswer/)
  } finally {
    h.close()
  }
})

// ── c. an oversized answer is cut and says so ────────────────────────────────
test('consult answer: an oversized answer is truncated and flagged, never silently dropped (T-487)', async () => {
  const h = await startHarness()
  try {
    await dispatch(h, 'T-ca-huge')
    const huge = 'y'.repeat(25_000)
    const result = await complete(h, { taskId: 'T-ca-huge', status: 'done', summary: 'huge', answer: huge })
    assert.equal(result.answerChars, 25_000)
    assert.equal(result.answerTruncated, true)
    const receipt = h.receiptRows().find((row) => row.taskId === 'T-ca-huge')
    assert.equal(Array.from(receipt.answer).length, 20_000)
    assert.equal(receipt.answerChars, 25_000)
    assert.equal(receipt.answerTruncated, true)
  } finally {
    h.close()
  }
})

// ── d. an empty answer is not an answer ─────────────────────────────────────
test('consult answer: a blank answer behaves like no answer at all (T-487)', async () => {
  const h = await startHarness()
  try {
    await dispatch(h, 'T-ca-blank')
    const result = await complete(h, { taskId: 'T-ca-blank', status: 'done', summary: 's', answer: '   \n  ' })
    assert.equal(result.answerChars ?? null, null)
    const receipt = h.receiptRows().find((row) => row.taskId === 'T-ca-blank')
    assert.equal(receipt.answer ?? null, null)
  } finally {
    h.close()
  }
})
