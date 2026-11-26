/**
 * Tests for scripts/check-no-memory-only-death.mjs (T-mwxjfvwn).
 *
 * The gate exists because `reconcileOrphanTasks()` declared a task dead from one fact: the new
 * process had no in-memory handle for it. That is a statement about memory; the task's fate
 * belongs to the session, and a DSH session survives a restart. T-MWXHO5U1 was declared lost at
 * 12:30:02 while its session was still active at 12:35:39.
 *
 * The previous gate in this repo shipped with a whole-file exemption and never scanned the main
 * entry (T-mwwfvvzw), so every case here runs the REAL gate binary against a throwaway tree, and
 * the red-check proves it fails on real input rather than trusting exit 0.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = path.join(import.meta.dirname, '..')
const GATE = path.join(REPO, 'scripts', 'check-no-memory-only-death.mjs')
const PLUGIN = 'plugins/mesh-waker'

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'death-gate-'))
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }
  return root
}

function runGate(root) {
  const args = root ? [GATE, '--json', '--root', root] : [GATE, '--json']
  try {
    const stdout = execFileSync(process.execPath, args, { cwd: REPO, encoding: 'utf8' })
    return { code: 0, json: JSON.parse(stdout) }
  } catch (error) {
    let json = null
    try {
      json = JSON.parse(String(error.stdout ?? '{}'))
    } catch {
      json = null
    }
    return { code: error.status ?? 1, json }
  }
}

function withTree(files, fn) {
  const root = makeTree(files)
  try {
    return fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('death gate: a lost verdict with no liveness evidence is red', () => {
  withTree(
    {
      [`${PLUGIN}/index.js`]: [
        'function reconcileOrphans(rows) {',
        '  for (const row of rows) {',
        "    updateTaskRow(row.taskId, { status: 'lost', settledAt: Date.now() })",
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'a memory-only verdict must fail the gate')
      const issue = result.json?.issues?.[0]
      assert.ok(issue, JSON.stringify(result.json))
      assert.equal(issue.line, 3)
      assert.equal(issue.file, `${PLUGIN}/index.js`)
      assert.match(issue.reason, /memory is not the session/)
    },
  )
})

test('death gate: the same verdict passes when the function reads liveness', () => {
  withTree(
    {
      [`${PLUGIN}/index.js`]: [
        'function reconcileOrphans(rows, sessions) {',
        '  for (const row of rows) {',
        '    const session = sessions.get(row.targetSessionId)',
        '    if (session?.live === true) continue',
        "    updateTaskRow(row.taskId, { status: 'lost', settledAt: Date.now() })",
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 0, `liveness evidence must justify the verdict: ${JSON.stringify(result.json?.issues)}`)
      assert.equal(result.json?.justifiedVerdicts, '1 with evidence')
    },
  )
})

test('death gate: a nearby death-allowed marker with a reason passes', () => {
  withTree(
    {
      [`${PLUGIN}/lib/x.mjs`]: [
        'function settleEverything(rows) {',
        '  for (const row of rows) {',
        '    // death-allowed: the session record was deleted, verified by the caller',
        "    updateTaskRow(row.taskId, { status: 'lost' })",
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 0, JSON.stringify(result.json?.issues))
    },
  )
})

test('death gate: an empty marker reason is not a justification', () => {
  withTree(
    {
      [`${PLUGIN}/lib/x.mjs`]: ['function f(rows) {', '  // death-allowed:', "  return rows.map((row) => ({ ...row, status: 'lost' }))", '}', ''].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'a marker with no reason proves nothing')
    },
  )
})

test('death gate: a marker two lines above does not count', () => {
  withTree(
    {
      [`${PLUGIN}/lib/x.mjs`]: [
        'function f(rows) {',
        '  // death-allowed: legacy path',
        '  const spacer = 1',
        "  return rows.map((row) => ({ ...row, status: 'lost', spacer }))",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'proximity is the rule, not "somewhere above"')
    },
  )
})

test('death gate: prose about liveness in a comment is not evidence', () => {
  // Regression caught by this gate's own red-check: a substring test let the word "liveness"
  // inside a comment satisfy the rule, so a far-away marker silently passed.
  withTree(
    {
      [`${PLUGIN}/lib/x.mjs`]: [
        'function f(rows) {',
        '  // there is no liveness API here yet, so we just call it dead',
        "  return rows.map((row) => ({ ...row, status: 'lost' }))",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'a comment is not a liveness check')
    },
  )
})

test('death gate: buildReceipt status is not a row verdict', () => {
  withTree(
    {
      [`${PLUGIN}/lib/x.mjs`]: [
        'function makeReceipt(row) {',
        '  return buildReceipt({',
        "    status: 'lost',",
        "    reasonDetail: 'host restart',",
        '  })',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 0, 'a receipt describing a verdict is not the verdict itself')
      assert.equal(result.json?.deathVerdicts, '0 verdict lines')
    },
  )
})

test('death gate: stalled verdicts are covered too', () => {
  withTree(
    {
      [`${PLUGIN}/lib/x.mjs`]: ['function sweep(rows) {', "  rows.forEach((row) => updateTaskRow(row.id, { status: 'stalled' }))", '}', ''].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'a stall is also a death-like verdict when it comes from memory')
    },
  )
})

test('death gate: the shipped tree is clean and every verdict is justified', () => {
  const result = runGate(null)
  assert.equal(result.code, 0, `the real tree must be clean: ${JSON.stringify(result.json?.issues)}`)
  assert.equal(result.json?.unexplainedVerdicts, '0 unexplained')
  assert.ok(
    Number.parseInt(String(result.json?.deathVerdicts), 10) >= 3,
    'the tree really does contain verdicts, so the gate is looking at them',
  )
})
