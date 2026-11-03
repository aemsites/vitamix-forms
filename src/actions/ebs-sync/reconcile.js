/**
 * Journal-independent reconciliation for ebs-sync.
 *
 * The journal pass only finds orders whose terminal entry shows up in the
 * global orders journal within the look-back window. If an entry lands late or
 * never lands, the order is never synced and nothing reports it. This pass
 * asks the orders API directly instead.
 *
 * Disabled unless EBS_RECONCILE_ENABLED is "true". Listing all orders needs
 * a token that may list orders (today: admin role only); enabling is tracked
 * in #126.
 *
 * At most once per RECONCILE_INTERVAL_MS (scheduled runs only):
 *   1. List orders in state payment_completed whose latest snapshot is between
 *      RECONCILE_LOOKBACK_MS and RECONCILE_MIN_AGE_MS old, without syncedAt or
 *      an EBS syncError (journal_fetch_failed is retried), and not waiting on a
 *      pending syncedAt patch.
 *   2. Check at most RECONCILE_MAX_ORDERS of them, never-reported first, then
 *      oldest first. For each, re-fetch the order (skip if synced, failed,
 *      cancelled or no longer payment_completed) and load its per-order journal.
 *   3. If the journal has a payment_completed entry from the last
 *      RECONCILE_MAX_AUTO_SYNC_AGE_MS, send the order to EBS through the normal
 *      path and report it. Otherwise report it once and leave it alone:
 *        - no payment_completed entry: the order can't be built; it is
 *          re-checked every pass and sent once the entry appears
 *        - older entries: EBS has no duplicate protection, so these need a
 *          person to check EBS first, then a manual backfill
 *
 * Every order found is reported to the operations log as an `order-sync` event
 * with an `error` field, which raises an alert. Reports for unsendable orders
 * are recorded in state.reconcile.alerted so they are sent once per reason.
 *
 * The pass is bounded: one list call, at most RECONCILE_MAX_ORDERS orders and
 * the run deadline. When it stops early with unreported orders left, it is not
 * marked done, so the next scheduled run (5 min later) continues.
 */

import {
  listOrders, getOrder, getOrderJournalEntries, logOrderSync,
} from './commerce.js';
import { errorInfo } from '../../utils.js';

export const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
export const RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_MIN_AGE_MS = 30 * 60 * 1000;
export const RECONCILE_MAX_AUTO_SYNC_AGE_MS = 6 * 60 * 60 * 1000;
export const RECONCILE_MAX_ORDERS = 20;
/** Don't start a pass with less than this left before the run deadline. */
export const RECONCILE_MIN_REMAINING_MS = 2 * 60 * 1000;

const ALERT_SOURCE = 'ebs-sync-reconcile';

/**
 * syncError codes that mean "not attempted yet" rather than "EBS failed":
 * the per-order journal couldn't be read. These stay reconciliation candidates.
 */
const RETRYABLE_SYNC_ERRORS = new Set(['journal_fetch_failed']);
const blocksReconcile = (syncError) => Boolean(syncError) && !RETRYABLE_SYNC_ERRORS.has(syncError);

/**
 * @typedef {{ lastRunAt: string | null, alerted: Record<string, { reason: string, at: string }> }} ReconcileState
 */

/** @returns {ReconcileState} */
function reconcileState(state) {
  const r = state.reconcile || {};
  return { lastRunAt: r.lastRunAt ?? null, alerted: { ...(r.alerted || {}) } };
}

/** Whether reconciliation is switched on for this deployment. */
export function isReconcileEnabled(params) {
  return String(params.EBS_RECONCILE_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/** Whether a reconciliation pass is due (none yet, or the last one is an interval old). */
export function isReconcileDue(state, now = Date.now()) {
  const last = Date.parse(state.reconcile?.lastRunAt);
  return Number.isNaN(last) || now - last >= RECONCILE_INTERVAL_MS;
}

/**
 * Run one reconciliation pass. Mutates state.reconcile; the caller saves state.
 *
 * @param {{ params: object, log: object, state: object }} runCtx
 * @param {{
 *   deadlineAt: number,
 *   sendOrder: (orderId: string, order: object, journal: object[]) => Promise<{ outcome: string, syncError?: string }>,
 *   skipReason: (orderId: string, order: object) => string | null,
 * }} deps
 */
export async function reconcileOrders(runCtx, { deadlineAt, sendOrder, skipReason }) {
  const { params, log, state } = runCtx;
  const rs = reconcileState(state);
  const now = Date.now();
  const result = {
    listed: 0,
    candidates: 0,
    checked: 0,
    synced: [],
    reported: [],
    deferred: 0,
    failedOrderId: null,
    error: null,
    complete: false,
  };

  const report = async (orderId, reason, message, extra = {}) => {
    const payload = {
      action: 'order-sync', id: orderId, source: ALERT_SOURCE, reason, error: message, ...extra,
    };
    await logOrderSync(params, payload).catch((err) => {
      log.warn(`[ebs-sync] reconcile: failed to report ${reason} for ${orderId}`, errorInfo(err));
    });
  };

  // Unsendable orders: report once per reason, then just re-check quietly.
  const reportOnce = async (orderId, reason, message) => {
    if (rs.alerted[orderId]?.reason === reason) return;
    await report(orderId, reason, message);
    rs.alerted[orderId] = { reason, at: new Date().toISOString() };
    result.reported.push(orderId);
  };

  const finish = (complete) => {
    result.complete = complete;
    if (complete) rs.lastRunAt = new Date(now).toISOString();
    // Forget reports for orders that have left the window.
    for (const [id, a] of Object.entries(rs.alerted)) {
      if (!(now - Date.parse(a.at) < 2 * RECONCILE_LOOKBACK_MS)) delete rs.alerted[id];
    }
    state.reconcile = rs;
    log.info(`[ebs-sync] reconcile: ${JSON.stringify(result)}`);
    return result;
  };

  let listed;
  try {
    listed = await listOrders(params, {
      since: new Date(now - RECONCILE_LOOKBACK_MS).toISOString(),
      until: new Date(now - RECONCILE_MIN_AGE_MS).toISOString(),
      state: 'payment_completed',
    });
  } catch (err) {
    log.error('[ebs-sync] reconcile: could not list orders', errorInfo(err));
    result.error = err.message;
    await report(ALERT_SOURCE, 'list_failed', `Reconciliation could not list orders: ${err.message}`);
    // Counted as a pass so a broken listing alerts hourly, not every 5 minutes.
    return finish(true);
  }
  result.listed = listed.length;

  const candidates = listed
    .filter((o) => o?.id
      && o.state === 'payment_completed'
      && !o.syncedAt && !blocksReconcile(o.syncError)
      && !state.pendingCustomUpdates[o.id])
    .sort((a, b) => Number(Boolean(rs.alerted[a.id])) - Number(Boolean(rs.alerted[b.id]))
      || String(a.updatedAt).localeCompare(String(b.updatedAt)));
  result.candidates = candidates.length;

  let i = 0;
  let stoppedEarly = false;
  for (; i < candidates.length; i++) {
    if (i >= RECONCILE_MAX_ORDERS || Date.now() > deadlineAt) {
      stoppedEarly = true;
      break;
    }
    const orderId = candidates[i].id;
    result.checked += 1;

    let order;
    try {
      order = await getOrder(params, orderId);
    } catch (err) {
      log.warn(`[ebs-sync] reconcile: could not fetch order ${orderId}: ${err.message}`);
      continue;
    }
    // Re-check on the full order right before sending: listing metadata can be stale.
    const skip = !order ? 'not found' : (skipReason(orderId, order)
      || (blocksReconcile(order.custom?.syncError) && `syncError ${order.custom.syncError}`)
      || (order.state !== 'payment_completed' && `state ${order.state}`));
    if (skip) {
      log.info(`[ebs-sync] reconcile: order ${orderId}: ${skip} — skipping.`);
      continue;
    }

    let journal;
    try {
      journal = await getOrderJournalEntries(
        params,
        orderId,
        order.createdAt ?? new Date(now - 2 * RECONCILE_LOOKBACK_MS).toISOString(),
        new Date().toISOString(),
      );
    } catch (err) {
      log.warn(`[ebs-sync] reconcile: could not fetch journal for ${orderId}: ${err.message}`);
      continue;
    }

    const completed = journal.find((e) => e.event === 'payment_completed');
    if (!completed) {
      await reportOnce(
        orderId,
        'journal_missing_payment',
        'Completed order is not synced to EBS and its journal has no payment_completed entry, so it cannot be sent. Re-checked hourly; sent automatically once the entry appears.',
      );
      continue;
    }
    const completedAt = Date.parse(completed.timestamp);
    if (Number.isNaN(completedAt) || Date.now() - completedAt > RECONCILE_MAX_AUTO_SYNC_AGE_MS) {
      await reportOnce(
        orderId,
        'too_old_for_auto_sync',
        `Completed order is not synced to EBS and completed more than ${RECONCILE_MAX_AUTO_SYNC_AGE_MS / 3_600_000}h ago, so it is not sent automatically (EBS has no duplicate protection). Check EBS, then run a manual backfill.`,
      );
      continue;
    }

    const { outcome, syncError } = await sendOrder(orderId, order, journal);
    delete rs.alerted[orderId];
    if (outcome === 'synced') {
      result.synced.push(orderId);
      await report(orderId, 'reconciled', 'Completed order was missing from the orders journal scan; sent to EBS by reconciliation.');
    } else {
      result.failedOrderId = orderId;
      await report(orderId, 'reconcile_failed', `Completed order was missing from the orders journal scan; sending it to EBS failed (${syncError}).`);
      // Likely an EBS problem: stop here and let the next pass continue.
      i += 1;
      stoppedEarly = true;
      break;
    }
  }

  const rest = candidates.slice(i);
  result.deferred = rest.length;
  if (rest.length) {
    log.warn(`[ebs-sync] reconcile: ${rest.length} candidate(s) left for a later pass: ${rest.map((o) => o.id).join(', ')}`);
  }
  // Done unless orders never reported were left unchecked (deadline or cap).
  // A failed send counts as done so a down EBS isn't retried every 5 minutes.
  const unreportedLeft = rest.some((o) => !rs.alerted[o.id]);
  return finish(result.failedOrderId !== null || !(stoppedEarly && unreportedLeft));
}
