// Receipt construction and liveness derivation (T-292): pure functions, no plugin state.
import { humanDuration, truncateText } from './text.mjs'

const BATCH_STATUS_ICON = {
  completed: '✅',
  error: '❌',
  aborted: '❌',
  blocked: '❌',
  interrupted: '❌',
  'max-tokens': '❌',
  forked: '✅',
  lost: '❌',
}


/**
 * TurnEndReason -> the receipt's `status` / `reasonKind` / `reasonDetail`.
 * Kept pure (no closure state) so the mapping is testable without a host.
 */
function minutesSince(at, now) {
  if (!Number.isFinite(at) || at <= 0) return 0
  return Math.max(0, Math.floor((now - at) / 60000))
}

function oldestOf(mapLike) {
  const entries =
    mapLike instanceof Map ? [...mapLike.entries()] : mapLike && typeof mapLike === 'object' ? Object.entries(mapLike) : []
  let best = null
  for (const [id, value] of entries) {
    const at = Number(value?.startedAt ?? value?.askedAt ?? value?.at ?? 0)
    if (!best || at < best.at) best = { id, value: value ?? {}, at }
  }
  return best
}

export function classifyTurnEnd(reason) {
  const kind = typeof reason === 'string' ? reason : String(reason?.kind ?? 'completed')
  const detailOf = (value) => {
    if (!value) return null
    if (typeof value === 'string') return value
    const nested = value.code ?? value.name ?? value.kind ?? value.reason ?? value.message
    return nested ? String(nested) : null
  }
  switch (kind) {
    case 'error':
      return { status: 'error', reasonKind: 'error', reasonDetail: detailOf(reason?.error) }
    case 'aborted':
      return { status: 'aborted', reasonKind: 'aborted', reasonDetail: detailOf(reason?.reason ?? reason?.cause) }
    case 'blocked':
      return { status: 'blocked', reasonKind: 'blocked', reasonDetail: detailOf(reason?.reason ?? reason?.cause) }
    case 'completed':
    case 'max-tokens':
    case 'interrupted':
    case 'forked':
      return { status: kind, reasonKind: kind, reasonDetail: null }
    default:
      return { status: kind, reasonKind: kind, reasonDetail: null }
  }
}

export function buildReceipt({
  taskId,
  sessionId,
  turn = null,
  status,
  reasonKind = status,
  reasonDetail = null,
  injectedAt = null,
  endedAt = null,
  summary = '',
  receiptMode = 'file',
  summaryChars = 300,
  baselineTurn = null,
  settledTurn = null,
  injectedDuringTurn = false,
  source = 'observed',
  routedTo = null,
  noticeSummary = false,
} = {}) {
  const at = endedAt ?? Date.now()
  return {
    taskId: taskId ?? null,
    sessionId: sessionId ?? null,
    turn: turn ?? null,
    status: status ?? 'completed',
    reasonKind: reasonKind ?? status ?? null,
    reasonDetail: reasonDetail ?? null,
    injectedAt: injectedAt ?? null,
    endedAt: at,
    durationMs: injectedAt ? Math.max(0, at - injectedAt) : null,
    summary: truncateText(summary, summaryChars),
    source: source === 'declared' || source === 'resumed' ? source : 'observed',
    receiptMode,
    // Diagnostics: a receipt whose settledTurn equals baselineTurn (queue mode) means the
    // task was injected while that turn was already running — useful when auditing.
    baselineTurn: baselineTurn ?? null,
    settledTurn: settledTurn ?? turn ?? null,
    injectedDuringTurn: injectedDuringTurn === true,
    // How the dispatcher addressed this task (T-355): workspace:<slug> | session:<id> | thread:<id>.
    routedTo: routedTo ? String(routedTo).slice(0, 120) : null,
    // Per-task opt-in (T-404): render the summary in the injected notice too. Off by default
    // because 0.7.28/T-269 deliberately reduced notices to status lines after a reply storm.
    noticeSummary: noticeSummary === true,
  }
}

/**
 * Text of one injected receipt notice. A receipt is a completion signal, not a letter: by
 * default only the status line is injected (the summary stays in receipts.jsonl and the task
 * API). error/lost add one reason line because the dispatcher must act on it; the legacy
 * full-summary behaviour returns when the caller asks for it (T-269).
 */
export function receiptNoticeText(receipt, { includeSummary = false } = {}) {
  const marker = receipt.source ? ` (${receipt.source})` : ''
  const first = `[RECEIPT] ${receipt.taskId} ${receipt.status} ${receipt.durationMs ?? 0}ms${marker}`
  if (receipt.status === 'error' || receipt.status === 'lost') {
    const detail = String(receipt.reasonDetail ?? receipt.reasonKind ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    return detail ? `${first}\n${truncateText(detail, 120)}` : first
  }
  if (includeSummary && receipt.summary) return `${first}\n${receipt.summary}`
  return first
}

/**
 * Derive the liveness of one session from its event ledger (contract 2026-10-29).
 * Pure: the caller passes the ledger and the clock. Order matters:
 * not-started -> lost -> waiting-approval -> waiting-job -> waiting-tool -> stalled -> idle -> working.
 * `since` is the timestamp the current blocking state began, used for the waitLongMs alert.
 */
export function deriveLivenessState(ledger, { hasPending = false, lost = false, now = Date.now(), stallQuietMs = 300000 } = {}) {
  const state = {
    openTurn: ledger?.openTurn ?? null,
    lastEventAt: Number(ledger?.lastEventAt ?? 0),
    lastTurnStartAt: Number(ledger?.lastTurnStartAt ?? 0),
    openCalls: ledger?.openCalls ?? new Map(),
    openJobs: ledger?.openJobs ?? new Map(),
    openApprovals: ledger?.openApprovals ?? new Map(),
  }
  if (hasPending && !state.lastTurnStartAt) return { state: 'not-started', detail: 'no turn/start since injection', since: state.lastEventAt || now }
  if (lost) return { state: 'lost', detail: 'plugin restarted while the turn was open', since: state.lastEventAt || now }
  const approvals = oldestOf(state.openApprovals)
  if (approvals) {
    const toolName = approvals.value.toolName ?? 'unknown'
    return { state: 'waiting-approval', detail: `${toolName} ${minutesSince(approvals.at, now)}m`, since: approvals.at }
  }
  const job = oldestOf(state.openJobs)
  if (job) return { state: 'waiting-job', detail: `${job.id} ${minutesSince(job.at, now)}m`, since: job.at }
  const call = oldestOf(state.openCalls)
  if (call) {
    const name = call.value.name ?? 'unknown'
    return { state: 'waiting-tool', detail: `${name} ${minutesSince(call.at, now)}m`, since: call.at }
  }
  if (state.openTurn !== null && now - state.lastEventAt > stallQuietMs) {
    return { state: 'stalled', detail: `quiet ${minutesSince(state.lastEventAt, now)}m (turn ${state.openTurn})`, since: state.lastEventAt }
  }
  if (state.openTurn === null) return { state: 'idle', detail: '', since: now }
  return { state: 'working', detail: `turn ${state.openTurn}`, since: now }
}

/**
 * Build the aggregate batch receipt: the JSONL record and the chat body share the tasks.
 * `tasks` entries carry {taskId, status, durationMs, summary, detail}.
 */
export function buildBatchReceipt({ batchId, tasks = [], startedAt = 0, endedAt = Date.now(), summaryChars = 300, includeSummaries = false, maxBytes = 8192 } = {}) {
  const normalized = tasks.map((task) => ({
    taskId: task.taskId,
    status: task.status ?? 'pending',
    durationMs: task.durationMs ?? null,
    summary: truncateText(task.summary ?? '', summaryChars),
    detail: task.detail ?? null,
    settled: task.settled !== false,
    // T-355: every member carries its workspace so a failure names the right one.
    workspace: task.workspace ? String(task.workspace) : null,
  }))
  const pendingStates = ['pending', 'not-started', 'stalled', 'working', 'waiting-approval', 'waiting-job', 'waiting-tool']
  // done counts settled tasks (a failed turn still finished); open ones stay out.
  const done = normalized.filter((task) => task.settled && !pendingStates.includes(task.status)).length
  const record = {
    kind: 'batch',
    batchId,
    tasks: normalized.map(({ settled, ...rest }) => rest),
    startedAt: startedAt || null,
    endedAt,
    done,
    total: normalized.length,
  }
  const header = `[BATCH] ${batchId} ${done}/${normalized.length} done in ${humanDuration(endedAt - (startedAt || endedAt))}`
  const idWidth = normalized.reduce((max, task) => Math.max(max, Array.from(task.taskId ?? '').length), 0)
  const workspaceWidth = normalized.reduce((max, task) => Math.max(max, Array.from(task.workspace ?? '').length), 0)
  const lines = normalized.map((task) => {
    const icon = BATCH_STATUS_ICON[task.status] ?? '⏳'
    const id = String(task.taskId ?? '').padEnd(idWidth, ' ')
    const took = task.durationMs === null ? '' : humanDuration(task.durationMs)
    const status = task.detail ? `${task.status}(${task.detail})` : task.status
    const workspace = task.workspace ? String(task.workspace).padEnd(workspaceWidth, ' ') : ''
    // A failure names its workspace explicitly; success keeps the column aligned.
    const failed = ['error', 'lost', 'not-started', 'stalled'].includes(task.status)
    const ws = workspace ? `  ${workspace}${failed ? '  ← 失败' : ''}` : ''
    return `${icon} ${id}  ${took}  ${status}${ws}`.replace(/\s+$/, '')
  })
  const baseBody = [header, ...lines].join('\n')
  // Default stays byte-identical to 0.7.28 (status lines only). Summaries are opt-in per batch
  // (T-404) and capped, because injecting all of them is what caused the earlier reply storm.
  if (!includeSummaries) return { record, body: baseBody }
  const limit = Math.max(1024, Number(maxBytes) || 8192)
  if (Buffer.byteLength(baseBody, 'utf8') >= limit) return { record, body: baseBody }
  const summaries = normalized.map((task) => truncateText(String(task.summary ?? '').replace(/\s+/g, ' ').trim(), summaryChars))
  const hint = '…（摘要已截断，详见 GET /mesh/tasks/<id>）'
  const render = (count) => {
    const out = [header]
    normalized.forEach((task, index) => {
      out.push(lines[index])
      if (index < count && summaries[index]) out.push(`  ${summaries[index]}`)
    })
    return out.join('\n')
  }
  const available = summaries.filter(Boolean).length
  let count = available
  let body = render(count)
  while (Buffer.byteLength(body, 'utf8') > limit && count > 0) {
    count -= 1
    body = render(count)
  }
  if (count < available) {
    // Reserve room for the truncation hint itself, then keep dropping summaries until it fits.
    let withHint = `${render(count)}\n${hint}`
    while (Buffer.byteLength(withHint, 'utf8') > limit && count > 0) {
      count -= 1
      withHint = `${render(count)}\n${hint}`
    }
    body = Buffer.byteLength(withHint, 'utf8') <= limit ? withHint : render(count)
  }
  return { record, body }
}
