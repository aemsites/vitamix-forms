/**
 * Core EBS sync orchestration.
 *
 * Each scheduled invocation:
 *   1. Acquires a distributed lock (bails if already held)
 *   2. Loads the persisted `since` cursor from state
 *   3. Reads the global journal and filters to terminal events
 *      (payment_completed / payment_cancelled) to discover resolved orderIds
 *   4. For each resolved orderId (oldest first):
 *        a. Fetches the order — skips if already synced (custom.syncedAt or custom.syncedToEbs)
 *        b. Skips cancelled orders (including fraud-declined) — no EBS sync needed
 *        c. For payment_completed: queries complete per-order journal
 *        d. Calls syncOrderToEbs(ctx, params, order, orderJournal), retrying up to MAX_RETRIES
 *        e. On success: patches custom.syncedAt and clears custom.syncError to null
 *        f. On max-retries exhausted: patches custom.syncError with a short error
 *           code, records the error, halts without advancing cursor
 *   5. Checks a 9.5-minute deadline before each order
 *   6. On success/deadline: advances cursor to the latest journal entry timestamp
 *   7. Saves updated state and releases the lock
 */

import { Core } from '@adobe/aio-sdk';
import { loadState, saveState, acquireLock, releaseLock } from './state.js';
import { getJournalEntries, getOrderJournalEntries, getOrder, updateOrderCustom, logOrderSync } from './commerce.js';
import { syncOrderToEbs, isRetriableError } from './ebs.js';

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
  const log = Core.Logger('ebs-sync', { level: params.LOG_LEVEL ?? 'info' });
  const ctx = { env: params, log };
  const startTime = Date.now();

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

  const state = await loadState();

  // Allow the caller to override the cursor start (e.g. manual trigger via API).
  if (params.sinceOverride) {
    log.info(`[ebs-sync] Cursor overridden: ${state.since ?? 'null'} → ${params.sinceOverride}`);
    state.since = params.sinceOverride;
  }

  log.info(`[ebs-sync] State loaded — since=${state.since ?? 'null (will default to 1h ago)'}, status=${state.status}, processedCount=${state.processedCount ?? 0}, failedCount=${state.failedCount ?? 0}`);

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
    const { entries, until: batchUntil } = await getJournalEntries(params, state.since, log, params.untilOverride);
    log.info(`[ebs-sync] ${entries.length} journal entries since ${state.since ?? 'default (1h ago)'} until ${batchUntil}`);

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

    if (entries.length > 0 && terminalEntries.length === 0) {
      // Entries came back but none were terminal — log event type breakdown to diagnose.
      const eventCounts = {};
      for (const e of entries) {
        eventCounts[e.event ?? '(missing)'] = (eventCounts[e.event ?? '(missing)'] || 0) + 1;
      }
      log.info(`[ebs-sync] No terminal events found. Event breakdown: ${JSON.stringify(eventCounts)}`);
    }

    log.info(
      `[ebs-sync] ${terminalEntries.length} terminal entries, ${orderIds.length} unique order IDs to evaluate${orderIds.length > 0 ? `: ${orderIds.join(', ')}` : ''}`,
    );

    let halted = false;

    for (const orderId of orderIds) {
      // ── Deadline guard ──────────────────────────────────────────────
      if (Date.now() - startTime > DEADLINE_MS) {
        log.info('[ebs-sync] Approaching 10-minute deadline. Stopping.');
        summary.halted = true;
        summary.haltReason = 'deadline';
        break;
      }

      // ── 3. Fetch the order ──────────────────────────────────────────
      let order;
      try {
        order = await getOrder(params, orderId);
      } catch (fetchErr) {
        log.warn(`[ebs-sync] Could not fetch order ${orderId}: ${fetchErr.message}`);
        continue;
      }

      if (!order) {
        log.warn(`[ebs-sync] Order ${orderId} not found — skipping.`);
        continue;
      }

      // ── Already synced ─────────────────────────────────────────────
      const alreadySyncedAt = order.custom?.syncedAt || order.custom?.syncedToEbs;
      if (alreadySyncedAt) {
        log.info(
          `[ebs-sync] Order ${orderId} already synced at ${alreadySyncedAt} — skipping.`,
        );
        continue;
      }

      // ── Cancelled (including fraud-declined) — no EBS sync needed ──
      if (order.state === 'payment_cancelled') {
        log.info(`[ebs-sync] Order ${orderId} is payment_cancelled — skipping.`);
        continue;
      }

      // ── 4. Fetch complete per-order journal ─────────────────────────
      let orderJournal;
      try {
        const since = order.createdAt
          ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const until = new Date().toISOString();
        orderJournal = await getOrderJournalEntries(params, orderId, since, until);
        log.info(`[ebs-sync] Order ${orderId} journal: ${orderJournal.length} entries`);
      } catch (journalErr) {
        log.warn(
          `[ebs-sync] Could not fetch journal for ${orderId}: ${journalErr.message}`,
        );
        await updateOrderCustom(params, orderId, { syncError: 'journal_fetch_failed' }).catch((patchErr) => {
          log.warn(`[ebs-sync] Failed to patch syncError for ${orderId}: ${patchErr.message}`);
        });
        continue;
      }

      // ── 5. Sync to EBS (with retries) ──────────────────────────────
      let lastErr = null;
      let synced = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const { status, xml } = await syncOrderToEbs(ctx, params, order, orderJournal);

          await logOrderSync(params, { action: 'order-sync', id: orderId, status, xml }).catch((logErr) => {
            log.warn(`[ebs-sync] Failed to log order-sync for ${orderId}: ${logErr.message}`);
          });

          const syncedAt = new Date().toISOString();
          await updateOrderCustom(params, orderId, { syncedAt, syncError: null });

          state.lastProcessedOrderId = orderId;
          state.processedCount = (state.processedCount || 0) + 1;
          state.lastError = null;

          summary.processedOrders.push(orderId);
          summary.lastProcessedOrderId = orderId;
          summary.lastError = null;

          log.info(`[ebs-sync] Order ${orderId} synced on attempt ${attempt}.`);
          synced = true;
          break;
        } catch (err) {
          lastErr = err;

          const errStatus = err?.ebsStatus ?? err?.response?.error?.statusCode ?? 0;
          const syncLog = { action: 'order-sync', id: orderId, status: errStatus, error: err.message };
          if (errStatus >= 400) {
            const body = err?.response?.error?.body;
            if (body) syncLog.response = typeof body === 'string' ? body : JSON.stringify(body);
          }
          await logOrderSync(params, syncLog).catch((logErr) => {
            log.warn(`[ebs-sync] Failed to log order-sync for ${orderId}: ${logErr.message}`);
          });

          if (!isRetriableError(err)) {
            log.warn(
              `[ebs-sync] Order ${orderId} attempt ${attempt}/${MAX_RETRIES} failed with non-retriable error: ${err.message}`,
            );
            break;
          }
          log.warn(
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

        // Surface the failure on the order itself so it's visible downstream.
        await updateOrderCustom(params, orderId, { syncError: describeSyncError(lastErr) }).catch((patchErr) => {
          log.warn(`[ebs-sync] Failed to patch syncError for ${orderId}: ${patchErr.message}`);
        });

        log.error(
          `[ebs-sync] Order ${orderId} failed after ${MAX_RETRIES} attempts. Halting.\n${errStack}`,
        );
        break;
      }
    }

    // ── 8. Advance cursor ──────────────────────────────────────────────
    // On success or deadline: advance to the query's `until` boundary so the
    // next invocation starts right where this one left off — even when the
    // batch was empty.
    // On halt (max-retries): do NOT advance — the batch will be re-fetched
    // next invocation and already-synced orders are skipped cheaply.
    if (!halted) {
      state.since = batchUntil;
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
