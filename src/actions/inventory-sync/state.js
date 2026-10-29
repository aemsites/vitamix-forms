/**
 * State management for the inventory-sync job.
 *
 * Keys (aio-lib-state v3 — no atomic ops, no list):
 *   inventory-sync:state   run metadata (this action is the only writer)
 *   inventory-sync:lock    best-effort lock (primary guard: concurrency: 1)
 *   inventory:cursor       last applied outbox seq (this action is the only writer)
 *   inventory:outbox:head  latest outbox seq (read-only here; ebs-sync writes it)
 *   inventory:outbox:{seq} outbox entries (ebs-sync creates, this action deletes)
 */

import { init } from '@adobe/aio-lib-state';
import {
  CURSOR_KEY, OUTBOX_HEAD_KEY, OUTBOX_TTL_SEC, outboxKey, parseSeq,
} from '../../inventory.js';

const STATE_KEY = 'inventory-sync:state';
const LOCK_KEY = 'inventory-sync:lock';

/** Lock TTL — must exceed the action's max run duration (5-min timeout). */
const LOCK_TTL_SEC = 360; // 6 minutes

/** State TTL — effectively permanent (1 year). */
const STATE_TTL_SEC = 365 * 24 * 3600;

/** @type {import('@adobe/aio-lib-state').AdobeState | null} */
let _client = null;

async function client() {
  if (!_client) _client = await init();
  return _client;
}

/** @typedef {{
 *   lastRun: string | null,
 *   status: 'idle' | 'error',
 *   lastError: string | null,
 *   lastAppliedSeq: number | null,
 *   appliedEntries: number,
 *   sheetUpdates: number,
 *   productsUpdated: number,
 *   oversoldEvents: number,
 *   outOfStockEvents: number,
 * }} InventorySyncState
 */

/** @type {InventorySyncState} */
const DEFAULT_STATE = {
  lastRun: null,
  status: 'idle',
  lastError: null,
  lastAppliedSeq: null,
  appliedEntries: 0,
  sheetUpdates: 0,
  productsUpdated: 0,
  oversoldEvents: 0,
  outOfStockEvents: 0,
};

/** Load run metadata, returning defaults if none exists. */
export async function loadState() {
  const c = await client();
  const result = await c.get(STATE_KEY);
  if (!result) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(result.value) };
  } catch {
    console.log(`[inventory-sync] Invalid state JSON: ${result.value}`);
    return { ...DEFAULT_STATE };
  }
}

/**
 * Merge `updates` into the stored state and persist.
 * @param {Partial<InventorySyncState>} updates
 */
export async function saveState(updates) {
  const c = await client();
  const next = { ...(await loadState()), ...updates };
  await c.put(STATE_KEY, JSON.stringify(next), { ttl: STATE_TTL_SEC });
  return next;
}

/** @returns {Promise<boolean>} true if acquired, false if already held */
export async function acquireLock() {
  const c = await client();
  const existing = await c.get(LOCK_KEY);
  if (existing) {
    console.log(`[inventory-sync] Lock already held: ${existing.value}`);
    return false;
  }
  await c.put(LOCK_KEY, JSON.stringify({ lockedAt: new Date().toISOString() }), { ttl: LOCK_TTL_SEC });
  return true;
}

export async function releaseLock() {
  const c = await client();
  await c.delete(LOCK_KEY);
}

/** @returns {Promise<number>} last applied seq (0 if never applied) */
export async function getCursor() {
  const c = await client();
  return parseSeq(await c.get(CURSOR_KEY));
}

/** @param {number} seq */
export async function setCursor(seq) {
  const c = await client();
  await c.put(CURSOR_KEY, String(seq), { ttl: OUTBOX_TTL_SEC });
}

/** @returns {Promise<number>} latest outbox seq written by ebs-sync (0 if none) */
export async function getHead() {
  const c = await client();
  return parseSeq(await c.get(OUTBOX_HEAD_KEY));
}

/**
 * @param {number} seq
 * @returns {Promise<object | null>} the parsed entry, or null if missing/invalid
 */
export async function getOutboxEntry(seq) {
  const c = await client();
  const result = await c.get(outboxKey(seq));
  if (!result) return null;
  try {
    return JSON.parse(result.value);
  } catch {
    console.log(`[inventory-sync] Invalid outbox entry JSON for seq ${seq}: ${result.value}`);
    return null;
  }
}

/** @param {number} seq */
export async function deleteOutboxEntry(seq) {
  const c = await client();
  await c.delete(outboxKey(seq));
}
