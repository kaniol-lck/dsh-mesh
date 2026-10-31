import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { findDeadKeys, findDeclarations } from '../scripts/check-config-usage.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-config-usage.mjs')

const LIVE = [
  'const config = {',
  '  pollMs: Number(c.pollMs ?? 30000),',
  '  quiet: c.quiet !== false,',
  '  logMaxBytes: clampInterval(c.logMaxBytes, 1024),',
  '}',
  'setInterval(tick, config.pollMs)',
  'if (config.quiet) log(config.logMaxBytes)',
]

const DEAD = [
  'const config = {',
  '  pollMs: Number(c.pollMs ?? 30000),',
  '  maxInlineBytes: Number(c.maxInlineBytes ?? 4096),',
  '}',
  'setInterval(tick, config.pollMs)',
]

function fixture(lines) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'config-usage-'))
  writeFileSync(path.join(dir, 'index.js'), lines.join('\n') + '\n', 'utf8')
  writeFileSync(path.join(dir, 'README.md'), '| `pollMs` | 30000 | x |\n| `maxInlineBytes` | 4096 | x |\n', 'utf8')
  return dir
}

function run(dir, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, '--index', path.join(dir, 'index.js'), '--readme', path.join(dir, 'README.md'), ...extra], {
    encoding: 'utf8',
  })
}

test('usage: every declared key is referenced', () => {
  const dir = fixture(LIVE)
  const result = run(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /DEAD 0/)
})

test('usage: a key that is only declared is reported DEAD', () => {
  const dir = fixture(DEAD)
  const result = run(dir, ['--json'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed.dead.map((item) => item.key), ['maxInlineBytes'])
  assert.equal(parsed.dead[0].describedInReadme, true)
})

test('usage: the exclusion table suppresses known display-only keys', () => {
  const lines = ['const config = {', '  agentPreset: String(c.agentPreset ?? ""),', '  logMaxBytes: c.logMaxBytes,', '}']
  const dir = fixture(lines)
  const result = run(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('usage: declarations are found for multi-line objects', () => {
  const declarations = findDeclarations(['  permissionPresetByTrust: {', "    strict: 'read-only',", '    ...(c.permissionPresetByTrust ?? {}),', '  },' ])
  assert.equal(declarations.get('permissionPresetByTrust'), 1)
})

test('usage: dead detection ignores the declaration line itself', () => {
  const { code, dead } = findDeadKeys(DEAD, new Map())
  assert.equal(code, 2)
  assert.deepEqual(dead.map((item) => item.key), ['maxInlineBytes'])
})
