import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'skills', 'worklog', 'scripts', 'roadmap.mjs')

function fixture(gates) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'roadmap-checks-'))
  mkdirSync(path.join(dir, '.worklog', 'todo'), { recursive: true })
  writeFileSync(path.join(dir, '.worklog', 'todo', 'main.md'), '<!-- session: main · updated: 2026-01-01 -->\n', 'utf8')
  writeFileSync(path.join(dir, '.worklog', 'gates.json'), JSON.stringify({ gates }, null, 2), 'utf8')
  writeFileSync(
    path.join(dir, 'ROADMAP.md'),
    '# demo\n\n<!-- AUTO:TODO START -->\n<!-- AUTO:TODO END -->\n',
    'utf8',
  )
  return dir
}

function run(dir, mode, extra = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--worklog-dir', path.join(dir, '.worklog'), '--out', path.join(dir, 'ROADMAP.md'), '--gates', path.join(dir, '.worklog', 'gates.json'), mode, ...extra],
    { cwd: dir, encoding: 'utf8' },
  )
}

function gate(requires) {
  return [{ id: 'G1', name: 'demo', question: 'q?', requires }]
}

function jsonGates(dir, extra = []) {
  const result = run(dir, '--json', extra)
  return JSON.parse(result.stdout).gates
}

/** --check runs checks and caches; --write then renders them; a second --check is consistent. */
function stabilize(dir) {
  run(dir, '--check')
  run(dir, '--write')
  return run(dir, '--check')
}

test('check: exit 0 satisfies the gate', () => {
  const dir = fixture(gate([{ check: { label: 'ok', command: 'node -e "process.exit(0)"' } }]))
  const result = stabilize(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const gates = jsonGates(dir)
  assert.equal(gates[0].satisfied, true)
  assert.equal(gates[0].checks[0].ok, true)
})

test('check: failing check blocks the gate but --check still exits 0', () => {
  const dir = fixture(gate([{ check: { label: 'bad', command: 'node -e "process.exit(1)"' } }]))
  const result = stabilize(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /WARN check「bad」失败/)
  const gates = jsonGates(dir)
  assert.equal(gates[0].satisfied, false)
  assert.equal(gates[0].checks[0].ok, false)
})

test('check: --fail-on-check turns a failed check into exit 1', () => {
  const dir = fixture(gate([{ check: { label: 'bad', command: 'node -e "process.exit(1)"' } }]))
  stabilize(dir)
  const result = run(dir, '--check', ['--fail-on-check'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /--fail-on-check/)
})

test('check: optional failure only warns', () => {
  const dir = fixture(gate([{ check: { label: 'opt', command: 'node -e "process.exit(1)"', optional: true } }]))
  const result = stabilize(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /optional，不阻塞/)
  const gates = jsonGates(dir)
  assert.equal(gates[0].satisfied, true)
  assert.equal(gates[0].checks[0].optional, true)
})

test('check: --write does not execute checks', () => {
  const marker = 'marker.txt'
  const dir = fixture(gate([{ check: { label: 'touch', command: `node -e "require('fs').writeFileSync('${marker}','x')"` } }]))
  run(dir, '--write')
  assert.equal(existsSync(path.join(dir, marker)), false, '--write must not run checks')
  run(dir, '--check')
  assert.equal(existsSync(path.join(dir, marker)), true, '--check must run checks')
})

test('check: timeout counts as failure and does not hang', () => {
  const dir = fixture(gate([{ check: { label: 'slow', command: 'node -e "setTimeout(()=>{},5000)"', timeoutMs: 200 } }]))
  const started = Date.now()
  const result = stabilize(dir)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 6000, `checks took ${elapsed}ms`)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const gates = jsonGates(dir)
  assert.equal(gates[0].satisfied, false)
  assert.equal(gates[0].checks[0].ok, false)
})
