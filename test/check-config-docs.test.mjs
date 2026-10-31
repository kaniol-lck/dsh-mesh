import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyKeys, extractWakerKeys, tableKeysOf } from '../scripts/check-config-docs.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-config-docs.mjs')

test('classify: a key in corpus and table is fully covered', () => {
  const result = classifyKeys(['tokenFile'], 'see tokenFile here', new Set(['tokenFile']))
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.notInTable, [])
})

test('classify: a key only in prose is NOT-IN-TABLE, not MISSING', () => {
  const result = classifyKeys(['tokenFile'], 'tokenFile is described in prose', new Set())
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.notInTable, ['tokenFile'])
})

test('classify: a key absent from every document is MISSING', () => {
  const result = classifyKeys(['ghostKey'], 'nothing here', new Set())
  assert.deepEqual(result.missing, ['ghostKey'])
  assert.deepEqual(result.notInTable, [])
})

test('extract: nested access yields parent and child, builtins are excluded', () => {
  const keys = extractWakerKeys('const a = c.approvalBridge?.to; const b = c.constructor; const d = c.trust')
  assert.ok(keys.includes('approvalBridge'))
  assert.ok(keys.includes('to'))
  assert.ok(keys.includes('trust'))
  assert.ok(!keys.includes('constructor'))
})

test('tableKeys: only backticked first-column rows count', () => {
  const keys = tableKeysOf('| `tokenFile` | 说明 |\n| `wakeSecret` | 说明 |\n| 普通 | x |\n')
  assert.deepEqual([...keys], ['tokenFile', 'wakeSecret'])
})

/** Build a throwaway "repo" the script can run against: <root>/scripts/<copy of the checker>. */
function fakeRepo({ wakerSource, wakerReadme, docs = {}, hubServer = "process.env.MESH_TEST_KEY", hubDocs = "MESH_TEST_KEY" }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-config-docs-'))
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  mkdirSync(path.join(dir, 'plugins', 'mesh-waker'), { recursive: true })
  mkdirSync(path.join(dir, 'docs'), { recursive: true })
  mkdirSync(path.join(dir, 'skills', 'mesh'), { recursive: true })
  mkdirSync(path.join(dir, 'hub'), { recursive: true })
  copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-config-docs.mjs'))
  writeFileSync(path.join(dir, 'plugins', 'mesh-waker', 'index.js'), wakerSource, 'utf8')
  writeFileSync(path.join(dir, 'plugins', 'mesh-waker', 'README.md'), wakerReadme, 'utf8')
  for (const [name, body] of Object.entries(docs)) writeFileSync(path.join(dir, 'docs', name), body, 'utf8')
  writeFileSync(path.join(dir, 'skills', 'mesh', 'SKILL.md'), '# skill\n', 'utf8')
  writeFileSync(path.join(dir, 'hub', 'server.mjs'), hubServer, 'utf8')
  writeFileSync(path.join(dir, 'hub', 'README.md'), hubDocs, 'utf8')
  writeFileSync(path.join(dir, 'hub', '.env.example'), hubDocs, 'utf8')
  return dir
}

function runFixture(dir) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-config-docs.mjs')], { encoding: 'utf8' })
}

test('script: reports MISSING and NOT-IN-TABLE from a fixture, independent of this repo', () => {
  const dir = fakeRepo({
    wakerSource: 'const a = c.ghostKey; const b = c.proseKey;',
    wakerReadme: '# waker\n\nno config table here\n',
    docs: { 'extra.md': 'proseKey is described here but not in the table\n' },
  })
  const result = runFixture(dir)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /MISSING（任何文档都没有）：.*ghostKey/)
  assert.match(result.stdout, /NOT-IN-TABLE（README 有但配置表没列）：.*proseKey/)
})

test('script: a fixture with everything documented exits 0', () => {
  const dir = fakeRepo({
    wakerSource: 'const token = c.tokenFile;',
    wakerReadme: '| `tokenFile` | path | token file |\n',
  })
  const result = runFixture(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /MISSING（任何文档都没有）/)
})
