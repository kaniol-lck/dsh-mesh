import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyOverdue, describeOverdue, DEFAULT_UNREAD_OVERDUE_MS } from '../plugins/mesh-waker/lib/unread-watchdog.mjs'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

function message(id, { ageMs = 0, read = false, conversation = 'conv/a', subject = 's' } = {}) {
  return { id, created_at: NOW - ageMs, read_at: read ? NOW - 1000 : null, conversation, subject }
}

test('unread watchdog: fresh unread mail is not overdue', () => {
  const result = classifyOverdue([message('m1', { ageMs: 5 * 60 * 1000 })], { now: NOW })
  assert.equal(result.count, 0)
  assert.equal(result.oldestAgeMs, null)
})

test('unread watchdog: unread mail past the threshold is overdue', () => {
  const result = classifyOverdue([message('m1', { ageMs: DEFAULT_UNREAD_OVERDUE_MS + 1 })], { now: NOW })
  assert.equal(result.count, 1)
  assert.equal(result.overdue[0].id, 'm1')
  assert.ok(result.oldestAgeMs > DEFAULT_UNREAD_OVERDUE_MS)
})

test('unread watchdog: read mail is never overdue, however old', () => {
  const result = classifyOverdue([message('m1', { ageMs: 10 * HOUR, read: true })], { now: NOW })
  assert.equal(result.count, 0)
})

test('unread watchdog: rows without a usable timestamp are ignored, not counted as fresh', () => {
  const result = classifyOverdue(
    [
      { id: 'no-ts', read_at: null },
      { id: 'zero', created_at: 0, read_at: null },
      { id: 'bad', created_at: 'not-a-number', read_at: null },
    ],
    { now: NOW },
  )
  assert.equal(result.count, 0)
})

test('unread watchdog: reports the oldest first so the worst case is visible', () => {
  const result = classifyOverdue(
    [
      message('young', { ageMs: DEFAULT_UNREAD_OVERDUE_MS + 1000 }),
      message('oldest', { ageMs: 3 * HOUR }),
      message('middle', { ageMs: HOUR }),
    ],
    { now: NOW },
  )
  assert.equal(result.count, 3)
  assert.deepEqual(result.overdue.map((row) => row.id), ['oldest', 'middle', 'young'])
})

test('unread watchdog: the threshold is configurable', () => {
  const messages = [message('m1', { ageMs: 10 * 60 * 1000 })]
  assert.equal(classifyOverdue(messages, { now: NOW, thresholdMs: 5 * 60 * 1000 }).count, 1)
  assert.equal(classifyOverdue(messages, { now: NOW, thresholdMs: 30 * 60 * 1000 }).count, 0)
})

test('unread watchdog: describeOverdue stays a single line and handles empty input', () => {
  assert.equal(describeOverdue(null), 'none')
  assert.equal(describeOverdue({ count: 0 }), 'none')
  assert.match(describeOverdue({ count: 2, oldestAgeMs: 90 * 60 * 1000 }), /^2 unread \(oldest 90m\)$/)
})
