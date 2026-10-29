/**
 * Managed inventory sheet logic (pure, no I/O).
 *
 * Sheet: /us/en_us/products/config/inventory.json (DA source).
 * Columns: SKU, Title, Variant, Availability, Managed Stock (Yes/No), Qty, Market (US/CA/blank).
 * Values are strings and may carry stray whitespace.
 *
 * Only the `Qty` and `Availability` cells of selected rows are ever written.
 * Rows are mutated in place, so every other cell, the row order and all sheet
 * metadata round-trip unchanged.
 */

import { normalizeMarket, normalizeSku } from '../../inventory.js';

export const SHEET_PATH = '/us/en_us/products/config/inventory.json';

export const OUT_OF_STOCK = 'OutOfStock';

/** Market → product locales. Blank market = one pool shared by all locales. */
const MARKET_LOCALES = {
  us: ['us/en_us'],
  ca: ['ca/en_us', 'ca/fr_ca'],
  '': ['us/en_us', 'ca/en_us', 'ca/fr_ca'],
};

/** @param {unknown} v */
const cell = (v) => String(v ?? '').trim();

/**
 * Locales for a sheet/order market. Unknown markets map to none.
 * @param {string} market
 * @returns {string[]}
 */
export function localesForMarket(market) {
  return MARKET_LOCALES[normalizeMarket(market)] ?? [];
}

/**
 * Return the (mutable) row array of the inventory sheet. Handles single-sheet
 * JSON (`data: []`) and multi-sheet JSON (`data: { data: [] }` or the first
 * named sheet with a SKU column).
 * @param {object} sheet
 * @returns {Record<string, string>[]}
 */
export function getRows(sheet) {
  if (Array.isArray(sheet?.data)) return sheet.data;
  if (sheet && typeof sheet === 'object') {
    if (Array.isArray(sheet.data?.data)) return sheet.data.data;
    const names = sheet[':names'] || Object.keys(sheet).filter((k) => !k.startsWith(':'));
    for (const name of names) {
      const rows = sheet[name]?.data;
      if (Array.isArray(rows) && rows.some((r) => r && 'SKU' in r)) return rows;
    }
  }
  throw new Error('inventory sheet has no data rows');
}

/** @param {Record<string, string>} row */
export function isManaged(row) {
  return cell(row['Managed Stock']).toLowerCase() === 'yes';
}

/**
 * Numeric Qty, or null when blank/non-numeric (row not being counted).
 * @param {Record<string, string>} row
 * @returns {number | null}
 */
export function parseQty(row) {
  const s = cell(row.Qty);
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** @param {Record<string, string>} row */
export function rowMarket(row) {
  return normalizeMarket(row.Market);
}

/** @param {Record<string, string>} row */
export function isOutOfStock(row) {
  return cell(row.Availability) === OUT_OF_STOCK;
}

/**
 * Pick the sheet row for a sold `(sku, market)`: exact SKU (trim + uppercase),
 * preferring the row whose Market equals the order market, else a blank-market row.
 * @param {Record<string, string>[]} rows
 * @param {string} sku
 * @param {string} market
 * @returns {Record<string, string> | null}
 */
export function selectRow(rows, sku, market) {
  const key = normalizeSku(sku);
  const m = normalizeMarket(market);
  const matches = rows.filter((r) => r && normalizeSku(r.SKU) === key);
  return (m && matches.find((r) => rowMarket(r) === m))
    || matches.find((r) => rowMarket(r) === '')
    || null;
}

/**
 * Merge outbox entries into one delta per `(sku, market)`.
 * @param {{ seq: number, deltas?: { sku: string, market?: string, units: number, orderId?: string }[] }[]} entries
 * @returns {{ sku: string, market: string, units: number, orderIds: string[], seqs: number[] }[]}
 */
export function mergeDeltas(entries) {
  const merged = new Map();
  for (const entry of entries) {
    for (const d of (entry?.deltas || [])) {
      const sku = normalizeSku(d?.sku);
      const units = Number(d?.units);
      if (!sku || !Number.isFinite(units) || units <= 0) continue;
      const market = normalizeMarket(d.market);
      const key = `${sku}|${market}`;
      if (!merged.has(key)) {
        merged.set(key, {
          sku, market, units: 0, orderIds: [], seqs: [],
        });
      }
      const m = merged.get(key);
      m.units += units;
      if (d.orderId && !m.orderIds.includes(d.orderId)) m.orderIds.push(d.orderId);
      if (!m.seqs.includes(entry.seq)) m.seqs.push(entry.seq);
    }
  }
  return [...merged.values()];
}

/**
 * Apply merged decrements to the sheet in place.
 *
 * Counted rows only: `Managed Stock` = yes and numeric `Qty`.
 *   new = max(0, Qty − sold)
 *   sold > Qty               → oversold event (also for rows already at 0)
 *   Qty > 0 && new === 0     → Availability = "OutOfStock" + out-of-stock event
 * Qty is never written below 0; `Managed Stock` is never touched.
 *
 * @param {object} sheet
 * @param {ReturnType<typeof mergeDeltas>} deltas
 */
export function applyDeltas(sheet, deltas) {
  const rows = getRows(sheet);
  const changes = [];
  const skipped = [];
  const oversold = [];
  const outOfStock = [];

  for (const delta of deltas) {
    const row = selectRow(rows, delta.sku, delta.market);
    if (!row) {
      skipped.push({ ...delta, reason: 'no-row' });
      continue;
    }
    if (!isManaged(row)) {
      skipped.push({ ...delta, reason: 'not-managed' });
      continue;
    }
    const available = parseQty(row);
    if (available === null) {
      skipped.push({ ...delta, reason: 'no-qty' });
      continue;
    }

    const sold = delta.units;
    const next = Math.max(0, available - sold);
    const sku = cell(row.SKU);
    const market = rowMarket(row);

    if (sold > available) {
      oversold.push({
        action: 'inventory-oversold',
        sku,
        market: delta.market,
        available,
        sold,
        oversold: sold - available,
        orderIds: delta.orderIds,
      });
    }

    let availabilityChanged = false;
    if (available > 0 && next === 0) {
      if (!isOutOfStock(row)) {
        row.Availability = OUT_OF_STOCK;
        availabilityChanged = true;
      }
      outOfStock.push({
        action: 'inventory-out-of-stock',
        sku,
        market,
        orderIds: delta.orderIds,
      });
    }

    const qtyChanged = next !== available;
    if (qtyChanged) row.Qty = String(next);

    if (qtyChanged || availabilityChanged) {
      changes.push({
        sku,
        market,
        orderMarket: delta.market,
        before: available,
        after: next,
        sold,
        availabilityChanged,
        orderIds: delta.orderIds,
        seqs: delta.seqs,
      });
    }
  }

  return {
    changes, skipped, oversold, outOfStock,
  };
}

/**
 * Managed rows that are sold out: Managed Stock = yes, numeric Qty <= 0 and
 * Availability = OutOfStock. These drive the product check.
 *
 * A blank-market row covers all locales except those of markets that have
 * their own row for the same SKU (that row is the stock pool for its market).
 *
 * @param {object} sheet
 * @returns {{ sku: string, market: string, locales: string[] }[]}
 */
export function soldOutRows(sheet) {
  const rows = getRows(sheet).filter((row) => row && cell(row.SKU));
  const marketRows = new Set(
    rows.filter((row) => rowMarket(row) !== '').map((row) => `${normalizeSku(row.SKU)}|${rowMarket(row)}`),
  );
  return rows
    .filter((row) => isManaged(row) && isOutOfStock(row))
    .filter((row) => {
      const qty = parseQty(row);
      return qty !== null && qty <= 0;
    })
    .map((row) => {
      const market = rowMarket(row);
      let locales = localesForMarket(market);
      if (market === '') {
        const own = ['us', 'ca'].filter((m) => marketRows.has(`${normalizeSku(row.SKU)}|${m}`));
        const excluded = new Set(own.flatMap((m) => localesForMarket(m)));
        locales = locales.filter((l) => !excluded.has(l));
      }
      return { sku: cell(row.SKU), market, locales };
    });
}
