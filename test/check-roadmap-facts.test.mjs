import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { findLeaks, parseDeployDecl, parseVersionDecl } from '../scripts/check-roadmap-facts.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-roadmap-facts.mjs')

const VERSION_ROW = '| 版本一致性 | ✅ `HUB_VERSION` = `hub/package.json` = **9.9.9**，`CHANGES` 有 `v9.9.9`；waker `package.json` = 8.8.8 |'
const DEPLOY_ROW = '| hub 部署 | **9.9.9 已部署** |'

function fixture(lines) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'roadmap-facts-'))
  writeFileSync(path.join(dir, 'ROADMAP.md'), lines.join('\n') + '\n', 'utf8')
  return dir
}

function run(dir, extra = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--roadmap', path.join(dir, 'ROADMAP.md'), '--hub-version', '9.9.9', '--waker-version', '8.8.8', ...extra],
    { encoding: 'utf8', env: { ...process.env, MESH_HUB_HEALTH_URL: '' } },
  )
}

test('facts: consistent version declaration exits 0', () => {
  const dir = fixture(['# demo', VERSION_ROW, DEPLOY_ROW])
  const result = run(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /版本声明 OK/)
  assert.match(result.stdout, /部署 SKIP/)
  assert.match(result.stdout, /泄漏 OK/)
})

test('facts: wrong version declaration is a MISMATCH', () => {
  const dir = fixture(['# demo', VERSION_ROW.replaceAll('9.9.9', '0.7.99'), DEPLOY_ROW])
  const result = run(dir, ['--json'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.versionDecl.ok, false)
  assert.equal(parsed.ok, false)
})

test('facts: a real IPv4 in the file is a LEAK', () => {
  // 运行时拼接：测试文件里出现公网 IP 字面量会被 check-paths 当成泄漏（它分不清示例与真实）。
  const badIp = ['120', '1', '2', '3'].join('.')
  const dir = fixture(['# demo', VERSION_ROW, '| 实时核对 | `curl http://' + badIp + ':8790/health` |', DEPLOY_ROW])
  const result = run(dir)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /LEAK 第 3 行/)
})

test('facts: loopback and placeholders are not leaks', () => {
  const dir = fixture(['# demo', VERSION_ROW, '`curl http://127.0.0.1:8790/health` <NAS-IP> <EDGE-PORT>', DEPLOY_ROW])
  const result = run(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('facts: missing ROADMAP skips everything with exit 0', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'roadmap-facts-missing-'))
  const result = spawnSync(process.execPath, [SCRIPT, '--roadmap', path.join(dir, 'nope.md')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /SKIP/)
})

test('parsers: version row and deploy row', () => {
  assert.deepEqual(parseVersionDecl(VERSION_ROW), { hub: '9.9.9', waker: '8.8.8' })
  assert.equal(parseDeployDecl(DEPLOY_ROW), '9.9.9')
  assert.deepEqual(findLeaks('| x | 10.0.0.5 |\n| y | 127.0.0.1 |'), [{ line: 1, text: '| x | 10.0.0.5 |' }])
})
