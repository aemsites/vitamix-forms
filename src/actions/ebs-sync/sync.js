/**
 * Core EBS sync orchestration.
 *
 * Each scheduled invocation:
 *   1. Acquires a distributed lock (bails if already held)
 *   2. Loads the persisted `since` cursor from state
 *   3. Reads all journal entries since that cursor
 *   4. Groups entries by orderId; for each group (oldest-first):
 *        a. Looks for a payment_completed entry in the window
 *        b. If absent, runs a targeted 30-minute fallback query for that order
 *        c. Fetches the full order document
 *        d. Skips if already synced, cancelled, or still in-flight
 *        e. Calls syncOrderToEbs(params, order, orderJournal), retrying up to MAX_RETRIES
 *        f. On success: patches custom.syncedToEbs, advances the resolved-cursor
 *        g. On max-retries exhausted: records the error, halts
 *   5. Checks a 9.5-minute deadline before each order
 *   6. Advances the cursor only past fully-resolved orders (not in-flight ones)
 *   7. Saves updated state and releases the lock
 */

import { loadState, saveState, acquireLock, releaseLock } from './state.js';
import { getJournalEntries, getOrderJournalEntries, getOrder, updateOrderCustom } from './commerce.js';
import { syncOrderToEbs } from './ebs.js';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 3_000; // 3s, 6s, 9s
const DEADLINE_MS = 9.5 * 60 * 1000; // stop accepting new orders at 9.5 min
/** Fallback window: 30 minutes from order creation to find payment_completed. */
const FALLBACK_WINDOW_MS = 30 * 60 * 1000;

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

    // Keep only order-scoped entries, sort oldest-first.
    const orderEntries = entries
      .filter((e) => Boolean(e.orderId))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Group all entries by orderId, preserving chronological order within each group.
    const groupedByOrder = new Map();
    for (const e of orderEntries) {
      if (!groupedByOrder.has(e.orderId)) groupedByOrder.set(e.orderId, []);
      groupedByOrder.get(e.orderId).push(e);
    }

    // Sort order groups by their earliest entry so we process oldest orders first.
    const orderGroups = [...groupedByOrder.entries()]
      .map(([orderId, grpEntries]) => ({ orderId, entries: grpEntries }))
      .sort(
        (a, b) =>
          new Date(a.entries[0].timestamp).getTime() -
          new Date(b.entries[0].timestamp).getTime(),
      );

    console.log(`[ebs-sync] ${orderGroups.length} unique order IDs to evaluate`);

    // Track the latest timestamp for orders we've fully resolved (processed or
    // permanently skipped). The cursor only advances past resolved orders — orders
    // that are still in-flight (no payment_completed) keep the cursor in place so
    // they're re-evaluated in the next window once payment_completed arrives.
    let maxResolvedTimestamp = state.since;

    for (const { orderId, entries: windowEntries } of orderGroups) {
      // ── Deadline guard ──────────────────────────────────────────────────
      if (Date.now() - startTime > DEADLINE_MS) {
        console.log('[ebs-sync] Approaching 10-minute deadline. Stopping.');
        summary.halted = true;
        summary.haltReason = 'deadline';
        break;
      }

      const latestWindowTimestamp = windowEntries[windowEntries.length - 1].timestamp;

      // ── Find terminal events in the window entries ───────────────────
      let paymentCompletedEntry = windowEntries.find((e) => e.event === 'payment_completed');
      const paymentCancelledEntry = windowEntries.find((e) => e.event === 'payment_cancelled');
      let orderJournal = windowEntries;

      // payment_cancelled is a definitive terminal event: the order is done without payment.
      // Skip immediately — no fallback query or order fetch needed.
      if (paymentCancelledEntry && !paymentCompletedEntry) {
        console.log(`[ebs-sync] Order ${orderId} payment_cancelled in window — skipping.`);
        maxResolvedTimestamp = latestWindowTimestamp;
        continue;
      }

      // ── Fallback: targeted 30-min query when no terminal event in window ─
      if (!paymentCompletedEntry) {
        const createEntry = windowEntries.find((e) => e.event === 'create');
        if (createEntry) {
          const since = new Date(createEntry.timestamp);
          const until = new Date(since.getTime() + FALLBACK_WINDOW_MS);
          try {
            const fallback = await getOrderJournalEntries(
              params, orderId, since.toISOString(), until.toISOString(),
            );
            paymentCompletedEntry = fallback.find((e) => e.event === 'payment_completed');
            if (fallback.length > 0) {
              // Merge window + fallback, deduplicating by entry id.
              const seenIds = new Set(windowEntries.map((e) => e.id));
              orderJournal = [
                ...windowEntries,
                ...fallback.filter((e) => !seenIds.has(e.id)),
              ];
            }
            console.log(
              `[ebs-sync] Fallback journal for ${orderId}:`
              + ` ${fallback.length} entries, payment_completed=${Boolean(paymentCompletedEntry)}`,
            );
          } catch (fallbackErr) {
            console.warn(
              `[ebs-sync] Fallback journal query for ${orderId} failed: ${fallbackErr.message}`,
            );
          }
        }
      }

      // ── Fetch full order ─────────────────────────────────────────────────
      let order;
      try {
        order = await getOrder(params, orderId);
      } catch (fetchErr) {
        console.warn(`[ebs-sync] Could not fetch order ${orderId}: ${fetchErr.message}`);
        maxResolvedTimestamp = latestWindowTimestamp;
        continue;
      }

      if (!order) {
        console.warn(`[ebs-sync] Order ${orderId} not found — skipping.`);
        maxResolvedTimestamp = latestWindowTimestamp;
        continue;
      }

      // ── Already synced ───────────────────────────────────────────────────
      if (order.custom?.syncedToEbs) {
        console.log(
          `[ebs-sync] Order ${orderId} already synced at ${order.custom.syncedToEbs} — skipping.`,
        );
        maxResolvedTimestamp = latestWindowTimestamp;
        continue;
      }

      // ── Permanently cancelled — skip and advance cursor ──────────────────
      if (order.state === 'payment_cancelled') {
        console.log(`[ebs-sync] Order ${orderId} is payment_cancelled — skipping.`);
        maxResolvedTimestamp = latestWindowTimestamp;
        continue;
      }

      // ── No payment_completed — still in-flight; keep cursor in place ─────
      if (!paymentCompletedEntry) {
        console.log(
          `[ebs-sync] Order ${orderId} has no payment_completed yet`
          + ` (state=${order.state}) — will retry in next window.`,
        );
        // Do NOT update maxResolvedTimestamp — cursor stays before this order.
        continue;
      }

      // ── Sync to EBS (with retries) ───────────────────────────────────────
      let lastErr = null;
      let synced = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await syncOrderToEbs(params, order, orderJournal);

          const syncedAt = new Date().toISOString();
          await updateOrderCustom(params, orderId, { syncedToEbs: syncedAt });

          maxResolvedTimestamp = latestWindowTimestamp;
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

    // ── Persist state ──────────────────────────────────────────────────────
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

export { run };
