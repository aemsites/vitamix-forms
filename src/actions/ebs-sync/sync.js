/**
 * Core EBS sync orchestration.
 *
 * Each scheduled invocation:
 *   1. Acquires a distributed lock (bails if already held)
 *   2. Loads the persisted `since` cursor from state
 *   3. Reads all journal entries since that cursor
 *   4. For each entry with an orderId (oldest-first):
 *        a. Fetches the full order
 *        b. Skips if already synced (custom.syncedToEbs is set)
 *        c. Skips if still pending (not yet processable)
 *        d. Calls syncOrderToEbs(), retrying up to MAX_RETRIES times
 *        e. On success: patches custom.syncedToEbs, advances the cursor
 *        f. On max-retries exhausted: records the error, halts
 *   5. Checks a 9.5-minute deadline before each order to avoid exceeding the
 *      10-minute Runtime invocation limit
 *   6. Saves updated state and releases the lock
 */

import { loadState, saveState, acquireLock, releaseLock } from './state.js';
import { getJournalEntries, getOrder, updateOrderCustom } from './commerce.js';
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
async function run(params) {
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
    const entries = await getJournalEntries(params, state.since);
    console.log(`[ebs-sync] ${entries.length} journal entries since ${state.since ?? 'default (1h ago)'}`);

    // Keep only entries that belong to an order, sort oldest-first.
    const orderEntries = entries
      .filter((e) => Boolean(e.orderId))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Deduplicate: one entry per orderId — keep the most recent event so the
    // cursor advances as far as possible even when an order has many events.
    const seen = new Map();
    for (const e of orderEntries) {
      seen.set(e.orderId, e); // later entries overwrite earlier ones
    }
    // Re-sort deduplicated entries by timestamp so we process chronologically.
    const toProcess = [...seen.values()].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    console.log(`[ebs-sync] ${toProcess.length} unique order IDs to evaluate`);

    for (const entry of toProcess) {
      // ── Deadline guard ──────────────────────────────────────────────────
      if (Date.now() - startTime > DEADLINE_MS) {
        console.log('[ebs-sync] Approaching 10-minute deadline. Stopping.');
        summary.halted = true;
        summary.haltReason = 'deadline';
        break;
      }

      const { orderId, timestamp } = entry;

      // ── Fetch full order ─────────────────────────────────────────────────
      let order;
      try {
        order = await getOrder(params, orderId);
      } catch (fetchErr) {
        console.warn(`[ebs-sync] Could not fetch order ${orderId}: ${fetchErr.message}`);
        // Non-fatal: advance cursor and keep going.
        state.since = timestamp;
        continue;
      }

      if (!order) {
        console.warn(`[ebs-sync] Order ${orderId} not found — skipping.`);
        state.since = timestamp;
        continue;
      }

      // ── Already synced ───────────────────────────────────────────────────
      if (order.custom?.syncedToEbs) {
        console.log(`[ebs-sync] Order ${orderId} already synced at ${order.custom.syncedToEbs} — skipping.`);
        state.since = timestamp;
        continue;
      }

      // ── Not yet processable (payment not confirmed) ──────────────────────
      // Trust that the commerce API will emit a new journal entry (e.g.
      // payment_completed) when the order becomes processable, which will
      // re-introduce it into a future journal window with a later timestamp.
      if (order.state === 'pending') {
        console.log(`[ebs-sync] Order ${orderId} is still pending — skipping.`);
        state.since = timestamp;
        continue;
      }

      // ── Sync to EBS (with retries) ───────────────────────────────────────
      let lastErr = null;
      let synced = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await syncOrderToEbs(params, order);

          const syncedAt = new Date().toISOString();
          await updateOrderCustom(params, orderId, { syncedToEbs: syncedAt });

          state.since = timestamp;
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
          console.warn(`[ebs-sync] Order ${orderId} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
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

    // ── Persist state ──────────────────────────────────────────────────────
    state.lastRun = new Date().toISOString();
    state.status = (summary.halted && summary.haltReason !== 'deadline') ? 'error' : 'idle';
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

export { run };
