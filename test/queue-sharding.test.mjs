import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { duplicateQueueTaskIds } from '../scripts/check-ledger.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SYNC = path.join(ROOT, 'scripts', 'queue-sync.mjs')

function tempWorklog() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'queue-sync-'))
  mkdirSync(path.join(dir, 'dispatch', 'queue'), { recursive: true })
  return dir
}

function run(worklog, args) {
  return spawnSync(process.execPath, [SYNC, ...args], { encoding: 'utf8', env: { ...process.env, MESH_WORKLOG_DIR: worklog } })
}

const rows = (file) => file.split(/\r?\n/).filter((line) => /^\|\s*[A-Za-z0-9]/.test(line))

test('queue-sync: two sessions write their own shards and both appear in the aggregate', () => {
  const worklog = tempWorklog()
  assert.equal(run(worklog, ['--session', 'session-a', '--row', '| T-A | docs | a | 2026-11-07 01:00 | x | dispatched |']).status, 0)
  assert.equal(run(worklog, ['--session', 'session-b', '--row', '| T-B | docs | b | 2026-11-07 01:01 | x | dispatched |']).status, 0)
  const aggregate = rows(readFileSync(path.join(worklog, 'dispatch', 'queue.md'), 'utf8'))
  assert.deepEqual(aggregate.map((line) => line.split('|')[1].trim()), ['T-A', 'T-B'])
  assert.equal(run(worklog, ['--check']).status, 0)
})

test('queue-sync: a stale aggregate fails --check', () => {
  const worklog = tempWorklog()
  run(worklog, ['--session', 'session-a', '--row', '| T-A | docs | a | 2026-11-07 01:00 | x | dispatched |'])
  writeFileSync(path.join(worklog, 'dispatch', 'queue.md'), '| T-OLD | docs | hand edit | x | x | done |\n', 'utf8')
  const result = run(worklog, ['--check'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /stale/)
})

test('queue-sync: --migrate is dry-run by default and preserves the row count with --apply', () => {
  const worklog = tempWorklog()
  const aggregatePath = path.join(worklog, 'dispatch', 'queue.md')
  mkdirSync(path.dirname(aggregatePath), { recursive: true })
  writeFileSync(aggregatePath, [
    '# old ledger',
    '| 单号 | 归属 | 任务 | 派出时间 | 期望产物 | 状态 |',
    '|---|---|---|---|---|---|',
    '| T-1 | docs | one | 2026-11-01 10:00 | x | done |',
    '| T-2 | docs | two | 2026-11-01 11:00 | x | done |',
    '',
  ].join('\n'), 'utf8')
  const dry = run(worklog, ['--migrate'])
  assert.equal(dry.status, 0)
  assert.match(dry.stdout, /dry-run/)
  assert.match(dry.stdout, /2 rows/)
  assert.equal(rows(readFileSync(aggregatePath, 'utf8')).length, 2, 'dry-run must not rewrite')
  const applied = run(worklog, ['--migrate', '--apply'])
  assert.equal(applied.status, 0)
  assert.match(applied.stdout, /aggregate rows 2/)
  assert.equal(rows(readFileSync(aggregatePath, 'utf8')).length, 2)
  assert.equal(run(worklog, ['--check']).status, 0)
})

test('check-ledger: the same taskId in two shards is a conflict with file:line', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'queue-conflict-'))
  writeFileSync(path.join(dir, 'session-a.md'), '| T-X | docs | a | t | x | dispatched |\n', 'utf8')
  writeFileSync(path.join(dir, 'session-b.md'), '| T-X | docs | b | t | x | dispatched |\n', 'utf8')
  const conflicts = duplicateQueueTaskIds(dir)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].taskId, 'T-X')
  assert.deepEqual(conflicts[0].rows.map((row) => row.file).sort(), ['session-a.md', 'session-b.md'])
})
