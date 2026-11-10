// Task lifecycle (T-320): moved verbatim out of index.js. The module owns pending-task
// tracking, the stall watchdog with dormant resume (T-279), settlement and the turn-event
// router. Registry and receipt delivery are injected instances, never imports.
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import { messageText } from './text.mjs'
import { buildReceipt, classifyTurnEnd } from './receipt.mjs'
import { normalizeThread } from './session.mjs'


/** A task id already used by a different target in the same tier file (T-301). */
export class TaskIdCollisionError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'TaskIdCollisionError'
    this.status = 409
    this.details = details
  }
}


/**
 * Task lifecycle + settlement (T-320). Nothing here may capture the apply() closure.
 *
 * deps:
 *   pendingTasks        Map：在飞任务（taskId → task）
 *   receiptTimers       Set：看门狗 / dormant 定时器（unref 后也登记，便于统一清理）
 *   liveness            Map：会话活跃账本（openTurn 等）
 *   assistantText       Map：最近一条 assistant 正文（结算摘要）
 *   turnStartedAt       Map：会话最近 turn/start 的回合号
 *   state               apply() 的状态账本（pendingTasks / lastReceipt）
 *   config              { receiptStallMs, receiptSummaryChars, receiptFile, receiptMode, requireNamespacedIds, startedClaimWindowMs }
 *   fileLog             写 waker 日志
 *   taskRegistry        createTaskRegistry 的返回值（任务行读写）
 *   receiptFlow         createReceiptFlow 的返回值（结算后交回执）
 *   setLastReceipt      写 apply() 的 lastReceipt 镜像
 *   writeReceiptFile    回执落盘
 *   receiptDirForTask   任务 id → 回执目录
 *   receiptDirFor       回执 / 任务行 → 回执目录
 *   livenessFor         会话 id → 活跃账本条目
 *   maxTurnFor          会话 id → 已知最大回合号
 *   sessionCwdOf        会话 id → cwd（路由用）
 *   routeForCwds        LCA 路由：目标 / requester 的 cwd → scope
 *   scopeFields         路由 → scope 字段
 *   findTaskRowInFile   同一层文件里查 taskId（同层唯一性）
 *   layerLabel          目录 → 人类可读层名（错误信息）
 *   taskRecordFiles     所有层级的 tasks.jsonl（跨层重复检查）
 *   registerBatchTask   登记批次成员
 *   updateBatchTask     批次聚合的回执更新
 */
export function createTaskLifecycle(deps) {
  function clearPending(task) {
    if (!task) return
    if (task.stallTimer) {
      clearTimeout(task.stallTimer)
      deps.receiptTimers.delete(task.stallTimer)
      task.stallTimer = null
    }
    if (task.dormantTimer) {
      clearTimeout(task.dormantTimer)
      deps.receiptTimers.delete(task.dormantTimer)
      task.dormantTimer = null
    }
  }

  function discardDormant(taskId) {
    const task = deps.pendingTasks.get(taskId)
    if (!task || !task.dormant) return
    clearPending(task)
    deps.pendingTasks.delete(taskId)
    deps.state.pendingTasks = deps.pendingTasks.size
    deps.fileLog(`task ${taskId} dropped: dormant and the session stayed idle`)
  }

  /**
   * Stall watchdog: a queued task behind another running task is not "not-started", it is
   * simply waiting — re-arm instead of settling it (T-279). A real miss still reports
   * not-started once, but the task stays dormant so a late turn/start can resume tracking.
   */
  function armStallTimer(taskId, task) {
    const timer = setTimeout(() => {
      deps.receiptTimers.delete(timer)
      if (task.settled || task.dormant) return
      const busy = [...deps.pendingTasks.values()].some(
        (other) => other !== task && other.sessionId === task.sessionId && !other.settled && Number.isFinite(other.startedAt),
      )
      if (busy) {
        deps.fileLog(`task ${taskId} stall re-armed: another task is still running on ${task.sessionId}`)
        task.stallTimer = armStallTimer(taskId, task)
        return
      }
      deps.fileLog(`task ${taskId} not-started after ${deps.config.receiptStallMs}ms; kept dormant for resume`)
      settleTask(taskId, task, {
        turn: null,
        status: 'not-started',
        reasonKind: 'not-started',
        reasonDetail: `no turn/start within ${deps.config.receiptStallMs}ms`,
        keepTracking: true,
      })
      if (task.settled) return
      task.dormant = true
      task.dormantSince = Date.now()
      const drop = setTimeout(() => discardDormant(taskId), deps.config.receiptStallMs)
      drop.unref?.()
      deps.receiptTimers.add(drop)
      task.dormantTimer = drop
    }, deps.config.receiptStallMs)
    timer.unref?.()
    task.stallTimer = timer
    deps.receiptTimers.add(timer)
    return timer
  }

  function settleTask(taskId, task, details) {
    if (!task || task.settled) return null
    // A not-started receipt is advisory: the task may still run later, so keep it in
    // deps.pendingTasks (dormant) instead of deleting the only tracking record (T-279).
    const keepTracking = details.keepTracking === true
    if (!keepTracking) {
      task.settled = true
      deps.pendingTasks.delete(taskId)
    }
    clearPending(task)
    const shot = deps.assistantText.get(task.sessionId)
    // Turn numbers advance out of step between assistant/message and turn/end, so equality
    // alone can attach a previous turn's prose to this task (T-267). The snapshot must also
    // be newer than the injection; otherwise the summary stays empty (never wrong prose).
    const turnMatches =
      Boolean(shot) && (details.turn === null || details.turn === undefined || shot.turn === null || shot.turn === details.turn)
    const textIsFresh = Boolean(shot) && Number.isFinite(shot.at) && Number.isFinite(task.injectedAt) && shot.at >= task.injectedAt
    // A declared completion writes its own summary; observed settlement still uses the
    // guarded snapshot (never invent prose the worker did not send).
    const captured = turnMatches && textIsFresh ? shot.text : ''
    const summary = details.summary !== undefined ? String(details.summary) : captured
    const receipt = buildReceipt({
      taskId,
      sessionId: task.sessionId,
      turn: details.turn ?? null,
      status: details.status,
      reasonKind: details.reasonKind ?? details.status,
      reasonDetail: details.reasonDetail ?? null,
      injectedAt: task.injectedAt,
      endedAt: details.endedAt ?? Date.now(),
      summary,
      receiptMode: task.receiptMode,
      summaryChars: deps.config.receiptSummaryChars,
      baselineTurn: task.baselineTurn ?? null,
      settledTurn: details.turn ?? null,
      injectedDuringTurn: task.injectedDuringTurn === true,
      source: details.source ?? task.source ?? 'observed',
      routedTo: task.routedTo ?? null,
      noticeSummary: task.noticeSummary === true,
    })
    deps.writeReceiptFile(receipt, task.recordDir ?? deps.receiptDirForTask(taskId) ?? deps.receiptDirFor(receipt))
    // Registry status mirrors the receipt: not-started is the stall path, everything else
    // settled. Registry durationMs is measured from startedAt when the task was seen
    // starting (falling back to injection time); the receipt keeps its own duration.
    const registryStartedAt = Number.isFinite(task.startedAt) ? task.startedAt : task.injectedAt
    deps.taskRegistry.updateTaskRow(taskId, {
      status: receipt.status === 'not-started' ? 'stalled' : 'settled',
      settledAt: receipt.endedAt,
      durationMs: Math.max(0, receipt.endedAt - registryStartedAt),
      receiptRef: deps.config.receiptFile,
      receiptSummary: Array.from(receipt.summary ?? '').slice(0, 500).join(''),
    })
    const receiptMirror = { taskId: receipt.taskId, status: receipt.status, at: receipt.endedAt, deliveredTo: null }
    deps.setLastReceipt(receiptMirror)
    deps.state.lastReceipt = receiptMirror
    deps.state.pendingTasks = deps.pendingTasks.size
    deps.fileLog(`receipt ${taskId} ${receipt.status} turn=${receipt.turn ?? '-'} duration=${receipt.durationMs}ms`)
    void deps.receiptFlow.deliverReceipt(receipt, task).catch((error) => {
      deps.fileLog(`receipt ${taskId} delivery crashed: ${error && error.message ? error.message : error}`)
    })
    if (!keepTracking) deps.updateBatchTask(taskId, receipt)
    // Cross-machine settlement hook (T-388): the hub row mirrors this receipt exactly once.
    if (typeof deps.onSettled === 'function') {
      try {
        deps.onSettled(taskId, receipt, task)
      } catch (error) {
        deps.fileLog(`settle hook failed for ${taskId}: ${error?.message ?? error}`)
      }
    }
    return receipt
  }

  function registerPendingTask(target, meta, mode = 'queue', text = '') {
    const taskId = String(meta?.taskId ?? '').trim()
    // A namespaced cross-workspace id may carry one `<slug>/` prefix (T-301). `.`/`..`
    // segments are rejected so an id can never double as a path.
    const namespacedId = /^[A-Za-z0-9._-]{1,40}\/[A-Za-z0-9._:-]{1,80}$/
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(taskId) && !namespacedId.test(taskId)) {
      throw new Error('meta.taskId must match [A-Za-z0-9._:-]{1,80} or <slug>/<id>')
    }
    if (/(^|\/)\.\.?(\/|$)/.test(taskId)) throw new Error('meta.taskId must not contain . or .. segments')
    const requested = String(meta?.receipt ?? '')
    const batchId = meta?.batchId ? String(meta.batchId).trim() : null
    // Batch members never disturb the coordinator one by one: only the aggregate goes out.
    const receiptMode = batchId ? 'file' : ['file', 'queue', 'wake'].includes(requested) ? requested : deps.config.receiptMode
    const previous = deps.pendingTasks.get(taskId)
    if (previous) clearPending(previous)
    // If the session is mid-turn, that turn was already running before this task existed:
    // a queue delivery must wait for a strictly later turn, otherwise its turn/end would be
    // mistaken for the task finishing (the T-130 false receipt).
    const openTurn = deps.liveness.get(target.id)?.openTurn ?? null
    const injectedDuringTurn = openTurn !== null
    const taskMode = mode === 'steer' ? 'steer' : 'queue'
    // A queue prompt delivered while turn T runs becomes its own later turn, so two tasks
    // injected inside the same turn must NOT share a baseline: otherwise the first task's
    // turn/end settles the second one too (T-220: a task that never ran got "completed").
    // Each same-turn queue task therefore waits one extra turn per earlier queued task;
    // when the position is unclear this errs toward pending (a stall timer), never a fake
    // receipt.
    let baselineTurn = injectedDuringTurn ? openTurn : deps.maxTurnFor(target.id)
    let sameTurnInjected = false
    if (injectedDuringTurn && taskMode === 'queue') {
      const queuedAhead = [...deps.pendingTasks.values()].filter(
        (pending) =>
          pending.sessionId === target.id &&
          !pending.settled &&
          pending.mode === 'queue' &&
          pending.injectedDuringTurn === true &&
          pending.injectedAtTurn === openTurn,
      ).length
      baselineTurn = openTurn + queuedAhead
      sameTurnInjected = queuedAhead > 0
    }
    // Receipts go back to whoever dispatched the task; receiptTo is only the fallback.
    const requester = deps.receiptFlow.resolveRequester(meta?.requester, target)
    // LCA routing (T-282): same workspace -> ws/<slug>/, cross-workspace -> local/.
    const route = deps.routeForCwds(target.cwd ?? deps.sessionCwdOf(target.id), requester.sessionId ? deps.sessionCwdOf(requester.sessionId) : null)
    // Same-layer uniqueness (T-301): findRecord only sees this workspace + local, so a
    // duplicate id in the same file is ambiguous and silently resolves to the last row.
    // A retry/re-dispatch to the SAME target keeps working; a different target is rejected.
    const recordFile = join(route.dir, 'tasks.jsonl')
    const existingRow = deps.findTaskRowInFile(recordFile, taskId)
    if (existingRow && String(existingRow.targetSessionId ?? '') !== String(target.id ?? '')) {
      deps.fileLog(`task id collision rejected: ${taskId}`)
      throw new TaskIdCollisionError(
        `task id ${taskId} already exists in ${deps.layerLabel(route.dir)} for target ${existingRow.targetSessionId ?? '-'}; refusing to overwrite it with target ${target.id}`,
        {
          taskId,
          existingTarget: existingRow.targetSessionId ?? null,
          requestedTarget: target.id,
          layer: route.scope === 'machine' ? 'local' : `ws:${route.workspace}`,
        },
      )
    }
    // The same id in another layer is a different file (not a collision), but an upward
    // lookup can shadow it, so it must be visible.
    if (!existingRow) {
      for (const file of deps.taskRecordFiles()) {
        if (dirname(file) === route.dir) continue
        if (deps.findTaskRowInFile(file, taskId)) {
          deps.fileLog(`WARN task id ${taskId} also exists in ${deps.layerLabel(dirname(file))} (cross-layer duplicate; lookups may shadow)`)
          break
        }
      }
    }
    // Cross-workspace ids share local/tasks.jsonl between coordinators. `T4F-…` and
    // `<slug>/T-…` count as namespaced; a bare `T-…` warns, and is rejected when
    // requireNamespacedIds is on (opt-in so historical ids stay addressable).
    let idWarning = null
    if (route.scope === 'machine' && /^T-/i.test(taskId)) {
      // T-402: the example must be executable — use the real workspace slug of the target
      // session's cwd (the old hardcoded `dsh-mesh/T-123` belonged to no real workspace).
      let slug = null
      try {
        slug = deps.workspaceSlugForCwd?.(deps.sessionCwdOf?.(target.id)) ?? null
      } catch {
        slug = null
      }
      const namespaced = slug ? `${slug}/${taskId}` : `<workspace-slug>/${taskId}`
      const example = `${namespaced} (or <PREFIX>-<YYYYMMDD>-<SEQ>, e.g. DMSH-20261111-01)`
      if (deps.config.requireNamespacedIds === true) {
        deps.fileLog(`task id rejected (not namespaced): ${taskId}`)
        throw new Error(
          `cross-workspace task id ${taskId} must be namespaced: ${example}; set requireNamespacedIds:false to allow bare ids`,
        )
      }
      idWarning = `cross-workspace task ids should be namespaced: ${example}`
      deps.fileLog(`WARN cross-workspace task id ${taskId} is not namespaced`)
    }
    const task = {
      sessionId: target.id,
      requester: requester.requester,
      requesterSessionId: requester.sessionId,
      requesterInferred: requester.inferred === true,
      recordDir: route.dir,
      ...deps.scopeFields(route),
      injectedAt: Date.now(),
      baselineTurn,
      injectedDuringTurn,
      injectedAtTurn: openTurn,
      sameTurnInjected,
      mode: taskMode,
      receiptMode,
      batchId,
      // How the caller addressed this task (T-355): workspace:<slug> | session:<id> | thread:<id>.
      routedTo: meta?.routedTo ? String(meta.routedTo).slice(0, 120) : null,
      settled: false,
      stallTimer: null,
      // Per-dispatch opt-in (T-404): render the summary in the notice too.
      noticeSummary: meta?.receiptSummary === true,
      ...(idWarning ? { idWarning } : {}),
    }
    deps.pendingTasks.set(taskId, task)
    deps.state.pendingTasks = deps.pendingTasks.size
    if (batchId) deps.registerBatchTask(taskId, task, meta)
    deps.taskRegistry.recordTaskPending(taskId, target, meta, text, {
      batchId,
      thread: normalizeThread(meta?.thread),
      requester: requester.requester,
      requesterSessionId: requester.sessionId,
      deadlineMs: Number(meta?.deadlineMs) || null,
      route,
      routedTo: task.routedTo ?? null,
      // Persist the actual mode so a restart can still notify the dispatcher (T-273).
      receiptMode,
      noticeSummary: task.noticeSummary === true,
    })
    const timer = armStallTimer(taskId, task)
    task.stallTimer = timer
    deps.fileLog(
      `task ${taskId} pending on ${target.id} baselineTurn=${task.baselineTurn ?? 'unknown'} duringTurn=${injectedDuringTurn} mode=${task.mode} receipt=${receiptMode} requester=${task.requester ?? '-'}${batchId ? ` batch=${batchId}` : ''}`,
    )
    return taskId
  }

  function cancelPendingTask(taskId) {
    const task = deps.pendingTasks.get(taskId)
    if (!task) return
    clearPending(task)
    deps.pendingTasks.delete(taskId)
    deps.state.pendingTasks = deps.pendingTasks.size
    deps.taskRegistry.updateTaskRow(taskId, { status: 'cancelled', settledAt: Date.now() })
  }

  /** Feed the deps.liveness ledger, then settle tasks on turn/end. */
  function handleSessionEvent(session, event) {
    try {
      const sessionId = typeof session === 'string' ? session : session?.id ?? session?.sessionId
      if (!sessionId || !event || typeof event !== 'object') return
      // DSH hands over an envelope `{ type, seq, time, data }`: turn/reason/message/tool
      // fields live under `data`. Synthetic producers may still pass a flat payload, so
      // prefer the real shape and fall back to the event itself.
      const d = event.data && typeof event.data === 'object' ? event.data : event
      const type = String(event.type ?? d.type ?? '')
      const turn = Number.isFinite(Number(d.turn)) ? Number(d.turn) : null
      const ledger = deps.livenessFor(sessionId)
      const now = Date.now()
      ledger.lastEventAt = now
      switch (type) {
        case 'turn/start':
          ledger.openTurn = turn
          ledger.lastTurnStartAt = now
          ledger.openCalls.clear()
          ledger.openJobs.clear()
          ledger.openApprovals.clear()
          break
        case 'turn/end':
          ledger.openTurn = null
          ledger.lastReason = d.reason ?? null
          ledger.openCalls.clear()
          ledger.openJobs.clear()
          ledger.openApprovals.clear()
          break
        case 'tool/call':
          ledger.openCalls.set(String(d.callId ?? randomUUID()), {
            name: String(d.name ?? 'tool'),
            startedAt: now,
          })
          break
        case 'tool/result': {
          const callId = d.callId ?? d.message?.callId
          if (callId !== undefined) ledger.openCalls.delete(String(callId))
          else {
            const first = ledger.openCalls.keys().next()
            if (!first.done) ledger.openCalls.delete(first.value)
          }
          break
        }
        case 'job/registered': {
          const jobId = d.jobId ?? d.id ?? d.job?.id ?? randomUUID()
          ledger.openJobs.set(String(jobId), { startedAt: now })
          break
        }
        case 'job/settled': {
          const jobId = d.jobId ?? d.id ?? d.job?.id
          if (jobId !== undefined) ledger.openJobs.delete(String(jobId))
          break
        }
        case 'approval/asked':
          ledger.openApprovals.set(String(d.id ?? randomUUID()), {
            toolName: String(d.toolName ?? d.name ?? 'tool'),
            askedAt: now,
          })
          break
        case 'approval/decided':
          if (d.id !== undefined) ledger.openApprovals.delete(String(d.id))
          break
        case 'llm/retry':
        case 'llm/retry-started':
          ledger.lastLlmAt = now
          break
        default:
          break
      }
      if (type === 'turn/start') {
        if (turn !== null) deps.turnStartedAt.set(sessionId, Math.max(turn, deps.turnStartedAt.get(sessionId) ?? 0))
        for (const [taskId, task] of deps.pendingTasks) {
          if (task.sessionId !== sessionId || task.settled || task.startedAt) continue
          // Same ownership rule as settlement: a queue task owns a strictly later turn, a
          // steer task may own the running one. A null baseline means we had no turn
          // knowledge at injection (T-253): claim only if this turn starts within the
          // configured window after injection, then record the baseline so settlement and
          // later turns behave like the normal path. Outside the window: never invent
          // progress (the task stays pending/stalled).
          const resumed = task.dormant === true
          const withinWindow =
            Number.isFinite(task.injectedAt) && now - task.injectedAt <= deps.config.startedClaimWindowMs
          const ownsTurn = resumed
            ? turn !== null &&
              (task.baselineTurn === null ||
                (task.mode === 'steer' ? turn >= task.baselineTurn : turn > task.baselineTurn))
            : task.baselineTurn !== null
              ? turn !== null && (task.mode === 'steer' ? turn >= task.baselineTurn : turn > task.baselineTurn)
              : turn !== null && withinWindow
          if (!ownsTurn) continue
          if (resumed) {
            task.dormant = false
            task.source = 'resumed'
            if (task.dormantTimer) {
              clearTimeout(task.dormantTimer)
              deps.receiptTimers.delete(task.dormantTimer)
              task.dormantTimer = null
            }
            deps.fileLog(`task ${taskId} resumed at turn=${turn} (not-started was advisory)`)
          }
          if (task.baselineTurn === null) {
            // A queued task owns strictly later turns; the claim turn itself is the start.
            task.baselineTurn = turn - 1
            deps.fileLog(
              `task ${taskId} claimed null baseline within ${deps.config.startedClaimWindowMs}ms: turn=${turn} baselineTurn=${task.baselineTurn} injectedAgo=${now - task.injectedAt}ms`,
            )
          }
          task.startedAt = now
          deps.taskRegistry.updateTaskRow(taskId, { status: 'started', startedAt: now })
          deps.fileLog(`task ${taskId} started turn=${turn} baselineTurn=${task.baselineTurn}`)
        }
        for (const task of deps.pendingTasks.values()) {
          if (task.sessionId !== sessionId || task.settled) continue
          if (task.baselineTurn === null || (turn !== null && turn > task.baselineTurn)) clearPending(task)
        }
        return
      }
      if (type === 'assistant/message') {
        const text = messageText(d.message)
        if (text) deps.assistantText.set(sessionId, { turn, text, at: Date.now() })
        return
      }
      if (type === 'turn/end') {
        const classified = classifyTurnEnd(d.reason)
        for (const [taskId, task] of [...deps.pendingTasks]) {
          if (task.sessionId !== sessionId || task.settled) continue
          if (task.baselineTurn !== null && turn !== null) {
            // queue: the task only started in a strictly later turn; steer was inserted into
            // the running turn, so that turn's end already covers it.
            const settled = task.mode === 'steer' ? turn >= task.baselineTurn : turn > task.baselineTurn
            if (!settled) continue
          }
          settleTask(taskId, task, { turn, ...classified })
        }
      }
    } catch (error) {
      deps.fileLog(`session/event handling failed: ${error.message}`)
    }
  }

  return { clearPending, settleTask, registerPendingTask, cancelPendingTask, handleSessionEvent }
}
