/**
 * Pre-upload validation for feeds-push. An upload replaces the provider's
 * catalog, so a feed that fails any check is never pushed.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MIN_ITEMS, MAX_SHRINK } from './config.js';
import { BV_NAMESPACE } from '../feeds/providers/bazaarvoice.js';

const BV_PRODUCT_REQUIRED = ['ExternalId', 'Name', 'ProductPageUrl', 'ImageUrl'];
const BV_URL_FIELDS = ['ProductPageUrl', 'ImageUrl'];

/** @param {unknown} v */
const asArray = (v) => {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
};

/** Text of an element as parsed (CDATA merged, attributes ignored). */
const text = (v) => (v === undefined || v === null || typeof v === 'object' ? '' : String(v).trim());

/** The first five ids, then "…". */
const sample = (ids) => `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}`;

/**
 * Bazaarvoice ProductFeed checks. BV imports a non-incremental feed as the
 * client's full catalog, so a structurally broken file is never uploaded:
 *   - root <Feed> in the BV namespace, incremental="false"
 *   - <Product> count equals the built item count
 *   - each product has the fields BV needs to show it (ExternalId, Name,
 *     ProductPageUrl, ImageUrl), absolute http(s) URLs, and an ExternalId
 *     without "/" (the schema's ExternalIdType)
 *   - product and category ExternalIds are unique
 *   - every CategoryExternalId / ParentExternalId has a <Category> in the file
 *     (BV rejects references to undefined categories)
 * @param {string} body
 * @param {number} itemCount
 * @returns {string[]} problems
 */
export function checkBazaarvoice(body, itemCount) {
  const problems = [];
  let doc;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      isArray: (name) => name === 'Product' || name === 'Category',
    }).parse(body);
  } catch (err) {
    return [`invalid Bazaarvoice XML: ${err.message}`];
  }
  const feed = doc?.Feed;
  if (!feed || typeof feed !== 'object') return ['missing <Feed> root element'];
  if (feed['@_xmlns'] !== BV_NAMESPACE) {
    problems.push(`<Feed> namespace is ${JSON.stringify(feed['@_xmlns'] ?? null)}, expected ${BV_NAMESPACE}`);
  }
  if (feed['@_incremental'] !== 'false') {
    problems.push('<Feed> must be a full feed (incremental="false")');
  }

  const categories = asArray(feed.Categories?.Category);
  const products = asArray(feed.Products?.Product);

  if (products.length !== itemCount) {
    problems.push(`${products.length} <Product> elements, expected ${itemCount}`);
  }

  const categoryIds = new Set();
  const dupCategories = [];
  for (const c of categories) {
    const id = text(c.ExternalId);
    if (!id) continue;
    if (categoryIds.has(id)) dupCategories.push(id);
    categoryIds.add(id);
  }
  if (dupCategories.length) problems.push(`duplicate category ExternalIds: ${sample(dupCategories)}`);
  const badParents = categories
    .filter((c) => text(c.ParentExternalId) && !categoryIds.has(text(c.ParentExternalId)))
    .map((c) => `${text(c.ExternalId)}→${text(c.ParentExternalId)}`);
  if (badParents.length) problems.push(`categories with an undefined parent: ${sample(badParents)}`);
  const unnamed = categories.filter((c) => !text(c.ExternalId) || !text(c.Name))
    .map((c) => text(c.ExternalId) || '(no id)');
  if (unnamed.length) problems.push(`categories missing ExternalId or Name: ${sample(unnamed)}`);

  /** @type {Record<string, string[]>} */
  const missing = {};
  const productIds = new Set();
  const dupProducts = [];
  const badIds = [];
  const badUrls = [];
  const badCategoryRefs = [];
  products.forEach((p, i) => {
    const id = text(p.ExternalId);
    const label = id || `#${i + 1}`;
    for (const field of BV_PRODUCT_REQUIRED) {
      if (!text(p[field])) (missing[field] ||= []).push(label);
    }
    if (id) {
      if (productIds.has(id)) dupProducts.push(id);
      productIds.add(id);
      if (id.includes('/')) badIds.push(id);
    }
    for (const field of BV_URL_FIELDS) {
      const url = text(p[field]);
      if (url && !/^https?:\/\/\S+$/.test(url)) badUrls.push(`${label} ${field}`);
    }
    const cat = text(p.CategoryExternalId);
    if (cat && !categoryIds.has(cat)) badCategoryRefs.push(`${label}→${cat}`);
  });
  for (const [field, ids] of Object.entries(missing)) {
    problems.push(`${ids.length} products missing ${field}: ${sample(ids)}`);
  }
  if (dupProducts.length) problems.push(`duplicate product ExternalIds: ${sample(dupProducts)}`);
  if (badIds.length) problems.push(`product ExternalIds containing "/": ${sample(badIds)}`);
  if (badUrls.length) problems.push(`invalid product URLs: ${sample(badUrls)}`);
  if (badCategoryRefs.length) problems.push(`products referencing an undefined category: ${sample(badCategoryRefs)}`);

  return problems;
}

/** Provider-specific structural checks, run on well-formed XML. */
const PROVIDER_CHECKS = {
  bazaarvoice: checkBazaarvoice,
};

/**
 * Item ids in a serialized feed (XML `<id>` or the CSV `id` column).
 * @param {string} body
 * @param {string} contentType
 * @returns {string[]}
 */
export function extractIds(body, contentType) {
  if (/xml/.test(contentType)) {
    return [...body.matchAll(/<(?:g:)?id>([^<]*)<\/(?:g:)?id>/g)].map((m) => m[1].trim());
  }
  return [];
}

/**
 * @param {{ body: string, contentType: string, itemCount: number }} built
 * @param {{
 *   provider?: string,
 *   idPattern?: RegExp,
 *   previousCount?: number | null,
 *   force?: boolean,
 *   minItems?: number,
 *   maxShrink?: number,
 * }} [opts]
 * @returns {{ problems: string[], warnings: string[] }} the feed may be
 *   uploaded when `problems` is empty; `warnings` don't block the upload
 */
export function validateFeed(built, {
  provider, idPattern, previousCount, force = false, minItems = MIN_ITEMS, maxShrink = MAX_SHRINK,
} = {}) {
  const problems = [];
  const warnings = [];
  const { body, contentType, itemCount } = built;

  if (!body || !body.trim()) {
    return { problems: ['feed body is empty'], warnings };
  }

  if (/xml/.test(contentType)) {
    const result = XMLValidator.validate(body);
    if (result !== true) {
      problems.push(`invalid XML: ${result.err?.msg || 'parse error'} (line ${result.err?.line})`);
    } else if (provider && PROVIDER_CHECKS[provider]) {
      problems.push(...PROVIDER_CHECKS[provider](body, itemCount));
    }
  } else if (/csv/.test(contentType)) {
    const header = body.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
    if (!header || !header.includes(',')) {
      problems.push('CSV has no header row');
    }
  }

  if (itemCount < minItems) {
    problems.push(`only ${itemCount} items (minimum ${minItems})`);
  }

  if (!force && previousCount && itemCount < previousCount * maxShrink) {
    problems.push(
      `item count dropped from ${previousCount} to ${itemCount} (more than ${Math.round((1 - maxShrink) * 100)}%); `
      + 're-run with force=true if this is intended',
    );
  }

  // Provider id rules (e.g. CJ item-level commissioning) affect only the
  // offending items, so they warn rather than hold back the whole catalog.
  if (idPattern) {
    const bad = extractIds(body, contentType).filter((id) => !idPattern.test(id));
    if (bad.length) {
      warnings.push(`${bad.length} ids don't match ${idPattern}: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', …' : ''}`);
    }
  }

  return { problems, warnings };
}
