/**
 * Shared managed-inventory helpers for ebs-sync (producer) and inventory-sync
 * (consumer).
 *
 * The two actions communicate through an outbox in aio-lib-state. Each key has
 * exactly one writer, so the actions never race:
 *
 *   inventory:outbox:{seq}  written by ebs-sync, deleted by inventory-sync after apply
 *   inventory:outbox:head   written by ebs-sync (latest seq)
 *   inventory:cursor        written by inventory-sync (last applied seq)
 */

export const OUTBOX_HEAD_KEY = 'inventory:outbox:head';
export const CURSOR_KEY = 'inventory:cursor';

/** @param {number} seq */
export function outboxKey(seq) {
  return `inventory:outbox:${seq}`;
}

/** State TTL for outbox entries and pointers — effectively permanent (1 year). */
export const OUTBOX_TTL_SEC = 365 * 24 * 3600;

/**
 * Exact-match SKU key: trim + uppercase only. Deliberately does NOT strip
 * leading zeros or a trailing `-NN` (unlike product-admin's config matcher).
 * @param {unknown} sku
 * @returns {string}
 */
export function normalizeSku(sku) {
  return String(sku ?? '').trim().toUpperCase();
}

/**
 * Lowercased, trimmed market code (`us`, `ca`, or '' for none).
 * @param {unknown} market
 * @returns {string}
 */
export function normalizeMarket(market) {
  return String(market ?? '').trim().toLowerCase();
}

/**
 * Parse an integer counter stored in state (`head`, `cursor`).
 * @param {{ value?: string } | null | undefined} result - aio-lib-state get() result
 * @returns {number}
 */
export function parseSeq(result) {
  const n = Number.parseInt(result?.value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
