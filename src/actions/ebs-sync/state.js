/**
 * State management for the EBS sync job.
 *
 * Persists sync state (since cursor, counters, last error) and a distributed
 * lock across invocations using @adobe/aio-lib-state.
 *
 * Note: aio-lib-state get/put operations are NOT atomic. The lock here is a
 * best-effort guard against accidental parallel runs. The primary concurrency
 * protection is the `limits.concurrency: 1` annotation in app.config.yaml,
 * which prevents the platform from queuing a new invocation while one is
 * already running on a given container.
 */

import { init } from '@adobe/aio-lib-state';
import {
  OUTBOX_HEAD_KEY, OUTBOX_TTL_SEC, outboxKey, parseSeq,
} from '../../inventory.js';

const STATE_KEY = 'ebs-sync:state';
const LOCK_KEY = 'ebs-sync:lock';

/**
 * Lock TTL — must exceed the action's max run duration (the 600000ms / 10-min
 * timeout in app.config.yaml) so the lock can never expire while a run is still
 * in progress. This is what keeps overlapping triggers from running in parallel:
 * the sync fires every 5 minutes but a run may last up to 10, so a trigger that
 * fires mid-run must find the lock still held and skip. Do NOT lower this to
 * track the schedule interval — it is keyed to run duration, not cron cadence.
 */
const LOCK_TTL_SEC = 660; // 11 minutes (> 10-min max run)

/** State TTL — effectively permanent (1 year). */
const STATE_TTL_SEC = 365 * 24 * 3600;

/** @type {import('@adobe/aio-lib-state').AdobeState | null} */
let _client = null;

async function client() {
  if (!_client) _client = await init();
  return _client;
}

/** @typedef {{
 *   since: string | null,
 *   lastProcessedOrderId: string | null,
 *   lastError: string | null,
 *   lastRun: string | null,
 *   processedCount: number,
 *   failedCount: number,
 *   status: 'idle' | 'running' | 'error',
 *   pendingCustomUpdates: Record<string, PendingCustomUpdate>,
 * }} SyncState
 */

/**
 * An order that was accepted by EBS but whose `custom.syncedAt` patch failed.
 * On later runs we retry only the patch and never send the order to EBS again.
 * @typedef {{ syncedAt: string, failedAt: string, error: string }} PendingCustomUpdate
 */

/** @type {SyncState} */
const DEFAULT_STATE = {
  since: null,
  lastProcessedOrderId: null,
  lastError: null,
  lastRun: null,
  processedCount: 0,
  failedCount: 0,
  status: 'idle',
  pendingCustomUpdates: {},
};

/** Load the current sync state, returning defaults if none exists. */
export async function loadState() {
  const c = await client();
  const result = await c.get(STATE_KEY);
  if (!result) return { ...DEFAULT_STATE, pendingCustomUpdates: {} };

  let state = { ...DEFAULT_STATE };
  try {
    state = { ...DEFAULT_STATE, ...JSON.parse(result.value) };
  } catch {
    console.log(`[ebs-sync] State already loaded (invalid JSON: ${result.value})`);
  }
  // Never hand out the shared DEFAULT_STATE object — callers mutate it.
  state.pendingCustomUpdates = { ...(state.pendingCustomUpdates || {}) };
  return state;
}

/**
 * Merge `updates` into the stored state and persist.
 * @param {Partial<SyncState>} updates
 */
export async function saveState(updates) {
  const c = await client();
  const current = await loadState();
  const next = { ...current, ...updates };
  await c.put(STATE_KEY, JSON.stringify(next), { ttl: STATE_TTL_SEC });
  return next;
}

/**
 * Try to acquire the distributed lock.
 * Returns true if the lock was acquired, false if already locked.
 */
export async function acquireLock() {
  const c = await client();
  const existing = await c.get(LOCK_KEY);
  if (existing) {
    try {
      const { lockedAt } = JSON.parse(existing.value) || {};
      console.log(`[ebs-sync] Lock already held (acquired at ${lockedAt})`);
    } catch {
      console.log(`[ebs-sync] Lock already held (invalid JSON: ${existing.value})`);
    }
    return false;
  }
  await c.put(LOCK_KEY, JSON.stringify({ lockedAt: new Date().toISOString() }), { ttl: LOCK_TTL_SEC });
  return true;
}

/** Release the distributed lock. */
export async function releaseLock() {
  const c = await client();
  await c.delete(LOCK_KEY);
}

/**
 * Upper bound on free-slot probing past `head`. Slots past head only exist when
 * an earlier entry write succeeded but its head write failed.
 */
const MAX_OUTBOX_PROBE = 50;

/**
 * Append a managed-inventory outbox entry: write `inventory:outbox:{seq}` first,
 * then `inventory:outbox:head = seq`. ebs-sync is the only writer of both keys.
 *
 * If `head + 1` is already occupied (an earlier head write failed after its
 * entry write), skip to the next free seq so that entry is not overwritten;
 * inventory-sync reads `cursor+1..head`, so it is picked up once head moves past it.
 *
 * @param {{ activationId?: string, orderIds: string[], deltas: object[] }} payload
 * @returns {Promise<number>} the seq written
 */
export async function writeInventoryOutbox({ activationId, orderIds, deltas }) {
  const c = await client();
  const head = parseSeq(await c.get(OUTBOX_HEAD_KEY));
  let seq = head + 1;
  for (let i = 0; i < MAX_OUTBOX_PROBE && await c.get(outboxKey(seq)); i++) {
    console.log(`[ebs-sync] inventory outbox seq ${seq} already exists past head ${head} — skipping`);
    seq += 1;
  }
  const entry = {
    seq,
    activationId: activationId ?? null,
    createdAt: new Date().toISOString(),
    orderIds,
    deltas,
  };
  await c.put(outboxKey(seq), JSON.stringify(entry), { ttl: OUTBOX_TTL_SEC });
  await c.put(OUTBOX_HEAD_KEY, String(seq), { ttl: OUTBOX_TTL_SEC });
  return seq;
}
