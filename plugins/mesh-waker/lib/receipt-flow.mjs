// Receipt delivery subsystem (T-317): moved verbatim out of index.js so the flow can be
// imported without loading the plugin. Every dependency arrives through `deps`; the only
// module-level imports are the two pure helpers it needs.
import { isCoordinatorTitle } from './session.mjs'
import { buildReceipt } from './receipt.mjs'

/**
 * Receipt delivery subsystem (T-314, step 3 of the source-structure plan).
 *
 * Nothing in here may capture the apply() closure: every plugin/host dependency arrives
 * through `deps`, so the flow can be constructed and exercised without booting the plugin
 * (see the "receipt flow runs without apply()" cases). Callers inside apply() go through
 * receiptFlow.resolveRequester / deliverReceipt / deliverNotice / reconcileOrphanTasks.
 *
 * deps:
 *   state                 apply() 的状态账本（写 lastError / lastReceipt）
 *   config                normalize() 后的配置快照（receiptTo / wakeSecret / receiptSummaryChars）
 *   log                   宿主 logger（wake 缺 wakeSecret 时 warn）
 *   fileLog               写 waker 日志
 *   listLocalSessions     列举本机会话（requester 推断）
 *   resolveLocalSession   按 id / 标题解析本机会话
 *   promptWithResume      真正投递（queue / steer）
 *   receiptBody           把回执渲染成通知文本
 *   writeReceiptFile      回执落盘
 *   dirForRow             任务行 → 分层目录
 *   updateTaskRow         任务库追加 / 更新行
 *   taskRows              任务库内存索引（重启补发扫描）
 *   getLastReceipt        读 apply() 的 lastReceipt 镜像
 *   setLastReceipt        写回 apply() 的 lastReceipt 镜像
 */
export function createReceiptFlow(deps) {
  /**
   * Resolve a requester id/title once. When the dispatcher named nobody, infer a coordinator
   * from the *target's* cwd (exactly one `· 协调` / `· coordinator` session there). The global
   * receiptTo is deliberately not consulted: one waker can serve several workspaces, and a
   * receipt must never cross into another project's coordinator (T-255).
   */
  function inferRequesterFromWorkspace(target) {
    const cwd = String(target?.cwd ?? '').trim()
    if (!cwd) return { kind: 'no-cwd' }
    let sessions = []
    try {
      sessions = deps.listLocalSessions()
    } catch {
      return { kind: 'none' }
    }
    const matches = sessions.filter(
      (session) =>
        session.id !== target.id &&
        !session.archived &&
        String(session.cwd ?? '').trim() === cwd &&
        isCoordinatorTitle(session.title),
    )
    if (matches.length === 1) return { kind: 'one', session: matches[0] }
    if (matches.length > 1) {
      // Numbered coordinators are normal (mesh · 协调 2). A clearly newer one wins; only
      // equal/unknown activity keeps the "ambiguous, do not guess" behaviour (T-287).
      matches.sort((left, right) => Number(right.last_active ?? 0) - Number(left.last_active ?? 0))
      const newest = Number(matches[0].last_active ?? 0)
      const runnerUp = Number(matches[1].last_active ?? 0)
      if (Number.isFinite(newest) && Number.isFinite(runnerUp) && newest > runnerUp) {
        return { kind: 'one', session: matches[0], pickedLatest: true }
      }
    }
    return { kind: matches.length === 0 ? 'none' : 'ambiguous', candidates: matches, cwd }
  }

  function resolveRequester(raw, target = null) {
    const requester = String(raw ?? '').trim()
    if (!requester) {
      const inferred = inferRequesterFromWorkspace(target)
      if (inferred.kind === 'one') {
        deps.fileLog(
          `requester inferred from workspace: ${inferred.session.title} (${inferred.session.id})${inferred.pickedLatest ? ' [newest of several coordinators]' : ''}`,
        )
        return { requester: inferred.session.title || inferred.session.id, sessionId: inferred.session.id, inferred: true }
      }
      if (inferred.kind === 'ambiguous') {
        deps.fileLog(
          `requester inference ambiguous: ${inferred.candidates.length} coordinator sessions share cwd ${inferred.cwd}; receipt stays file-only`,
        )
      }
      return { requester: null, sessionId: null, inferred: false }
    }
    try {
      const target = deps.resolveLocalSession({ session: requester, title: requester })
      return { requester, sessionId: target.id, inferred: false }
    } catch (error) {
      deps.state.lastError = `requester not resolved (${requester}): ${error.message}; falling back to receiptTo`
      deps.fileLog(`requester ${requester} not resolved (${error.message}); receipts fall back to receiptTo`)
      return { requester, sessionId: null, inferred: false }
    }
  }

  /**
   * Deliver one notice (receipt or batch text). `targetSessionId` wins when given (the
   * dispatcher's own session); otherwise fall back to the configured receiptTo; file mode
   * never injects. Returns the session id that actually received it, or null.
   */
  async function deliverNotice(mode, text, label, targetSessionId) {
    if (mode === 'file') return null
    let targetId = targetSessionId ? String(targetSessionId) : ''
    if (!targetId) {
      if (!deps.config.receiptTo) {
        deps.state.lastError = 'no requester and receiptTo is empty; notice written to file only'
        deps.fileLog(`${label} delivery skipped: no requester, receiptTo is empty`)
        return null
      }
      try {
        targetId = deps.resolveLocalSession({ session: deps.config.receiptTo, title: deps.config.receiptTo }).id
      } catch (error) {
        deps.state.lastError = `receiptTo not resolved: ${error.message}`
        deps.fileLog(`${label} delivery skipped: ${error.message}`)
        return null
      }
    }
    let turnMode = 'queue'
    if (mode === 'wake') {
      if (deps.config.wakeSecret) turnMode = 'steer'
      else deps.log.warn('[mesh-waker] wake delivery needs wakeSecret; delivering as queue')
    }
    try {
      await deps.promptWithResume(targetId, text, turnMode)
      deps.fileLog(`${label} delivered to ${targetId} (${mode}, mode=${turnMode})`)
      return targetId
    } catch (error) {
      deps.state.lastError = `${label} delivery failed: ${error.message}`
      deps.fileLog(`${label} delivery failed: ${error.message}`)
      return null
    }
  }

  async function deliverReceipt(receipt, task) {
    const hasRequester = Boolean(task?.requesterSessionId || task?.requester)
    if (receipt.receiptMode === 'file') {
      // File mode never injects, but it must never be silent either (T-255: a 16.8s turn
      // ended in error and nobody was told because this branch returned without a log line).
      const requesterLabel = hasRequester ? (task?.requesterInferred ? '有 (inferred)' : '有') : '无'
      deps.fileLog(
        `receipt ${receipt.taskId} ${receipt.status} → file only (requester=${requesterLabel}, receiptTo=${deps.config.receiptTo ? '有' : '无'})`,
      )
      if (!hasRequester && !deps.config.receiptTo) {
        deps.fileLog(`WARN receipt ${receipt.taskId} has no delivery target; nobody was notified`)
        deps.state.lastError = `receipt ${receipt.taskId} has no delivery target; nobody was notified`
      }
      return
    }
    const deliveredTo = await deliverNotice(
      receipt.receiptMode,
      deps.receiptBody(receipt),
      `receipt ${receipt.taskId}`,
      task?.requesterSessionId ?? '',
    )
    const current = deps.getLastReceipt()
    if (deliveredTo && current && current.taskId === receipt.taskId) {
      current.deliveredTo = deliveredTo
      deps.setLastReceipt(current)
      deps.state.lastReceipt = current
    }
  }

  /**
   * A host restart clears pendingTasks but leaves pending/started rows in tasks.jsonl.
   * Those rows belong to the previous process (this one never registered them in memory),
   * so they can never settle: mark each lost and send the receipt its dispatcher is still
   * waiting for. Runs once at startup; finished rows are never touched (T-265).
   */
  async function reconcileOrphanTasks() {
    const orphans = [...deps.taskRows.values()].filter(
      (row) => (row.status === 'pending' || row.status === 'started') && (row.settledAt === null || row.settledAt === undefined),
    )
    if (orphans.length === 0) return
    deps.fileLog(`restart reconciliation: ${orphans.length} orphan task(s) from the previous process`)
    for (const row of orphans) {
      const settledAt = Date.now()
      const summary = 'session restarted before this task finished; resend if still needed'
      deps.updateTaskRow(row.taskId, {
        status: 'lost',
        settledAt,
        reasonKind: 'lost',
        reasonDetail: 'host restart',
        receiptSummary: summary,
      })
      let requester = row.requester ?? null
      let requesterSessionId = null
      let inferred = false
      if (row.requester) {
        const resolved = resolveRequester(row.requester, null)
        requesterSessionId = resolved.sessionId
      } else {
        const target =
          deps.listLocalSessions().find((session) => session.id === row.targetSessionId) ?? { id: row.targetSessionId, cwd: null }
        const resolved = resolveRequester(null, target)
        requester = resolved.requester
        requesterSessionId = resolved.sessionId
        inferred = resolved.inferred === true
      }
      const receipt = buildReceipt({
        taskId: row.taskId,
        sessionId: row.targetSessionId ?? null,
        status: 'lost',
        reasonKind: 'lost',
        reasonDetail: 'host restart',
        injectedAt: row.createdAt ?? null,
        endedAt: settledAt,
        summary,
        // Rows written before 0.7.30 have no receiptMode. A named requester asked to be told,
        // so default those to queue; without a requester a file-only notice has no value (T-273).
        receiptMode: ['file', 'queue', 'wake'].includes(row.receiptMode) ? row.receiptMode : requester ? 'queue' : 'file',
        summaryChars: deps.config.receiptSummaryChars,
      })
      deps.writeReceiptFile(receipt, deps.dirForRow(row))
      deps.fileLog(`task ${row.taskId} marked lost after restart (requester=${requester ? '有' : '无'})`)
      await deliverReceipt(receipt, { requester, requesterSessionId, requesterInferred: inferred })
    }
  }

  return { inferRequesterFromWorkspace, resolveRequester, deliverNotice, deliverReceipt, reconcileOrphanTasks }
}
