// Tool schemas and output validators (T-292): pure data/validation, no plugin state.
import { durationToMs } from './text.mjs'

const TOOL_SCHEMA_CONSTRAINTS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const TOOL_SCHEMA_ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const TOOL_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])


/**
 * Model-callable dispatch tool. It lives in the plugin so any project gets local
 * multi-session dispatch without this repository's scripts/.
 */
export const MESH_DISPATCH_TOOL = {
  name: 'mesh_dispatch',
  description:
    'Dispatch a task text into another local DSH session (same machine, no hub). target = session id, full title, or a unique title substring. ' +
    'Returns immediately with taskId; do NOT poll or wait for the result — the waker writes a receipt when that turn ends (file by default). ' +
    'Pass the same batchId for several tasks to get exactly one aggregate notice after all of them finish (batch barrier). ' +
    'Pass a thread id to group follow-ups: once bound, a later dispatch may omit target and goes to the same session. ' +
    'Set createIfMissing:true to create the session when target does not resolve. A created session always lives in a workspace: it inherits the caller session\u2019s cwd by default, or the absolute path you pass as workspacePath; a cross-workspace create is refused. ' +
    'requester names the session that should receive the receipt (usually passed by the CLI; models may omit it).',
  parameters: {
    target: { type: 'string', description: 'Session id, full title, or a unique title substring. Required unless a known `thread` is given.' },
    text: { type: 'string', required: true, description: 'Task text, delivered verbatim after a one-line [TASK …] header (max 64 KiB).' },
    workspacePath: {
      type: 'string',
      description:
        'Absolute workspace path for a session created by createIfMissing (e.g. D:\\projects\\proj). Omit to inherit the caller session\u2019s workspace. Refused when it points at a different workspace than the caller\u2019s.',
    },
    cwd: { type: 'string', description: 'Alias of workspacePath (absolute path).' },
    thread: {
      type: 'string',
      description: 'Optional follow-up thread id (≤128 bytes, e.g. TH-1). A known thread lets you omit target and keeps binding follow-ups to the same session.',
    },
    requester: {
      type: 'string',
      description:
        'Session id or title that receives the receipt (the dispatcher). Usually set by the CLI; the tool handler also uses the caller session when the host exposes it.',
    },
    subject: {
      type: 'string',
      description: 'Readable task title for the registry/panel (≤120 chars). Omit to derive one from the first line of text.',
    },
    createIfMissing: {
      type: 'boolean',
      description: 'Create a session titled with target when it does not resolve (default false).',
    },
    mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue (default) or steer.' },
    taskId: { type: 'string', description: 'Receipt task id; a T-<base36 timestamp> is generated when omitted.' },
    batchId: { type: 'string', description: 'Batch barrier id: one aggregate receipt after every task ends.' },
    receipt: { type: 'string', enum: ['file', 'queue', 'wake'], description: 'Override the plugin receipt mode.' },
    deadline: { type: 'string', description: 'Batch deadline such as 30m / 2h / 600s.' },
  },
  required: ['text'],
}

/**
 * Model-callable "ask the human" tool. This is a coordination channel, not a security
 * gate: approvals stay on approval/request and fail closed.
 */
export const MESH_ASK_TOOL = {
  name: 'mesh_ask',
  description:
    'Ask a human a question through the mesh inbox and wait for an answer. Use it when a decision needs the owner (ship or not, which option, continue or stop); it is NOT a security gate — dangerous commands must keep going through approvals. ' +
    'Accepts free text or 2–6 numbered options; the answer comes back as text. On timeout it returns {status:"unanswered"} and never guesses a default.',
  parameters: {
    question: { type: 'string', required: true, description: 'Question text, at most 2000 characters.' },
    options: { type: 'array', items: { type: 'string' }, description: 'Optional 2–6 choices; the answer may be a number.' },
    to: { type: 'string', description: 'Peer to ask; defaults to questionBridge.to.' },
    timeoutSeconds: { type: 'number', description: 'How long to wait (30–3600, default questionBridge.timeoutSeconds).' },
  },
  required: ['question'],
}

/**
 * The host enforces a JSON Schema subset: one scalar `type`, `oneOf`, object
 * `properties`/`required`/boolean `additionalProperties`, array `items`, scalar
 * `enum`/`const`, plus annotations. `type: ['string', 'null']` is valid JSON Schema but
 * NOT in that subset — it silently kept mesh_dispatch from ever registering (T-236).
 */
export const DISPATCH_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      sessionId: { type: 'string' },
      title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      taskId: { type: 'string' },
      batchId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      mode: { type: 'string' },
      created: { type: 'boolean' },
      warning: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['ok', 'sessionId', 'taskId', 'mode', 'created'],
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export const ASK_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      answer: { type: 'string' },
      by: { type: 'string' },
      ms: { type: 'number' },
      questionId: { type: 'string' },
      timeoutSeconds: { type: 'number' },
    },
    required: ['status', 'questionId'],
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Worker-side completion tool (0.7.31): the session doing the work declares the outcome
 * instead of waker guessing from turn/end. `summary` is whatever the worker writes (receipt
 * file only); `detail` becomes the reason line for blocked tasks.
 */
export const MESH_COMPLETE_TOOL = {
  name: 'mesh_complete',
  description:
    'Declare the outcome of a task dispatched to THIS session. status done|partial|blocked settles the task immediately with source=declared; summary is your own ≤300-char summary for the receipt file. Unknown tasks, tasks of other sessions, and already-settled tasks are rejected (already-settled returns alreadySettled:true). Tasks that never call this still settle from turn/end with source=observed.',
  parameters: {
    taskId: { type: 'string', required: true, description: 'Task id from the [TASK …] header.' },
    status: { type: 'string', required: true, enum: ['done', 'partial', 'blocked'], description: 'done | partial | blocked' },
    summary: { type: 'string', description: 'Your own summary (≤300 chars), stored in receipts.jsonl only.' },
    detail: { type: 'string', description: 'One-line reason when blocked (goes into the receipt reasonDetail).' },
  },
  required: ['taskId', 'status'],
}

export const COMPLETE_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      taskId: { type: 'string' },
      status: { type: 'string' },
      receiptStatus: { type: 'string' },
      source: { type: 'string' },
      alreadySettled: { type: 'boolean' },
      summary: { type: 'string' },
    },
    required: ['ok', 'taskId', 'status'],
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Worker-side thread tool (0.7.23): a worker can see, take over, or hand back a thread.
 * `list` is read-only; `subscribe` binds the caller session (refuses to steal); `release`
 * unbinds only for the current owner, after which dispatches without target hit
 * "unknown thread" — that is the hand-back-to-coordinator semantics.
 */
export const MESH_THREAD_TOOL = {
  name: 'mesh_thread',
  description:
    'Inspect or change thread bindings. list (scope mine|all) shows bindings; subscribe binds the calling session to a thread (refused when another session owns it); release unbinds a thread only for its current owner, after which dispatches without target report unknown thread.',
  parameters: {
    action: { type: 'string', required: true, enum: ['list', 'subscribe', 'release'], description: 'list | subscribe | release' },
    thread: { type: 'string', description: 'Thread id for subscribe/release (≤128 bytes, e.g. TH-1).' },
    scope: { type: 'string', enum: ['mine', 'all'], description: 'list scope: mine (default) or all.' },
  },
  required: ['action'],
}

export const THREAD_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      action: { type: 'string' },
      thread: { type: 'string' },
      released: { type: 'boolean' },
      scope: { type: 'string' },
      threads: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            thread: { type: 'string' },
            targetSessionId: { type: 'string' },
            targetTitle: { type: 'string' },
            count: { type: 'number' },
            lastTaskId: { type: 'string' },
            updatedAt: { type: 'number' },
            subscribedBy: { type: 'string' },
            taskIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: ['ok', 'action'],
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Validate a tool output definition against the host's enforced JSON Schema subset.
 * Returns `{ ok, issues }`; this is the guard test that would have caught T-236
 * (`type: ['string','null']` is rejected by the host, not by JSON Schema).
 */
export function validateToolSchema(definition, path = 'schema') {
  const issues = []
  const walk = (node, at) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      issues.push(`${at} must be a schema object`)
      return
    }
    for (const key of Object.keys(node)) {
      if (!TOOL_SCHEMA_CONSTRAINTS.has(key) && !TOOL_SCHEMA_ANNOTATIONS.has(key)) {
        issues.push(`${at}.${key} is not supported by the host schema subset`)
      }
    }
    if (node.type !== undefined) {
      if (Array.isArray(node.type)) {
        issues.push(`${at}.type must be a single type string (type arrays are not supported)`)
      } else if (!TOOL_SCHEMA_TYPES.has(node.type)) {
        issues.push(`${at}.type must be one of ${[...TOOL_SCHEMA_TYPES].join(', ')}`)
      }
    }
    if (node.oneOf !== undefined) {
      if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) issues.push(`${at}.oneOf must be a non-empty array`)
      else node.oneOf.forEach((child, index) => walk(child, `${at}.oneOf[${index}]`))
    }
    if (node.properties !== undefined) {
      if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        issues.push(`${at}.properties must be an object`)
      } else {
        for (const [key, child] of Object.entries(node.properties)) walk(child, `${at}.properties.${key}`)
      }
    }
    if (node.items !== undefined) walk(node.items, `${at}.items`)
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
      issues.push(`${at}.additionalProperties must be a boolean`)
    }
    if (node.required !== undefined && !Array.isArray(node.required)) issues.push(`${at}.required must be an array`)
  }
  walk(definition && definition.schema, path)
  if (!definition || !definition.schema || definition.schema.type !== 'object') {
    issues.push(`${path} must be an object-rooted schema for tool output`)
  }
  return { ok: issues.length === 0, issues }
}

export function buildDispatchMeta({ taskId, batchId, deadline } = {}, now = Date.now()) {
  return {
    taskId: String(taskId ?? '').trim() || `T-${now.toString(36)}`,
    batchId: String(batchId ?? '').trim() || null,
    deadlineMs: durationToMs(deadline),
  }
}
