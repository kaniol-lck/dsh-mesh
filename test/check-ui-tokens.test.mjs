import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-ui-tokens.mjs')

function fixture(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-tokens-'))
  const file = path.join(dir, 'ui.js')
  writeFileSync(file, body, 'utf8')
  return file
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
}

test('ui-tokens: a clean file has zero violations', () => {
  const file = fixture("const a = 'var(--dsw-alias-bg-layer-1)'\nconst b = { color: 'currentColor' }\n")
  const result = run(['--paths', file, '--json'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.totals.rawColorCount, 0)
  assert.equal(parsed.totals.rawFontSizeCount, 0)
})

test('ui-tokens: hex colours and fontSize numbers are counted', () => {
  const file = fixture("a = { color: '#fff', borderColor: '#2f9e6e', fontSize: 12 }\nb = { color: '#fff' }\n")
  const result = run(['--paths', file, '--json'])
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.totals.rawColorCount, 3)
  assert.equal(parsed.totals.distinctColorCount, 2)
  assert.equal(parsed.totals.rawFontSizeCount, 1)
})

test('ui-tokens: --dsw token references are counted but not violations', () => {
  const file = fixture("const c = 'var(--dsw-alias-border-l1)'\nconst d = '--dsw-radius-sm'\n")
  const result = run(['--paths', file, '--json'])
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.totals.tokenRefCount, 2)
  assert.equal(parsed.totals.rawColorCount, 0)
})

test('ui-tokens: --strict passes inside the baseline and fails above it', () => {
  const file = fixture("const c = '#2f9e6e'\n")
  const baseline = path.join(path.dirname(file), 'baseline.json')
  const update = run(['--paths', file, '--baseline', baseline, '--update-baseline'])
  assert.equal(update.status, 0, update.stdout + update.stderr)
  const inside = run(['--paths', file, '--baseline', baseline, '--strict'])
  assert.equal(inside.status, 0, inside.stdout + inside.stderr)
  writeFileSync(file, "const c = '#2f9e6e'\nconst d = '#000'\n", 'utf8')
  const above = run(['--paths', file, '--baseline', baseline, '--strict'])
  assert.equal(above.status, 1, above.stdout + above.stderr)
  assert.match(above.stdout, /strict: FAIL/)
})

test('ui-tokens: --help exits 0 and documents the two violation kinds', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /rawColor/)
  assert.match(result.stdout, /rawFontSize/)
})
