import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

test('script: exits 1 while real MISSING keys remain, and reports both levels', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /MISSING（任何文档都没有）/)
  assert.match(result.stdout, /NOT-IN-TABLE（README 有但配置表没列）/)
  // these three are documented in prose, so they must not be reported as MISSING
  const missingLine = result.stdout.split('\n').find((line) => line.startsWith('MISSING（')) ?? ''
  for (const key of ['tokenFile', 'wakeSecret', 'topics']) {
    assert.ok(!missingLine.includes(key), `${key} must not be MISSING`)
  }
})
