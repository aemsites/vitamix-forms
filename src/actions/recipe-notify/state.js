/**
 * State management for the recipe-notify job.
 *
 * Persists the cursor (`since` = max DateUpdated notified so far), run metadata,
 * and a best-effort distributed lock across invocations using
 * @adobe/aio-lib-state. As with ebs-sync, the primary concurrency guard is the
 * `limits.concurrency: 1` annotation in app.config.yaml; this lock just prevents
 * accidental overlap between a scheduled run and a manual trigger.
 */

import { init } from '@adobe/aio-lib-state';

const STATE_KEY = 'recipe-notify:state';
const LOCK_KEY = 'recipe-notify:lock';

/** Lock TTL — comfortably exceeds the action's max run duration. */
const LOCK_TTL_SEC = 300; // 5 minutes (> 2-min action timeout)

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
 *   lastRun: string | null,
 *   lastError: string | null,
 *   processedCount: number,
 *   status: 'idle' | 'running' | 'error',
 * }} NotifyState
 */

/** @type {NotifyState} */
const DEFAULT_STATE = {
  since: null,
  lastRun: null,
  lastError: null,
  processedCount: 0,
  status: 'idle',
};

/** Load the current state, returning defaults if none exists. */
export async function loadState() {
  const c = await client();
  const result = await c.get(STATE_KEY);
  if (!result) return { ...DEFAULT_STATE };

  try {
    return { ...DEFAULT_STATE, ...JSON.parse(result.value) };
  } catch {
    console.log(`[recipe-notify] Invalid state JSON: ${result.value}`);
    return { ...DEFAULT_STATE };
  }
}

/**
 * Merge `updates` into the stored state and persist.
 * @param {Partial<NotifyState>} updates
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
 * @returns {Promise<boolean>} true if acquired, false if already locked
 */
export async function acquireLock() {
  const c = await client();
  const existing = await c.get(LOCK_KEY);
  if (existing) {
    try {
      const { lockedAt } = JSON.parse(existing.value) || {};
      console.log(`[recipe-notify] Lock already held (acquired at ${lockedAt})`);
    } catch {
      console.log(`[recipe-notify] Lock already held (invalid JSON: ${existing.value})`);
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
