import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

function spawnFixture({ exitCode, stdout, stderr = '' }) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'roadmap-status-spawn-'))
  const root = path.join(base, 'repo')
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  mkdirSync(path.join(root, 'skills', 'worklog', 'scripts'), { recursive: true })
  mkdirSync(path.join(root, '.worklog'), { recursive: true })
  copyFileSync(SCRIPT, path.join(root, 'scripts', 'check-roadmap-status.mjs'))
  writeFileSync(
    path.join(root, 'skills', 'worklog', 'scripts', 'roadmap.mjs'),
    `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${exitCode})`,
    'utf8',
  )
  writeFileSync(path.join(root, '.worklog', 'gates.json'), '{}', 'utf8')
  writeFileSync(path.join(base, 'ROADMAP.md'), '# demo\n\n## 本阶段焦点\n\n八关口 **2 个达成**（G1 a / G2 b）。\n', 'utf8')
  return path.join(root, 'scripts', 'check-roadmap-status.mjs')
}

function runScript(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' })
}

test('spawn: a non-zero roadmap exit with valid JSON still compares', () => {
  const stdout = JSON.stringify({ gates: [{ id: 'G1', satisfied: true }, { id: 'G2', satisfied: true }] })
  const result = runScript(spawnFixture({ exitCode: 1, stdout }))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /OK 一致/)
  assert.match(result.stderr, /note: roadmap exited 1/)
})

test('spawn: corrupt JSON is reported with stderr and a stdout head', () => {
  const result = runScript(spawnFixture({ exitCode: 0, stdout: 'not json at all' }))
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /输出无法解析/)
  assert.match(result.stderr, /stdout 前几行/)
  assert.match(result.stderr, /not json at all/)
})

test('spawn: empty stdout keeps the child stderr in the error', () => {
  const result = runScript(spawnFixture({ exitCode: 2, stdout: '', stderr: 'boom from roadmap' }))
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /boom from roadmap/)
})
