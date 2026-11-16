import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { pickAliveSessions } from '../skills/spawn/scripts/spawn.mjs'

const NOW = 1_800_000_000_000
const CWD = path.join('work', 'repo')

function row(child, { createdAt = NOW - 60_000, cwd = CWD, status = 'dispatched', title = 'x' } = {}) {
  return { child, cwd, status, title, createdAt: new Date(createdAt).toISOString() }
}

function session(id, { live = true, archived = false, lastActive = NOW - 30_000 } = {}) {
  return { id, live, archived, last_active: lastActive }
}

test('spawn liveness: a live derived session blocks the next spawn', () => {
  const { alive } = pickAliveSessions([row('session-a')], [session('session-a')], { now: NOW, cwd: CWD })
  assert.equal(alive.length, 1)
  assert.equal(alive[0].child, 'session-a')
  assert.equal(alive[0].idleMs, 30_000)
})

test('spawn liveness: archived or dead sessions do not block', () => {
  const rows = [row('session-arch'), row('session-dead')]
  const sessions = [session('session-arch', { archived: true }), session('session-dead', { live: false })]
  const { alive } = pickAliveSessions(rows, sessions, { now: NOW, cwd: CWD })
  assert.deepEqual(alive, [])
})

test('spawn liveness: a row whose session is gone is unknown, not alive', () => {
  const { alive, unknown } = pickAliveSessions([row('session-gone')], [], { now: NOW, cwd: CWD })
  assert.deepEqual(alive, [])
  assert.deepEqual(unknown, ['session-gone'])
})

test('spawn liveness: rows outside the window or from another workspace do not block', () => {
  const rows = [
    row('session-old', { createdAt: NOW - 3 * 60 * 60 * 1000 }),
    row('session-other', { cwd: path.join('work', 'other') }),
    row('session-settled', { status: 'done' }),
  ]
  const sessions = [session('session-old'), session('session-other'), session('session-settled')]
  const { alive } = pickAliveSessions(rows, sessions, { now: NOW, cwd: CWD })
  assert.deepEqual(alive, [])
})

test('spawn liveness: identical titles are irrelevant — only ids and host facts count', () => {
  // The accident: the old session looked "stopped" because a receipt said lost, so a second
  // session with the same topic was spawned. Titles must never decide this.
  const sameTitle = '虾酱 · 重构讨论'
  const rows = [row('session-old', { title: sameTitle }), row('session-new', { title: sameTitle })]
  const sessions = [session('session-old', { live: true }), session('session-new', { archived: true })]
  const { alive } = pickAliveSessions(rows, sessions, { now: NOW, cwd: CWD })
  assert.equal(alive.length, 1)
  assert.equal(alive[0].child, 'session-old')
})
