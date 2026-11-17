/**
 * T-487: one dispatch entry, routed inside.
 *
 * The failure this pins down: five times in three weeks a session tried to hand work to
 * "the session on this machine" by addressing the machine's own agent id through mesh_send,
 * and the hub refused it as self-send. The fix is that `mesh_dispatch` decides — local session
 * first, remote agent second, own agent id never — so the caller does not have to know which
 * transport it is talking to.
 *
 * These are structural assertions over the real source: the routing must live in the handler,
 * not in prose telling the model to pick the right tool.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const index = readFileSync(path.join(ROOT, 'plugins/mesh-waker/index.js'), 'utf8')
const tools = readFileSync(path.join(ROOT, 'plugins/mesh-waker/lib/tools.mjs'), 'utf8')

test('dispatch routes inside the handler instead of making the model choose', () => {
  assert.match(index, /async function resolveRemoteAgentTarget\(/, 'a peer lookup must exist')
  assert.match(index, /async function dispatchOverHub\(/, 'a hub branch must exist')
  // The remote check has to sit inside the local-resolution failure path, not before it:
  // a local session must always win, otherwise a name collision silently goes off-box.
  const localTry = index.indexOf('session = resolveLocalSession(')
  const remoteCall = index.indexOf('await dispatchOverHub(explicitTarget')
  assert.ok(localTry > 0 && remoteCall > 0, 'both branches must be present')
  assert.ok(remoteCall > localTry, 'the hub branch must be reached only after local resolution fails')
})

test('this machine\'s own agent id is refused with the local route, not forwarded', () => {
  const ownId = index.indexOf("is this machine's own agent id")
  assert.ok(ownId > 0, 'the self-target guard must exist')
  const guard = index.slice(ownId - 400, ownId + 400)
  assert.match(guard, /list_local_sessions|session id|title substring/, 'the guard must name the local alternative')
  // It must throw rather than fall through to the hub: sending to yourself is never meaningful.
  assert.match(guard, /throw new Error/)
})

test('the hub branch uses the hub\'s field names and uploads the body as a blob', () => {
  const start = index.indexOf('async function dispatchOverHub')
  const body = index.slice(start, start + 4000)
  for (const field of ['task_id', 'target_agent', 'origin_ws', 'text_ref', 'text_bytes']) {
    assert.ok(body.includes(field), `hub task payload must carry ${field}`)
  }
  assert.match(body, /\/api\/blob\?name=/, 'the body must go to the blob store first')
  assert.match(body, /sha256/, 'the blob hash must be verified')
  // A half-made task must never look like a local one.
  assert.match(body, /local reference row failed/)
})

test('the tool description states one entry and forbids picking a transport', () => {
  assert.match(tools, /ONE entry/, 'the description must say it is a single entry')
  assert.match(tools, /routes it for you/i, 'the description must say routing is automatic')
  assert.match(tools, /own agent id is never a valid target/, 'the description must warn against self-addressing')
})
