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
    receiptSummary: {
      type: 'boolean',
      description:
        'Include the worker\u2019s summary in the receipt notice (default false: the notice is a status line only; error/lost add one reason line). The summary is always stored in receipts.jsonl and readable from GET /mesh/tasks/<id>. For a batch this opts the whole batch into summaries.',
    },
    expectBranch: {
      type: 'string',
      description:
        'Optional branch the target workspace is expected to sit on. A mismatch only produces a warning (dispatch response and receipt); it never blocks the task.',
    },
    artifacts: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Up to 10 paths relative to the target workspace that the task should produce. Settlement lists each as {path, exists, sizeBytes, mtimeMs} in the receipt (and the batch record); missing files are listed with exists:false. Absolute paths and .. are rejected. The plugin never creates files.',
    },
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
      // Always present, null when the dispatch carried no taskId (host validates the value,
      // not just presence: a null under `type: string` throws ToolOutputError).
      taskId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      batchId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      mode: { type: 'string' },
      created: { type: 'boolean' },
      warning: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      requester: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      // T-402 fields: always present, null when unknown (declared so the contract is explicit).
      workspacePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      workspace: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      // Dispatch-time git snapshot (T-416); null when the target cwd is not a git repo.
      git: {
        oneOf: [
          {
            type: 'object',
            properties: {
              cwd: { type: 'string' },
              branch: { type: 'string' },
              head: { type: 'string' },
              dirty: { type: 'boolean' },
            },
            required: ['cwd', 'branch', 'head', 'dirty'],
          },
          { type: 'null' },
        ],
      },
      warnings: { type: 'array', items: { type: 'string' } },
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
            // A thread may be bound before anything is dispatched and its binding row may
            // predate a field: the host rejects null under `type: string` (T-413).
            targetSessionId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            targetTitle: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            count: { type: 'number' },
            lastTaskId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            updatedAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
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
 * Stop the turn behind a dispatched task (T-403). This is NOT session deletion: the session
 * stays alive so it can receive the next task. Deleting a session remains /mesh/sessions/delete.
 */
export const MESH_CANCEL_TOOL = {
  name: 'mesh_cancel',
  description:
    'Stop the running turn of a dispatched task (or of an explicit session) and settle its receipt as aborted. ' +
    'Pass task (task id) or session (session id / exact title / unique title substring); at least one is required, and both must resolve to the same session. ' +
    'This stops the turn only: the session stays alive and is NOT deleted or archived — use /mesh/sessions/delete to remove a session. ' +
    'Returns turnWasOpen/turnStopped/sessionLive and the receipt status; 404 for an unknown task, 409 when there is nothing to cancel.',
  parameters: {
    task: { type: 'string', description: 'Task id whose target session should be stopped (e.g. T-mwasu2ot).' },
    session: { type: 'string', description: 'Session id, exact title, or a unique title substring to stop.' },
    reason: { type: 'string', description: 'Short reason recorded in the receipt (reasonDetail: "cancelled by <caller>: <reason>").' },
  },
  required: [],
}

export const CANCEL_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      action: { type: 'string' },
      taskId: { type: 'string' },
      sessionId: { type: 'string' },
      by: { type: 'string' },
      turnWasOpen: { type: 'boolean' },
      turnStopped: { type: 'boolean' },
      sessionLive: { type: 'boolean' },
      taskStatus: { type: 'string' },
      receipt: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['taskId', 'status'],
      },
    },
    required: ['ok', 'action'],
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Advisory workspace lock (T-418). Owner decision B+C: lock a workspace so git-changing tasks
 * run one at a time, without the plugin creating worktrees or switching branches.
 */
export const MESH_LOCK_TOOL = {
  name: 'mesh_lock',
  description:
    'Advisory workspace lock. acquire serialises git-changing dispatches in one workspace: new dispatches to a locked workspace queue as waiting-lock instead of racing the worktree (they are not rejected). release frees the lock; status shows the holder and expiry. In-memory per process (a restart drops every lock), never blocks reads, and never creates worktrees or switches branches.',
  parameters: {
    action: { type: 'string', required: true, enum: ['acquire', 'release', 'status'], description: 'acquire | release | status' },
    workspace: { type: 'string', description: 'Workspace slug or cwd; defaults to the calling session\u2019s workspace.' },
    ttlMs: { type: 'number', description: 'Lock lifetime in ms (default workspaceLockTtlMs, clamped 10s\u20131h).' },
    reason: { type: 'string', description: 'Why the workspace is locked (visible to waiters).' },
  },
  required: ['action'],
}

export const LOCK_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      action: { type: 'string' },
      workspace: { type: 'string' },
      released: { type: 'boolean' },
      renewed: { type: 'boolean' },
      lock: {
        oneOf: [
          {
            type: 'object',
            properties: {
              workspace: { type: 'string' },
              ownerSessionId: { type: 'string' },
              ownerLabel: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              reason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              acquiredAt: { type: 'number' },
              expiresAt: { type: 'number' },
            },
            required: ['workspace', 'ownerSessionId', 'acquiredAt', 'expiresAt'],
          },
          { type: 'null' },
        ],
      },
    },
    required: ['ok', 'action', 'workspace'],
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/** Board-side task listing for the session that received the work (T-459). */
export const MESH_TASKS_TOOL = {
  name: 'mesh_tasks',
  description:
    'List tasks dispatched to this session (or an explicit session). status=unacked (default) lists tasks that are unacked and unsettled, so it is the board a digest points at; status=all lists every task of the session. include=text adds each task body, and a body whose file is gone comes back with textMissing:true instead of failing. count is the number of returned rows and unackedCount is how many of those rows are unacked — both computed from the same list.',
  parameters: {
    session: { type: 'string', description: 'Session id to inspect (coordinator use); defaults to the calling session.' },
    include: { type: 'string', enum: ['meta', 'text'], description: 'meta (default) = ids/titles; text also returns each task body.' },
    status: {
      type: 'string',
      enum: ['unacked', 'all'],
      description: 'unacked (default) = ackedAt empty and not settled; all = every task of the session.',
    },
    limit: { type: 'number', description: 'Maximum rows (1–100, default 20).' },
  },
  required: [],
}

export const TASKS_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      sessionId: { type: 'string' },
      include: { type: 'string' },
      status: { type: 'string' },
      count: { type: 'number' },
      unackedCount: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            subject: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            status: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            acked: { type: 'boolean' },
            ackedAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
            ackBy: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            notifiedAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
            notifyCount: { type: 'number' },
            createdAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
            targetTitle: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            text: { type: 'string' },
            textMissing: { type: 'boolean' },
          },
          required: ['taskId', 'acked', 'notifyCount'],
        },
      },
    },
    required: ['ok', 'sessionId', 'count', 'unackedCount', 'tasks'],
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Ack is a *board marker* (T-459): it tells the waker "I have seen this notice, stop waking me
 * for it". It never completes the task, never writes a receipt and never wakes anybody.
 */
export const MESH_ACK_TOOL = {
  name: 'mesh_ack',
  description:
    'Mark tasks as acknowledged on the board: no receipt, no injection, no waiting — it only stops future digests for those tasks. Acking is NOT completion: the task still needs mesh_complete. Defaults to tasks of the calling session; force:true lets a coordinator ack another session\u2019s tasks (risk: the worker stops being reminded). At most 50 ids per call; returns {acked, skipped:[{id, reason}]} with reason one of not-found | not-mine | already-acked | settled.',
  parameters: {
    ids: { type: 'array', items: { type: 'string' }, required: true, description: 'Task ids to acknowledge (≤50).' },
    force: { type: 'boolean', description: 'Allow acking tasks that belong to another session (coordinator only; hides the reminder from the worker).' },
  },
  required: ['ids'],
}

export const ACK_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      acked: { type: 'array', items: { type: 'string' } },
      skipped: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['id', 'reason'],
        },
      },
    },
    required: ['ok', 'acked', 'skipped'],
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
