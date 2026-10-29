/**
 * Product index + catalog access for the inventory-sync product check.
 *
 * The product index is only a filter for which products to fetch; the product
 * returned by the catalog GET is the source of truth.
 *
 * Eligibility mirrors product-admin ("Update managed inventory"):
 *   - exact SKU match (trim + uppercase), never `-VB` component SKUs
 *   - a variant whose SKU matches, or a product without variants whose SKU matches
 *   - configurable parents (products with variants) are never updated
 *   - custom.managedStock must already be "1"; it is never created or changed
 *   - only `availability` is written, and only to "OutOfStock"
 */

import { normalizeSku } from '../../inventory.js';
import { OUT_OF_STOCK } from './sheet.js';

/** Re-GET + re-PUT attempts after a 412 (If-Match precondition failed). */
export const MAX_412_RETRIES = 3;

/** @param {unknown} v */
const cell = (v) => String(v ?? '').trim();

/** @param {string} sku */
export function isBundleComponentSku(sku) {
  return normalizeSku(sku).endsWith('-VB');
}

/**
 * Fetch a locale's product index (all rows, cache-busted).
 * @param {{ env: object, log: object }} ctx
 * @param {string} locale - e.g. `us/en_us`
 * @returns {Promise<{ columns: string[], data: Record<string, string>[] }>}
 */
export async function fetchIndex(ctx, locale) {
  const { ORG, SITE } = ctx.env;
  const url = `https://main--${SITE}--${ORG}.aem.network/${locale}/products/index.json?include=all&_=${Date.now()}`;
  const resp = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!resp.ok) {
    throw new Error(`product index ${locale} returned ${resp.status}`);
  }
  const json = await resp.json();
  return {
    columns: Array.isArray(json?.columns) ? json.columns : [],
    data: Array.isArray(json?.data) ? json.data : [],
  };
}

/** Catalog path from an absolute product URL (`https://…/us/en_us/products/x` → `/us/en_us/products/x`). */
function pathFromUrl(url) {
  try {
    return new URL(url).pathname.replace(/\.json$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * Index rows for `sku` that should be checked, with their product paths.
 *
 * With the `managedStock` index column (the normal case): rows where
 * `managedStock === "1"` and `availability !== "OutOfStock"`. Without the
 * column (pre-indexer-config fallback): every exact-SKU row.
 *
 * @param {{ columns: string[], data: Record<string, string>[] }} index
 * @param {string} sku
 * @param {string} locale
 * @returns {{ matched: boolean, candidates: { sku: string, path: string, isVariant: boolean }[] }}
 */
export function findCandidates(index, sku, locale) {
  const key = normalizeSku(sku);
  if (!key || isBundleComponentSku(key)) return { matched: false, candidates: [] };

  const rows = index.data;
  const hasColumn = index.columns.includes('managedStock');
  const matches = rows.filter((r) => r && normalizeSku(r.sku) === key && !isBundleComponentSku(r.sku));
  const filtered = hasColumn
    ? matches.filter((r) => cell(r.managedStock) === '1' && cell(r.availability) !== OUT_OF_STOCK)
    : matches;

  const seen = new Set();
  const candidates = [];
  for (const row of filtered) {
    let urlKey = row.urlKey;
    let fallbackUrl = row.url;
    if (row.parentSku) {
      // Variant rows have no urlKey: use the parent product's.
      const parent = rows.find((p) => p && !p.parentSku && p.sku === row.parentSku);
      urlKey = parent?.urlKey;
      fallbackUrl = parent?.url || row.url;
    }
    const path = urlKey ? `/${locale}/products/${cell(urlKey)}` : pathFromUrl(fallbackUrl);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    candidates.push({ sku: cell(row.sku), path, isVariant: Boolean(row.parentSku) });
  }
  return { matched: matches.length > 0, candidates };
}

/**
 * Locate the product entry to update for `sku`, mirroring product-admin.
 * @param {object} product - catalog product
 * @param {string} sku
 * @returns {{ target: object | null, reason?: string }}
 */
export function resolveTarget(product, sku) {
  const key = normalizeSku(sku);
  if (isBundleComponentSku(key)) return { target: null, reason: 'bundle-component' };
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const variant = variants.find((v) => normalizeSku(v?.sku) === key);
  if (variant) return { target: variant };
  if (variants.length) return { target: null, reason: normalizeSku(product?.sku) === key ? 'configurable-parent' : 'sku-not-found' };
  if (normalizeSku(product?.sku) === key) return { target: product };
  return { target: null, reason: 'sku-not-found' };
}

/**
 * Decide, per SKU, whether the product entry should be flipped. Mutates the
 * matched entries' `availability` to OutOfStock when eligible.
 * @param {object} product
 * @param {string[]} skus
 * @returns {{ sku: string, status: 'flip' | 'skipped', reason?: string }[]}
 */
export function planProductUpdate(product, skus) {
  return skus.map((sku) => {
    const { target, reason } = resolveTarget(product, sku);
    if (!target) return { sku, status: 'skipped', reason };
    if (target.custom?.managedStock !== '1') return { sku, status: 'skipped', reason: 'not-managed' };
    if (target.availability === OUT_OF_STOCK) return { sku, status: 'skipped', reason: 'already-out-of-stock' };
    target.availability = OUT_OF_STOCK;
    return { sku, status: 'flip' };
  });
}

/** @param {{ env: object }} ctx @param {string} path */
function catalogUrl(ctx, path) {
  const { EDGE_COMMERCE_API_BASE, ORG, SITE } = ctx.env;
  return `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/catalog${path}.json`;
}

/**
 * Set availability = OutOfStock on the eligible entries of one product, using
 * GET (ETag) → PUT If-Match, re-reading and retrying on 412.
 *
 * @param {{ env: object, log: object }} ctx
 * @param {string} path - catalog product path, e.g. `/ca/en_us/products/a2300`
 * @param {string[]} skus - sold-out SKUs that index to this product
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<{ path: string, status: 'updated' | 'planned' | 'unchanged' | 'not-found' | 'conflict', results: object[], attempts: number }>}
 */
export async function updateProductAvailability(ctx, path, skus, { dryRun = false } = {}) {
  const url = catalogUrl(ctx, path);
  const token = ctx.env.EDGE_COMMERCE_API_CATALOG_TOKEN;
  const auth = token ? { Authorization: `Bearer ${token}` } : {};

  for (let attempt = 1; attempt <= MAX_412_RETRIES + 1; attempt++) {
    const getResp = await fetch(url, { headers: { ...auth, 'Cache-Control': 'no-cache' } });
    if (getResp.status === 404) return { path, status: 'not-found', results: [], attempts: attempt };
    if (!getResp.ok) throw new Error(`catalog GET ${path} returned ${getResp.status}`);
    const etag = getResp.headers.get('etag');
    const product = await getResp.json();

    const results = planProductUpdate(product, skus);
    if (!results.some((r) => r.status === 'flip')) {
      return { path, status: 'unchanged', results, attempts: attempt };
    }
    if (dryRun) return { path, status: 'planned', results, attempts: attempt };
    if (!etag) throw new Error(`catalog GET ${path} returned no ETag; refusing unconditional write`);

    const putResp = await fetch(url, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify(product),
    });
    if (putResp.status === 412) {
      ctx.log.info(`[inventory-sync] 412 on ${path} (attempt ${attempt}); re-reading`);
      continue;
    }
    if (!putResp.ok) {
      const detail = putResp.headers.get('x-error') || await putResp.text().catch(() => '');
      throw new Error(`catalog PUT ${path} returned ${putResp.status}${detail ? `: ${detail}` : ''}`);
    }
    return { path, status: 'updated', results, attempts: attempt };
  }
  return { path, status: 'conflict', results: [], attempts: MAX_412_RETRIES + 1 };
}
