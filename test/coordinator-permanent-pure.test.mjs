import { expireCoordinators, coordinatorsView, normalizeCoordinators } from '../plugins/mesh-waker/lib/coordinators.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LEASE = 600_000

// C. the sweeper must keep permanent members and still cut finite leases.
test('expireCoordinators: a permanent member never expires, a finite lease still does (T-mwmcgl07)', () => {
  const now = 1_800_000_000_000
  const members = [
    { sessionId: 's-perm', status: 'approved', isPrimary: true, permanent: true, leaseUntil: null, claimedAt: now - 90 * 24 * 3600 * 1000 },
    { sessionId: 's-lease', status: 'approved', isPrimary: false, permanent: false, leaseUntil: now - 1, claimedAt: now - 3600_000 },
    { sessionId: 's-fresh', status: 'approved', isPrimary: false, permanent: false, leaseUntil: now + LEASE, claimedAt: now - 1000 },
    { sessionId: 's-pending', status: 'pending', requestedAt: now - 1000 },
  ]
  const changed = expireCoordinators(members, { now, pendingTtlMs: 60_000 })
  assert.equal(changed, true)
  const left = members.map((member) => member.sessionId)
  assert.deepEqual(left, ['s-perm', 's-fresh', 's-pending'], 'the expired lease is gone, the permanent one stays')
  assert.equal(members[0].status, 'approved', 'a permanent member keeps its status')
  assert.equal(members[0].leaseUntil, null)
})

// D. the public view and the normaliser both carry the flag.
test('coordinatorsView/normalizeCoordinators: permanent survives the registry round-trip (T-mwmcgl07)', () => {
  const stored = [
    { sessionId: 's-perm', status: 'approved', isPrimary: true, permanent: true, leaseUntil: null, claimedAt: 1, requestedAt: 1 },
    { sessionId: 's-lease', status: 'approved', isPrimary: false, leaseUntil: 2, claimedAt: 2, requestedAt: 2 },
  ]
  // A restart reads the file through the normaliser: the flag must not be dropped there.
  const reloaded = normalizeCoordinators(JSON.parse(JSON.stringify(stored)))
  assert.equal(reloaded[0].permanent, true)
  assert.equal(reloaded[0].leaseUntil, null)
  assert.equal(reloaded[1].permanent, false, 'absent means not permanent, not undefined')
  const view = coordinatorsView(reloaded)
  assert.equal(view[0].permanent, true)
  assert.equal(view[1].permanent, false)
})
