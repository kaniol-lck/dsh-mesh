import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { compare, parseDeclared } from '../scripts/check-roadmap-status.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-roadmap-status.mjs')

function fixture({ count, ids, actual }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'roadmap-status-'))
  const list = ids.map((id) => `${id} 示例`).join(' / ')
  writeFileSync(
    path.join(dir, 'ROADMAP.md'),
    `# demo\n\n## 现在\n\n## 本阶段焦点（手写）\n\n八关口 **${count} 个达成**（${list}）。其余待办。\n\n## 待办汇总\n`,
    'utf8',
  )
  writeFileSync(
    path.join(dir, 'gates.json'),
    JSON.stringify({ gates: actual.map((id) => ({ id, satisfied: true })) }),
    'utf8',
  )
  return dir
}

function run(dir, extra = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--roadmap', path.join(dir, 'ROADMAP.md'), '--gates-json', path.join(dir, 'gates.json'), ...extra],
    { encoding: 'utf8' },
  )
}

test('status: consistent declaration exits 0', () => {
  const dir = fixture({ count: 2, ids: ['G1', 'G2'], actual: ['G1', 'G2'] })
  const result = run(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /OK 一致/)
})

test('status: declaring one more gate than actual is a mismatch', () => {
  const dir = fixture({ count: 3, ids: ['G1', 'G2', 'G3'], actual: ['G1', 'G2'] })
  const result = run(dir, ['--json'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.ok, false)
  assert.deepEqual(parsed.declared.ids, ['G1', 'G2', 'G3'])
  assert.deepEqual(parsed.actual.ids, ['G1', 'G2'])
})

test('status: missing ROADMAP is skipped with exit 0', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'roadmap-status-missing-'))
  const result = spawnSync(process.execPath, [SCRIPT, '--roadmap', path.join(dir, 'nope.md')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /SKIP/)
})

test('parseDeclared: reads the count and the gate ids', () => {
  const text = '## 本阶段焦点（手写）\n\n八关口 **6 个达成**（G1 a / G2 b / G7 c）。G6 回到 ⏳。\n\n## next\n'
  const declared = parseDeclared(text)
  assert.equal(declared.count, 6)
  assert.deepEqual(declared.ids.sort(), ['G1', 'G2', 'G7'])
})

test('compare: extra id in the declared list is detected', () => {
  const result = compare({ count: 2, ids: ['G1', 'G6'] }, ['G1', 'G2'])
  assert.equal(result.ok, false)
  assert.deepEqual(result.extraInDeclared, ['G6'])
  assert.deepEqual(result.missingInDeclared, ['G2'])
})
