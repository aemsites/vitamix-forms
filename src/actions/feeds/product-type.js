/**
 * `product_type` from the Edge product index (<site>/<locale>/products/index.json,
 * `include=all` so parents hidden from the default index — e.g. search-only
 * configurables — are still available for variant fallback).
 *
 * The GMC source feed carries no product_type, but the index does:
 *   - `productType` — the legacy Magento product_type vocabulary ("Countertop
 *     Blender", "Blender Container", ...), set on simples/parents but not on
 *     configurable variants
 *   - `categories`  — comma-separated store categories; noisy (merchandising /
 *     promo groupings, generic "Accessories") so only used as a last resort
 *
 * Resolution order per item (first non-empty wins):
 *   1. the source feed's own product_type
 *   2. the item's index `productType`
 *   3. the parent's (item_group_id) index `productType`
 *   4. the item's, then the parent's, `categories` via CATEGORY_RULES
 */

// Ordered category -> product_type rules; the first rule matching any of the
// item's categories wins, so the most specific come first: smoothie cups and
// food-processing bowls are also in "Blender Containers", personal blender
// containers in "Personal Blending", Compact Food Recycling items in "Kitchen
// Tools". Values follow the index `productType` vocabulary. Ordering was checked
// against the index rows that carry both productType and categories.
const CATEGORY_RULES = [
  [['Smoothie Cups'], 'Smoothie Cup'],
  [['Tampers'], 'Tamper'],
  [['Cookbooks'], 'Cookbook'],
  [['Compact Food Recycling'], 'Compact Food Recycling'],
  [['Food Processing'], 'Food Processing'],
  [['Blender Containers'], 'Blender Container'],
  [['Kitchen Tools', 'Juicing'], 'Kitchen Tool'],
  [['Immersion Blender'], 'Immersion Blender'],
  [['Personal Blending'], 'Personal Blender'],
  [[
    'Full Size Blenders',
    'Legacy Series Blenders',
    'Certified Reconditioned Series',
    'Propel Series Blenders',
    'Explorian Series Blenders',
    'Explorian Series',
    'Blenders',
  ], 'Countertop Blender'],
].map(([cats, type]) => [new Set(cats.map((c) => c.toLowerCase())), type]);

// Categories that say nothing about the product type: navigation roots,
// generic/series groupings and promo/eligibility flags. Not mapped (an item
// with only these gets no product_type); listed so unknown categories can be
// told apart and logged.
const IGNORED_CATEGORIES = new Set([
  'Shop',
  'Accessories',
  'Ascent Series Accessories',
  'All Blenders',
  'Eligible Employee Discount',
  'All Household Products - Promo Category',
].map((c) => c.toLowerCase()));

const PAGE_SIZE = 1000;
const FETCH_TIMEOUT_MS = 10000;

/** @param {unknown} value comma-separated categories */
const splitCategories = (value) => String(value ?? '')
  .split(',')
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);

/**
 * @param {unknown} categories comma-separated index categories
 * @returns {string | undefined}
 */
export function categoryToProductType(categories) {
  const cats = splitCategories(categories);
  return CATEGORY_RULES.find(([match]) => cats.some((c) => match.has(c)))?.[1];
}

/**
 * Categories that are neither mapped nor explicitly ignored — candidates for a
 * new rule.
 * @param {unknown} categories
 * @returns {string[]}
 */
export function unknownCategories(categories) {
  return splitCategories(categories).filter((c) => !IGNORED_CATEGORIES.has(c)
    && !CATEGORY_RULES.some(([match]) => match.has(c)));
}

/**
 * Fetch the product index for a locale, keyed by sku. Never throws: on any
 * failure the feed is still served, just without index-derived product_type.
 * @param {{ env: { FEED_SITE_BASE: string }, log: Console }} ctx
 * @param {string} locale e.g. "us/en_us"
 * @returns {Promise<Map<string, Record<string, string>>>}
 */
export async function loadProductIndex(ctx, locale) {
  const base = ctx.env.FEED_SITE_BASE.replace(/\/$/, '');
  const url = `${base}/${locale}/products/index.json`;
  const bySku = new Map();
  try {
    let offset = 0;
    let total = 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      const resp = await fetch(`${url}?include=all&offset=${offset}&limit=${PAGE_SIZE}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      // eslint-disable-next-line no-await-in-loop
      const page = await resp.json();
      const rows = page?.data ?? [];
      for (const row of rows) if (row?.sku) bySku.set(String(row.sku), row);
      total = Number(page?.total) || 0;
      offset += rows.length;
      if (!rows.length) break;
    } while (offset < total);
    ctx.log.info(`loaded product index ${url}: ${bySku.size} skus`);
  } catch (err) {
    ctx.log.warn(`failed to load product index ${url}: ${err.message}`);
  }
  return bySku;
}

/**
 * @param {Record<string, unknown>} item a (prepared) GMC item
 * @param {Map<string, Record<string, string>>} index sku -> index row
 * @returns {string | undefined}
 */
export function resolveProductType(item, index) {
  if (item.product_type) return String(item.product_type);
  const own = index.get(String(item.id));
  const parentSku = item.item_group_id ?? own?.parentSku;
  const parent = parentSku ? index.get(String(parentSku)) : undefined;
  return own?.productType
    || parent?.productType
    || categoryToProductType(own?.categories)
    || categoryToProductType(parent?.categories)
    || undefined;
}

/**
 * Set `product_type` on every item from the index, logging items left without
 * one and categories no rule knows about.
 * @param {{ env: { FEED_SITE_BASE: string }, log: Console }} ctx
 * @param {Record<string, unknown>[]} items
 * @param {string} locale
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function withProductType(ctx, items, locale) {
  const index = await loadProductIndex(ctx, locale);
  const missing = [];
  const unknown = new Set();
  const out = items.map((item) => {
    const productType = resolveProductType(item, index);
    if (!productType) {
      missing.push(String(item.id));
      const own = index.get(String(item.id));
      const parent = index.get(String(item.item_group_id ?? own?.parentSku ?? ''));
      for (const c of [own?.categories, parent?.categories].flatMap(unknownCategories)) {
        unknown.add(c);
      }
    }
    return productType ? { ...item, product_type: productType } : item;
  });
  if (index.size && missing.length) {
    ctx.log.warn(`no product_type for ${missing.length} items in ${locale}: ${missing.join(', ')}`
      + (unknown.size ? ` (unmapped categories: ${[...unknown].join(', ')})` : ''));
  }
  return out;
}
