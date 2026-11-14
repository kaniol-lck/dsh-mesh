// Task ledger (T-319): moved verbatim out of index.js. The module owns the in-memory row
// index and the append-only jsonl rewrite rules; every storage path helper is injected so
// this file never imports the storage subsystem or index.js.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveTaskSubject } from './text.mjs'
import { resolveTaskText } from './tasks.mjs'


/**
 * Task ledger + API projection (T-319). Nothing here may capture the apply() closure.
 *
 * deps:
 *   taskRows             任务库内存索引（taskId → 行）
 *   taskFiles            taskId → 所在 tasks.jsonl（追加时复用同一文件）
 *   config               { tasksRetentionDays, tasksMaxRows } 保留策略的两个上限
 *   fileLog              写 waker 日志
 *   tasksFileIn          目录 → tasks.jsonl 路径（存储分层）
 *   dirForRow            任务行 → 分层目录（存储分层）
 *   taskRecordFiles      所有层级的 tasks.jsonl 列表（启动加载）
 *   taskTextDir          大正文目录（清理孤儿 .md）
 *   taskTextsDir         正文解析目录（taskRowForApi withText）
 *   writeTaskText        写正文文件并返回 textRef
 *   routeForSessions     LCA 路由：目标 / requester 的 cwd → scope
 *   scopeFields          路由 → scope 字段
 */
export function createTaskRegistry(deps) {
  function appendTaskRow(row) {
    const file = deps.taskFiles.get(row.taskId) ?? deps.tasksFileIn(deps.dirForRow(row))
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 })
      deps.taskFiles.set(row.taskId, file)
      return true
    } catch (error) {
      deps.fileLog(`task registry write failed for ${row.taskId}: ${error.message}`)
      return false
    }
  }

  function updateTaskRow(taskId, patch) {
    const current = deps.taskRows.get(taskId)
    if (!current) return null
    const next = { ...current, ...patch }
    deps.taskRows.set(taskId, next)
    appendTaskRow(next)
    return next
  }

  /** Load every tier file into one in-memory view, then apply retention across the union. */
  function loadTaskRegistry() {
    const files = deps.taskRecordFiles()
    const parsed = []
    for (const file of files) {
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            const row = JSON.parse(line)
            if (row && typeof row === 'object' && row.taskId) parsed.push({ row, file })
          } catch {
            /* skip a torn line */
          }
        }
      } catch {
        /* unreadable file: skip */
      }
    }
    const latest = new Map()
    for (const entry of parsed) latest.set(String(entry.row.taskId), entry)
    const cutoff = Date.now() - deps.config.tasksRetentionDays * 24 * 60 * 60 * 1000
    const kept = [...latest.values()]
      .filter((entry) => Number(entry.row.createdAt) >= cutoff)
      .sort((left, right) => Number(right.row.createdAt) - Number(left.row.createdAt))
      .slice(0, deps.config.tasksMaxRows)
    deps.taskRows.clear()
    deps.taskFiles.clear()
    const keepIds = new Set()
    for (const entry of kept) {
      const taskId = String(entry.row.taskId)
      deps.taskRows.set(taskId, entry.row)
      deps.taskFiles.set(taskId, entry.file)
      keepIds.add(taskId)
    }
    try {
      // Rewrite only when something was pruned: unchanged files stay byte-identical.
      if (kept.length !== parsed.length) {
        const byFile = new Map(files.map((file) => [file, []]))
        for (const entry of kept) {
          if (!byFile.has(entry.file)) byFile.set(entry.file, [])
          byFile.get(entry.file).push(entry.row)
        }
        for (const [file, rows] of byFile) {
          mkdirSync(dirname(file), { recursive: true })
          const temp = `${file}.rewrite.tmp`
          writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 })
          renameSync(temp, file)
        }
      }
    } catch (error) {
      deps.fileLog(`task registry compaction failed: ${error.message}`)
    }
    try {
      for (const name of readdirSync(deps.taskTextDir)) {
        if (!name.endsWith('.md')) continue
        const id = name.slice(0, -3)
        if (!keepIds.has(id)) rmSync(join(deps.taskTextDir, name), { force: true })
      }
    } catch {
      /* no text dir yet */
    }
    deps.fileLog(`task registry loaded rows=${deps.taskRows.size} files=${files.length}`)
  }

  /** Persist a dispatched task; bodies over 8 KiB go to tasks/<id>.md (privacy: never logged). */
  function recordTaskPending(taskId, target, meta, text, extra = {}) {
    const body = String(text ?? '')
    const textBytes = Buffer.byteLength(body)
    // Reusing an id is allowed (a deliberate re-dispatch), but never silent: two rows with
    // contradictory outcomes under one id make reconciliation lie (T-255).
    const previousRow = deps.taskRows.get(taskId)
    let reusedId = false
    if (previousRow && Number.isFinite(Number(previousRow.createdAt))) {
      const age = Date.now() - Number(previousRow.createdAt)
      if (age <= 24 * 60 * 60 * 1000) {
        reusedId = true
        const settledAt = Number(previousRow.settledAt ?? previousRow.createdAt)
        deps.fileLog(`WARN taskId ${taskId} reused (previous settled at ${new Date(settledAt).toISOString()})`)
      }
    }
    const route = extra.route ?? deps.routeForSessions(target.id, extra.requesterSessionId ?? null)
    const row = {
      taskId,
      batchId: extra.batchId ?? null,
      thread: extra.thread ?? null,
      requester: extra.requester ?? null,
      targetSessionId: target.id,
      targetTitle: target.title ?? null,
      subject: resolveTaskSubject(meta?.subject, body),
      textBytes,
      createdAt: Date.now(),
      deadlineMs: extra.deadlineMs ?? null,
      status: 'pending',
      startedAt: null,
      settledAt: null,
      durationMs: null,
      receiptMode: extra.receiptMode ?? null,
      receiptRef: null,
      // Addressing mode (T-355): workspace:<slug> | session:<id> | thread:<id>.
      routedTo: extra.routedTo ?? null,
      // Per-dispatch summary opt-in (T-404); persists so the batch can honour it after settle.
      ...(extra.noticeSummary === true ? { noticeSummary: true } : {}),
      // Digest mode (T-459): the row is announced, never injected.
      ...(extra.declaredOnly === true ? { declaredOnly: true } : {}),
      // Git/artifact context (T-416): persisted so a later reader can audit branch and files.
      ...(extra.cwd ? { cwd: String(extra.cwd) } : {}),
      ...(extra.expectBranch ? { expectBranch: String(extra.expectBranch) } : {}),
      ...(Array.isArray(extra.artifacts) && extra.artifacts.length ? { artifacts: extra.artifacts.slice(0, 10) } : {}),
      ...deps.scopeFields(route),
      ...(reusedId ? { reusedId: true } : {}),
      refs: Array.isArray(meta?.refs)
        ? meta.refs
            .filter((ref) => typeof ref === 'string' && ref.trim())
            .slice(0, 10)
            .map((ref) => ref.slice(0, 200))
        : [],
    }
    const textRef = body ? deps.writeTaskText(body) : null
    if (textRef) {
      row.textRef = textRef
    } else if (body) {
      // Storage failure must not lose the task body; keep it inline as a fallback.
      row.text = body
      deps.fileLog(`task text store unavailable for ${taskId}; kept inline (${textBytes} bytes)`)
    }
    deps.taskRows.set(taskId, row)
    deps.taskFiles.set(taskId, join(route.dir, 'tasks.jsonl'))
    appendTaskRow(row)
    deps.fileLog(
      `task registry pending ${taskId} bytes=${textBytes} scope=${route.scope}${route.workspace ? ` ws=${route.workspace}` : ''}${route.scopeUncertain ? ' scopeUncertain' : ''} subject=${JSON.stringify(row.subject)}`,
    )
  }

  function taskRowForApi(row, { withText = false } = {}) {
    const base = {
      taskId: row.taskId,
      batchId: row.batchId ?? null,
      thread: row.thread ?? null,
      scope: row.scope ?? null,
      origin: row.origin ?? null,
      ...(Array.isArray(row.peers) && row.peers.length ? { peers: row.peers } : {}),
      ...(row.scopeUncertain === true ? { scopeUncertain: true } : {}),
      ...(row.workspace ? { workspace: row.workspace } : {}),
      routedTo: row.routedTo ?? null,
      requester: row.requester ?? null,
      targetSessionId: row.targetSessionId ?? null,
      targetTitle: row.targetTitle ?? null,
      subject: row.subject ?? '',
      textBytes: row.textBytes ?? 0,
      createdAt: row.createdAt ?? null,
      deadlineMs: row.deadlineMs ?? null,
      status: row.status ?? 'pending',
      startedAt: row.startedAt ?? null,
      settledAt: row.settledAt ?? null,
      durationMs: row.durationMs ?? null,
      receiptRef: row.receiptRef ?? null,
      receiptSummary: row.receiptSummary ?? null,
      refs: Array.isArray(row.refs) ? row.refs : [],
      reusedId: row.reusedId === true,
      textRef: row.textRef ?? null,
      hasTextFile: Boolean(row.textRef || row.textPath),
      // Digest + ack fields (T-459): orthogonal to status; acked is a board marker only.
      notifiedAt: row.notifiedAt ?? null,
      notifyCount: Number(row.notifyCount) || 0,
      ackedAt: row.ackedAt ?? null,
      ackBy: row.ackBy ?? null,
      ...(row.declaredOnly === true ? { declaredOnly: true } : {}),
    }
    if (!withText) return base
    return { ...base, text: resolveTaskText(row, deps.taskTextsDir) }
  }

  return { appendTaskRow, recordTaskPending, updateTaskRow, loadTaskRegistry, taskRowForApi }
}
