/**
 * Core EBS sync orchestration.
 *
 * Each scheduled invocation:
 *   1. Acquires a distributed lock (bails if already held)
 *   2. Loads the persisted `since` cursor from state
 *   3. Reads the global journal to discover orderIds from the time range
 *   4. Fetches each order to check its authoritative state:
 *        a. Skips if already synced (custom.syncedToEbs is set)
 *        b. Skips if cancelled (payment_cancelled) — advances cursor
 *        c. Skips if still in-flight (no terminal state yet) — does NOT advance cursor
 *        d. For payment_completed orders: queries the per-order journal for
 *           complete entries, then syncs to EBS with retries
 *        e. On success: patches custom.syncedToEbs, advances cursor
 *        f. On max-retries exhausted: records the error, halts
 *   5. Checks a 9.5-minute deadline before each order
 *   6. Advances the cursor only past fully-resolved orders
 *   7. Saves updated state and releases the lock
 */

import { loadState, saveState, acquireLock, releaseLock } from './state.js';
import { getJournalEntries, getOrderJournalEntries, getOrder, updateOrderCustom } from './commerce.js';
import { syncOrderToEbs } from './ebs.js';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 3_000; // 3s, 6s, 9s
const DEADLINE_MS = 9.5 * 60 * 1000; // stop accepting new orders at 9.5 min

/**
 * Run the EBS sync job.
 *
 * @param {object} params - Action params (env vars injected by the Runtime)
 * @returns {Promise<{body: object}>}
 */
export async function run(params) {
  const startTime = Date.now();

  const locked = await acquireLock();
  if (!locked) {
    console.log('[ebs-sync] Skipping: another invocation is holding the lock.');
    return {
      body: {
        message: 'Skipped — another invocation is in progress.',
        skipped: true,
      },
    };
  }

  const state = await loadState();

  /** Accumulated summary returned as the action response body. */
  const summary = {
    since: state.since,
    processedOrders: [],
    skippedOrders: [],
    lastProcessedOrderId: state.lastProcessedOrderId,
    lastError: null,
    halted: false,
    haltReason: null,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
  };

  try {
    // ── 1. Discover orderIds from the global journal ────────────────────
    const entries = await getJournalEntries(params, state.since);
    console.log(`[ebs-sync] ${entries.length} journal entries since ${state.since ?? 'default (1h ago)'}`);

    // Build per-order metadata: earliest timestamp (for processing order)
    // and latest timestamp (for cursor advancement).
    const orderMeta = new Map();
    for (const e of entries) {
      if (!e.orderId) continue;
      const meta = orderMeta.get(e.orderId);
      if (!meta) {
        orderMeta.set(e.orderId, { earliest: e.timestamp, latest: e.timestamp });
      } else {
        if (e.timestamp < meta.earliest) meta.earliest = e.timestamp;
        if (e.timestamp > meta.latest) meta.latest = e.timestamp;
      }
    }

    // Process oldest orders first.
    const orderIds = [...orderMeta.keys()].sort(
      (a, b) => orderMeta.get(a).earliest.localeCompare(orderMeta.get(b).earliest),
    );

    console.log(`[ebs-sync] ${orderIds.length} unique order IDs to evaluate`);

    // Track the latest timestamp for orders we've fully resolved (synced,
    // cancelled, or permanently skipped). The cursor only advances past
    // resolved orders — in-flight orders keep the cursor in place so they
    // are re-evaluated once they reach a terminal state.
    let maxResolvedTimestamp = state.since;

    for (const orderId of orderIds) {
      // ── Deadline guard ──────────────────────────────────────────────
      if (Date.now() - startTime > DEADLINE_MS) {
        console.log('[ebs-sync] Approaching 10-minute deadline. Stopping.');
        summary.halted = true;
        summary.haltReason = 'deadline';
        break;
      }

      const latestTimestamp = orderMeta.get(orderId).latest;

      // ── 2. Fetch the order and check its authoritative state ────────
      let order;
      try {
        order = await getOrder(params, orderId);
      } catch (fetchErr) {
        console.warn(`[ebs-sync] Could not fetch order ${orderId}: ${fetchErr.message}`);
        maxResolvedTimestamp = latestTimestamp;
        continue;
      }

      if (!order) {
        console.warn(`[ebs-sync] Order ${orderId} not found — skipping.`);
        maxResolvedTimestamp = latestTimestamp;
        continue;
      }

      // ── Already synced ─────────────────────────────────────────────
      if (order.custom?.syncedToEbs) {
        console.log(
          `[ebs-sync] Order ${orderId} already synced at ${order.custom.syncedToEbs} — skipping.`,
        );
        maxResolvedTimestamp = latestTimestamp;
        continue;
      }

      // ── Cancelled — skip and advance cursor ────────────────────────
      if (order.state === 'payment_cancelled') {
        console.log(`[ebs-sync] Order ${orderId} is payment_cancelled — skipping.`);
        summary.skippedOrders.push(orderId);
        maxResolvedTimestamp = latestTimestamp;
        continue;
      }

      // ── Not in a terminal state — still in-flight ──────────────────
      if (order.state !== 'payment_completed') {
        console.log(
          `[ebs-sync] Order ${orderId} is not terminal (state=${order.state})`
          + ' — will retry in next window.',
        );
        // Do NOT advance cursor past in-flight orders.
        continue;
      }

      // ── 3. Terminal & unsynced: query complete per-order journal ────
      let orderJournal;
      try {
        const since = order.createdAt
          ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const until = new Date().toISOString();
        orderJournal = await getOrderJournalEntries(params, orderId, since, until);
        console.log(`[ebs-sync] Order ${orderId} journal: ${orderJournal.length} entries`);
      } catch (journalErr) {
        console.warn(
          `[ebs-sync] Could not fetch journal for ${orderId}: ${journalErr.message}`,
        );
        // Don't advance cursor — we'll retry this order next invocation.
        continue;
      }

      // ── 4. Sync to EBS (with retries) ──────────────────────────────
      let lastErr = null;
      let synced = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await syncOrderToEbs(params, order, orderJournal);

          const syncedAt = new Date().toISOString();
          await updateOrderCustom(params, orderId, { syncedToEbs: syncedAt });

          maxResolvedTimestamp = latestTimestamp;
          state.lastProcessedOrderId = orderId;
          state.processedCount = (state.processedCount || 0) + 1;
          state.lastError = null;

          summary.processedOrders.push(orderId);
          summary.lastProcessedOrderId = orderId;
          summary.lastError = null;

          console.log(`[ebs-sync] Order ${orderId} synced on attempt ${attempt}.`);
          synced = true;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(
            `[ebs-sync] Order ${orderId} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`,
          );
          if (attempt < MAX_RETRIES) {
            await sleep(RETRY_BASE_DELAY_MS * attempt);
          }
        }
      }

      if (!synced) {
        const errStack = lastErr?.stack || String(lastErr);
        state.failedCount = (state.failedCount || 0) + 1;
        state.lastError = errStack;

        summary.lastError = errStack;
        summary.halted = true;
        summary.haltReason = 'max-retries';

        console.error(
          `[ebs-sync] Order ${orderId} failed after ${MAX_RETRIES} attempts. Halting.\n${errStack}`,
        );
        break;
      }
    }

    // ── Persist state ──────────────────────────────────────────────────
    if (maxResolvedTimestamp && maxResolvedTimestamp !== state.since) {
      state.since = maxResolvedTimestamp;
    }
    state.lastRun = new Date().toISOString();
    state.status =
      summary.halted && summary.haltReason !== 'deadline' ? 'error' : 'idle';
    await saveState(state);
  } finally {
    await releaseLock();
    summary.elapsedMs = Date.now() - startTime;
  }

  return { body: summary };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
