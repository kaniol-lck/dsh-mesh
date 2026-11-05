/**
 * Origin scan (T-364): find which local DSH session sent the message a peer is replying to.
 *
 * Plain outbound messages go through the hub's MCP tool, not through the waker, so the waker
 * never sees the send. The session log does: every tool call is recorded with its name and
 * full arguments, so reading the tail of recent session logs identifies the origin session
 * without asking anyone to pass an id.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** Decode the tail of a (possibly multi-frame) zstd session log into text. */
export function readLogTail(file, { tailBytes = 2_000_000, maxFrames = 400 } = {}) {
  const size = statSync(file).size
  const start = Math.max(0, size - Math.max(1024, tailBytes))
  const buffer = Buffer.alloc(size - start)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, start)
  } finally {
    closeSync(fd)
  }
  // Frame starts; the first magic may be cut by the tail bound and simply fails to decode.
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1] && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
      starts.push(index)
    }
  }
  let text = ''
  for (const frameStart of starts.slice(-maxFrames)) {
    const next = starts[starts.indexOf(frameStart) + 1]
    const end = next === undefined ? buffer.length : next
    try {
      text += zstdDecompressSync(buffer.subarray(frameStart, end)).toString('utf8')
    } catch {
      /* a partial frame at the tail bound carries no complete event */
    }
  }
  return text
}

/**
 * Does a logged tool name refer to the configured tool? The host prefixes MCP tools with
 * `mcp__<server>__`, so a bare `mesh_send` must match `mcp__mesh__mesh_send` — but nothing
 * looser than that: `mesh_send_evil` or `my_mesh_send` must not match (T-365).
 */
export function toolNameMatches(name, want) {
  const actual = String(name ?? '')
  const expected = String(want ?? '')
  if (!actual || !expected) return false
  if (actual === expected) return true
  if (actual === 'mcp__' + expected) return true
  return actual.startsWith('mcp__') && actual.endsWith('__' + expected)
}

/**
 * The session that FIRST sent into `conversation` (T-366). A reply is answered by whoever
 * opened the dialogue, but every session that forwards a message also leaves a log entry, so
 * "first match in directory order" picks the wrong one. Collect every hit, keep the earliest
 * event.time; a hit without a finite time never wins; ties break on session id so the result
 * never depends on enumeration order. Returns null when nothing matches (caller → inbox).
 */
export function findOutboundSession({ sessions, conversation, toolNames = ['mesh_send', 'mcp__mesh__mesh_send'], sinceMs = 0, readTail = readLogTail } = {}) {
  const needle = JSON.stringify(String(conversation))
  const bare = needle.slice(1, -1)
  let best = null
  for (const session of sessions) {
    if (sinceMs && Number(session.mtime ?? 0) < sinceMs) continue
    const sessionId = String(session.id ?? '')
    if (!sessionId) continue
    let text
    try {
      text = readTail(session.log)
    } catch {
      continue
    }
    if (!text.includes(bare)) continue
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"tool/call"')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const data = event?.data && typeof event.data === 'object' ? event.data : {}
      const name = String(data.name ?? '')
      if (!toolNames.some((want) => toolNameMatches(name, want))) continue
      const args = String(data.arguments ?? '')
      if (!args.includes(bare)) continue
      const at = Number(event.time)
      // An entry without a usable timestamp must not pretend to be the earliest (0 would win).
      if (!Number.isFinite(at)) continue
      const better =
        !best ||
        at < best.at ||
        (at === best.at && sessionId < best.sessionId)
      if (better) {
        best = { sessionId, workspace: session.workspace ?? null, tool: name, at }
      }
    }
  }
  return best
}
