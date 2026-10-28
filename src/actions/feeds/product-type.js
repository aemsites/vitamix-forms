/**
 * `product_type` from the store categories in the Edge product index
 * (<site>/<locale>/products/index.json, `include=all` so search-only parents are
 * available for variant fallback).
 *
 * Categories are authored on each product (`custom.categories`, managed in the
 * commerce admin) and indexed as `categories` (names) and `categoriesUrlKey`
 * (slugs, same order). Rules match on the slugs: they are stable across locales
 * and renames, whereas names collide (e.g. both `explorian-series` and
 * `explorian-series-accessories` are named "Explorian Series").
 *
 * Variant index rows carry no categories, so a variant uses its parent's
 * (item_group_id). Resolution order per item (first non-empty wins):
 *   1. the source feed's own product_type
 *   2. the item's, then the parent's, categories via CATEGORY_RULES
 *   3. the legacy index `productType` (`custom.catalogProductType`), item then
 *      parent — transitional, until every product has a type-bearing
 *      category; items typed this way are logged
 */

// Ordered slug -> product_type rules; the first rule matching any of the item's
// category slugs wins, so the most specific come first: smoothie cups and
// food-processor bowls are also in blender-containers, personal blender
// containers in personal-blending, FoodCyclers in kitchen-tools.
// Values keep the legacy Magento product_type vocabulary.
const CATEGORY_RULES = [
  [['smoothie-cups'], 'Smoothie Cup'],
  [['tampers'], 'Tamper'],
  [['cookbooks'], 'Cookbook'],
  [['compact-food-recycling'], 'Compact Food Recycling'],
  [['food-processing'], 'Food Processing'],
  [['blender-containers'], 'Blender Container'],
  [['immersion-blender'], 'Immersion Blender'],
  [['kitchen-tools', 'juicing'], 'Kitchen Tool'],
  [['personal-blending'], 'Personal Blender'],
  [[
    'full-size-blenders',
    'legacy-series-blenders',
    'certified-reconditioned-series',
    'propel-series-blenders',
    'explorian-series-blenders',
    'explorian-series',
    'ascent-x-series-blenders',
  ], 'Countertop Blender'],
].map(([slugs, type]) => [new Set(slugs), type]);

// Slugs that say nothing about the product type: navigation roots, broad or
// series groupings, membership/promo lists (e.g. the admin's sale-skus sync),
// and commercial-only categories. Ignored without a warning; any other
// unmapped slug is logged as a candidate for a new rule.
const IGNORED_CATEGORIES = new Set([
  'shop',
  'accessories',
  'all-blenders',
  'allblenders',
  'blenders', // named "All Blenders" on some products; includes immersion/personal
  'bundles',
  'ascent-series-accessories',
  'explorian-series-accessories',
  'eligible-employee-discount',
  'all-household-products-promo-category',
  'sale-skus',
  'commercial',
  'products',
  'drink-machine',
  'food-preparation',
  'frozen-treat-mixers',
  'container-rinsers',
]);

const PAGE_SIZE = 1000;
const FETCH_TIMEOUT_MS = 10000;

/** @param {unknown} value comma-separated category slugs */
const splitSlugs = (value) => String(value ?? '')
  .split(',')
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);

/**
 * @param {unknown} slugs comma-separated category slugs (`categoriesUrlKey`)
 * @returns {string | undefined}
 */
export function categoryToProductType(slugs) {
  const cats = splitSlugs(slugs);
  return CATEGORY_RULES.find(([match]) => cats.some((c) => match.has(c)))?.[1];
}

/**
 * Category slugs that are neither mapped nor explicitly ignored — candidates
 * for a new rule.
 * @param {unknown} slugs
 * @returns {string[]}
 */
export function unknownCategories(slugs) {
  return splitSlugs(slugs).filter((c) => !IGNORED_CATEGORIES.has(c)
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
 * @typedef {'source' | 'category' | 'legacy' | 'none'} TypeSource
 */

/**
 * @param {Record<string, unknown>} item a (prepared) GMC item
 * @param {Map<string, Record<string, string>>} index sku -> index row
 * @returns {{ productType?: string, source: TypeSource }}
 */
export function resolveProductType(item, index) {
  if (item.product_type) return { productType: String(item.product_type), source: 'source' };
  const own = index.get(String(item.id));
  const parentSku = item.item_group_id ?? own?.parentSku;
  const parent = parentSku ? index.get(String(parentSku)) : undefined;
  const byCategory = categoryToProductType(own?.categoriesUrlKey)
    || categoryToProductType(parent?.categoriesUrlKey);
  if (byCategory) return { productType: byCategory, source: 'category' };
  const legacy = own?.productType || parent?.productType;
  if (legacy) return { productType: legacy, source: 'legacy' };
  return { source: 'none' };
}

/**
 * Set `product_type` on every item from the index, logging items that still
 * depend on the legacy productType, items left without a type, and category
 * slugs no rule knows about.
 * @param {{ env: { FEED_SITE_BASE: string }, log: Console }} ctx
 * @param {Record<string, unknown>[]} items
 * @param {string} locale
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function withProductType(ctx, items, locale) {
  const index = await loadProductIndex(ctx, locale);
  /** @type {Record<TypeSource, string[]>} */
  const bySource = {
    source: [], category: [], legacy: [], none: [],
  };
  const unknown = new Set();
  const out = items.map((item) => {
    const { productType, source } = resolveProductType(item, index);
    bySource[source].push(String(item.id));
    if (source === 'legacy' || source === 'none') {
      const own = index.get(String(item.id));
      const parent = index.get(String(item.item_group_id ?? own?.parentSku ?? ''));
      for (const c of [own?.categoriesUrlKey, parent?.categoriesUrlKey].flatMap(unknownCategories)) {
        unknown.add(c);
      }
    }
    return productType ? { ...item, product_type: productType } : item;
  });
  if (index.size) {
    ctx.log.info(`product_type for ${locale}: ${bySource.category.length} from categories,`
      + ` ${bySource.source.length} from source, ${bySource.legacy.length} from legacy productType,`
      + ` ${bySource.none.length} none`);
    if (bySource.legacy.length) {
      ctx.log.warn(`no type-bearing category for ${bySource.legacy.length} items in ${locale}`
        + ` (typed from legacy productType): ${bySource.legacy.join(', ')}`);
    }
    if (bySource.none.length) {
      ctx.log.warn(`no product_type for ${bySource.none.length} items in ${locale}: ${bySource.none.join(', ')}`);
    }
    if (unknown.size) {
      ctx.log.warn(`unmapped categories in ${locale}: ${[...unknown].join(', ')}`);
    }
  }
  return out;
}
