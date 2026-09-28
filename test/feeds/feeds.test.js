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
