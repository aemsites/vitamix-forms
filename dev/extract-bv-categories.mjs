/**
 * Extract Bazaarvoice category data from the reference BV feeds into a single
 * lookup file used during BV feed generation.
 *
 *   node dev/extract-bv-categories.mjs
 *
 * Output: src/actions/feeds/data/bv-categories.json
 *   {
 *     categories:      { <externalId>: { name, parent, url: { us, ca } } },
 *     productCategory: { <sku>: <categoryExternalId> }
 *   }
 *
 * The reference feeds (test/feeds/fixtures/expected-bazaarvoice*.xml) carry both
 * the full <Categories> tree and each product's <CategoryExternalId>, so we lift
 * the category taxonomy straight from them (it is not in the GMC feed).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => `${HERE}/../test/feeds/fixtures/${name}`;
const OUT = `${HERE}/../src/actions/feeds/data/bv-categories.json`;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  cdataPropName: '__cdata',
});

// fast-xml-parser puts CDATA under __cdata; fall back to the plain text node.
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
  const doc = parser.parse(readFileSync(fixture(file), 'utf-8'));
  const feed = doc.Feed;

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

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ categories, productCategory }, null, 2)}\n`);

// Report
const catCount = Object.keys(categories).length;
const prodCount = Object.keys(productCategory).length;
const orphanCats = Object.entries(categories)
  .filter(([, c]) => c.parent && !categories[c.parent]).map(([id]) => id);
const missingCatRefs = [...new Set(Object.values(productCategory))].filter((id) => !categories[id]);

console.log(`wrote ${OUT}`);
console.log(`categories: ${catCount}`);
console.log(`product→category mappings: ${prodCount}`);
console.log(`us/ca assignment conflicts (kept US): ${conflicts.length}`);
if (conflicts.length) console.log(JSON.stringify(conflicts, null, 2));
console.log(`categories with an unknown parent: ${orphanCats.length}${orphanCats.length ? ` [${orphanCats.join(', ')}]` : ''}`);
console.log(`product categoryIds with no category definition: ${missingCatRefs.length}${missingCatRefs.length ? ` [${missingCatRefs.join(', ')}]` : ''}`);
