/**
 * Advisory receipt for a digest task nobody claimed (T-mwgtchp6 / T-480).
 *
 * A declaredOnly task is announced by a digest and only closed by `mesh_complete`, so a
 * forgotten declaration is invisible: no turn/end settlement, no stall watchdog. When the
 * claim sweep decides it has waited long enough, this builds a receipt with status
 * `unclaimed`, writes it next to the other receipts and sends it to the dispatcher.
 *
 * It never settles the task: the row stays pending (later stalled) and only the worker's
 * `mesh_complete` closes it.
 */

export function createUnclaimedNotice({
  buildReceipt,
  writeReceiptFile,
  dirForRow,
  receiptDirForTask,
  rowFor = () => null,
  deliverNotice,
  fileLog = () => {},
  config = {},
}) {
  return function sendUnclaimedNotice(taskId, task, { waitedMs = 0, started = false } = {}) {
    const row = rowFor(taskId) ?? null
    const mode = ['file', 'queue', 'wake'].includes(row?.receiptMode) ? row.receiptMode : 'queue'
    const receipt = buildReceipt({
      taskId,
      sessionId: task?.sessionId ?? row?.targetSessionId ?? null,
      status: 'unclaimed',
      reasonKind: 'unclaimed',
      reasonDetail: `digest announced ${Math.round(waitedMs / 1000)}s ago, no mesh_complete yet${
        started ? ' (the session did start a turn)' : ' (no turn observed yet)'
      }`,
      injectedAt: Number(row?.notifiedAt) || task?.injectedAt || null,
      endedAt: Date.now(),
      receiptMode: mode,
      summaryChars: config.receiptSummaryChars,
      source: 'observed',
      noticeSummary: true,
    })
    try {
      writeReceiptFile(receipt, row ? dirForRow(row) : receiptDirForTask(taskId))
    } catch (error) {
      fileLog(`unclaimed receipt write failed task=${taskId}: ${error?.message ?? error}`)
    }
    try {
      const sent = deliverNotice(mode, receipt, `receipt ${taskId} unclaimed`, task?.requesterSessionId ?? row?.requesterSessionId ?? '')
      // The receipt flow delivers asynchronously; a rejection must not escape the sweep.
      if (sent && typeof sent.catch === 'function') {
        sent.catch((error) => fileLog(`unclaimed receipt delivery failed task=${taskId}: ${error?.message ?? error}`))
      }
    } catch (error) {
      fileLog(`unclaimed receipt delivery failed task=${taskId}: ${error?.message ?? error}`)
    }
    return receipt
  }
}
