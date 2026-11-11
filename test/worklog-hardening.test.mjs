import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROADMAP = path.join(ROOT, 'skills', 'worklog', 'scripts', 'roadmap.mjs')
const HOOKS = path.join(ROOT, 'skills', 'worklog', 'scripts', 'install-hooks.mjs')

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
}

function worklogFixture(entries) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'worklog-hardening-'))
  mkdirSync(path.join(dir, '.worklog', 'todo'), { recursive: true })
  writeFileSync(
    path.join(dir, '.worklog', 'todo', 'docs.md'),
    ['# docs', '', ...entries, ''].join('\n'),
    'utf8',
  )
  writeFileSync(
    path.join(dir, 'ROADMAP.md'),
    ['# ROADMAP', '', '<!-- AUTO:TODO START -->', '<!-- AUTO:TODO END -->', ''].join('\n'),
    'utf8',
  )
  return dir
}

const GOOD = '- [P1] 好条目 —— 描述；验收：测试通过；状态：未开始；归属：docs；功能：文档；'
const NO_FEATURE = '- [P1] 缺功能 —— 描述；验收：测试通过；状态：未开始；归属：docs；'
const BAD = '- [P1] 坏条目 —— 只有描述'

test('roadmap: missing 验收/状态 exits 1 with file:line and "未写任何文件"', () => {
  const dir = worklogFixture([GOOD, BAD])
  const result = run(ROADMAP, ['--check', '--worklog-dir', path.join(dir, '.worklog'), '--out', path.join(dir, 'ROADMAP.md')], dir)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /docs\.md:4: missing 验收：/)
  assert.match(result.stderr, /校验失败（未写任何文件）/)
})

test('roadmap: --strict fails on missing 功能, default mode stays green', () => {
  const dir = worklogFixture([GOOD, NO_FEATURE])
  const worklogDir = path.join(dir, '.worklog')
  const out = path.join(dir, 'ROADMAP.md')
  const write = run(ROADMAP, ['--write', '--worklog-dir', worklogDir, '--out', out], dir)
  assert.equal(write.status, 0, write.stdout + write.stderr)
  const relaxed = run(ROADMAP, ['--check', '--worklog-dir', worklogDir, '--out', out], dir)
  assert.equal(relaxed.status, 0, relaxed.stdout + relaxed.stderr)
  const strict = run(ROADMAP, ['--check', '--strict', '--worklog-dir', worklogDir, '--out', out], dir)
  assert.equal(strict.status, 1, strict.stdout + strict.stderr)
  assert.match(strict.stderr, /docs\.md:4: missing 功能：/)
})

test('roadmap: a parse error makes --write exit 1 without touching the artifacts', () => {
  const dir = worklogFixture([GOOD])
  const worklogDir = path.join(dir, '.worklog')
  const out = path.join(dir, 'ROADMAP.md')
  assert.equal(run(ROADMAP, ['--write', '--worklog-dir', worklogDir, '--out', out], dir).status, 0)
  const before = readFileSync(out, 'utf8')
  const beforeMtime = statSync(out).mtimeMs
  writeFileSync(path.join(worklogDir, 'todo', 'docs.md'), ['# docs', '', GOOD, BAD, ''].join('\n'), 'utf8')
  const result = run(ROADMAP, ['--write', '--worklog-dir', worklogDir, '--out', out], dir)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /未写入/)
  assert.equal(readFileSync(out, 'utf8'), before)
  assert.equal(statSync(out).mtimeMs, beforeMtime)
})

test('roadmap: --write prints both absolute artifact paths', () => {
  const dir = worklogFixture([GOOD])
  const worklogDir = path.join(dir, '.worklog')
  const out = path.join(dir, 'ROADMAP.md')
  const result = run(ROADMAP, ['--write', '--worklog-dir', worklogDir, '--out', out], dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, new RegExp(`wrote ROADMAP[^\\n]*-> ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(result.stdout, new RegExp(`wrote HTML -> ${path.join(worklogDir, 'roadmap.html').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

function gitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'worklog-hooks-'))
  const init = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return dir
}

test('install-hooks: --help writes nothing', () => {
  const repo = gitRepo()
  const result = run(HOOKS, ['--help', '--repo', repo], repo)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /--apply/)
  assert.equal(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')), false)
})

test('install-hooks: dry-run writes nothing, --apply is idempotent, --uninstall removes', () => {
  const repo = gitRepo()
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
  const dry = run(HOOKS, ['--repo', repo], repo)
  assert.equal(dry.status, 0, dry.stdout + dry.stderr)
  assert.match(dry.stdout, /dry-run, nothing written/)
  assert.equal(existsSync(hook), false)

  const first = run(HOOKS, ['--apply', '--repo', repo], repo)
  assert.equal(first.status, 0, first.stdout + first.stderr)
  const content = readFileSync(hook, 'utf8')
  assert.match(content, /# generated by skills\/worklog\/scripts\/install-hooks\.mjs/)
  assert.match(content, /roadmap\.mjs.*--check/)

  const second = run(HOOKS, ['--apply', '--repo', repo], repo)
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /already installed/)
  assert.equal(readFileSync(hook, 'utf8'), content)

  const removed = run(HOOKS, ['--uninstall', '--repo', repo], repo)
  assert.equal(removed.status, 0, removed.stdout + removed.stderr)
  assert.equal(existsSync(hook), false)
})

test('install-hooks: a foreign hook is refused, --force backs it up', () => {
  const repo = gitRepo()
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho custom\n', 'utf8')
  const refused = run(HOOKS, ['--apply', '--repo', repo], repo)
  assert.equal(refused.status, 1, refused.stdout + refused.stderr)
  assert.match(refused.stderr, /not generated by this tool/)
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\necho custom\n')

  const forced = run(HOOKS, ['--apply', '--force', '--repo', repo], repo)
  assert.equal(forced.status, 0, forced.stdout + forced.stderr)
  assert.match(forced.stdout, /backed up/)
  assert.match(readFileSync(hook, 'utf8'), /# generated by skills\/worklog\/scripts\/install-hooks\.mjs/)
  const backups = readdirSync(path.join(repo, '.git', 'hooks')).filter((name) => name.startsWith('pre-commit.bak-'))
  assert.equal(backups.length, 1, backups.join(','))
})
