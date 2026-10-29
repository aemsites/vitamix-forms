import {
  describe, test, expect, jest, afterEach,
} from '@jest/globals';

import { buildProviderFeed, resolveFeedEnv, DEFAULT_FEED_SITE_BASE } from '../../src/actions/feeds/build.js';
import { main } from '../../src/actions/feeds/index.js';

// Same source shape as feeds.test.js: a simple, a configurable parent + variant,
// and a bundle with a "-VB" duplicate option.
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

const log = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = { env: resolveFeedEnv({}), log };

afterEach(() => jest.restoreAllMocks());

describe('resolveFeedEnv', () => {
  test('defaults FEED_SITE_BASE and ignores non-URL values', () => {
    expect(resolveFeedEnv({})).toEqual({
      FEED_SITE_BASE: DEFAULT_FEED_SITE_BASE,
      FEED_CONTENT_BASE: undefined,
      BV_CATEGORY_SHEET_URL: undefined,
    });
    expect(resolveFeedEnv({ FEED_SITE_BASE: '$FEED_SITE_BASE' }).FEED_SITE_BASE)
      .toBe(DEFAULT_FEED_SITE_BASE);
    expect(resolveFeedEnv({ FEED_SITE_BASE: 'https://example.com' }).FEED_SITE_BASE)
      .toBe('https://example.com');
  });
});

describe('buildProviderFeed', () => {
  test('returns the same body the feeds web action serves, plus the item count', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => SAMPLE_FEED });
    const built = await buildProviderFeed(ctx, 'cj', 'us/en_us');
    const served = await main({
      __ow_method: 'GET', LOG_LEVEL: 'error', provider: 'cj', locale: 'us/en_us',
    });

    expect(built.body).toBe(served.body);
    expect(built.contentType).toBe('application/xml');
    expect(built.locale).toBe('us/en_us');
    // configurable parent and the -VB bundle option are dropped by preparation
    expect(built.itemCount).toBe((built.body.match(/<item>/g) || []).length);
    expect(built.itemCount).toBe(3);
  });

  test('raw=true skips preparation (every source item is kept)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => SAMPLE_FEED });
    const built = await buildProviderFeed(ctx, 'cj', 'us/en_us', { raw: true });
    expect(built.itemCount).toBe(5);
  });

  test('honors a provider-pinned locale (openai is US-only)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => SAMPLE_FEED });
    const built = await buildProviderFeed(ctx, 'openai', 'ca/fr_ca');
    expect(built.locale).toBe('us/en_us');
    expect(fetchSpy.mock.calls[0][0]).toBe(`${DEFAULT_FEED_SITE_BASE}/us/en_us/products/merchant-center-feed.xml`);
  });

  test('throws for an unknown provider', async () => {
    await expect(buildProviderFeed(ctx, 'nope', 'us/en_us')).rejects.toThrow('unknown provider "nope"');
  });

  test('propagates source fetch failures', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    await expect(buildProviderFeed(ctx, 'cj', 'us/en_us')).rejects.toThrow(/503/);
  });
});
