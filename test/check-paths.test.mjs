import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-paths.mjs')

function repoWith(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-paths-'))
  assert.equal(spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' }).status, 0)
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' }).status, 0)
  return dir
}

function check(dir) {
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' })
}

const upstreamOnly = JSON.stringify({ name: 'dsh-mesh-skills', repository: { url: 'git+https://github.com/kaniol-lck/dsh-mesh.git' } })

test('check-paths: skills/package.json upstream metadata is allowed', () => {
  const dir = repoWith({ 'skills/package.json': upstreamOnly })
  const result = check(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-paths: OK/)
})

test('check-paths: the allowlist does not hide a real drive path in skills/package.json', () => {
  const dir = repoWith({ 'skills/package.json': `${upstreamOnly}\n// local: D:\\Users\\alice\\secret\n` })
  const result = check(dir)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /skills\/package\.json:\d+: 盘符绝对路径/)
})

test('check-paths: the allowlist does not hide a private LAN address in skills/package.json', () => {
  const dir = repoWith({ 'skills/package.json': `${upstreamOnly}\n// hub: 192.168.10.77\n` })
  const result = check(dir)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /内网 IP/)
})

test('check-paths: a non-allowlisted file with the same username is still reported', () => {
  const dir = repoWith({ 'other/package.json': upstreamOnly })
  const result = check(dir)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /本机标识/)
})
