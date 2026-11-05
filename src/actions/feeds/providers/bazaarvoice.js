import { errorWithResponse } from '../../../utils.js';
import { loadProductIndex } from '../product-type.js';
import { decodeEntities } from '../prepare.js';
import { COMMERCIAL_SECTION } from '../source.js';

/**
 * Bazaarvoice product feed (ProductFeed.xml).
 *
 * BV uses its own schema — not the Google `g:`/`<feed>` shapes — so this provider
 * supplies a custom async `build` instead of the field/format descriptor the
 * other providers use. Like the legacy feed it includes the commercial catalog
 * (`includeCommercial`, see ../build.js).
 *
 * Two inputs the GMC feed can't provide are loaded at runtime:
 *   - the category taxonomy, from a published DA sheet (see
 *     dev/extract-bv-categories.mjs):
 *       - categories: externalId, parentExternalId, name, path
 *         (older sheets: url_us / url_ca, from which the path is derived)
 *       - products:   sku -> categoryExternalId
 *   - each product's `reviewsId` and categories, from the product indexes (see
 *     familyValues, resolveCategory)
 */

const DEFAULT_SHEET_URL = 'https://main--vitamix--aemsites.aem.live/config/feeds/bv-categories.json';
const BV_NAMESPACE = 'http://www.bazaarvoice.com/xs/PRR/ProductFeed/14.7';

/**
 * Categories too broad (or promotional) to describe a product. A product's own
 * categories only fall back to one of these when it has nothing more specific.
 */
const GENERIC_CATEGORIES = new Set([
  'shop', 'all blenders', 'blenders', 'commercial', 'products', 'all collections',
  'available products', 'eligible employee discount', 'employee sale exclusions',
  'in home trial', 'sale skus (sale exclusion products)', 'shop now!', 'why buy direct',
]);

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// CDATA-wrap, splitting any literal "]]>" so the section stays well-formed.
const cdata = (v) => `<![CDATA[${String(v ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

/** @param {unknown} name */
const nameKey = (name) => decodeEntities(String(name ?? '')).trim().toLowerCase();

/**
 * Category page path without the locale prefix:
 * "https://host/ca/fr_ca/shop/blenders" -> "/shop/blenders".
 * @param {unknown} url
 * @returns {string | undefined}
 */
export function categoryPath(url) {
  try {
    const { pathname } = new URL(String(url));
    return pathname.replace(/^\/[a-z]{2}\/[a-z]{2}_[a-z]{2}(?=\/|$)/, '') || '/';
  } catch {
    return undefined;
  }
}

/**
 * @typedef {{ name: string, parent?: string, path?: string }} BvCategory
 * @typedef {{
 *   categories: Record<string, BvCategory>,
 *   productCategory: Record<string, string>,
 *   byName: Map<string, string[]>,
 * }} CategoryData
 */

/**
 * Reshape the published category sheet.
 * @param {any} doc the sheet JSON
 * @returns {CategoryData}
 */
export function parseCategorySheet(doc) {
  /** @type {Record<string, BvCategory>} */
  const categories = {};
  /** @type {Map<string, string[]>} */
  const byName = new Map();
  for (const row of doc?.categories?.data ?? []) {
    if (!row.externalId) continue;
    const id = String(row.externalId);
    const name = decodeEntities(String(row.name ?? '')).trim();
    categories[id] = {
      name,
      parent: row.parentExternalId ? String(row.parentExternalId) : undefined,
      path: row.path || categoryPath(row.url_us || row.url_ca),
    };
    const key = nameKey(name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(id);
  }
  /** @type {Record<string, string>} */
  const productCategory = {};
  for (const row of doc?.products?.data ?? []) {
    if (row.sku && row.categoryExternalId) productCategory[row.sku] = String(row.categoryExternalId);
  }
  return { categories, productCategory, byName };
}

/**
 * Fetch + reshape the published category sheet.
 * @param {{ log: Console }} ctx
 * @param {string} url
 * @returns {Promise<CategoryData>}
 */
async function loadCategoryData(ctx, url) {
  ctx.log.info(`fetching BV category sheet: ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw errorWithResponse(
      `failed to fetch BV category sheet ${url}: ${resp.status}`,
      502,
      'failed to fetch category sheet',
    );
  }
  return parseCategorySheet(await resp.json());
}

/**
 * Ancestor chain of a category, nearest first (cycle-safe).
 * @param {string} id
 * @param {Record<string, BvCategory>} categories
 * @returns {string[]}
 */
function ancestors(id, categories) {
  const out = [];
  let cur = categories[id]?.parent;
  while (cur && categories[cur] && !out.includes(cur) && cur !== id) {
    out.push(cur);
    cur = categories[cur].parent;
  }
  return out;
}

/**
 * Pick one BV category from a product's own categories (names, as in the
 * product index `categories` column):
 *   1. map each name to sheet categories; a name used twice (e.g. "Accessories"
 *      for shop and commercial) resolves to the one in the product's catalog
 *   2. prefer specific categories over generic ones (GENERIC_CATEGORIES)
 *   3. then the deepest in the tree, then the product's own order
 * @param {string[]} names
 * @param {CategoryData} data
 * @param {boolean} commercial whether the product is in the commercial catalog
 * @returns {string | undefined}
 */
export function pickCategory(names, { categories, byName }, commercial) {
  const isCommercialCat = (id) => [id, ...ancestors(id, categories)].some(
    (c) => nameKey(categories[c]?.name) === 'commercial',
  );
  const candidates = [];
  names.forEach((name, order) => {
    const ids = byName.get(nameKey(name)) ?? [];
    const id = ids.find((c) => isCommercialCat(c) === commercial) ?? ids[0];
    if (!id) return;
    candidates.push({
      id,
      order,
      generic: GENERIC_CATEGORIES.has(nameKey(name)) || /promo/i.test(name),
      depth: ancestors(id, categories).length,
    });
  });
  candidates.sort((x, y) => (Number(x.generic) - Number(y.generic))
    || (y.depth - x.depth)
    || (x.order - y.order));
  return candidates[0]?.id;
}

/** @param {Record<string, unknown>} item */
const isCommercialItem = (item) => /\/products\/commercial\//.test(String(item.link ?? ''));

/** @param {unknown} value comma-separated index column */
const splitList = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The BV category of an item: the sheet's assignment (the item's, else its
 * variant group's), else one picked from the product's own categories in the
 * product index (the item's row, else its parent's). Only ids defined in the
 * sheet are returned: BV rejects a CategoryExternalId with no <Category>.
 * @param {Record<string, unknown>} item a normalized GMC item
 * @param {CategoryData} data
 * @param {Map<string, Record<string, string>>} index sku -> product index row
 * @returns {string | undefined}
 */
export function resolveCategory(item, data, index) {
  const id = String(item.id);
  const own = index.get(id);
  const parentSku = item.item_group_id ?? own?.parentSku;
  const fromSheet = [data.productCategory[id], parentSku && data.productCategory[String(parentSku)]]
    .find((c) => c && data.categories[c]);
  if (fromSheet) return fromSheet;

  const parent = parentSku ? index.get(String(parentSku)) : undefined;
  const names = splitList(own?.categories).length
    ? splitList(own?.categories)
    : splitList(parent?.categories);
  return pickCategory(names, data, isCommercialItem(item));
}

/**
 * BV_FE_FAMILY values for an item, matching the legacy Magento feed:
 *   1. the parent's `reviewsId` (the product's BV id on the PDP). It groups
 *      related products across PDPs, e.g. a blender and its bundles.
 *   2. the variant group: the parent sku (item_group_id), or the item's own id
 *      for a standalone product.
 * BV aggregates reviews across every product sharing any family value. Items
 * without a reviewsId get the group alone.
 * @param {Record<string, unknown>} item a normalized GMC item
 * @param {Map<string, Record<string, string>>} index sku -> product index row
 * @returns {string[]}
 */
export function familyValues(item, index) {
  const id = String(item.id);
  const own = index.get(id);
  const groupKey = String(item.item_group_id || id);
  const parent = index.get(String(item.item_group_id || own?.parentSku || id));
  const reviewsId = parent?.reviewsId || own?.reviewsId;
  return [...new Set([reviewsId, groupKey].filter(Boolean).map(String))];
}

/**
 * @param {string} id
 * @param {BvCategory} cat
 * @param {string} siteBase e.g. "https://www.vitamix.com"
 * @param {string} locale e.g. "ca/fr_ca"
 * @param {Record<string, BvCategory>} categories
 */
function categoryXml(id, cat, siteBase, locale, categories) {
  const parent = cat.parent && categories[cat.parent] ? cat.parent : undefined;
  const path = !cat.path || cat.path === '/' ? '' : cat.path;
  const url = `${siteBase}/${locale}${path}`;
  return `    <Category>
      <ExternalId>${esc(id)}</ExternalId>${parent ? `
      <ParentExternalId>${esc(parent)}</ParentExternalId>` : ''}
      <Name>${cdata(cat.name)}</Name>
      <CategoryPageUrl>${cdata(url)}</CategoryPageUrl>
    </Category>`;
}

/**
 * @param {Record<string, unknown>} item a normalized GMC item
 * @param {string | undefined} categoryId
 * @param {Map<string, Record<string, string>>} index sku -> product index row
 */
function productXml(item, categoryId, index) {
  const id = String(item.id);
  const families = familyValues(item, index);

  return `    <Product>
      <ExternalId>${esc(id)}</ExternalId>
      <Name>${cdata(item.title)}</Name>${item.description ? `
      <Description>${cdata(item.description)}</Description>` : ''}${categoryId ? `
      <CategoryExternalId>${esc(categoryId)}</CategoryExternalId>` : ''}
      <ProductPageUrl>${cdata(item.link)}</ProductPageUrl>
      <ImageUrl>${cdata(item.image_link)}</ImageUrl>${item.gtin ? `
      <UPCs>
        <UPC>${cdata(item.gtin)}</UPC>
      </UPCs>` : ''}
      <Attributes>
${families.map((f) => `        <Attribute id="BV_FE_FAMILY">
          <Value>${esc(f)}</Value>
        </Attribute>
        <Attribute id="BV_FE_EXPAND">
          <Value>BV_FE_FAMILY:${esc(f)}</Value>
        </Attribute>`).join('\n')}
      </Attributes>
    </Product>`;
}

export default {
  contentType: 'application/xml',
  includeCommercial: true,
  /**
   * @param {{ env: Record<string, string>, log: Console }} ctx
   * @param {{ items: Record<string, unknown>[] }} feed
   * @param {string} locale
   * @returns {Promise<string>}
   */
  build: async (ctx, feed, locale) => {
    const url = ctx.env.BV_CATEGORY_SHEET_URL || DEFAULT_SHEET_URL;
    const [data, mainIndex, commercialIndex] = await Promise.all([
      loadCategoryData(ctx, url),
      // required: this is a full feed, so serving it without the reviewsId
      // families would regroup every product's reviews
      loadProductIndex(ctx, locale, { required: true }),
      loadProductIndex(ctx, locale, {
        required: true, section: COMMERCIAL_SECTION, missingOk: true,
      }),
    ]);
    // Look an item up in its own catalog's index first: a product that moved to
    // the commercial catalog can leave a stale row in the main index.
    const shopFirst = new Map([...commercialIndex, ...mainIndex]);
    const commercialFirst = new Map([...mainIndex, ...commercialIndex]);
    const indexOf = (item) => (isCommercialItem(item) ? commercialFirst : shopFirst);
    const siteBase = String(ctx.env.FEED_SITE_BASE || '').replace(/\/$/, '');
    const extractDate = new Date().toISOString();

    const productCategories = feed.items.map((item) => resolveCategory(item, data, indexOf(item)));
    // Only the categories this feed uses, with their ancestors: other stores'
    // categories don't belong in this locale's feed.
    const used = new Set();
    for (const id of productCategories) {
      if (!id) continue;
      used.add(id);
      ancestors(id, data.categories).forEach((a) => used.add(a));
    }
    const categoriesXml = [...used]
      .sort((x, y) => Number(x) - Number(y) || x.localeCompare(y))
      .map((id) => categoryXml(id, data.categories[id], siteBase, locale, data.categories)).join('\n');
    const productsXml = feed.items
      .map((item, i) => productXml(item, productCategories[i], indexOf(item))).join('\n');

    const uncategorized = feed.items.filter((_, i) => !productCategories[i]).map((it) => it.id);
    if (uncategorized.length) {
      ctx.log.warn(`no BV category for ${uncategorized.length} items in ${locale}: ${uncategorized.join(', ')}`);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Feed xmlns="${BV_NAMESPACE}" name="vitamix" incremental="false" extractDate="${extractDate}" generator="vitamix-forms">
  <Categories>
${categoriesXml}
  </Categories>
  <Products>
${productsXml}
  </Products>
</Feed>`;
  },
};
