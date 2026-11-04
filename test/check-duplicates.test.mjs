import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { semanticStatus } from '../scripts/check-duplicates.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-duplicates.mjs')

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-duplicates-'))
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  mkdirSync(path.join(dir, 'test'), { recursive: true })
  const body = '#!/usr/bin/env node\n' + Array.from({ length: 40 }, (_, index) => `// line ${index}`).join('\n')
  writeFileSync(path.join(dir, 'scripts', 'tool.mjs'), body, 'utf8')
  writeFileSync(path.join(dir, 'test', 'tool.mjs'), body, 'utf8')
  return dir
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
}

test('duplicates: --root scans another checkout and reports the duplicate', () => {
  const dir = fixture()
  const result = run(['--root', dir])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /scripts\/tool\.mjs/)
  assert.match(result.stdout, /test\/tool\.mjs/)
  assert.match(result.stdout, /建议：保留/)
})

test('duplicates: --root with --json reports the scanned root', () => {
  const dir = fixture()
  const result = run(['--root', dir, '--json'])
  assert.equal(result.status, 1)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.ok, false)
  assert.ok(parsed.root.endsWith(path.basename(dir)))
})

test('duplicates: a missing --root is a usage error', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-duplicates-missing-'))
  const result = run(['--root', path.join(dir, 'nope')])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--root is not a directory/)
})

test('duplicates: --help exits 0 and mentions --root', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--root <dir>/)
})

test('duplicates: semantic group allows one implementation plus shells', () => {
  const members = [
    { path: 'plugins/x/bin/dispatch.mjs', lines: 276, text: '#!/usr/bin/env node' },
    { path: 'scripts/mesh-dispatch.mjs', lines: 132, text: "execFileSync('node', ['plugins', 'x', 'bin', 'dispatch.mjs']) // scripts/mesh-dispatch.mjs" },
    { path: '.worklog/bin/mesh-dispatch.mjs', lines: 12, text: "spawnSync(process.execPath, ['scripts/mesh-dispatch.mjs'])" },
  ]
  const status = semanticStatus(members)
  assert.equal(status.ok, true)
  assert.equal(status.canonical, 'plugins/x/bin/dispatch.mjs')
  assert.equal(status.shells.length, 2)
})

test('duplicates: two implementations in a semantic group fail', () => {
  const members = [
    { path: 'scripts/a.mjs', lines: 300, text: 'impl' },
    { path: 'plugins/x/bin/a.mjs', lines: 280, text: 'impl2' },
  ]
  const status = semanticStatus(members)
  assert.equal(status.ok, false)
  assert.equal(status.implementations.length, 2)
})

test('duplicates: a renamed byte-identical copy is reported', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-duplicates-renamed-'))
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  mkdirSync(path.join(dir, 'test'), { recursive: true })
  writeFileSync(path.join(dir, 'scripts', 'original.mjs'), '#!/usr/bin/env node\nconst x = 1\n', 'utf8')
  writeFileSync(path.join(dir, 'test', 'renamed.mjs'), '#!/usr/bin/env node\nconst x = 1\n', 'utf8')
  const result = run(['--root', dir])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /改名副本/)
  assert.match(result.stdout, /original\.mjs/)
  assert.match(result.stdout, /renamed\.mjs/)
})
