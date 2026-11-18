import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyOverdue, describeOverdue, DEFAULT_UNREAD_OVERDUE_MS } from '../plugins/mesh-waker/lib/unread-watchdog.mjs'
import { clampInterval, clampDuration, resolveUnreadWatchdog } from '../plugins/mesh-waker/lib/settings.mjs'

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

// ── T-mwxcog4: the wiring, not just the classifier ─────────────────────────────
// The bug was never in classifyOverdue; it was that the threshold never arrived (a three-arg
// clamp returned NaN), so these cases assert the resolved configuration itself.

test('unread watchdog wiring: the default pair is finite and positive', () => {
  const resolved = resolveUnreadWatchdog({})
  assert.ok(Number.isFinite(resolved.unreadWatchdogMs), `unreadWatchdogMs must be finite, got ${resolved.unreadWatchdogMs}`)
  assert.ok(resolved.unreadWatchdogMs > 0)
  assert.ok(Number.isFinite(resolved.unreadOverdueMs), `unreadOverdueMs must be finite, got ${resolved.unreadOverdueMs}`)
  assert.ok(resolved.unreadOverdueMs > 0)
  assert.equal(resolved.unreadWatchdogMs, 300_000)
  assert.equal(resolved.unreadOverdueMs, 1_800_000)
})

test('unread watchdog wiring: explicit values survive, and an explicit 0 still disables', () => {
  const tuned = resolveUnreadWatchdog({ unreadWatchdogMs: 60_000, unreadOverdueMs: 900_000 })
  assert.equal(tuned.unreadWatchdogMs, 60_000)
  assert.equal(tuned.unreadOverdueMs, 900_000)
  // 0 means "no timer" — clampInterval would turn that into the fallback, which is why the
  // pair goes through clampDuration instead.
  assert.equal(resolveUnreadWatchdog({ unreadWatchdogMs: 0 }).unreadWatchdogMs, 0)
  // Junk and negatives fall back to the default instead of silently disabling the watchdog.
  assert.equal(resolveUnreadWatchdog({ unreadWatchdogMs: 'soon' }).unreadWatchdogMs, 300_000)
  assert.equal(resolveUnreadWatchdog({ unreadWatchdogMs: -5 }).unreadWatchdogMs, 300_000)
  // Out-of-range values are clamped, not passed through.
  assert.equal(resolveUnreadWatchdog({ unreadWatchdogMs: 9_999_999 }).unreadWatchdogMs, 3_600_000)
  assert.equal(resolveUnreadWatchdog({ unreadOverdueMs: 1 }).unreadOverdueMs, 60_000)
})

test('unread watchdog wiring: a missing max is a loud error, not NaN', () => {
  // The exact shape of the bug: three arguments instead of four.
  assert.throws(() => clampInterval(300_000, 300_000, 0), TypeError)
  assert.throws(() => clampDuration(300_000, 300_000, 0), TypeError)
  // A correct call is unaffected.
  assert.equal(clampInterval(9_999_999, 300_000, 0, 3_600_000), 3_600_000)
})
