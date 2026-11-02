import {
  describe, test, expect, jest, afterEach,
} from '@jest/globals';
import { XMLParser } from 'fast-xml-parser';
import { main } from '../../src/actions/feeds/index.js';
import { familyValues } from '../../src/actions/feeds/providers/bazaarvoice.js';

const GMC = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
  <item>
    <g:id>7500</g:id>
    <g:title>Vitamix 7500</g:title>
    <g:description>A blender</g:description>
    <g:link>https://www.vitamix.com/us/en_us/products/7500</g:link>
    <g:image_link>https://www.vitamix.com/img/7500.jpg</g:image_link>
    <g:availability>in_stock</g:availability>
    <g:price>599.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
    <g:gtin>703113600000</g:gtin>
  </item>
  <item>
    <g:id>056405</g:id>
    <g:title>Vitamix 7500 - Black</g:title>
    <g:link>https://www.vitamix.com/us/en_us/products/7500</g:link>
    <g:image_link>https://www.vitamix.com/img/black.jpg</g:image_link>
    <g:availability>in_stock</g:availability>
    <g:price>599.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
    <g:gtin>703113600017</g:gtin>
    <g:item_group_id>7500</g:item_group_id>
  </item>
  <item>
    <g:id>NOCAT</g:id>
    <g:title>Uncategorized Thing</g:title>
    <g:link>https://www.vitamix.com/us/en_us/products/nocat</g:link>
    <g:image_link>https://www.vitamix.com/img/nocat.jpg</g:image_link>
    <g:availability>in_stock</g:availability>
    <g:price>9.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
  </item>
</channel>
</rss>`;

const SHEET = {
  ':type': 'multi-sheet',
  ':names': ['categories', 'products'],
  categories: {
    total: 2,
    limit: 2,
    offset: 0,
    data: [
      {
        externalId: '55', parentExternalId: '', name: 'Shop', url_us: 'https://www.vitamix.com/us/en_us/shop', url_ca: 'https://www.vitamix.com/ca/fr_ca/shop',
      },
      {
        externalId: '91', parentExternalId: '55', name: 'Blenders', url_us: 'https://www.vitamix.com/us/en_us/shop/blenders', url_ca: 'https://www.vitamix.com/ca/fr_ca/shop/blenders',
      },
    ],
  },
  products: {
    total: 1,
    limit: 1,
    offset: 0,
    // the legacy BV feed listed configurable parents; variants inherit
    data: [
      { sku: '7500', categoryExternalId: '91' },
    ],
  },
};

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const asArray = (v) => (Array.isArray(v) ? v : [v]);

// Product index: the parent carries the reviewsId (a variant row doesn't).
const INDEX = {
  total: 3,
  data: [
    { sku: '7500', reviewsId: '7500standard' },
    { sku: '056405', parentSku: '7500' },
    { sku: 'NOCAT' },
  ],
};

/**
 * Mock the fetches: the category sheet (JSON), the product index (JSON) and the
 * GMC feed (XML).
 */
function mockFetch({ sheetOk = true, indexOk = true, index = INDEX } = {}) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes('bv-categories')) {
      return { ok: sheetOk, status: sheetOk ? 200 : 500, json: async () => SHEET };
    }
    if (String(url).includes('/products/index.json')) {
      const body = typeof index === 'function' ? index(new URL(url)) : index;
      const ok = indexOk && !!body;
      return { ok, status: ok ? 200 : 503, json: async () => body };
    }
    return { ok: true, status: 200, text: async () => GMC };
  });
}

/** BV_FE_FAMILY / BV_FE_EXPAND values of a parsed product */
const attrValues = (product, id) => asArray(product.Attributes.Attribute)
  .filter((a) => a['@_id'] === id)
  .map((a) => a.Value);

const GET = (params) => main({ __ow_method: 'GET', LOG_LEVEL: 'error', provider: 'bazaarvoice', ...params });

afterEach(() => jest.restoreAllMocks());

describe('bazaarvoice provider', () => {
  test('produces a BV ProductFeed with Categories and Products', async () => {
    mockFetch();
    const res = await GET({ locale: 'us/en_us' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml');

    const doc = parser.parse(res.body);
    expect(doc.Feed['@_xmlns']).toBe('http://www.bazaarvoice.com/xs/PRR/ProductFeed/14.7');

    const cats = asArray(doc.Feed.Categories.Category);
    expect(cats.map((c) => c.ExternalId).sort()).toEqual(['55', '91']);
    const blenders = cats.find((c) => c.ExternalId === '91');
    expect(blenders.ParentExternalId).toBe('55');
    expect(blenders.Name).toBe('Blenders');
    expect(blenders.CategoryPageUrl).toBe('https://www.vitamix.com/us/en_us/shop/blenders');

    // prepared by default: the configurable parent (7500) is dropped
    const prods = asArray(doc.Feed.Products.Product);
    expect(prods.map((p) => p.ExternalId)).toEqual(['056405', 'NOCAT']);
  });

  test('maps identifiers, category and family per product', async () => {
    mockFetch();
    const res = await GET({ locale: 'us/en_us' });
    const prods = asArray(parser.parse(res.body).Feed.Products.Product);

    const variant = prods.find((p) => p.ExternalId === '056405');
    expect(variant.UPCs.UPC).toBe('703113600017'); // from gtin
    // the parent's reviewsId, then its variant group (item_group_id)
    expect(attrValues(variant, 'BV_FE_FAMILY')).toEqual(['7500standard', '7500']);
    expect(attrValues(variant, 'BV_FE_EXPAND'))
      .toEqual(['BV_FE_FAMILY:7500standard', 'BV_FE_FAMILY:7500']);
    // not in the sheet itself: inherits the parent's category
    expect(variant.CategoryExternalId).toBe('91');
  });

  test('raw=true serves the unprepared source feed (parents included)', async () => {
    mockFetch();
    const res = await GET({ locale: 'us/en_us', raw: 'true' });
    const prods = asArray(parser.parse(res.body).Feed.Products.Product);
    expect(prods.map((p) => p.ExternalId)).toEqual(['7500', '056405', 'NOCAT']);

    const parent = prods.find((p) => p.ExternalId === '7500');
    expect(parent.CategoryExternalId).toBe('91');
    expect(parent.UPCs.UPC).toBe('703113600000');
    expect(attrValues(parent, 'BV_FE_FAMILY')).toEqual(['7500standard', '7500']);
    // source title untouched
    expect(prods.find((p) => p.ExternalId === 'NOCAT').Name).toBe('Uncategorized Thing');
  });

  test('omits CategoryExternalId when the product is not in the sheet', async () => {
    mockFetch();
    const res = await GET({ locale: 'us/en_us' });
    const nocat = asArray(parser.parse(res.body).Feed.Products.Product)
      .find((p) => p.ExternalId === 'NOCAT');
    expect(nocat.CategoryExternalId).toBeUndefined();
    // still a valid product; no reviewsId, so family = its own id
    expect(attrValues(nocat, 'BV_FE_FAMILY')).toEqual(['NOCAT']);
  });

  test('uses the ca category url for a ca locale', async () => {
    mockFetch();
    const res = await GET({ locale: 'ca/en_us' });
    expect(res.body).toContain('https://www.vitamix.com/ca/fr_ca/shop/blenders');
    expect(res.body).not.toContain('/us/en_us/shop/blenders');
  });

  test('returns 502 when the product index is unavailable', async () => {
    mockFetch({ indexOk: false });
    const res = await GET({ locale: 'us/en_us' });
    expect(res.statusCode).toBe(502);
  });

  test('returns 502 when a later product index page fails', async () => {
    // first page loads, the next one errors: no partial index
    mockFetch({
      index: (url) => (url.searchParams.get('offset') === '0'
        ? { total: 2000, data: INDEX.data }
        : undefined),
    });
    const res = await GET({ locale: 'us/en_us' });
    expect(res.statusCode).toBe(502);
  });

  test('returns 502 when the product index is empty', async () => {
    mockFetch({ index: { total: 0, data: [] } });
    const res = await GET({ locale: 'us/en_us' });
    expect(res.statusCode).toBe(502);
  });

  test('returns 502 when the category sheet is unavailable', async () => {
    mockFetch({ sheetOk: false });
    const res = await GET({ locale: 'us/en_us' });
    expect(res.statusCode).toBe(502);
  });
});

describe('familyValues', () => {
  const index = new Map([
    ['P1', { sku: 'P1', reviewsId: 'fam1' }],
    ['V1', { sku: 'V1', parentSku: 'P1' }],
    ['V2', { sku: 'V2', parentSku: 'P1', reviewsId: 'own' }],
    ['S1', { sku: 'S1', reviewsId: 'S1' }],
    ['S2', { sku: 'S2' }],
  ]);

  test('variant: parent reviewsId, then the variant group', () => {
    expect(familyValues({ id: 'V1', item_group_id: 'P1' }, index)).toEqual(['fam1', 'P1']);
  });

  test('prefers the parent reviewsId over the variant row', () => {
    expect(familyValues({ id: 'V2', item_group_id: 'P1' }, index)).toEqual(['fam1', 'P1']);
  });

  test('resolves the parent from the index when item_group_id is missing', () => {
    expect(familyValues({ id: 'V1' }, index)).toEqual(['fam1', 'V1']);
  });

  test('standalone: its own reviewsId and id, deduplicated', () => {
    expect(familyValues({ id: 'S1' }, index)).toEqual(['S1']);
  });

  test('no reviewsId or not in the index: the group alone', () => {
    expect(familyValues({ id: 'S2' }, index)).toEqual(['S2']);
    expect(familyValues({ id: 'X', item_group_id: 'XP' }, new Map())).toEqual(['XP']);
  });
});
