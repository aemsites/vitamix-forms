/**
 * Managed-inventory sold-unit collection for ebs-sync.
 *
 * ebs-sync only *queues* decrements for orders EBS accepted; it never touches
 * DA, IMS or the catalog. inventory-sync applies the queued deltas.
 */

import { stripBundleSuffix } from './ebs.js';
import { normalizeMarket } from '../../inventory.js';

/**
 * Whether the managed-inventory feature is enabled for this deployment.
 * Set INVENTORY_SYNC_ENABLED=true in prod only.
 * @param {object} params
 */
export function isInventorySyncEnabled(params) {
  return String(params?.INVENTORY_SYNC_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/**
 * Locale prefix of an item path (`/ca/en_ca/products/x` → `ca`).
 * @param {unknown} path
 * @returns {string}
 */
function marketFromPath(path) {
  const match = /^\/?([a-z]{2})\//i.exec(String(path ?? ''));
  return match ? match[1].toLowerCase() : '';
}

/** Positive integer units, or 0 if the quantity is unusable. */
function units(quantity) {
  const n = Number(quantity ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Collect sold units for one order accepted by EBS.
 *
 * - Simple item: `{ sku: item.sku, units: item.quantity }`
 * - Bundle item: one delta per component, `-VB` stripped (component quantity
 *   already equals the bundle line quantity)
 * - Warranty lines (`custom.linkedTo`) are skipped
 * - Market = order.country, falling back to the item path's locale prefix
 *
 * @param {object} order - stored order
 * @returns {{ sku: string, market: string, units: number, orderId: string }[]}
 */
export function collectOrderDeltas(order) {
  const deltas = [];
  const orderId = order?.id;
  const orderMarket = normalizeMarket(order?.country);

  const push = (sku, quantity, path) => {
    const trimmed = String(sku ?? '').trim();
    const n = units(quantity);
    if (!trimmed || n === 0) return;
    deltas.push({
      sku: trimmed,
      market: orderMarket || marketFromPath(path),
      units: n,
      orderId,
    });
  };

  for (const item of (order?.items || [])) {
    if (item?.custom?.linkedTo) continue; // warranty line
    if (item?.bundleItems?.length) {
      for (const child of item.bundleItems) {
        push(stripBundleSuffix(child?.sku), child?.quantity, item.path);
      }
    } else {
      push(item?.sku, item?.quantity, item?.path);
    }
  }
  return deltas;
}
