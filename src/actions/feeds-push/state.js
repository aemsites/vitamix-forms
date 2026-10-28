/**
 * feeds-push state: the item count of the last successful upload per target +
 * locale, for the shrink guard (see MAX_SHRINK in ./config.js).
 *
 * Stored as one JSON map under a single aio-lib-state key. Keys can't contain
 * "/", so locales live inside the value, not in the key.
 */

import { init } from '@adobe/aio-lib-state';

const COUNTS_KEY = 'feeds-push.counts';
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
