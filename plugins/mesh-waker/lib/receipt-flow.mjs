// Receipt delivery subsystem (T-317): moved verbatim out of index.js so the flow can be
// imported without loading the plugin. Every dependency arrives through `deps`; the only
// module-level imports are the two pure helpers it needs.
import { isCoordinatorTitle } from './session.mjs'
import { liveRequesterOf } from './coordinators.mjs'
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
   * Resolve a requester id/title once. When the dispatcher named nobody, infer the coordinator
   * of the *target's* workspace. The global receiptTo is deliberately not consulted: one waker
   * can serve several workspaces, and a receipt must never cross into another project's
   * coordinator (T-255).
   *
   * T-mwwdyc7i: identity comes from the workspace registry (`coordinators[]` + live lease), never
   * from a session title. The title path below is a *last resort*, is logged as deprecated, and
   * cannot fire when the registry has a live claim — a long-dead session whose title still says
   * `mesh · 协调` used to receive every unattributed receipt (same class as WORKLOG:594).
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
    const liveById = new Map(sessions.filter((session) => !session.archived).map((session) => [session.id, session]))

    // 1) Registry first: the truth about who leads this cwd.
    let entry = null
    try {
      entry = deps.getWorkspaceEntry?.(cwd) ?? null
    } catch (error) {
      deps.fileLog(`workspace lookup failed for ${cwd}: ${error?.message ?? error}`)
      entry = null
    }
    if (entry) {
      const live = liveRequesterOf(entry, { now: Date.now() })
      if (live.kind === 'one') {
        const session = liveById.get(live.sessionId) ?? { id: live.sessionId, cwd, title: null }
        return { kind: 'one', session, source: 'registry', why: live.why }
      }
      if (live.kind === 'ambiguous') {
        // The registry itself says "several lead here": never guess, not even with titles.
        return { kind: 'ambiguous', candidates: live.candidates.map((id) => liveById.get(id) ?? { id }), cwd, source: 'registry', why: live.why }
      }
      // live.kind === 'none': no live claim. Fall through to the deprecated title path.
    }

    // 2) Deprecated: title matching, only when the registry has nothing to say.
    const matches = sessions.filter(
      (session) =>
        session.id !== target.id &&
        !session.archived &&
        String(session.cwd ?? '').trim() === cwd &&
        // title-identity-allowed: fallback — reached only after the registry reported no live claim, logged as source=title-fallback
        isCoordinatorTitle(session.title),
    )
    if (matches.length === 1) return { kind: 'one', session: matches[0], source: 'title-fallback' }
    if (matches.length > 1) {
      // Numbered coordinators are normal (mesh · 协调 2). A clearly newer one wins; only
      // equal/unknown activity keeps the "ambiguous, do not guess" behaviour (T-287).
      matches.sort((left, right) => Number(right.last_active ?? 0) - Number(left.last_active ?? 0))
      const newest = Number(matches[0].last_active ?? 0)
      const runnerUp = Number(matches[1].last_active ?? 0)
      if (Number.isFinite(newest) && Number.isFinite(runnerUp) && newest > runnerUp) {
        return { kind: 'one', session: matches[0], pickedLatest: true, source: 'title-fallback' }
      }
    }
    return { kind: matches.length === 0 ? 'none' : 'ambiguous', candidates: matches, cwd, source: 'title-fallback' }
  }

  function resolveRequester(raw, target = null) {
    const requester = String(raw ?? '').trim()
    if (!requester) {
      const inferred = inferRequesterFromWorkspace(target)
      if (inferred.kind === 'one') {
        if (inferred.source === 'registry') {
          deps.fileLog(
            `requester inferred from workspace: ${inferred.session.title ?? '(no title)'} (${inferred.session.id}) source=registry why=${inferred.why}`,
          )
        } else {
          deps.fileLog(
            `WARN requester inferred from workspace by TITLE (deprecated, source=title-fallback): ${inferred.session.title} (${inferred.session.id})` +
              `${inferred.pickedLatest ? ' [newest of several coordinators]' : ''} — the registry has no live coordinator claim for this workspace; ` +
              'titles are not identity, approve a coordinator so this fallback is never needed',
          )
        }
        return { requester: inferred.session.title || inferred.session.id, sessionId: inferred.session.id, inferred: true }
      }
      if (inferred.kind === 'ambiguous') {
        deps.fileLog(
          `requester inference ambiguous (source=${inferred.source}${inferred.why ? ` why=${inferred.why}` : ''}): ${inferred.candidates.length} candidates share cwd ${inferred.cwd}; receipt stays file-only`,
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
    const digestTarget = task?.requesterSessionId ? String(task.requesterSessionId) : ''
    // T-467: queue-mode receipts are merged into one notice when receiptDigest is on. file and
    // wake keep their existing semantics (wake still steers immediately).
    if (deps.receiptDigest?.enabled && receipt.receiptMode === 'queue' && digestTarget) {
      try {
        deps.receiptDigest.enqueue(receipt, task, digestTarget)
        deps.fileLog(`receipt ${receipt.taskId} ${receipt.status} → receipt-digest queued for ${digestTarget}`)
        return
      } catch (error) {
        deps.fileLog(`receipt-digest enqueue failed for ${receipt.taskId}: ${error.message}; delivering normally`)
      }
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
   *
   * The old rule said: this process never registered those rows, so they can never settle, so
   * mark them lost and tell the dispatcher. The first half is about MEMORY. The second half
   * assumed something memory cannot prove: that the TASK is dead. A DSH session is persisted —
   * after a restart it is still there and can still finish the work. T-MWXHO5U1 was marked lost
   * at 12:30:02 while its session was still active at 12:35:39, and the receipt told the
   * dispatcher "session restarted before this task finished; resend if still needed" — a false
   * statement that costs a real resend.
   *
   * What the host can actually answer AT BOOT is weaker than it looks (measured, not assumed):
   * a persisted session reports `live: false`, `turnOpen: false`, `lastActivityAt: null` until
   * it is resumed and emits its first event. So a boot-time liveness check alone would still
   * have declared T-MWXHO5U1 dead. Hence two phases:
   *
   *   boot    — decide only what the evidence supports:
   *               session missing or archived              -> lost
   *               session live / has an open turn          -> defer
   *               lastActivityAt after this boot           -> defer
   *               lastActivityAt after the row was created -> defer
   *               otherwise                                -> HOLD (defer), not lost
   *             A held row gets `deferredAt`/`deferredReason` and NO receipt. We do not have
   *             enough evidence to declare it dead, so we do not.
   *   recheck — after `restartGraceMs`, revisit the held rows:
   *               session still shows no life                -> lost (now it is evidence-based)
   *               session live / turnOpen / activity arrived -> stays pending, deferredAt cleared
   *
   * A probe failure skips the whole round with a WARN: guessing "dead" from a failed probe is the
   * same mistake in another dress.
   */
  function probeSessions() {
    try {
      const sessions = deps.listLocalSessions()
      if (!Array.isArray(sessions)) throw new Error('session probe did not return an array')
      return { ok: true, byId: new Map(sessions.map((session) => [session.id, session])) }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /** True when the session shows a sign of life that a restart could not fake. */
  function sessionLooksAlive(session, row, processStartedAt) {
    if (!session || session.archived === true) return false
    if (session.live === true) return true
    if (session.turnOpen === true) return true
    const lastActivityAt = Number(session.lastActivityAt) || 0
    if (lastActivityAt > processStartedAt) return true
    const createdAt = Number(row.createdAt) || 0
    if (createdAt > 0 && lastActivityAt > createdAt) return true
    return false
  }

  /** boot phase: 'lost' | 'defer' | 'hold' */
  function bootVerdict(row, session, processStartedAt) {
    if (!session) return 'lost' // gone: the row really is orphaned
    if (session.archived === true) return 'lost'
    if (sessionLooksAlive(session, row, processStartedAt)) return 'defer'
    // The session exists but is quiet. At boot that is indistinguishable from "has not been
    // resumed yet", so hold it instead of inventing a verdict.
    return 'hold'
  }

  /** recheck phase: 'lost' | 'alive' */
  function recheckVerdict(row, session, processStartedAt) {
    if (sessionLooksAlive(session, row, processStartedAt)) return 'alive'
    return 'lost'
  }

  async function markRowLost(row, session) {
    const settledAt = Date.now()
    const summary = 'session restarted before this task finished; resend if still needed'
    deps.updateTaskRow(row.taskId, {
      // death-allowed: writer, not judge — callers pass the session they just probed
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
      const target = session ?? { id: row.targetSessionId, cwd: null }
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
      // T-483: rows that already had a receipt-digest target keep it — the migration
      // exists so their dispatchers eventually hear the outcome. Bare file rows stay
      // file-only unless a requester asked for more.
      receiptMode: row.receiptDigestSessionId
        ? 'queue'
        : ['file', 'queue', 'wake'].includes(row.receiptMode)
          ? row.receiptMode
          : requester ? 'queue' : 'file',
      summaryChars: deps.config.receiptSummaryChars,
    })
    deps.writeReceiptFile(receipt, deps.dirForRow(row))
    deps.fileLog(`task ${row.taskId} marked lost after restart (requester=${requester ? '有' : '无'})`)
    await deliverReceipt(receipt, { requester, requesterSessionId, requesterInferred: inferred })
  }

  /**
   * Boot phase of restart reconciliation. Never marks a row lost on "this process has no memory
   * of it" alone — that was the T-MWXHO5U1 defect.
   */
  async function reconcileOrphanTasks() {
    const probe = probeSessions()
    if (!probe.ok) {
      deps.fileLog(
        `WARN restart reconciliation skipped: session probe failed (${probe.error?.message ?? probe.error}); no row is marked lost without evidence`,
      )
      return { skipped: true, reason: 'probe-failed', deferred: 0, held: 0, lost: 0 }
    }
    const processStartedAt = Date.now() - Math.round(process.uptime() * 1000)

    const orphans = [...deps.taskRows.values()].filter(
      (row) => (row.status === 'pending' || row.status === 'started') && (row.settledAt === null || row.settledAt === undefined),
    )
    if (orphans.length === 0) return { skipped: false, deferred: 0, held: 0, lost: 0 }
    deps.fileLog(`restart reconciliation: ${orphans.length} orphan task(s) from the previous process`)

    let deferred = 0
    let held = 0
    let lost = 0
    for (const row of orphans) {
      const session = probe.byId.get(row.targetSessionId) ?? null
      const verdict = bootVerdict(row, session, processStartedAt)
      if (verdict !== 'lost') {
        // Keep `startedAt`/`ackedAt`: they are the evidence that the work was claimed, and
        // claimState() treats them as CLAIM_OK, so the claim sweep will not re-stall it.
        deps.updateTaskRow(row.taskId, {
          status: 'pending',
          deferredAt: Date.now(),
          deferredReason: verdict === 'defer' ? 'session-alive-after-restart' : 'awaiting-restart-grace',
        })
        deps.fileLog(
          verdict === 'defer'
            ? `restart reconciliation: deferred ${row.taskId} (session still live) session=${row.targetSessionId} live=${session?.live === true} turnOpen=${session?.turnOpen === true} lastActivityAt=${session?.lastActivityAt ?? '-'}`
            : `restart reconciliation: held ${row.taskId} (no sign of life yet; rechecked in ${deps.config.restartGraceMs}ms) session=${row.targetSessionId}`,
        )
        if (verdict === 'defer') deferred += 1
        else held += 1
        continue
      }
      lost += 1
      await markRowLost(row, session)
    }
    return { skipped: false, deferred, held, lost }
  }

  /**
   * Recheck phase, after `restartGraceMs`.
   *
   * Two jobs, both of which need evidence that does not exist at boot:
   *
   *  a. Judge the rows held at boot. By now "the session never came back" IS evidence rather
   *     than the absence of it, so silence becomes a real `lost`.
   *  b. Undo historical false `lost` rows (T-MWXHO5U1's 5 predecessors). This also has to run
   *     here and not at boot: `lastActivityAt` comes from the in-memory event ledger, which is
   *     empty immediately after a restart. Waiting for the grace window is what makes the
   *     comparison `lastActivityAt > settledAt` meaningful.
   */
  async function recheckDeferredTasks() {
    const probe = probeSessions()
    if (!probe.ok) {
      deps.fileLog(
        `WARN restart recheck skipped: session probe failed (${probe.error?.message ?? probe.error}); rows stay deferred`,
      )
      return { checked: 0, lost: 0, alive: 0, resurrected: 0, skipped: true }
    }
    const processStartedAt = Date.now() - Math.round(process.uptime() * 1000)
    const resurrected = resurrectFalseLost(probe.byId)

    const held = [...deps.taskRows.values()].filter(
      (row) => row.status === 'pending' && row.deferredReason === 'awaiting-restart-grace',
    )
    if (held.length === 0) return { checked: 0, lost: 0, alive: 0, resurrected, skipped: false }

    let lost = 0
    let alive = 0
    for (const row of held) {
      const session = probe.byId.get(row.targetSessionId) ?? null
      if (recheckVerdict(row, session, processStartedAt) === 'alive') {
        deps.updateTaskRow(row.taskId, { deferredAt: null, deferredReason: null })
        deps.fileLog(`restart reconciliation: ${row.taskId} is alive after the grace window; staying pending`)
        alive += 1
        continue
      }
      lost += 1
      deps.fileLog(
        `restart reconciliation: grace expired for ${row.taskId}, no sign of life from ${row.targetSessionId}; marking lost`,
      )
      await markRowLost(row, session)
    }
    return { checked: held.length, lost, alive, resurrected, skipped: false }
  }

  /**
   * Undo historical false `lost` rows, with evidence only (T-mwxjfvwn).
   *
   * A row marked lost by a previous boot is provably mis-judged when its session was STILL
   * ACTIVE AFTER the verdict: `lastActivityAt > settledAt` (settledAt is the moment it was
   * declared dead). That is the hard condition — a row whose session has been silent since the
   * verdict is not resurrected, because nothing distinguishes it from a genuinely dead task.
   *
   * Rows that a worker later declared (`mesh_complete`) are no longer `lost`, so "no declared
   * receipt" is implied by the status. Only `reasonDetail === 'host restart'` rows qualify:
   * `lost` written for any other reason (a real not-started settlement, a hub-side loss) is a
   * different claim and is left alone.
   */
  function resurrectFalseLost(byId) {
    let count = 0
    for (const row of deps.taskRows.values()) {
      if (row.status !== 'lost') continue
      if (row.reasonDetail !== 'host restart') continue
      const lostAt = Number(row.settledAt) || 0
      if (!lostAt) continue
      const session = byId.get(row.targetSessionId) ?? null
      if (!session || session.archived === true || session.live !== true) continue
      const lastActivityAt = Number(session.lastActivityAt) || 0
      // The evidence: the session moved AFTER we declared it dead.
      if (!(lastActivityAt > lostAt)) continue
      deps.updateTaskRow(row.taskId, {
        status: 'pending',
        settledAt: null,
        resurrectedAt: Date.now(),
        resurrectedReason: 'session-active-after-lost',
      })
      deps.fileLog(
        `restart reconciliation: resurrected ${row.taskId} (session active ${lastActivityAt - lostAt}ms after it was marked lost) session=${row.targetSessionId} lostAt=${lostAt} lastActivityAt=${lastActivityAt}`,
      )
      count += 1
    }
    return count
  }

  /**
   * Public, cheap answer to "is this session plausibly still working?" — used by the batch
   * restore path, which used to settle every open batch task as `lost` the moment the plugin
   * restarted (T-mwxjfvwn; the gate caught it as a second instance of the same defect).
   */
  function sessionAlive(sessionId) {
    const probe = probeSessions()
    if (!probe.ok) return { known: false, alive: false, reason: 'probe-failed' }
    const session = probe.byId.get(sessionId) ?? null
    if (!session) return { known: true, alive: false, reason: 'missing' }
    if (session.archived === true) return { known: true, alive: false, reason: 'archived' }
    if (session.live === true || session.turnOpen === true) {
      return { known: true, alive: true, reason: session.live === true ? 'live' : 'turn-open' }
    }
    return { known: true, alive: false, reason: 'quiet' }
  }

  return {
    inferRequesterFromWorkspace,
    resolveRequester,
    deliverNotice,
    deliverReceipt,
    reconcileOrphanTasks,
    recheckDeferredTasks,
    sessionAlive,
  }
}
