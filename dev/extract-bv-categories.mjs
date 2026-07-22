/**
 * Extract Bazaarvoice category data from the reference BV feeds into a DA sheet
 * that the BV feed generator loads at runtime.
 *
 *   node dev/extract-bv-categories.mjs
 *
 * Output: dev/bv-categories.json  — an AEM multi-sheet document to upload to DA
 * (e.g. /config/feeds/bv-categories), with two sheets:
 *   - categories: externalId, parentExternalId, name, url_us, url_ca
 *   - products:   sku, categoryExternalId
 *
 * The category taxonomy is the one BV input the GMC feed can't provide, so we
 * lift it from the reference feeds (which carry the full <Categories> tree and
 * each product's <CategoryExternalId>). Regenerate + re-upload when the taxonomy
 * changes; product→category assignments are a snapshot (see README/notes).
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
const asArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));

const STORES = [
  { key: 'us', file: 'expected-bazaarvoice.xml' },
  { key: 'ca', file: 'expected-bazaarvoice-ca.xml' },
];

/** @type {Record<string, { name?: string, parent?: string, url: Record<string,string> }>} */
const categories = {};
/** @type {Record<string, string>} */
const productCategory = {};
const conflicts = [];

for (const { key, file } of STORES) {
  const feed = parser.parse(readFileSync(fixture(file), 'utf-8')).Feed;

  for (const cat of asArray(feed.Categories?.Category)) {
    const id = text(cat.ExternalId);
    if (!id) continue;
    const entry = categories[id] ?? (categories[id] = { url: {} });
    entry.name = entry.name ?? text(cat.Name);
    const parent = text(cat.ParentExternalId);
    if (parent) entry.parent = parent;
    const url = text(cat.CategoryPageUrl);
    if (url) entry.url[key] = url;
  }

  for (const prod of asArray(feed.Products?.Product)) {
    const sku = text(prod.ExternalId);
    const catId = text(prod.CategoryExternalId);
    if (!sku || !catId) continue;
    if (productCategory[sku] && productCategory[sku] !== catId) {
      conflicts.push({ sku, us: productCategory[sku], [key]: catId });
      continue; // keep the first (US) assignment
    }
    productCategory[sku] = catId;
  }
}

// Shape as an AEM multi-sheet DA document.
const categoryRows = Object.entries(categories).map(([externalId, c]) => ({
  externalId,
  parentExternalId: c.parent ?? '',
  name: c.name ?? '',
  url_us: c.url.us ?? '',
  url_ca: c.url.ca ?? '',
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
console.log(`us/ca conflicts (kept US): ${conflicts.length}${conflicts.length ? ` ${JSON.stringify(conflicts)}` : ''}`);
console.log(`categories with unknown parent: ${orphanCats.length}${orphanCats.length ? ` [${orphanCats.join(', ')}]` : ''}`);
console.log(`product categoryIds with no definition: ${missingCatRefs.length}${missingCatRefs.length ? ` [${missingCatRefs.join(', ')}]` : ''}`);
