/**
 * Core EBS sync orchestration.
 *
 * Each invocation:
 *   0. Retries any pending custom.syncedAt patches left over from earlier runs
 *      (orders already accepted by EBS). These are never sent to EBS again.
 *   1. Acquires a distributed lock (bails if already held, without touching state)
 *   2. Loads the persisted `since` cursor from state (or the manual override)
 *   3. Reads the global journal from `since - OVERLAP_MS` (60 min, see
 *      commerce.js) and collects orders with a terminal event
 *      (payment_completed / payment_cancelled), oldest terminal entry first
 *   4. For each order:
 *        a. Fetches the order — skips if already synced (custom.syncedAt or
 *           custom.syncedToEbs), its syncedAt patch is pending, or it is
 *           cancelled (including fraud-declined)
 *        b. Queries the complete per-order journal
 *        c. Calls syncOrderToEbs(ctx, params, order, orderJournal), retrying up to MAX_RETRIES
 *        d. On success: patches custom.syncedAt and clears custom.syncError to null,
 *           retrying the patch up to CUSTOM_UPDATE_RETRIES times. If it still fails,
 *           the order is saved in state.pendingCustomUpdates so later runs retry
 *           only the patch and don't send the order to EBS again.
 *        e. On max-retries exhausted: patches custom.syncError with a short error
 *           code, records the error and halts
 *   5. Checks a 9.5-minute deadline before each order (see Time below)
 *   6. Cursor (see nextCursor): completed → the query's `until`; max-retries →
 *      unchanged; deadline → the terminal entry of the first order not handled
 *   7. Scheduled runs only, at most hourly, and only when EBS_RECONCILE_ENABLED
 *      is "true" (off for now, see #126): reconciliation (reconcile.js) lists
 *      recently completed orders without syncedAt / syncError straight from the
 *      orders API, so orders missing from the global journal are still found;
 *      each one found is reported to the operations log
 *   8. Saves updated state and releases the lock
 *
 * Time: no order starts after DEADLINE_MS, and no EBS attempt starts once
 * there is less than one attempt (EBS_ATTEMPT_TIMEOUT_MS) plus
 * AFTER_SEND_RESERVE_MS left before the action timeout; such an order is
 * treated like a deadline stop and is first on the next run.
 *
 * Manual (POST) runs either scan [sinceOverride, untilOverride] or process one
 * order (orderIdOverride). They keep the persisted cursor unless
 * params.persistCursor is true (window runs only), never reconcile, and leave
 * the scheduled status / lastError alone. Their summary is saved as
 * state.lastManualRun, since the HTTP response can time out on long runs;
 * `nextSince` there is where to resume a backfill cut short by the deadline.
 *
 * Managed inventory (only when INVENTORY_SYNC_ENABLED is "true"): the sold units
 * of each order accepted by EBS are logged at acceptance and queued as an
 * `inventory:outbox:{seq}` entry right after its syncedAt is persisted (see the
 * comment at the queue call for why not earlier). Queued per order, so a run
 * that halts, throws or is killed at the action timeout (where `finally` does
 * not run) keeps every order queued before that point. inventory-sync
 * applies all queued entries once per run. No DA/IMS/catalog calls here.
 */

import { Core } from '@adobe/aio-sdk';
import {
  loadState, saveState, acquireLock, releaseLock,
  allocateInventoryOutboxSeq, putInventoryOutboxEntry, publishInventoryOutboxHead,
  inventoryOutboxEntryExists,
} from './state.js';
import { collectOrderDeltas, isInventorySyncEnabled } from './inventory.js';
import { getJournalEntries, getOrderJournalEntries, getOrder, updateOrderCustom, logOrderSync } from './commerce.js';
import {
  reconcileOrders, isReconcileDue, isReconcileEnabled, RECONCILE_MIN_REMAINING_MS,
} from './reconcile.js';
import { syncOrderToEbs, isRetriableError } from './ebs.js';
import { errorInfo } from '../../utils.js';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 3_000; // 3s, 6s, 9s
export const DEADLINE_MS = 9.5 * 60 * 1000; // stop accepting new orders at 9.5 min
/** Must match `limits.timeout` in app.config.yaml. */
export const ACTION_TIMEOUT_MS = 10 * 60 * 1000;
/** Each EBS request is aborted after this long. */
export const EBS_ATTEMPT_TIMEOUT_MS = 60_000;
/**
 * Time kept free after an EBS attempt for the syncedAt patch (3 tries of at
 * most COMMERCE_TIMEOUT_MS plus backoff), the pending-update save, the
 * operations log, the inventory outbox, saving state and releasing the lock.
 */
export const AFTER_SEND_RESERVE_MS = 60_000;
const PENDING_SAVE_RETRIES = 2;
const CUSTOM_UPDATE_RETRIES = 3;
const CUSTOM_UPDATE_BASE_DELAY_MS = 1_000; // 1s, 2s
const OUTBOX_WRITE_RETRIES = 3;
const OUTBOX_WRITE_BASE_DELAY_MS = 1_000; // 1s, 2s

/**
 * Run the EBS sync job.
 *
 * @param {object} params - Action params (env vars injected by the Runtime)
 * @returns {Promise<{body: object}>}
 */
export async function run(params) {
  const log = Core.Logger('ebs-sync', { level: params.LOG_LEVEL ?? 'info' });
  const ctx = { env: params, log };
  const startTime = Date.now();
  const deadlineAt = startTime + DEADLINE_MS;
  // No EBS attempt starts after this, so a running attempt (aborted at
  // EBS_ATTEMPT_TIMEOUT_MS) still finishes and records its result before the
  // Runtime kills the action. A kill skips `finally`: state isn't saved and an
  // order EBS accepted has no syncedAt, so the next run would resend it.
  const lastAttemptStartAt = startTime + ACTION_TIMEOUT_MS - EBS_ATTEMPT_TIMEOUT_MS - AFTER_SEND_RESERVE_MS;

  // Manual (POST) runs carry sinceOverride (a backfill window) or
  // orderIdOverride (one order). They leave the persisted cursor alone unless
  // the caller opts in with persistCursor, and they don't change the scheduled
  // run's status / lastError; their summary is kept in state.lastManualRun.
  const singleOrderId = params.orderIdOverride || null;
  const manual = Boolean(params.sinceOverride || singleOrderId);
  const persistCursor = !manual || (params.persistCursor === true && !singleOrderId);

  const locked = await acquireLock();
  if (!locked) {
    log.info('[ebs-sync] Skipping: another invocation is holding the lock.');
    return {
      body: {
        message: 'Skipped — another invocation is in progress.',
        skipped: true,
      },
    };
  }

  /** Accumulated summary returned as the action response body. */
  const summary = {
    manual,
    since: null,
    until: null,
    nextSince: null,
    cursorPersisted: false,
    processedOrders: [],
    lastProcessedOrderId: null,
    lastError: null,
    pendingCustomUpdates: [],
    halted: false,
    haltReason: null,
    reconcile: null,
    ...(singleOrderId ? { orderId: singleOrderId, outcome: null } : {}),
    startedAt: new Date(startTime).toISOString(),
    elapsedMs: 0,
  };

  let state;
  try {
    state = await loadState();
    const scheduledStatus = { status: state.status, lastError: state.lastError };
    const scanSince = params.sinceOverride ?? state.since;
    summary.since = scanSince;
    summary.lastProcessedOrderId = state.lastProcessedOrderId;

    if (manual) {
      log.info(`[ebs-sync] Manual run from ${scanSince}${params.untilOverride ? ` until ${params.untilOverride}` : ''}; persisted cursor ${state.since ?? 'null'} is ${persistCursor ? 'replaced' : 'kept'}.`);
    }
    log.info(`[ebs-sync] State loaded — since=${state.since ?? 'null (will default to 1h ago)'}, status=${state.status}, processedCount=${state.processedCount ?? 0}, failedCount=${state.failedCount ?? 0}`);

    // Managed-inventory: queue sold units per order accepted by EBS.
    const inventoryEnabled = isInventorySyncEnabled(params);
    if (inventoryEnabled) summary.inventoryOutboxSeqs = [];

    const runCtx = {
      params, ctx, log, state, summary, inventoryEnabled, lastAttemptStartAt,
    };

    // ── 0. Retry pending custom updates from previous runs ───────────
    await flushPendingCustomUpdates(params, state, log);

    // ── Single order (manual POST { orderId }) ───────────────────────
    // Same checks and send as the journal pass, for an order the journal
    // pass can't see (its global journal entry is missing). Ignores
    // custom.syncError on purpose: this is the explicit retry.
    if (singleOrderId) {
      const { outcome, reason } = await processOrder(runCtx, singleOrderId);
      summary.outcome = outcome;
      if (reason) summary.reason = reason;
      if (outcome === 'failed') {
        summary.halted = true;
        summary.haltReason = 'max-retries';
      } else if (outcome === 'deferred') {
        summary.halted = true;
        summary.haltReason = 'deadline';
      }
      summary.reconcile = { skipped: 'manual' };
      finishManualRun(state, summary, scheduledStatus);
      await saveState(manualRunUpdates(state, false));
      return { body: summary };
    }

    // ── 1. Fetch journal entries and find the batch boundary ────────────
    const { entries, until: batchUntil } = await getJournalEntries(params, scanSince, log, params.untilOverride);
    summary.until = batchUntil;
    log.info(`[ebs-sync] ${entries.length} journal entries since ${scanSince ?? 'default (1h ago)'} until ${batchUntil}`);

    // ── 2. Terminal events → unique orders, oldest first ─────────────
    const queue = terminalOrders(entries);

    if (entries.length > 0 && queue.length === 0) {
      // Entries came back but none were terminal — log event type breakdown to diagnose.
      const eventCounts = {};
      for (const e of entries) {
        eventCounts[e.event ?? '(missing)'] = (eventCounts[e.event ?? '(missing)'] || 0) + 1;
      }
      log.info(`[ebs-sync] No terminal events found. Event breakdown: ${JSON.stringify(eventCounts)}`);
    }

    log.info(
      `[ebs-sync] ${queue.length} unique order IDs to evaluate${queue.length > 0 ? `: ${queue.map((q) => q.orderId).join(', ')}` : ''}`,
    );

    // ── 3. Process each order ──────────────────────────────────────────
    let stoppedAt = -1; // index of the first order not handled on deadline
    let firstRetryAt = -1; // index of the first order whose reads failed
    let failed = false;
    for (let i = 0; i < queue.length; i++) {
      if (Date.now() > deadlineAt) {
        log.info(`[ebs-sync] Approaching 10-minute deadline. Stopping with ${queue.length - i} order(s) left.`);
        summary.halted = true;
        summary.haltReason = 'deadline';
        stoppedAt = i;
        break;
      }

      const { outcome, stopRun } = await processOrder(runCtx, queue[i].orderId);
      if (stopRun) {
        // EBS has the order but neither syncedAt nor the pending update could
        // be stored. Send nothing more; keep the cursor so it is re-read.
        summary.halted = true;
        summary.haltReason = 'state-unavailable';
        failed = true;
        break;
      }
      if (outcome === 'retry') {
        // Order or journal read failed: keep going, but the cursor must not
        // pass this order's entry or it would never be read again.
        if (firstRetryAt < 0) firstRetryAt = i;
        summary.retryOrders = [...(summary.retryOrders ?? []), queue[i].orderId];
        continue;
      }
      if (outcome === 'failed') {
        summary.halted = true;
        summary.haltReason = 'max-retries';
        failed = true;
        break;
      }
      if (outcome === 'deferred') {
        // Not enough time left to send it safely; it is first next run.
        log.info(`[ebs-sync] Not enough time left to send ${queue[i].orderId}. Stopping with ${queue.length - i} order(s) left.`);
        summary.halted = true;
        summary.haltReason = 'deadline';
        stoppedAt = i;
        break;
      }
    }

    // ── 4. Cursor ──────────────────────────────────────────────────────
    const holdAt = [stoppedAt, firstRetryAt].filter((x) => x >= 0);
    summary.nextSince = nextCursor({
      scanSince, batchUntil, failed, stoppedAt: holdAt.length ? Math.min(...holdAt) : -1, queue,
    });
    if (persistCursor && summary.nextSince) {
      state.since = summary.nextSince;
      summary.cursorPersisted = true;
    }

    // ── 5. Journal-independent reconciliation (scheduled runs, hourly) ─
    if (!isReconcileEnabled(params)) {
      summary.reconcile = { skipped: 'disabled' };
    } else if (manual) {
      summary.reconcile = { skipped: 'manual' };
    } else if (failed) {
      // EBS just failed for an order; don't send more until the next pass.
      summary.reconcile = { skipped: 'journal-pass-failed' };
    } else if (summary.haltReason === 'deadline' || Date.now() > deadlineAt - RECONCILE_MIN_REMAINING_MS) {
      summary.reconcile = { skipped: 'deadline' };
    } else if (!isReconcileDue(state)) {
      summary.reconcile = { skipped: 'not-due' };
    } else {
      summary.reconcile = await reconcileOrders(runCtx, {
        deadlineAt,
        sendOrder: (orderId, order, orderJournal) => sendOrder(runCtx, orderId, order, orderJournal),
        skipReason: (orderId, order) => skipReason(state, orderId, order),
      });
      if (summary.reconcile.failedOrderId || summary.reconcile.stateUnavailable) failed = true;
    }

    if (manual) {
      finishManualRun(state, summary, scheduledStatus);
      await saveState(manualRunUpdates(state, persistCursor));
    } else {
      state.lastRun = new Date().toISOString();
      state.status = failed ? 'error' : 'idle';
      await saveState(state);
    }
  } catch (err) {
    // A manual run's HTTP response may be gone by now (long runs): record
    // the failure where GET can show it. Best effort; rethrow either way.
    if (manual && state) {
      summary.lastError = err.message;
      await saveState({ lastManualRun: manualRunRecord(summary) }).catch(() => {});
    }
    throw err;
  } finally {
    await releaseLock();
    summary.elapsedMs = Date.now() - startTime;
  }

  return { body: summary };
}

/** What GET shows about the last manual run (its HTTP response may time out). */
function manualRunRecord(summary) {
  const keys = [
    'since', 'until', 'orderId', 'outcome', 'reason', 'nextSince', 'cursorPersisted',
    'processedOrders', 'retryOrders', 'pendingCustomUpdates', 'halted', 'haltReason', 'lastError', 'startedAt',
  ];
  const record = Object.fromEntries(keys.filter((k) => k in summary).map((k) => [k, summary[k]]));
  record.finishedAt = new Date().toISOString();
  return record;
}

/**
 * The fields a manual run writes. Not the whole state: a scheduled run may
 * have saved a newer cursor (or other fields) meanwhile.
 */
function manualRunUpdates(state, persistCursor) {
  const updates = {
    pendingCustomUpdates: state.pendingCustomUpdates,
    lastManualRun: state.lastManualRun,
    lastProcessedOrderId: state.lastProcessedOrderId,
    processedCount: state.processedCount,
    failedCount: state.failedCount,
  };
  if (persistCursor) updates.since = state.since;
  return updates;
}

/** Manual runs leave the scheduled run's status / lastError as they were. */
function finishManualRun(state, summary, scheduledStatus) {
  Object.assign(state, scheduledStatus);
  state.lastManualRun = manualRunRecord(summary);
}

const TERMINAL_EVENTS = new Set(['payment_completed', 'payment_cancelled']);

/**
 * Unique orderIds with a terminal entry, ordered by their earliest terminal
 * entry's timestamp (journal buckets are not guaranteed to come back sorted).
 *
 * @param {object[]} entries
 * @returns {{ orderId: string, ts: number }[]} ts is NaN when unknown
 */
export function terminalOrders(entries) {
  const byOrder = new Map();
  entries.forEach((e, idx) => {
    if (!e.orderId || !TERMINAL_EVENTS.has(e.event)) return;
    const ts = Date.parse(e.timestamp);
    const prev = byOrder.get(e.orderId);
    if (!prev || (!Number.isNaN(ts) && (Number.isNaN(prev.ts) || ts < prev.ts))) {
      byOrder.set(e.orderId, { orderId: e.orderId, ts, idx: prev?.idx ?? idx });
    }
  });
  // Unknown timestamps sort first so the cursor never moves past them.
  const key = (o) => (Number.isNaN(o.ts) ? -Infinity : o.ts);
  return [...byOrder.values()]
    .sort((a, b) => key(a) - key(b) || a.idx - b.idx)
    .map(({ orderId, ts }) => ({ orderId, ts }));
}

/**
 * Where the next run should start reading.
 *
 *   completed      → the queried `until`, even for an empty batch
 *   max-retries    → unchanged (`scanSince`): the batch is re-read next run
 *   deadline / read failure
 *                  → the terminal entry of the first unhandled order (stoppedAt:
 *                    deadline stop or the first order whose reads failed), so
 *                    the next run re-reads it; unchanged if its time is unknown
 *
 * @returns {string | null}
 */
export function nextCursor({
  scanSince, batchUntil, failed, stoppedAt, queue,
}) {
  if (failed) return scanSince;
  if (stoppedAt < 0) return batchUntil;
  const { ts } = queue[stoppedAt];
  if (Number.isNaN(ts)) return scanSince;
  return new Date(Math.min(ts, Date.parse(batchUntil))).toISOString();
}

/** Why an order must not be (re)sent to EBS, or null if it may be. */
export function skipReason(state, orderId, order) {
  if (state.pendingCustomUpdates[orderId]) return 'custom-update-pending';
  const alreadySyncedAt = order.custom?.syncedAt || order.custom?.syncedToEbs;
  if (alreadySyncedAt) return `already synced at ${alreadySyncedAt}`;
  if (order.state === 'payment_cancelled') return 'payment_cancelled';
  return null;
}

/**
 * Journal path: fetch one order, skip it if it needs no sync, else load its
 * per-order journal and send it to EBS.
 *
 * 'retry': reading the order or its journal failed; nothing was sent.
 *
 * @returns {Promise<{ outcome: 'synced' | 'skipped' | 'retry' | 'failed' | 'deferred', reason?: string, stopRun?: boolean }>}
 */
async function processOrder(runCtx, orderId) {
  const { params, log, state } = runCtx;

  // Already accepted by EBS, custom patch still pending — don't even fetch.
  if (state.pendingCustomUpdates[orderId]) {
    log.info(`[ebs-sync] Order ${orderId} already sent to EBS (custom update pending) — skipping.`);
    return { outcome: 'skipped', reason: 'custom-update-pending' };
  }

  let order;
  try {
    order = await getOrder(params, orderId);
  } catch (fetchErr) {
    log.warn(`[ebs-sync] Could not fetch order ${orderId}: ${fetchErr.message}`);
    return { outcome: 'retry', reason: 'order-fetch-failed' };
  }
  if (!order) {
    log.warn(`[ebs-sync] Order ${orderId} not found — skipping.`);
    return { outcome: 'skipped', reason: 'not-found' };
  }

  const reason = skipReason(state, orderId, order);
  if (reason) {
    log.info(`[ebs-sync] Order ${orderId}: ${reason} — skipping.`);
    return { outcome: 'skipped', reason };
  }

  let orderJournal;
  try {
    const since = order.createdAt
      ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    orderJournal = await getOrderJournalEntries(params, orderId, since, new Date().toISOString());
    log.info(`[ebs-sync] Order ${orderId} journal: ${orderJournal.length} entries`);
  } catch (journalErr) {
    log.warn(`[ebs-sync] Could not fetch journal for ${orderId}: ${journalErr.message}`);
    await updateOrderCustom(params, orderId, { syncError: 'journal_fetch_failed' }).catch((patchErr) => {
      log.warn(`[ebs-sync] Failed to patch syncError for ${orderId}: ${patchErr.message}`);
    });
    return { outcome: 'retry', reason: 'journal-fetch-failed' };
  }

  return sendOrder(runCtx, orderId, order, orderJournal);
}

/**
 * Send one order to EBS (with retries) and record the outcome: syncedAt (or a
 * pending custom update), inventory outbox, counters; on failure syncError.
 * Callers must have checked skipReason() right before.
 *
 * 'deferred': an attempt could not start in time (runCtx.lastAttemptStartAt).
 * The order was not accepted by EBS and gets no syncError; it is retried on a
 * later run.
 *
 * stopRun: EBS accepted the order but no marker could be stored; the caller
 * must not send anything else in this run.
 *
 * @returns {Promise<{ outcome: 'synced' | 'failed' | 'deferred', syncError?: string, stopRun?: boolean }>}
 */
async function sendOrder(runCtx, orderId, order, orderJournal) {
  const {
    params, ctx, log, state, summary, inventoryEnabled, lastAttemptStartAt,
  } = runCtx;
  let lastErr = null;
  let ebsResult = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (Date.now() > lastAttemptStartAt) {
      log.info(`[ebs-sync] Order ${orderId}: no time left for attempt ${attempt}; leaving it for the next run.`);
      return { outcome: 'deferred' };
    }
    try {
      ebsResult = await syncOrderToEbs(ctx, params, order, orderJournal, {
        signal: AbortSignal.timeout(EBS_ATTEMPT_TIMEOUT_MS),
      });
      log.info(`[ebs-sync] Order ${orderId} synced to EBS on attempt ${attempt}.`);
      break;
    } catch (err) {
      lastErr = err;

      const errStatus = err?.ebsStatus ?? err?.response?.error?.statusCode ?? 0;
      const syncLog = { action: 'order-sync', id: orderId, status: errStatus, error: err.message };
      // Set only on errors raised by proxyFetch. 'none' means the proxy rejected the
      // request itself; a status means the proxy forwarded that status from EBS.
      if (err?.upstreamStatus) syncLog.upstreamStatus = err.upstreamStatus;
      if (errStatus >= 400) {
        const body = err?.response?.error?.body;
        if (body) syncLog.response = typeof body === 'string' ? body : JSON.stringify(body);
      }
      await logOrderSync(params, syncLog).catch((logErr) => {
        log.warn(`[ebs-sync] Failed to log order-sync for ${orderId}`, errorInfo(logErr));
      });

      if (!isRetriableError(err)) {
        log.warn(
          `[ebs-sync] Order ${orderId} attempt ${attempt}/${MAX_RETRIES} failed with non-retriable error`,
          errorInfo(err),
        );
        break;
      }
      log.warn(
        `[ebs-sync] Order ${orderId} attempt ${attempt}/${MAX_RETRIES} failed`,
        errorInfo(err),
      );
      if (attempt < MAX_RETRIES) {
        if (Date.now() + RETRY_BASE_DELAY_MS * attempt > lastAttemptStartAt) {
          log.info(`[ebs-sync] Order ${orderId}: no time left to retry; leaving it for the next run.`);
          return { outcome: 'deferred' };
        }
        await sleep(RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }

  if (ebsResult) {
    // EBS accepted the order: record its managed-inventory units. Collecting
    // and logging do no I/O, so they don't widen the resend window below;
    // the log line is the recovery source if the run dies before queueing.
    let inventoryDeltas = [];
    if (inventoryEnabled) {
      try {
        inventoryDeltas = collectOrderDeltas(order);
      } catch (invErr) {
        log.error(`[ebs-sync] Failed to collect inventory deltas for ${orderId}`, errorInfo(invErr));
      }
      if (inventoryDeltas.length) {
        log.info(`[ebs-sync] Inventory deltas for ${orderId}: ${JSON.stringify(inventoryDeltas)}`);
      }
    }

    // EBS has the order now. From here on, never send it again. Store that
    // first (syncedAt, else a pending update in state), before any other I/O:
    // a run killed in between would resend the order on the next run. If the
    // syncedAt patch fails, keep it in state and retry only the patch.
    const syncedAt = new Date().toISOString();
    let stopRun = false;
    const patchErr = await markOrderSynced(params, orderId, syncedAt, log);
    if (patchErr) {
      state.pendingCustomUpdates[orderId] = {
        syncedAt,
        failedAt: new Date().toISOString(),
        error: patchErr.message,
      };
      summary.pendingCustomUpdates.push(orderId);
      log.error(
        `[ebs-sync] Order ${orderId} sent to EBS but custom update failed after ${CUSTOM_UPDATE_RETRIES} attempts — will retry the update on the next run.`,
        errorInfo(patchErr),
      );
      // Persist now so a crash later in this run can't cause the order to be resent.
      const saveErr = await savePendingUpdates(state, log);
      if (saveErr) {
        // Nothing durable says EBS has this order. Stop sending; the final
        // state save at the end of the run is the last chance to store it.
        stopRun = true;
        log.error(`[ebs-sync] ORDER ${orderId} IS IN EBS BUT NOT MARKED SYNCED (custom patch and state save failed). Stopping the run; if the next run resends it, EBS gets a duplicate.`, errorInfo(saveErr));
      }
    }

    await logOrderSync(params, {
      action: 'order-sync', id: orderId, status: ebsResult.status, xml: ebsResult.xml,
    }).catch((logErr) => {
      log.warn(`[ebs-sync] Failed to log order-sync for ${orderId}`, errorInfo(logErr));
    });

    // Queue the inventory decrement only AFTER syncedAt / the pending update is
    // persisted. Queueing earlier would sit inside the window where a crash
    // makes the next run resend the order to EBS, and that resend would also
    // queue it again (double decrement), while lengthening the window with
    // state round-trips and retry sleeps. Trade-off: a crash between here and
    // the outbox write loses the queue write, but the deltas are in the info
    // log above for manual recovery. Still per order (not in finally), so a
    // run killed at the action timeout keeps every order queued before it.
    // Not when stopRun: then the next run will most likely resend the order
    // and queue it itself; queueing here too would decrement twice.
    if (inventoryDeltas.length && stopRun) {
      log.error(`[ebs-sync] INVENTORY NOT QUEUED for ${orderId} (no sync marker stored). If the order is not resent, apply manually: ${JSON.stringify(inventoryDeltas)}`);
    } else if (inventoryDeltas.length) {
      summary.inventoryOutboxSeqs.push(await queueInventoryDeltas({ orderIds: [orderId], deltas: inventoryDeltas }, log));
    }

    state.lastProcessedOrderId = orderId;
    state.processedCount = (state.processedCount || 0) + 1;
    state.lastError = null;

    summary.processedOrders.push(orderId);
    summary.lastProcessedOrderId = orderId;
    summary.lastError = null;
    return { outcome: 'synced', ...(stopRun ? { stopRun } : {}) };
  }

  const errStack = lastErr?.stack || String(lastErr);
  state.failedCount = (state.failedCount || 0) + 1;
  state.lastError = errStack;
  summary.lastError = errStack;

  // Surface the failure on the order itself so it's visible downstream.
  const syncError = describeSyncError(lastErr);
  await updateOrderCustom(params, orderId, { syncError }).catch((patchErr) => {
    log.warn(`[ebs-sync] Failed to patch syncError for ${orderId}`, errorInfo(patchErr));
  });

  log.error(
    `[ebs-sync] Order ${orderId} failed after ${MAX_RETRIES} attempts. Halting.`,
    errorInfo(lastErr),
  );
  return { outcome: 'failed', syncError };
}


/**
 * Write one accepted order's inventory deltas to the outbox: entry first, then head.
 *
 * Retries are idempotent: the seq is allocated once and reused, and the entry
 * write is not repeated once it succeeded. So a failure between the entry and
 * head writes (or an ambiguous failure of either) never publishes a second
 * copy of the same run's deltas, which would double-decrement the sheet.
 *
 * Never throws: the orders are already in EBS and will not be processed again,
 * so on final failure the full payload is logged for manual recovery.
 *
 * @returns {Promise<number | null>} the outbox seq, or null on failure
 */
export async function queueInventoryDeltas({ orderIds, deltas }, log) {
  const entry = {
    activationId: process.env.__OW_ACTIVATION_ID,
    createdAt: new Date().toISOString(),
    orderIds,
    deltas,
  };
  let seq = null;
  let entryWritten = false;
  let lastErr = null;
  for (let attempt = 1; attempt <= OUTBOX_WRITE_RETRIES; attempt++) {
    try {
      if (seq === null) seq = await allocateInventoryOutboxSeq();
      if (!entryWritten) {
        await putInventoryOutboxEntry(seq, entry);
        entryWritten = true;
      }
      await publishInventoryOutboxHead(seq);
      log.info(`[ebs-sync] Queued inventory outbox seq=${seq}: ${deltas.length} deltas for orders ${orderIds.join(', ')}`);
      return seq;
    } catch (err) {
      lastErr = err;
      log.warn(`[ebs-sync] Inventory outbox write attempt ${attempt}/${OUTBOX_WRITE_RETRIES} failed (seq=${seq ?? 'unallocated'}, entryWritten=${entryWritten})`, errorInfo(err));
      if (attempt < OUTBOX_WRITE_RETRIES) await sleep(OUTBOX_WRITE_BASE_DELAY_MS * attempt);
    }
  }
  log.error(await describeOutboxFailure(seq, entryWritten, entry), errorInfo(lastErr));
  return null;
}

/**
 * Final-failure message for an outbox write. Telling ops to "apply manually"
 * when the entry was in fact stored would double-decrement: a stored entry past
 * head is applied automatically once a later write moves head past it.
 */
async function describeOutboxFailure(seq, entryWritten, entry) {
  const payload = JSON.stringify({ seq, ...entry });
  let stored = entryWritten;
  if (!stored && seq !== null) {
    stored = await inventoryOutboxEntryExists(seq).catch(() => null); // null = unknown
  }
  if (stored === true) {
    return `[ebs-sync] INVENTORY OUTBOX HEAD NOT PUBLISHED — entry inventory:outbox:${seq} is stored and will be applied automatically once a later write moves head past it. Do NOT apply manually: ${payload}`;
  }
  if (stored === null) {
    return `[ebs-sync] INVENTORY OUTBOX WRITE FAILED — check whether inventory:outbox:${seq} exists: if it does, it will be applied automatically (do NOT apply manually); if it does not, apply manually: ${payload}`;
  }
  return `[ebs-sync] INVENTORY OUTBOX WRITE FAILED — entry not stored, apply manually: ${payload}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Patch custom.syncedAt (and clear syncError), retrying up to CUSTOM_UPDATE_RETRIES times.
 *
 * @returns {Promise<Error | null>} null on success, or the last error
 */
async function markOrderSynced(params, orderId, syncedAt, log) {
  let lastErr = null;
  for (let attempt = 1; attempt <= CUSTOM_UPDATE_RETRIES; attempt++) {
    try {
      await updateOrderCustom(params, orderId, { syncedAt, syncError: null });
      return null;
    } catch (err) {
      lastErr = err;
      log.warn(
        `[ebs-sync] Custom update for ${orderId} attempt ${attempt}/${CUSTOM_UPDATE_RETRIES} failed`,
        errorInfo(err),
      );
      if (attempt < CUSTOM_UPDATE_RETRIES) {
        await sleep(CUSTOM_UPDATE_BASE_DELAY_MS * attempt);
      }
    }
  }
  return lastErr;
}

/**
 * Persist state.pendingCustomUpdates, retrying once.
 * @returns {Promise<Error | null>} null on success, or the last error
 */
async function savePendingUpdates(state, log) {
  let lastErr = null;
  for (let attempt = 1; attempt <= PENDING_SAVE_RETRIES; attempt++) {
    try {
      await saveState({ pendingCustomUpdates: state.pendingCustomUpdates });
      return null;
    } catch (err) {
      lastErr = err;
      log.warn(`[ebs-sync] Saving pending custom updates attempt ${attempt}/${PENDING_SAVE_RETRIES} failed`, errorInfo(err));
    }
  }
  return lastErr;
}

/**
 * Retry custom.syncedAt patches for orders that EBS accepted on an earlier run.
 * Mutates state.pendingCustomUpdates: entries are removed once the patch succeeds.
 */
async function flushPendingCustomUpdates(params, state, log) {
  const pending = Object.entries(state.pendingCustomUpdates);
  if (pending.length === 0) return;

  log.info(`[ebs-sync] Retrying ${pending.length} pending custom update(s): ${pending.map(([id]) => id).join(', ')}`);

  for (const [orderId, entry] of pending) {
    const patchErr = await markOrderSynced(params, orderId, entry.syncedAt, log);
    if (patchErr) {
      state.pendingCustomUpdates[orderId] = { ...entry, error: patchErr.message };
      log.error(`[ebs-sync] Pending custom update for ${orderId} still failing`, errorInfo(patchErr));
    } else {
      delete state.pendingCustomUpdates[orderId];
      log.info(`[ebs-sync] Pending custom update for ${orderId} succeeded (syncedAt=${entry.syncedAt}).`);
    }
  }
}

/**
 * Reduce a sync failure to a compact, stable code for storage in the order's
 * custom.syncError. This value is customer-readable via the API, so it must
 * never carry raw error messages, payloads, or other internals — only a vague
 * code naming the system involved. The matching detail lives in the logs.
 *
 *   payment_snapshot_missing  - journal had no usable payment_completed entry
 *   ebs_rejected              - EBS responded but did not accept the order
 *   ebs_http_<status>         - EBS/proxy returned a non-2xx HTTP status
 *   ebs_unreachable           - network/timeout/DNS — no response from EBS
 *   sync_failed               - anything else
 *
 * @param {(Error & { ebsStatus?: number, response?: { statusCode?: number, error?: { statusCode?: number } } }) | null} err
 * @returns {string}
 */
function describeSyncError(err) {
  if (!err) return 'sync_failed';
  const message = err.message ?? String(err);

  if (/cannot build payment snapshot/i.test(message)) {
    return 'payment_snapshot_missing';
  }

  if (err.ebsStatus != null || /EBS rejected order/i.test(message)) {
    return 'ebs_rejected';
  }

  const status = err?.response?.statusCode ?? err?.response?.error?.statusCode;
  if (status) return `ebs_http_${status}`;

  if (isRetriableError(err)) return 'ebs_unreachable';

  return 'sync_failed';
}
