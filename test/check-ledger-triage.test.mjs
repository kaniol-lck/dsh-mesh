import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { queueTriage } from '../scripts/check-ledger.mjs'

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-triage-'))
  const triageDir = path.join(dir, 'triage')
  mkdirSync(triageDir, { recursive: true })
  const queueFile = path.join(dir, 'queue.md')
  writeFileSync(
    queueFile,
    [
      '| 单号 | 角色 | 任务 | 派出 | 期望 | 状态 |',
      '|---|---|---|---|---|---|',
      '| T-A | docs | missing stamp | 2026-11-04 10:00 | x | done |',
      '| T-B | docs | reviewed | 2026-11-04 11:00 | x | deployed |',
      '| T-C | docs | historical | 2026-11-03 09:00 | x | done |',
      '| T-D | docs | open | 2026-11-04 12:00 | x | dispatched |',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(path.join(triageDir, 'T-B.json'), JSON.stringify({ taskId: 'T-B', verdict: 'red', needsReview: true }), 'utf8')
  return { queueFile, triageDir }
}

test('ledger triage: a done row since 2026-11-04 without a stamp is missing', () => {
  const { queueFile, triageDir } = fixture()
  const result = queueTriage(queueFile, triageDir)
  assert.deepEqual(result.missing.map((item) => item.taskId), ['T-A'])
  assert.equal(result.missing[0].line, 3)
})

test('ledger triage: needsReview stamps are accepted but listed', () => {
  const { queueFile, triageDir } = fixture()
  const result = queueTriage(queueFile, triageDir)
  assert.deepEqual(result.reviewed.map((item) => item.taskId), ['T-B'])
})

test('ledger triage: rows before 2026-11-04 and open rows are ignored', () => {
  const { queueFile, triageDir } = fixture()
  const result = queueTriage(queueFile, triageDir)
  const all = [...result.missing, ...result.reviewed].map((item) => item.taskId)
  assert.ok(!all.includes('T-C'), 'historical row must be exempt')
  assert.ok(!all.includes('T-D'), 'dispatched row must be ignored')
})
