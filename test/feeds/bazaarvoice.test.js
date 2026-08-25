import {
  describe, test, expect, jest, afterEach,
} from '@jest/globals';
import { XMLParser } from 'fast-xml-parser';
import { main } from '../../src/actions/feeds/index.js';

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
    total: 2,
    limit: 2,
    offset: 0,
    data: [
      { sku: '7500', categoryExternalId: '91' },
      { sku: '056405', categoryExternalId: '91' },
    ],
  },
};

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const asArray = (v) => (Array.isArray(v) ? v : [v]);

/** Mock the two fetches: the category sheet (JSON) and the GMC feed (XML). */
function mockFetch({ sheetOk = true } = {}) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes('bv-categories')) {
      return { ok: sheetOk, status: sheetOk ? 200 : 500, json: async () => SHEET };
    }
    return { ok: true, status: 200, text: async () => GMC };
  });
}

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

    const prods = asArray(doc.Feed.Products.Product);
    expect(prods).toHaveLength(3);
  });

  test('maps identifiers, category and family per product', async () => {
    mockFetch();
    const res = await GET({ locale: 'us/en_us' });
    const prods = asArray(parser.parse(res.body).Feed.Products.Product);

    const parent = prods.find((p) => p.ExternalId === '7500');
    expect(parent.CategoryExternalId).toBe('91');
    expect(parent.UPCs.UPC).toBe('703113600000'); // from gtin
    expect(asArray(parent.Attributes.Attribute)[0].Value).toBe('7500'); // BV_FE_FAMILY

    const variant = prods.find((p) => p.ExternalId === '056405');
    // grouped with its parent via item_group_id
    expect(asArray(variant.Attributes.Attribute)[0].Value).toBe('7500');
    expect(variant.CategoryExternalId).toBe('91');
  });

  test('omits CategoryExternalId when the product is not in the sheet', async () => {
    mockFetch();
    const res = await GET({ locale: 'us/en_us' });
    const nocat = asArray(parser.parse(res.body).Feed.Products.Product)
      .find((p) => p.ExternalId === 'NOCAT');
    expect(nocat.CategoryExternalId).toBeUndefined();
    // still a valid product, family = its own id
    expect(asArray(nocat.Attributes.Attribute)[0].Value).toBe('NOCAT');
  });

  test('uses the ca category url for a ca locale', async () => {
    mockFetch();
    const res = await GET({ locale: 'ca/en_us' });
    expect(res.body).toContain('https://www.vitamix.com/ca/fr_ca/shop/blenders');
    expect(res.body).not.toContain('/us/en_us/shop/blenders');
  });

  test('returns 502 when the category sheet is unavailable', async () => {
    mockFetch({ sheetOk: false });
    const res = await GET({ locale: 'us/en_us' });
    expect(res.statusCode).toBe(502);
  });
});
