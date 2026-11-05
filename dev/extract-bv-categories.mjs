/**
 * Extract Bazaarvoice category data from legacy BV product feeds into a DA sheet
 * that the BV feed generator loads at runtime.
 *
 *   node dev/extract-bv-categories.mjs [--us <file>] [--ca <file>] [--mx <file>]
 *
 * Each option is a legacy BV ProductFeed.xml for that store; without options
 * the US and CA test fixtures are used. Pass the latest exports to refresh the
 * mapping.
 *
 * Output: dev/bv-categories.json, an AEM multi-sheet document to upload to DA
 * (e.g. /config/feeds/bv-categories), with two sheets:
 *   - categories: externalId, parentExternalId, name, path
 *   - products:   sku, categoryExternalId
 *
 * `path` is the category page path without the locale prefix (e.g.
 * "/shop/blenders"); the feed builds the URL for the requested locale.
 *
 * The category taxonomy is the one BV input the GMC feed can't provide, so we
 * lift it from the legacy feeds (which carry the full <Categories> tree and
 * each product's <CategoryExternalId>). Product→category assignments are a
 * snapshot: products missing from it fall back to their own categories (see
 * src/actions/feeds/providers/bazaarvoice.js).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => `${HERE}/../test/feeds/fixtures/${name}`;
const OUT = `${HERE}/bv-categories.json`;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  cdataPropName: '__cdata',
});

const text = (node) => {
  if (node == null) return undefined;
  if (typeof node === 'string') return node.trim();
  if (node.__cdata != null) return String(node.__cdata).trim();
  if (node['#text'] != null) return String(node['#text']).trim();
  return undefined;
};
// the legacy feed double-escapes some names (e.g. "Mix&#039;n Machine")
const decode = (s) => s?.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const asArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const custom = ['us', 'ca', 'mx'].filter((key) => opt(key));
// first store wins product conflicts, so list the primary store first
const STORES = custom.length
  ? custom.map((key) => ({ key, file: opt(key) }))
  : [
    { key: 'us', file: fixture('expected-bazaarvoice.xml') },
    { key: 'ca', file: fixture('expected-bazaarvoice-ca.xml') },
  ];

/** "https://host/us/en_us/shop/blenders" -> "/shop/blenders" */
const pathOf = (url) => {
  try {
    const { pathname } = new URL(url);
    return pathname.replace(/^\/[a-z]{2}\/[a-z]{2}_[a-z]{2}(?=\/|$)/, '') || '/';
  } catch {
    return '';
  }
};

/** @type {Record<string, { name?: string, parent?: string, path?: string, stores: string[] }>} */
const categories = {};
/** @type {Record<string, string>} */
const productCategory = {};
const conflicts = [];
const pathConflicts = [];

for (const { key, file } of STORES) {
  const feed = parser.parse(readFileSync(file, 'utf-8')).Feed;

  for (const cat of asArray(feed.Categories?.Category)) {
    const id = text(cat.ExternalId);
    if (!id) continue;
    const entry = categories[id] ?? (categories[id] = { stores: [] });
    entry.stores.push(key);
    entry.name = entry.name ?? decode(text(cat.Name));
    // a store omits the parent when the parent isn't in that store: keep any
    const parent = text(cat.ParentExternalId);
    if (parent) entry.parent = parent;
    const path = pathOf(text(cat.CategoryPageUrl));
    if (path && entry.path && entry.path !== path) pathConflicts.push({ id, [key]: path, kept: entry.path });
    entry.path = entry.path || path;
  }

  for (const prod of asArray(feed.Products?.Product)) {
    const sku = text(prod.ExternalId);
    const catId = text(prod.CategoryExternalId);
    if (!sku || !catId) continue;
    if (productCategory[sku] && productCategory[sku] !== catId) {
      conflicts.push({ sku, kept: productCategory[sku], [key]: catId });
      continue; // keep the first store's assignment
    }
    productCategory[sku] = catId;
  }
}

// Shape as an AEM multi-sheet DA document.
const categoryRows = Object.entries(categories).map(([externalId, c]) => ({
  externalId,
  parentExternalId: c.parent ?? '',
  name: c.name ?? '',
  path: c.path ?? '',
}));
const productRows = Object.entries(productCategory).map(([sku, categoryExternalId]) => ({
  sku,
  categoryExternalId,
}));

const sheet = (data) => ({
  total: data.length, limit: data.length, offset: 0, data,
});
const doc = {
  ':version': 3,
  ':type': 'multi-sheet',
  ':names': ['categories', 'products'],
  categories: sheet(categoryRows),
  products: sheet(productRows),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);

// Tab-delimited dumps for copy/paste into a DA sheet (same as Google Sheets:
// header row + rows, columns separated by tabs). One file per sheet.
const tsv = (rows) => {
  const cols = Object.keys(rows[0]);
  const line = (obj) => cols.map((c) => String(obj[c] ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t');
  return [cols.join('\t'), ...rows.map(line)].join('\n');
};
const CATEGORIES_TSV = `${HERE}/bv-categories.categories.tsv`;
const PRODUCTS_TSV = `${HERE}/bv-categories.products.tsv`;
writeFileSync(CATEGORIES_TSV, `${tsv(categoryRows)}\n`);
writeFileSync(PRODUCTS_TSV, `${tsv(productRows)}\n`);

// Report
const orphanCats = categoryRows.filter((c) => c.parentExternalId && !categories[c.parentExternalId]).map((c) => c.externalId);
const missingCatRefs = [...new Set(productRows.map((p) => p.categoryExternalId))].filter((id) => !categories[id]);
console.log(`wrote ${OUT}`);
console.log(`wrote ${CATEGORIES_TSV}`);
console.log(`wrote ${PRODUCTS_TSV}`);
console.log(`categories sheet: ${categoryRows.length} rows`);
console.log(`products sheet:   ${productRows.length} rows`);
console.log(`stores: ${STORES.map((s) => s.key).join(', ')}`);
console.log(`product conflicts between stores (kept first): ${conflicts.length}${conflicts.length ? ` ${JSON.stringify(conflicts)}` : ''}`);
console.log(`category path conflicts between stores (kept first): ${pathConflicts.length}${pathConflicts.length ? ` ${JSON.stringify(pathConflicts)}` : ''}`);
console.log(`categories with unknown parent: ${orphanCats.length}${orphanCats.length ? ` [${orphanCats.join(', ')}]` : ''}`);
console.log(`product categoryIds with no definition: ${missingCatRefs.length}${missingCatRefs.length ? ` [${missingCatRefs.join(', ')}]` : ''}`);
