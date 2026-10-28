import {
  describe, test, expect, jest, afterEach,
} from '@jest/globals';

import { main } from '../../src/actions/feeds/index.js';

// Source shapes (mirroring the Edge product bus): a simple, a configurable
// parent (7500) + its simple variant, and a bundle (VBNDP750) whose selectable
// option is a "-VB" duplicate simple.
const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
  <title>Vitamix</title>
  <link>https://www.vitamix.com</link>
  <description></description>
  <item>
    <g:id>064584</g:id>
    <g:title>Under Blade Scraper</g:title>
    <g:description>A scraper</g:description>
    <g:link>https://www.vitamix.com/us/en_us/products/under-blade-scraper</g:link>
    <g:image_link>https://www.vitamix.com/img/scraper.jpg</g:image_link>
    <g:condition>new</g:condition>
    <g:availability>in_stock</g:availability>
    <g:price>14.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
    <g:gtin>0123456789012</g:gtin>
    <g:google_product_category>4653</g:google_product_category>
    <g:product_type>Kitchen Tool</g:product_type>
  </item>
  <item>
    <g:id>7500</g:id>
    <g:title>7500</g:title>
    <g:description>A blender</g:description>
    <g:link>https://www.vitamix.com/us/en_us/products/7500</g:link>
    <g:image_link>https://www.vitamix.com/img/main.jpg</g:image_link>
    <g:additional_image_link>https://www.vitamix.com/img/alt1.jpg</g:additional_image_link>
    <g:additional_image_link>https://www.vitamix.com/img/alt2.jpg</g:additional_image_link>
    <g:condition>new</g:condition>
    <g:availability>in_stock</g:availability>
    <g:price>599.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
  </item>
  <item>
    <g:id>056405-3898</g:id>
    <g:title>7500-Black</g:title>
    <g:description>A blender</g:description>
    <g:link>https://www.vitamix.com/us/en_us/products/7500</g:link>
    <g:image_link>https://www.vitamix.com/img/black.jpg</g:image_link>
    <g:condition>new</g:condition>
    <g:availability>in_stock</g:availability>
    <g:price>599.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
    <g:color>Black</g:color>
    <g:item_group_id>7500</g:item_group_id>
  </item>
  <item>
    <g:id>VBNDP750</g:id>
    <g:title>Propel® 750 Classic Bundle</g:title>
    <g:description>A bundle</g:description>
    <g:link>https://www.vitamix.com/us/en_us/products/propel-750-classic-bundle</g:link>
    <g:image_link>https://www.vitamix.com/img/bundle.jpg</g:image_link>
    <g:condition>new</g:condition>
    <g:availability>in_stock</g:availability>
    <g:price>699.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
  </item>
  <item>
    <g:id>071395-VB</g:id>
    <g:title>Propel Series 750 Black</g:title>
    <g:description>A bundle option</g:description>
    <g:link>https://www.vitamix.com/us/en_us/products/propel-750-classic-bundle</g:link>
    <g:image_link>https://www.vitamix.com/img/bundle-black.jpg</g:image_link>
    <g:condition>new</g:condition>
    <g:availability>in_stock</g:availability>
    <g:price>699.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
    <g:color>Black</g:color>
    <g:item_group_id>VBNDP750</g:item_group_id>
  </item>
</channel>
</rss>`;

const mockFetch = (xml, { ok = true, status = 200 } = {}) => jest
  .spyOn(global, 'fetch')
  .mockResolvedValue({ ok, status, text: async () => xml });

const GET = (params) => main({ __ow_method: 'GET', LOG_LEVEL: 'error', ...params });

afterEach(() => jest.restoreAllMocks());

describe('feeds action', () => {
  test('rejects non-GET methods', async () => {
    const res = await main({ __ow_method: 'POST', provider: 'meta' });
    expect(res.statusCode).toBe(405);
  });

  test('rejects unknown provider', async () => {
    const res = await GET({ provider: 'tiktok' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-error']).toMatch(/unknown provider/);
  });

  test('rejects malformed locale', async () => {
    const res = await GET({ provider: 'meta', locale: '../secrets' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-error']).toMatch(/invalid locale/);
  });

  test('meta: fetches the right locale feed as a non-namespaced rss feed', async () => {
    const fetchSpy = mockFetch(SAMPLE_FEED);
    const res = await GET({ provider: 'meta', locale: 'ca/en_us' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://www.vitamix.com/ca/en_us/products/merchant-center-feed.xml',
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml');
    // ungated feed is shared-cacheable
    expect(res.headers['cache-control']).toBe('max-age=3600, must-revalidate');
    // non-namespaced <rss> tags (no g: prefix)
    expect(res.body).toContain('<rss version="2.0"');
    expect(res.body).not.toContain('<g:');
    expect(res.body).toContain('<id>064584</id>');
    expect(res.body).toContain('<gtin>0123456789012</gtin>');
    // availability mapped to the spaced spec form
    expect(res.body).toContain('<availability>in stock</availability>');
  });

  test('sends simples and bundles; drops configurable parents and -VB bundle children', async () => {
    mockFetch(SAMPLE_FEED);
    const res = await GET({ provider: 'meta' });
    const ids = [...res.body.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);
    expect(ids).toEqual(['064584', '056405-3898', 'VBNDP750']);
  });

  test('variants are grouped by item_group_id + color with a Vitamix, sanitized title', async () => {
    mockFetch(SAMPLE_FEED);
    const res = await GET({ provider: 'meta' });
    expect(res.body).toContain('<title>Vitamix 7500 - Black</title>');
    expect(res.body).toContain('<item_group_id>7500</item_group_id>');
    expect(res.body).toContain('<color>Black</color>');
    // bundle title: ® stripped, brand prefixed
    expect(res.body).toContain('<title>Vitamix Propel 750 Classic Bundle</title>');
  });

  test('pinterest: non-namespaced rss with mapped availability and category fields', async () => {
    mockFetch(SAMPLE_FEED);
    const res = await GET({ provider: 'pinterest', locale: 'us/en_us' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<rss version="2.0"');
    expect(res.body).not.toContain('<g:');
    expect(res.body).toContain('<availability>in stock</availability>');
    expect(res.body).not.toContain('in_stock');
    expect(res.body).toContain('<google_product_category>4653</google_product_category>');
    expect(res.body).toContain('<product_type>Kitchen Tool</product_type>');
  });

  test('pinterest: product_type from the product index, empty google_product_category', async () => {
    // source without product_type / google_product_category (like the live feed)
    const source = SAMPLE_FEED
      .replace('<g:google_product_category>4653</g:google_product_category>', '')
      .replace('<g:product_type>Kitchen Tool</g:product_type>', '');
    const INDEX = {
      total: 4,
      data: [
        { sku: '064584', productType: 'Kitchen Tool', categories: 'Accessories' },
        // configurable parent carries the type; the variant doesn't
        { sku: '7500', productType: 'Countertop Blender' },
        { sku: '056405-3898', parentSku: '7500' },
        // no productType: falls back to the category rules ("Shop" is ignored)
        { sku: 'VBNDP750', categories: 'Shop,All Blenders,Full Size Blenders' },
      ],
    };
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => (
      String(url).includes('/products/index.json')
        ? { ok: true, status: 200, json: async () => INDEX }
        : { ok: true, status: 200, text: async () => source }
    ));
    const res = await GET({ provider: 'pinterest', locale: 'ca/en_us' });

    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/www\.vitamix\.com\/ca\/en_us\/products\/index\.json/),
      expect.anything(),
    );
    const typeOf = Object.fromEntries([...res.body.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .map(([, x]) => [x.match(/<id>([^<]+)/)[1], x.match(/<product_type>([^<]+)/)?.[1]]));
    expect(typeOf).toEqual({
      '064584': 'Kitchen Tool',
      '056405-3898': 'Countertop Blender',
      VBNDP750: 'Countertop Blender',
    });
    // always present, empty (as in the legacy Magento feed)
    expect(res.body.match(/<google_product_category><\/google_product_category>/g)).toHaveLength(3);
  });

  test('pinterest: still served (without product_type) when the index is unavailable', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => (
      String(url).includes('/products/index.json')
        ? { ok: false, status: 503 }
        : { ok: true, status: 200, text: async () => SAMPLE_FEED.replace('<g:product_type>Kitchen Tool</g:product_type>', '') }
    ));
    const res = await GET({ provider: 'pinterest' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<product_type>');
    expect(res.body).toContain('<google_product_category>4653</google_product_category>');
  });

  test('meta: no empty google_product_category tag', async () => {
    mockFetch(SAMPLE_FEED.replace('<g:google_product_category>4653</g:google_product_category>', ''));
    const res = await GET({ provider: 'meta' });
    expect(res.body).not.toContain('google_product_category');
  });

  test('cj: <feed> root, non-namespaced, no google_product_category', async () => {
    mockFetch(SAMPLE_FEED);
    const res = await GET({ provider: 'cj' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<feed>');
    expect(res.body).not.toContain('<rss');
    expect(res.body).not.toContain('<g:');
    expect(res.body).toContain('<gtin>0123456789012</gtin>');
    // CJ follows the Google spec: underscore availability, no google_product_category
    expect(res.body).toContain('<availability>in_stock</availability>');
    expect(res.body).not.toContain('google_product_category');
  });

  test('raw=true skips preparation: parents, -VB rows and source titles kept', async () => {
    mockFetch(SAMPLE_FEED);
    const res = await GET({ provider: 'meta', raw: 'true' });
    const ids = [...res.body.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);
    expect(ids).toEqual(['064584', '7500', '056405-3898', 'VBNDP750', '071395-VB']);
    expect(res.body).toContain('<title>7500-Black</title>');
  });

  test('merchant-center: namespaced rss passing every prepared field through', async () => {
    const withExtras = SAMPLE_FEED.replace(
      '<g:item_group_id>7500</g:item_group_id>',
      `<g:item_group_id>7500</g:item_group_id>
    <g:sale_price>499.95 USD</g:sale_price>
    <g:sale_price_effective_date>2026-01-01T00:00:00Z/2026-02-01T00:00:00Z</g:sale_price_effective_date>
    <g:additional_image_link>https://www.vitamix.com/img/black-2.jpg</g:additional_image_link>
    <g:additional_image_link>https://www.vitamix.com/img/black-3.jpg</g:additional_image_link>
    <g:shipping><g:country>US</g:country><g:price>0.00 USD</g:price></g:shipping>`,
    );
    mockFetch(withExtras);
    const res = await GET({ provider: 'merchant-center', locale: 'us/en_us' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml');
    expect(res.body).toContain('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
    expect(res.body).toContain('<title>Vitamix</title>'); // channel
    // prepared: same product selection as every other provider
    const ids = [...res.body.matchAll(/<g:id>([^<]+)<\/g:id>/g)].map((m) => m[1]);
    expect(ids).toEqual(['064584', '056405-3898', 'VBNDP750']);
    expect(res.body).toContain('<g:title>Vitamix 7500 - Black</g:title>');
    // GMC availability form kept; fields not in the rss-plain list pass through
    expect(res.body).toContain('<g:availability>in_stock</g:availability>');
    expect(res.body).toContain(
      '<g:sale_price_effective_date>2026-01-01T00:00:00Z/2026-02-01T00:00:00Z</g:sale_price_effective_date>',
    );
    expect(res.body).toContain('<g:additional_image_link>https://www.vitamix.com/img/black-3.jpg</g:additional_image_link>');
    expect(res.body).toMatch(
      /<g:shipping>\s*<g:country>US<\/g:country>\s*<g:price>0\.00 USD<\/g:price>\s*<\/g:shipping>/,
    );
    // no un-prefixed item tags
    expect(res.body).not.toMatch(/<item>\s*<(?!g:)/);
  });

  test('every provider sends the same products', async () => {
    const SHEET = { categories: { data: [] }, products: { data: [] } };
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => (
      String(url).includes('bv-categories')
        ? { ok: true, status: 200, json: async () => SHEET }
        : { ok: true, status: 200, text: async () => SAMPLE_FEED }
    ));
    const idsOf = {
      meta: (b) => [...b.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]),
      pinterest: (b) => [...b.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]),
      cj: (b) => [...b.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]),
      'merchant-center': (b) => [...b.matchAll(/<g:id>([^<]+)<\/g:id>/g)].map((m) => m[1]),
      bazaarvoice: (b) => [...b.matchAll(/<Product>\s*<ExternalId>([^<]+)</g)].map((m) => m[1]),
      openai: (b) => b.split('\n').slice(1).map((row) => row.split(',')[0]),
    };
    for (const [provider, ids] of Object.entries(idsOf)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await GET({ provider, locale: 'us/en_us' });
      expect(res.statusCode).toBe(200);
      expect({ provider, ids: ids(res.body) })
        .toEqual({ provider, ids: ['064584', '056405-3898', 'VBNDP750'] });
    }
  });

  test('returns 502 when the source feed is unavailable', async () => {
    mockFetch('', { ok: false, status: 404 });
    const res = await GET({ provider: 'meta' });
    expect(res.statusCode).toBe(502);
  });

  describe('token gate', () => {
    const TOKEN = 'secret-token';

    test('401 when token configured but not provided', async () => {
      const res = await GET({ provider: 'meta', FEEDS_TOKEN: TOKEN });
      expect(res.statusCode).toBe(401);
    });

    test('401 on wrong token', async () => {
      const res = await GET({
        provider: 'meta', FEEDS_TOKEN: TOKEN, __ow_headers: { authorization: 'Bearer nope' },
      });
      expect(res.statusCode).toBe(401);
    });

    test('200 with correct Bearer header', async () => {
      mockFetch(SAMPLE_FEED);
      const res = await GET({
        provider: 'meta', FEEDS_TOKEN: TOKEN, __ow_headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });

    test('gated response is not shared-cacheable', async () => {
      mockFetch(SAMPLE_FEED);
      const res = await GET({
        provider: 'meta', FEEDS_TOKEN: TOKEN, __ow_headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    test('200 with ?token query param', async () => {
      mockFetch(SAMPLE_FEED);
      const res = await GET({ provider: 'meta', FEEDS_TOKEN: TOKEN, token: TOKEN });
      expect(res.statusCode).toBe(200);
    });
  });
});
