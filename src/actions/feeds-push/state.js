/**
 * feeds-push state, per target + locale:
 * - the item count of the last successful upload, for the shrink guard (see
 *   MAX_SHRINK in ./config.js);
 * - the warnings last alerted on, so a persistent warning (e.g. one bad id)
 *   emails once rather than every night.
 *
 * Each is one JSON map under a single aio-lib-state key. Keys can't contain
 * "/", so locales live inside the value, not in the key.
 */

import { init } from '@adobe/aio-lib-state';

const COUNTS_KEY = 'feeds-push.counts';
const ALERTED_WARNINGS_KEY = 'feeds-push.alerted-warnings';
const TTL_SEC = 365 * 24 * 3600; // 1 year

/** @typedef {Record<string, { count: number, at: string }>} Counts */

/** @type {import('@adobe/aio-lib-state').AdobeState | null} */
let client = null;

async function getClient() {
  if (!client) client = await init();
  return client;
}

/**
 * @param {string} target
 * @param {string} locale
 * @returns {string}
 */
export const countKey = (target, locale) => `${target}|${locale}`;

/** @returns {Promise<Counts>} */
export async function loadCounts() {
  const c = await getClient();
  const result = await c.get(COUNTS_KEY);
  if (!result?.value) return {};
  try {
    return JSON.parse(result.value) || {};
  } catch {
    return {};
  }
}

/**
 * Merge new counts into the stored map.
 * @param {Counts} updates
 */
export async function saveCounts(updates) {
  const c = await getClient();
  const next = { ...(await loadCounts()), ...updates };
  await c.put(COUNTS_KEY, JSON.stringify(next), { ttl: TTL_SEC });
  return next;
}

/** @typedef {Record<string, string>} AlertedWarnings target|locale → warning signature ('' = none) */

/** @returns {Promise<AlertedWarnings>} */
export async function loadAlertedWarnings() {
  const c = await getClient();
  const result = await c.get(ALERTED_WARNINGS_KEY);
  if (!result?.value) return {};
  try {
    return JSON.parse(result.value) || {};
  } catch {
    return {};
  }
}

/**
 * Merge per-feed warning signatures into the stored map.
 * @param {AlertedWarnings} updates
 */
export async function saveAlertedWarnings(updates) {
  const c = await getClient();
  const next = { ...(await loadAlertedWarnings()), ...updates };
  await c.put(ALERTED_WARNINGS_KEY, JSON.stringify(next), { ttl: TTL_SEC });
  return next;
}
