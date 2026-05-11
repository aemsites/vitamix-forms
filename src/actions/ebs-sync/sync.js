/**
 * Core EBS sync orchestration.
 *
 * Each scheduled invocation:
 *   1. Acquires a distributed lock (bails if already held)
 *   2. Loads the persisted `since` cursor from state
 *   3. Reads the global journal and filters to terminal events
 *      (payment_completed / payment_cancelled) to discover resolved orderIds
 *   4. For each resolved orderId (oldest first):
 *        a. Fetches the order — skips if already synced (custom.syncedToEbs)
 *        b. Skips cancelled orders (including fraud-declined) — no EBS sync needed
 *        c. For payment_completed: queries complete per-order journal
 *        d. Calls syncOrderToEbs(params, order, orderJournal), retrying up to MAX_RETRIES
 *        e. On success: patches custom.syncedToEbs
 *        f. On max-retries exhausted: records the error, halts without advancing cursor
 *   5. Checks a 9.5-minute deadline before each order
 *   6. On success/deadline: advances cursor to the latest journal entry timestamp
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
    lastProcessedOrderId: state.lastProcessedOrderId,
    lastError: null,
    halted: false,
    haltReason: null,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
  };

  try {
    // ── 1. Fetch journal entries and find the batch boundary ────────────
    const entries = await getJournalEntries(params, state.since);
    console.log(`[ebs-sync] ${entries.length} journal entries since ${state.since ?? 'default (1h ago)'}`);

    // The cursor advances to the latest timestamp in the batch — not
    // Date.now(), since time passes during processing.
    let batchLatestTimestamp = state.since;
    for (const e of entries) {
      if (e.timestamp > batchLatestTimestamp) batchLatestTimestamp = e.timestamp;
    }

    // ── 2. Filter to terminal events, collect unique orderIds ──────────
    const TERMINAL_EVENTS = new Set(['payment_completed', 'payment_cancelled']);
    const terminalEntries = entries.filter(
      (e) => e.orderId && TERMINAL_EVENTS.has(e.event),
    );

    // Deduplicate to unique orderIds, preserving oldest-first order.
    const seen = new Set();
    const orderIds = [];
    for (const e of terminalEntries) {
      if (!seen.has(e.orderId)) {
        seen.add(e.orderId);
        orderIds.push(e.orderId);
      }
    }

    console.log(
      `[ebs-sync] ${terminalEntries.length} terminal entries, ${orderIds.length} unique order IDs to evaluate`,
    );

    let halted = false;

    for (const orderId of orderIds) {
      // ── Deadline guard ──────────────────────────────────────────────
      if (Date.now() - startTime > DEADLINE_MS) {
        console.log('[ebs-sync] Approaching 10-minute deadline. Stopping.');
        summary.halted = true;
        summary.haltReason = 'deadline';
        break;
      }

      // ── 3. Fetch the order ──────────────────────────────────────────
      let order;
      try {
        order = await getOrder(params, orderId);
      } catch (fetchErr) {
        console.warn(`[ebs-sync] Could not fetch order ${orderId}: ${fetchErr.message}`);
        continue;
      }

      if (!order) {
        console.warn(`[ebs-sync] Order ${orderId} not found — skipping.`);
        continue;
      }

      // ── Already synced ─────────────────────────────────────────────
      if (order.custom?.syncedToEbs) {
        console.log(
          `[ebs-sync] Order ${orderId} already synced at ${order.custom.syncedToEbs} — skipping.`,
        );
        continue;
      }

      // ── Cancelled (including fraud-declined) — no EBS sync needed ──
      if (order.state === 'payment_cancelled') {
        console.log(`[ebs-sync] Order ${orderId} is payment_cancelled — skipping.`);
        continue;
      }

      // ── 4. Fetch complete per-order journal ─────────────────────────
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
        continue;
      }

      // ── 5. Sync to EBS (with retries) ──────────────────────────────
      let lastErr = null;
      let synced = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await syncOrderToEbs(params, order, orderJournal);

          const syncedAt = new Date().toISOString();
          await updateOrderCustom(params, orderId, { syncedToEbs: syncedAt });

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
        halted = true;

        console.error(
          `[ebs-sync] Order ${orderId} failed after ${MAX_RETRIES} attempts. Halting.\n${errStack}`,
        );
        break;
      }
    }

    // ── 8. Advance cursor ──────────────────────────────────────────────
    // On success or deadline: advance to the latest journal entry timestamp.
    // On halt (max-retries): do NOT advance — the batch will be re-fetched
    // next invocation and already-synced orders are skipped cheaply.
    if (!halted && batchLatestTimestamp && batchLatestTimestamp !== state.since) {
      state.since = batchLatestTimestamp;
    }
    state.lastRun = new Date().toISOString();
    state.status = halted ? 'error' : 'idle';
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
