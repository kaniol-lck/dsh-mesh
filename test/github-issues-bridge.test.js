/**
 * Local-server tests for scripts/github-issues-bridge.mjs — no network, no real GitHub.
 *
 *   node --test test/github-issues-bridge.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pollIssues, stripCodeBlocks, resolveGithubAuth, authLogLine } from '../scripts/github-issues-bridge.mjs'

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function issue(number, title, { login = 'alice', type = 'User', labels = [], body = 'plain body' } = {}) {
  return {
    number,
    title,
    state: 'open',
    body,
    user: { login, type },
    labels: labels.map((name) => ({ name })),
    html_url: `https://github.com/acme/demo/issues/${number}`,
    updated_at: '2026-10-30T00:00:00Z',
  }
}

async function fakeHub() {
  const posts = []
  const server = await listen((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      posts.push({ method: req.method, body: raw ? JSON.parse(raw) : null })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end('{"id":"msg"}')
    })
  })
  return { ...server, posts }
}

async function fakeGithub(issues, { etag = 'W/"1"', throttleOnce = false } = {}) {
  const methods = []
  let calls = 0
  const server = await listen((req, res) => {
    methods.push(req.method)
    calls += 1
    if (throttleOnce && calls === 1) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"message":"rate limited"}')
      return
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', etag })
    res.end(JSON.stringify(issues))
  })
  return { ...server, methods, calls: () => calls }
}

function makeOptions(githubUrl, hubUrl, stateFile, extra = {}) {
  return {
    repo: 'acme/demo',
    hub: hubUrl,
    githubApi: githubUrl,
    conversation: 'issues/acme/demo',
    stateFile,
    meshToken: ['mesh', 'test', 'token'].join('_'),
    to: 'triage',
    maxBodyChars: 400,
    fetchImpl: fetch,
    log: () => {},
    sleep: async () => {},
    ...extra,
  }
}

test('two issues become two summaries without code blocks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'issues-bridge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const github = await fakeGithub([
    issue(1, 'First bug', { labels: ['needs-triage'], body: 'intro\n```\nsecret log\n```\noutro' }),
    issue(2, 'Second bug', { body: 'plain' }),
  ])
  const hub = await fakeHub()
  t.after(async () => { await github.close(); await hub.close() })

  const result = await pollIssues(makeOptions(github.url, hub.url, join(dir, 'state.json')))
  assert.equal(result.sent, 2)
  assert.equal(hub.posts.length, 2)
  for (const post of hub.posts) {
    assert.equal(post.method, 'POST')
    assert.match(post.body.body, /^来源=外部未验证（GitHub issue）/)
    assert.equal(post.body.body.includes('```'), false)
    assert.equal(post.body.conversation, 'issues/acme/demo')
    assert.equal(post.body.to, 'triage')
  }
  assert.equal(stripCodeBlocks('a\n```\nx\n```\nb'), 'a\n\nb')
  assert.equal(github.methods.every((method) => method === 'GET'), true, 'bridge must never write to GitHub')
})

test('a second poll with the same ETag sends nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'issues-bridge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const github = await fakeGithub([issue(1, 'Only bug')])
  const hub = await fakeHub()
  t.after(async () => { await github.close(); await hub.close() })

  const options = makeOptions(github.url, hub.url, join(dir, 'state.json'))
  await pollIssues(options)
  const second = await pollIssues(options)
  assert.equal(firstSent(hub), 1)
  assert.equal(second.sent, 0)
  assert.equal(hub.posts.length, 1)
  assert.equal(github.methods.every((method) => method === 'GET'), true)
})

function firstSent(hub) {
  return hub.posts.length
}

test('label filter and bot author are skipped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'issues-bridge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const github = await fakeGithub([
    issue(1, 'Triaged', { labels: ['needs-triage'] }),
    issue(2, 'Untriaged'),
    issue(3, 'Bot report', { type: 'Bot' }),
  ])
  const hub = await fakeHub()
  t.after(async () => { await github.close(); await hub.close() })

  const result = await pollIssues(makeOptions(github.url, hub.url, join(dir, 'state.json'), { label: 'needs-triage' }))
  assert.equal(result.sent, 1)
  assert.equal(hub.posts.length, 1)
  assert.match(hub.posts[0].body.subject, /Triaged/)
})

test('HTTP 429 backs off before retrying', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'issues-bridge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const github = await fakeGithub([issue(1, 'After throttle')], { throttleOnce: true })
  const hub = await fakeHub()
  t.after(async () => { await github.close(); await hub.close() })

  const delays = []
  const result = await pollIssues(makeOptions(github.url, hub.url, join(dir, 'state.json'), {
    sleep: async (ms) => { delays.push(ms) },
  }))
  assert.equal(result.sent, 1)
  assert.equal(delays.length, 1)
  assert.equal(delays[0], 5000)
})

test('resolves the gh CLI token and never logs its value', async () => {
  const token = ['ghp', 'a'.repeat(36)].join('_')
  const auth = await resolveGithubAuth({
    env: {},
    execFileImpl: (command, args, options, callback) => {
      assert.equal(command, 'gh')
      assert.deepEqual(args, ['auth', 'token'])
      callback(null, `${token}\n`)
    },
  })
  assert.equal(auth.source, 'gh-cli')
  assert.equal(auth.token, token)
  const line = authLogLine(auth)
  assert.match(line, /gh-cli/)
  assert.equal(line.includes(token), false, 'log line must not contain the token')
})

test('environment token wins over the gh CLI', async () => {
  let called = false
  const auth = await resolveGithubAuth({
    env: { GITHUB_TOKEN: ['env', 'token', 'value'].join('-') },
    execFileImpl: () => { called = true },
  })
  assert.equal(auth.source, 'env')
  assert.equal(called, false)
})

test('corrupt state fails loudly instead of double-sending', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'issues-bridge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'state.json')
  await import('node:fs').then((fs) => fs.writeFileSync(stateFile, '{not json'))
  const github = await fakeGithub([issue(1, 'x')])
  const hub = await fakeHub()
  t.after(async () => { await github.close(); await hub.close() })

  await assert.rejects(
    () => pollIssues(makeOptions(github.url, hub.url, stateFile)),
    /state file is corrupt/,
  )
})
