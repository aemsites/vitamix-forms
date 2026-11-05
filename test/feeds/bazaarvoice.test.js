import {
  describe, test, expect, jest, afterEach,
} from '@jest/globals';
import { XMLParser } from 'fast-xml-parser';
import { main } from '../../src/actions/feeds/index.js';
import {
  familyValues, pickCategory, parseCategorySheet, categoryPath, bvLocale,
} from '../../src/actions/feeds/providers/bazaarvoice.js';

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
 * GMC feed (XML). The commercial sub-index (index + feed) is missing (404)
 * unless `commercial` gives its status, index and feed.
 */
function mockFetch({
  sheetOk = true, indexOk = true, index = INDEX, sheet = SHEET, gmc = GMC,
  commercial = { status: 404 },
} = {}) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes('bv-categories')) {
      return { ok: sheetOk, status: sheetOk ? 200 : 500, json: async () => sheet };
    }
    if (String(url).includes('/products/commercial/')) {
      const ok = commercial.status === 200;
      return String(url).includes('index.json')
        ? { ok, status: commercial.status, json: async () => commercial.index }
        : { ok, status: commercial.status, text: async () => commercial.gmc };
    }
    if (String(url).includes('/products/index.json')) {
      const body = typeof index === 'function' ? index(new URL(url)) : index;
      const ok = indexOk && !!body;
      return { ok, status: ok ? 200 : 503, json: async () => body };
    }
    return { ok: true, status: 200, text: async () => gmc };
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

  test('builds category urls for the requested locale', async () => {
    mockFetch();
    for (const locale of ['ca/en_us', 'ca/fr_ca', 'mx/es_mx']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await GET({ locale });
      const cats = asArray(parser.parse(res.body).Feed.Categories.Category);
      expect(cats.find((c) => c.ExternalId === '91').CategoryPageUrl)
        .toBe(`https://www.vitamix.com/${locale}/shop/blenders`);
      expect(cats.find((c) => c.ExternalId === '55').CategoryPageUrl)
        .toBe(`https://www.vitamix.com/${locale}/shop`);
    }
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

describe('bazaarvoice locale fields', () => {
  /** text + locale of a localized element, e.g. Names.Name */
  const loc = (node) => ({ text: node['#text'], locale: node['@_locale'] });

  test.each([
    ['us/en_us', 'en_US'],
    ['ca/en_us', 'en_CA'],
    ['ca/fr_ca', 'fr_CA'],
    ['mx/es_mx', 'es_MX'],
  ])('%s carries its values under %s', async (locale, bvLocale) => {
    mockFetch();
    const res = await GET({ locale });
    const feed = parser.parse(res.body).Feed;
    const variant = asArray(feed.Products.Product).find((p) => p.ExternalId === '056405');
    expect(loc(variant.Names.Name)).toEqual({ text: variant.Name, locale: bvLocale });
    expect(loc(variant.ProductPageUrls.ProductPageUrl))
      .toEqual({ text: variant.ProductPageUrl, locale: bvLocale });
    expect(loc(variant.ImageUrls.ImageUrl)).toEqual({ text: variant.ImageUrl, locale: bvLocale });
    // prepared: the variant inherits the parent's description
    expect(loc(variant.Descriptions.Description))
      .toEqual({ text: variant.Description, locale: bvLocale });

    const blenders = asArray(feed.Categories.Category).find((c) => c.ExternalId === '91');
    expect(loc(blenders.Names.Name)).toEqual({ text: 'Blenders', locale: bvLocale });
    expect(loc(blenders.CategoryPageUrls.CategoryPageUrl))
      .toEqual({ text: `https://www.vitamix.com/${locale}/shop/blenders`, locale: bvLocale });
  });

  test('omits Descriptions without a description', async () => {
    mockFetch();
    const res = await GET({ locale: 'us/en_us', raw: 'true' });
    const variant = asArray(parser.parse(res.body).Feed.Products.Product)
      .find((p) => p.ExternalId === '056405');
    expect(variant.Description).toBeUndefined();
    expect(variant.Descriptions).toBeUndefined();
    expect(variant.Names.Name['@_locale']).toBe('en_US');
  });

  test('bvLocale', () => {
    expect(bvLocale('us/en_us')).toBe('en_US');
    expect(bvLocale('mx/es_mx')).toBe('es_MX');
    // the country comes from the first segment, not the language variant
    expect(bvLocale('ca/en_us')).toBe('en_CA');
    expect(bvLocale('us')).toBeUndefined();
    expect(bvLocale(undefined)).toBeUndefined();
  });
});

const GMC_ITEM = (id, link, extra = '') => `
  <item>
    <g:id>${id}</g:id>
    <g:title>Vitamix ${id}</g:title>
    <g:description>About ${id}</g:description>
    <g:link>${link}</g:link>
    <g:image_link>https://www.vitamix.com/img/${id}.jpg</g:image_link>
    <g:availability>in_stock</g:availability>
    <g:price>9.95 USD</g:price>${extra}
  </item>`;
const gmcOf = (...items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel>${items.join('')}</channel></rss>`;

// path-based sheet (current schema) with a shop and a commercial tree
const TREE_SHEET = {
  categories: {
    data: [
      { externalId: '28', name: 'Commercial', path: '/commercial' },
      { externalId: '29', parentExternalId: '28', name: 'Products', path: '/commercial/products' },
      { externalId: '194', parentExternalId: '29', name: 'Accessories', path: '/commercial/products/accessories' },
      { externalId: '55', name: 'Shop', path: '/shop' },
      { externalId: '58', parentExternalId: '55', name: 'Accessories', path: '/shop/accessories' },
      { externalId: '64', parentExternalId: '55', name: 'All Blenders', path: '/shop/blenders' },
      { externalId: '287', parentExternalId: '55', name: 'Personal Blending', path: '/shop/personal-blending' },
      { externalId: '148', parentExternalId: '145', name: 'Mix&#039;n Machine', path: '/shop/frozen-treat-mixers/mix-n-machine' },
      { externalId: '145', parentExternalId: '55', name: 'Frozen Treat Mixers', path: '/shop/frozen-treat-mixers' },
      { externalId: '300', parentExternalId: '55', name: 'Unused', path: '/shop/unused' },
    ],
  },
  products: {
    data: [
      { sku: 'MAPPED', categoryExternalId: '58' },
      { sku: 'DANGLING', categoryExternalId: '223' },
    ],
  },
};

describe('bazaarvoice categories', () => {
  const US = 'https://www.vitamix.com/us/en_us/products';
  const gmc = gmcOf(
    GMC_ITEM('MAPPED', `${US}/mapped`),
    GMC_ITEM('DANGLING', `${US}/dangling`),
    GMC_ITEM('NANO-1', `${US}/nano`, '<g:item_group_id>Nano</g:item_group_id><g:color>Black</g:color>'),
    GMC_ITEM('NONE', `${US}/none`),
  );
  const index = {
    total: 6,
    data: [
      { sku: 'MAPPED', categories: 'Personal Blending' },
      { sku: 'DANGLING', categories: 'Shop,Accessories' },
      { sku: 'Nano', categories: 'All Blenders,Personal Blending' },
      { sku: 'NANO-1', parentSku: 'Nano' },
      { sku: 'NONE', categories: '' },
      // stale main-index row of a product that moved to the commercial catalog
      { sku: 'QUIET', categories: 'Shop' },
    ],
  };

  const categoryOf = (body) => Object.fromEntries(
    asArray(parser.parse(body).Feed.Products.Product)
      .map((p) => [p.ExternalId, p.CategoryExternalId]),
  );

  test('sheet first, then the product categories', async () => {
    mockFetch({ sheet: TREE_SHEET, gmc, index });
    const res = await GET({ locale: 'us/en_us' });
    expect(res.statusCode).toBe(200);
    expect(categoryOf(res.body)).toEqual({
      MAPPED: '58', // the sheet wins over the product's own categories
      DANGLING: '58', // sheet id not defined: falls back, skipping "Shop"
      'NANO-1': '287', // the parent's categories, the generic one skipped
      NONE: undefined,
    });
  });

  test('emits only the categories in use, with their ancestors', async () => {
    mockFetch({ sheet: TREE_SHEET, gmc, index });
    const res = await GET({ locale: 'mx/es_mx' });
    const cats = asArray(parser.parse(res.body).Feed.Categories.Category);
    expect(cats.map((c) => c.ExternalId)).toEqual(['55', '58', '287']);
    expect(cats.find((c) => c.ExternalId === '287').CategoryPageUrl)
      .toBe('https://www.vitamix.com/mx/es_mx/shop/personal-blending');
  });

  test('includes commercial products, with their reviewsId and category', async () => {
    const C = 'https://www.vitamix.com/us/en_us/products/commercial';
    mockFetch({
      sheet: TREE_SHEET,
      gmc,
      index,
      commercial: {
        status: 200,
        // MAPPED is in both feeds: the main feed's row wins
        gmc: gmcOf(GMC_ITEM('QUIET', `${C}/quiet`), GMC_ITEM('MAPPED', `${C}/dup`)),
        index: { total: 1, data: [{ sku: 'QUIET', reviewsId: 'quiet', categories: 'Commercial,Accessories' }] },
      },
    });
    const res = await GET({ locale: 'us/en_us' });
    expect(res.statusCode).toBe(200);
    const prods = asArray(parser.parse(res.body).Feed.Products.Product);
    expect(prods.map((p) => p.ExternalId)).toEqual(['MAPPED', 'DANGLING', 'NANO-1', 'NONE', 'QUIET']);
    expect(prods.find((p) => p.ExternalId === 'MAPPED').ProductPageUrl).toBe(`${US}/mapped`);
    const quiet = prods.find((p) => p.ExternalId === 'QUIET');
    // its commercial index row wins over the stale main one; "Accessories"
    // resolves to the commercial category for a commercial product
    expect(quiet.CategoryExternalId).toBe('194');
    expect(attrValues(quiet, 'BV_FE_FAMILY')).toEqual(['quiet', 'QUIET']);
    const cats = asArray(parser.parse(res.body).Feed.Categories.Category).map((c) => c.ExternalId);
    expect(cats).toEqual(expect.arrayContaining(['28', '29', '194']));
  });

  test('returns 502 when the commercial feed fails (other than missing)', async () => {
    mockFetch({ commercial: { status: 500 } });
    const res = await GET({ locale: 'us/en_us' });
    expect(res.statusCode).toBe(502);
  });

  test('other providers ignore the commercial catalog', async () => {
    const spy = mockFetch();
    const res = await main({
      __ow_method: 'GET', LOG_LEVEL: 'error', provider: 'meta', locale: 'us/en_us',
    });
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([url]) => String(url).includes('/commercial/'))).toBe(false);
  });
});

describe('parseCategorySheet', () => {
  test('derives the path from legacy url columns and decodes names', () => {
    const data = parseCategorySheet({
      categories: {
        data: [
          { externalId: '91', name: 'Mix&#039;n Machine', url_ca: 'https://www.vitamix.com/ca/fr_ca/shop/blenders' },
          { externalId: '55', name: 'Shop', path: '/shop', url_us: 'https://www.vitamix.com/us/en_us/other' },
        ],
      },
      products: { data: [{ sku: 'A', categoryExternalId: 91 }] },
    });
    expect(data.categories['91']).toEqual({ name: "Mix'n Machine", parent: undefined, path: '/shop/blenders' });
    expect(data.categories['55'].path).toBe('/shop');
    expect(data.productCategory).toEqual({ A: '91' });
    expect(data.byName.get("mix'n machine")).toEqual(['91']);
  });

  test('categoryPath strips the locale prefix', () => {
    expect(categoryPath('https://www.vitamix.com/us/en_us/shop/blenders')).toBe('/shop/blenders');
    expect(categoryPath('https://www.vitamix.com/us/en_us/')).toBe('/');
    expect(categoryPath('not a url')).toBeUndefined();
  });
});

describe('pickCategory', () => {
  const data = parseCategorySheet(TREE_SHEET);

  test('prefers specific, then deeper, then the product order', () => {
    expect(pickCategory(['All Blenders', 'Personal Blending'], data, false)).toBe('287');
    expect(pickCategory(['Frozen Treat Mixers', "Mix'n Machine"], data, false)).toBe('148');
    expect(pickCategory(['Personal Blending', 'Accessories'], data, false)).toBe('287');
  });

  test('falls back to a generic category, or nothing', () => {
    expect(pickCategory(['Shop', 'All Blenders'], data, false)).toBe('64');
    expect(pickCategory(['Unknown'], data, false)).toBeUndefined();
    expect(pickCategory([], data, false)).toBeUndefined();
  });

  test('resolves a shared name by catalog', () => {
    expect(pickCategory(['Accessories'], data, false)).toBe('58');
    expect(pickCategory(['Accessories'], data, true)).toBe('194');
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
