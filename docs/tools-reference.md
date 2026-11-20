<!-- drift: waker=* hub=* owner=docs -->
# 工具参数参考（自动生成）

> **本文件由 `node scripts/gen-tool-reference.mjs` 生成，不要手工编辑。**
> 数据源：`plugins/mesh-waker/lib/tools.mjs`。改参数 → 跑一次生成器 → 否则 `check-tool-docs` 判红。
>
> 为什么生成而不是手写：owner 2026-11-20 指出「同步文档不该靠催」。此前 `mesh_dispatch.mode`
> （steer 的派活入口）**在任何文档里都不存在**，而同一概念的 `mesh_send.delivery` 写了两处——
> 因为参数只活在代码里、文档靠手抄。手抄必漂移，所以只认代码。

## `mesh_ack`

> Mark tasks as acknowledged on the board: no receipt, no injection, no waiting — it only stops future digests for those tasks. Acking is NOT completion: the task still needs mesh_complete, and an ack does NOT stop the unclaimed-task watchdog (T-485) — that alarm exists precisely for the announced-but-never-declared window after an ack. Defaults to tasks of the calling session; force:true lets a coordinator ack another session’s tasks (risk: the worker stops being reminded). dismissClaim:true is a different action: the requesting side explicitly stops watching a task, so the watchdog never warns about it (the target session cannot dismiss its own task). At most 50 ids per call; returns {acked, skipped:[{id, reason}]} with reason one of not-found | not-mine | already-acked | settled (dismissClaim returns {dismissed, skipped} with reason dismiss-is-requester-side).

| 参数 | 类型 / 取值 | 必填 | 说明 |
|---|---|---|---|
| `ids` | array | 是 | Task ids to acknowledge (≤50). |
| `force` | boolean |  | Allow acking tasks that belong to another session (coordinator only; hides the reminder from the worker). |
| `dismissClaim` | boolean |  | Stop the unclaimed-task watchdog for these tasks (requester side only; a worker cannot silence its own task). Distinct from an ack: dismissal says "do not warn me about this one", ack says "I saw it". |

## `mesh_ask`

> Ask a human a question through the mesh inbox and wait for an answer. Use it when a decision needs the owner (ship or not, which option, continue or stop); it is NOT a security gate — dangerous commands must keep going through approvals. Accepts free text or 2–6 numbered options; the answer comes back as text. On timeout it returns {status:"unanswered"} and never guesses a default.

| 参数 | 类型 / 取值 | 必填 | 说明 |
|---|---|---|---|
| `question` | string | 是 | Question text, at most 2000 characters. |
| `options` | array |  | Optional 2–6 choices; the answer may be a number. |
| `to` | string |  | Peer to ask; defaults to questionBridge.to. |
| `timeoutSeconds` | number |  | How long to wait (30–3600, default questionBridge.timeoutSeconds). |

## `mesh_cancel`

> Stop the running turn of a dispatched task (or of an explicit session) and settle its receipt as aborted. Pass task (task id) or session (session id / exact title / unique title substring); at least one is required, and both must resolve to the same session. This stops the turn only: the session stays alive and is NOT deleted or archived — use /mesh/sessions/delete to remove a session. Returns turnWasOpen/turnStopped/sessionLive and the receipt status; 404 for an unknown task, 409 when there is nothing to cancel. dryRun:true answers the same question WITHOUT stopping anything: it returns turnWasOpen/turn/sessionLive and changes no state — no cancel, no receipt, no task row. Use it to check whether a session is still running.

| 参数 | 类型 / 取值 | 必填 | 说明 |
|---|---|---|---|
| `task` | string |  | Task id whose target session should be stopped (e.g. T-mwasu2ot). |
| `session` | string |  | Session id, exact title, or a unique title substring to stop. |
| `reason` | string |  | Short reason recorded in the receipt (reasonDetail: "cancelled by <caller>: <reason>"). |
| `dryRun` | boolean |  | Read-only probe: report whether a turn is running here and change nothing (no cancel, no receipt, no row update). Defaults to false — the real cancel. |

## `mesh_complete`

> Declare the outcome of a task dispatched to THIS session. status done|partial|blocked settles the task immediately with source=declared; summary is your own ≤300-char summary for the receipt file. For a consultation — a task whose deliverable IS the answer — pass the full text as answer: it is stored in the receipt and served as receiptAnswer by GET /mesh/tasks/<id>, while the notice the dispatcher receives carries the summary plus one line saying where to read the whole answer. answer is optional and bounded (20k chars; beyond that it is cut and flagged answerTruncated). Unknown tasks, tasks of other sessions, and already-settled tasks are rejected (already-settled returns alreadySettled:true). Tasks that never call this still settle from turn/end with source=observed.

| 参数 | 类型 / 取值 | 必填 | 说明 |
|---|---|---|---|
| `taskId` | string | 是 | Task id from the [TASK …] header. |
| `status` | `done` \| `partial` \| `blocked` | 是 | done \| partial \| blocked |
| `summary` | string |  | Your own summary (≤300 chars), stored in receipts.jsonl only. |
| `detail` | string |  | One-line reason when blocked (goes into the receipt reasonDetail). |
| `answer` | string |  | Full answer text for a consultation task (bounded at 20k chars). Stored in the receipt and returned as receiptAnswer by GET /mesh/tasks/<id>; the dispatcher notice says where to read it. Omit for ordinary work tasks — summary alone is then exactly as before. |

## `mesh_dispatch`

> Send work to another session. ONE entry for both cases — the plugin routes it for you: target = a local session (id / unique title substring) → injected locally; target = a known remote agent name (another machine) → sent over the hub. Never hand-pick between "local" and "hub" yourself; that choice is the source of past mistakes. Returns immediately with taskId; do NOT poll or wait for the result — the waker writes a receipt when that turn ends (file by default). Pass the same batchId for several tasks to get exactly one aggregate notice after all of them finish (batch barrier). Pass a thread id to group follow-ups: once bound, a later dispatch may omit target and goes to the same session. Set createIfMissing:true to create the session when target does not resolve. A created session always lives in a workspace: it inherits the caller session’s cwd by default, or the absolute path you pass as workspacePath; a cross-workspace create is refused. requester names the session that should receive the receipt (usually passed by the CLI; models may omit it).

| 参数 | 类型 / 取值 | 必填 | 说明 |
|---|---|---|---|
| `target` | string |  | Session id / unique title substring (local dispatch), or a registered remote agent name such as "hermes" (hub dispatch). Required unless a known `thread` is given. There is no "send to myself": this machine’s own agent id is never a valid target — name the session instead. |
| `text` | string | 是 | Task text, delivered verbatim after a one-line [TASK …] header (max 64 KiB). |
| `workspacePath` | string |  | Absolute workspace path for a session created by createIfMissing (e.g. <workspace>). Omit to inherit the caller session’s workspace. Refused when it points at a different workspace than the caller’s. |
| `cwd` | string |  | Alias of workspacePath (absolute path). |
| `thread` | string |  | Optional follow-up thread id (≤128 bytes, e.g. TH-1). A known thread lets you omit target and keeps binding follow-ups to the same session. |
| `requester` | string |  | Session id or title that receives the receipt (the dispatcher). Usually set by the CLI; the tool handler also uses the caller session when the host exposes it. |
| `subject` | string |  | Readable task title for the registry/panel (≤120 chars). Omit to derive one from the first line of text. |
| `createIfMissing` | boolean |  | Create a session titled with target when it does not resolve (default false). |
| `mode` | `queue` \| `steer` |  | queue (default) or steer. |
| `taskId` | string |  | Receipt task id; a T-<base36 timestamp> is generated when omitted. |
| `batchId` | string |  | Batch barrier id: one aggregate receipt after every task ends. |
| `receipt` | `file` \| `queue` \| `wake` |  | Override the plugin receipt mode. Omit to inherit it — the default is queue (the requester gets notified; with receiptDigest on, via the merged digest). Use file for a quiet, JSONL-only receipt with no notification. |
| `receiptSummary` | boolean |  | Include the worker’s summary in the receipt notice (default false: the notice is a status line only; error/lost add one reason line). The summary is always stored in receipts.jsonl and readable from GET /mesh/tasks/<id>. For a batch this opts the whole batch into summaries. |
| `expectBranch` | string |  | Optional branch the target workspace is expected to sit on. A mismatch only produces a warning (dispatch response and receipt); it never blocks the task. |
| `artifacts` | array |  | Up to 10 paths relative to the target workspace that the task should produce. Settlement lists each as {path, exists, sizeBytes, mtimeMs} in the receipt (and the batch record); missing files are listed with exists:false. Absolute paths and .. are rejected. The plugin never creates files. |
| `deadline` | string |  | Batch deadline such as 30m / 2h / 600s. |

## `mesh_lock`

> Advisory workspace lock. acquire serialises git-changing dispatches in one workspace: new dispatches to a locked workspace queue as waiting-lock instead of racing the worktree (they are not rejected). release frees the lock; status shows the holder and expiry. In-memory per process (a restart drops every lock), never blocks reads, and never creates worktrees or switches branches.

| 参数 | 类型 / 取值 | 必填 | 说明 |
|---|---|---|---|
| `action` | `acquire` \| `release` \| `status` | 是 | acquire \| release \| status |
| `workspace` | string |  | Workspace slug or cwd; defaults to the calling session’s workspace. |
| `ttlMs` | number |  | Lock lifetime in ms (default workspaceLockTtlMs, clamped 10s–1h). |
| `reason` | string |  | Why the workspace is locked (visible to waiters). |

## `mesh_tasks`

> List tasks dispatched to this session (or an explicit session). status=unacked (default) lists tasks that are unacked and not closed, so it is the board a digest points at: open tasks plus settled tasks whose receipt is still unacked (receiptDigest); status=all lists every task of the session. include=text adds each task body, and a body whose file is gone comes back with textMissing:true instead of failing. count is the number of returned rows and unackedCount is how many of those rows are unacked — both computed from the same list.

| 参数 | 类型 / 取值 | 必填 | 说明 |
|---|---|---|---|
| `session` | string |  | Session id to inspect (coordinator use); defaults to the calling session. |
| `include` | `meta` \| `text` |  | meta (default) = ids/titles; text also returns each task body. |
| `status` | `unacked` \| `all` |  | unacked (default) = ackedAt empty and (not settled, or settled with an unacked receipt digest); all = every task of the session. |
| `limit` | number |  | Maximum rows (1–100, default 20). |

## `mesh_thread`

> Inspect or change thread bindings. list (scope mine|all) shows bindings; subscribe binds the calling session to a thread (refused when another session owns it); release unbinds a thread only for its current owner, after which dispatches without target report unknown thread.

| 参数 | 类型 / 取值 | 必填 | 说明 |
|---|---|---|---|
| `action` | `list` \| `subscribe` \| `release` | 是 | list \| subscribe \| release |
| `thread` | string |  | Thread id for subscribe/release (≤128 bytes, e.g. TH-1). |
| `scope` | `mine` \| `all` |  | list scope: mine (default) or all. |

