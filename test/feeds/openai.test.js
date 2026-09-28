import {
  describe, test, expect, jest, afterEach,
} from '@jest/globals';
import { main } from '../../src/actions/feeds/index.js';

const GMC = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
  <item>
    <g:id>ASCENT-X5</g:id>
    <g:title>Vitamix Ascent X5 Blender</g:title>
    <g:description>Smart blender.</g:description>
    <g:link>https://www.vitamix.com/us/en_us/shop/ascent-x5</g:link>
    <g:image_link>https://www.vitamix.com/img/ascent-x5-main.jpg</g:image_link>
    <g:availability>in_stock</g:availability>
    <g:price>699.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
    <g:google_product_category>Home &amp; Garden &gt; Kitchen &amp; Dining &gt; Kitchen Appliances &gt; Blenders</g:google_product_category>
  </item>
  <item>
    <g:id>073495-04</g:id>
    <g:title>Vitamix Ascent X5, Black</g:title>
    <g:description>Smart blender, black.</g:description>
    <g:link>https://www.vitamix.com/us/en_us/shop/ascent-x5</g:link>
    <g:image_link>https://www.vitamix.com/img/ascent-x5-black.jpg</g:image_link>
    <g:additional_image_link>https://www.vitamix.com/img/alt1.jpg</g:additional_image_link>
    <g:additional_image_link>https://www.vitamix.com/img/alt2.jpg</g:additional_image_link>
    <g:availability>in_stock</g:availability>
    <g:price>699.95 USD</g:price>
    <g:sale_price>599.95 USD</g:sale_price>
    <g:brand>Vitamix</g:brand>
    <g:gtin>0703113650017</g:gtin>
    <g:mpn>072197</g:mpn>
    <g:condition>new</g:condition>
    <g:color>Black</g:color>
    <g:google_product_category>Home &amp; Garden &gt; Kitchen &amp; Dining &gt; Kitchen Appliances &gt; Blenders</g:google_product_category>
    <g:item_group_id>ASCENT-X5</g:item_group_id>
    <g:sale_price_effective_date>2026-09-25T13:00:00Z/2026-09-30T03:59:59Z</g:sale_price_effective_date>
  </item>
  <item>
    <g:id>073495-04-VB</g:id>
    <g:title>Ascent X5-Brushed Stainless</g:title>
    <g:description>Bundle option.</g:description>
    <g:link>https://www.vitamix.com/us/en_us/shop/x5-bundle</g:link>
    <g:image_link>https://www.vitamix.com/img/x5-bundle-option.jpg</g:image_link>
    <g:availability>in_stock</g:availability>
    <g:price>949.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
    <g:item_group_id>VBNDAX5KS</g:item_group_id>
  </item>
  <item>
    <g:id>VBNDAX5KS</g:id>
    <g:title>Ascent® X5 SmartPrep™ Kitchen System</g:title>
    <g:description>Blender plus food processor.</g:description>
    <g:link>https://www.vitamix.com/us/en_us/shop/x5-bundle</g:link>
    <g:image_link>https://www.vitamix.com/img/x5-bundle.jpg</g:image_link>
    <g:availability>in_stock</g:availability>
    <g:price>949.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
  </item>
  <item>
    <g:id>PREORDER-1</g:id>
    <g:title>New Model</g:title>
    <g:description>Brand “new” blender.</g:description>
    <g:link>https://www.vitamix.com/us/en_us/shop/new</g:link>
    <g:image_link>https://www.vitamix.com/img/new.jpg</g:image_link>
    <g:availability>preorder</g:availability>
    <g:price>799.95 USD</g:price>
    <g:brand>Vitamix</g:brand>
  </item>
</channel>
</rss>`;

const HEADER = 'item_id,title,description,url,brand,image_url,price,availability,'
  + 'seller_name,seller_url,return_policy,target_countries,store_country,'
  + 'is_eligible_search,is_eligible_checkout,is_ads_eligible,gtin,mpn,'
  + 'product_category,condition,color,sale_price,sale_price_start_date,'
  + 'sale_price_end_date,additional_image_urls,group_id,listing_has_variations,'
  + 'variant_dict';

const BOM = '\uFEFF';

/** Data rows of a response body (BOM stripped), parsed into fields. */
const rowsOf = (body) => body.slice(BOM.length).split('\n').map(parseCsvLine);

/** Minimal RFC 4180 line parser -> fields. */
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') { quoted = false; } else { field += c; }
    } else if (c === '"') { quoted = true; } else if (c === ',') { out.push(field); field = ''; } else { field += c; }
  }
  out.push(field);
  return out;
}

const mockFetch = () => jest.spyOn(global, 'fetch')
  .mockResolvedValue({ ok: true, status: 200, text: async () => GMC });

const GET = (params) => main({ __ow_method: 'GET', LOG_LEVEL: 'error', provider: 'openai', ...params });

afterEach(() => jest.restoreAllMocks());

describe('openai provider', () => {
  test('serves UTF-8 CSV (with BOM) with the exact spec column header', async () => {
    mockFetch();
    const res = await GET({});
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.body.startsWith(BOM)).toBe(true);
    expect(res.body.slice(BOM.length).split('\n')[0]).toBe(HEADER);
  });

  test('sends variants and bundles, not configurable parents or -VB bundle options', async () => {
    mockFetch();
    const res = await GET({});
    const ids = rowsOf(res.body).slice(1).map((r) => r[0]);
    expect(ids).toEqual(['073495-04', 'VBNDAX5KS', 'PREORDER-1']);
  });

  test('bundles and standalone items carry no variant grouping', async () => {
    mockFetch();
    const res = await GET({});
    const cols = HEADER.split(',');
    const row = rowsOf(res.body).find((r) => r[0] === 'VBNDAX5KS');
    expect(row[cols.indexOf('title')]).toBe('Vitamix Ascent X5 SmartPrep Kitchen System');
    expect(row[cols.indexOf('group_id')]).toBe('');
    expect(row[cols.indexOf('listing_has_variations')]).toBe('');
    expect(row[cols.indexOf('variant_dict')]).toBe('');
  });

  test('cleans description punctuation', async () => {
    mockFetch();
    const res = await GET({});
    const cols = HEADER.split(',');
    const row = rowsOf(res.body).find((r) => r[0] === 'PREORDER-1');
    expect(row[cols.indexOf('title')]).toBe('Vitamix New Model');
    expect(row[cols.indexOf('description')]).toBe('Brand "new" blender.');
  });

  test('maps a variant row from GMC attributes', async () => {
    mockFetch();
    const res = await GET({});
    const cols = HEADER.split(',');
    const row = rowsOf(res.body).find((r) => r[0] === '073495-04');
    const get = (name) => row[cols.indexOf(name)];

    // rebuilt from the parent title + color, sanitized
    expect(get('title')).toBe('Vitamix Ascent X5 Blender - Black');
    expect(get('description')).toBe('Smart blender, black.'); // comma survived CSV quoting
    expect(get('url')).toBe('https://www.vitamix.com/us/en_us/shop/ascent-x5');
    expect(get('price')).toBe('699.95 USD');
    expect(get('availability')).toBe('in_stock');
    expect(get('gtin')).toBe('0703113650017');
    expect(get('mpn')).toBe('072197');
    expect(get('condition')).toBe('new');
    expect(get('color')).toBe('Black');
    expect(get('sale_price')).toBe('599.95 USD');
    expect(get('product_category')).toBe('Home & Garden > Kitchen & Dining > Kitchen Appliances > Blenders');
    expect(get('additional_image_urls')).toBe('https://www.vitamix.com/img/alt1.jpg,https://www.vitamix.com/img/alt2.jpg');
    expect(get('sale_price_start_date')).toBe('2026-09-25T13:00:00Z');
    expect(get('sale_price_end_date')).toBe('2026-09-30T03:59:59Z');
    // variant grouping under the parent sku
    expect(get('group_id')).toBe('ASCENT-X5');
    expect(get('listing_has_variations')).toBe('true');
    expect(JSON.parse(get('variant_dict'))).toEqual({ color: 'Black' });
    // static launch config
    expect(get('seller_name')).toBe('Vitamix');
    expect(get('seller_url')).toBe('https://www.vitamix.com');
    expect(get('return_policy')).toBe('https://www.vitamix.com/us/en_us/returns');
    expect(get('target_countries')).toBe('US');
    expect(get('store_country')).toBe('US');
    expect(get('is_eligible_search')).toBe('true');
    expect(get('is_eligible_checkout')).toBe('false');
    expect(get('is_ads_eligible')).toBe('true');
  });

  test('remaps preorder to pre_order', async () => {
    mockFetch();
    const res = await GET({});
    const cols = HEADER.split(',');
    const row = rowsOf(res.body).find((r) => r[0] === 'PREORDER-1');
    expect(row[cols.indexOf('availability')]).toBe('pre_order');
  });

  test('is US-only: ignores a non-US locale and fetches us/en_us', async () => {
    const fetchSpy = mockFetch();
    await GET({ locale: 'ca/en_us' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://www.vitamix.com/us/en_us/products/merchant-center-feed.xml',
    );
  });
});
