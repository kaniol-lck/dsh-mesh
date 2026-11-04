import assert from 'node:assert/strict'
import test from 'node:test'
import { scanOwners } from '../scripts/check-todo-owners.mjs'

const ALLOWED = ['waker', 'docs', 'hub', 'ops', '协调']

test('owners: role slugs pass', () => {
  const result = scanOwners({ 'a.md': ['- [P1] x —— y；归属：docs；状态：未开始'] }, ALLOWED)
  assert.equal(result.checked, 1)
  assert.deepEqual(result.violations, [])
})

test('owners: a session title is rejected with file and line', () => {
  const result = scanOwners({ 'a.md': ['line', '- [P1] x —— y；归属：mesh · waker；状态：未开始'] }, ALLOWED)
  assert.equal(result.violations.length, 1)
  assert.deepEqual(result.violations[0], { file: 'a.md', line: 2, value: 'mesh · waker' })
})

test('owners: a sentence swallowed into the field is rejected', () => {
  const result = scanOwners({ 'b.md': ['- [P1] x —— y；归属：协调（实现预计跨 waker）；状态：未开始'] }, ALLOWED)
  assert.equal(result.violations[0].value, '协调（实现预计跨 waker）')
})

test('owners: multiple owners on one line are each checked', () => {
  const result = scanOwners({ 'c.md': ['归属：docs；归属：ops；归属：hub'] }, ALLOWED)
  assert.equal(result.checked, 3)
  assert.deepEqual(result.violations, [])
})
