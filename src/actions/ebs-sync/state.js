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

const STATE_KEY = 'ebs-sync:state';
const LOCK_KEY = 'ebs-sync:lock';

/** Lock TTL — one full schedule interval plus a generous buffer. */
const LOCK_TTL_SEC = 660; // 11 minutes

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
 * }} SyncState
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
};

/** Load the current sync state, returning defaults if none exists. */
async function loadState() {
  const c = await client();
  const result = await c.get(STATE_KEY);
  if (!result) return { ...DEFAULT_STATE };

  let state = { ...DEFAULT_STATE };
  try {
    state = { ...DEFAULT_STATE, ...JSON.parse(result.value) };
  } catch {
    console.log(`[ebs-sync] State already loaded (invalid JSON: ${result.value})`);
  }
  return state;
}

/**
 * Merge `updates` into the stored state and persist.
 * @param {Partial<SyncState>} updates
 */
async function saveState(updates) {
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
async function acquireLock() {
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
async function releaseLock() {
  const c = await client();
  await c.delete(LOCK_KEY);
}

export { loadState, saveState, acquireLock, releaseLock };
