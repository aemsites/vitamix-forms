import {
  describe, test, expect, jest, afterEach,
} from '@jest/globals';
import {
  findCandidates, planProductUpdate, updateProductAvailability, MAX_412_RETRIES,
} from '../../src/actions/inventory-sync/catalog.js';

const COLUMNS = ['sku', 'url', 'urlKey', 'availability', 'parentSku', 'managedStock'];

function index(data, columns = COLUMNS) {
  return { columns, data };
}

describe('findCandidates', () => {
  const data = [
    { sku: 'A2300', urlKey: 'a2300', url: 'https://www.vitamix.com/ca/en_us/products/a2300', managedStock: '0' },
    { sku: '062327', parentSku: 'A2300', url: 'https://www.vitamix.com/ca/en_us/products/a2300', managedStock: '1', availability: 'InStock' },
    { sku: '062327', urlKey: 'a2300-1', url: 'https://www.vitamix.com/ca/en_us/products/a2300-1', managedStock: '1', availability: 'InStock' },
    { sku: '062326', parentSku: 'A2300', managedStock: '1', availability: 'OutOfStock' },
    { sku: '062325-1', parentSku: 'A2300', managedStock: '0', availability: 'InStock' },
    { sku: '062324', parentSku: 'A2300', availability: 'InStock' }, // not re-synced yet
    { sku: 'VBND2SIB', urlKey: 'bundle' },
    { sku: '073511-VB', parentSku: 'VBND2SIB', managedStock: '1', availability: 'InStock' },
    { sku: 'ORPHAN', parentSku: 'MISSING', url: 'https://www.vitamix.com/ca/en_us/products/orphan', managedStock: '1' },
  ];

  test('variant uses the parent urlKey; duplicate SKUs map to every product', () => {
    expect(findCandidates(index(data), ' 062327 ', 'ca/en_us')).toEqual({
      matched: true,
      candidates: [
        { sku: '062327', path: '/ca/en_us/products/a2300', isVariant: true },
        { sku: '062327', path: '/ca/en_us/products/a2300-1', isVariant: false },
      ],
    });
  });

  test('filters on managedStock === "1" and availability !== OutOfStock', () => {
    expect(findCandidates(index(data), '062326', 'ca/en_us')).toEqual({ matched: true, candidates: [] });
    expect(findCandidates(index(data), '062325-1', 'ca/en_us').candidates).toEqual([]);
    expect(findCandidates(index(data), '062324', 'ca/en_us').candidates).toEqual([]);
  });

  test('never matches -VB component entries', () => {
    expect(findCandidates(index(data), '073511-VB', 'ca/en_us')).toEqual({ matched: false, candidates: [] });
    expect(findCandidates(index(data), '073511', 'ca/en_us')).toEqual({ matched: false, candidates: [] });
  });

  test('falls back to the row url when the parent row is missing', () => {
    expect(findCandidates(index(data), 'ORPHAN', 'ca/en_us').candidates).toEqual([
      { sku: 'ORPHAN', path: '/ca/en_us/products/orphan', isVariant: true },
    ]);
  });

  test('without the managedStock column: every exact-SKU row is a candidate', () => {
    const noCol = index(data, COLUMNS.filter((c) => c !== 'managedStock'));
    expect(findCandidates(noCol, '062326', 'ca/en_us').candidates).toEqual([
      { sku: '062326', path: '/ca/en_us/products/a2300', isVariant: true },
    ]);
  });

  test('no match → matched: false', () => {
    expect(findCandidates(index(data), '999', 'us/en_us')).toEqual({ matched: false, candidates: [] });
  });
});

describe('planProductUpdate', () => {
  const configurable = () => ({
    sku: 'A2300',
    availability: 'InStock',
    custom: { managedStock: '1' },
    variants: [
      { sku: '062327', availability: 'InStock', custom: { managedStock: '1' } },
      { sku: '062326', availability: 'OutOfStock', custom: { managedStock: '1' } },
      { sku: '062325-1', availability: 'InStock', custom: { managedStock: '0' } },
      { sku: '062324', availability: 'InStock', custom: {} },
      { sku: '062323', availability: 'InStock' },
    ],
  });

  test('flips only the exact-SKU managed variant', () => {
    const p = configurable();
    expect(planProductUpdate(p, ['062327'])).toEqual([{ sku: '062327', status: 'flip' }]);
    expect(p.variants[0].availability).toBe('OutOfStock');
    expect(p.variants[0].custom.managedStock).toBe('1');
    expect(p.availability).toBe('InStock'); // parent untouched
    expect(p.variants.slice(1).map((v) => v.availability)).toEqual(['OutOfStock', 'InStock', 'InStock', 'InStock']);
  });

  test('skips non-managed (never sets or creates managedStock), already-OOS, and configurable parents', () => {
    const p = configurable();
    const before = JSON.parse(JSON.stringify(p));
    expect(planProductUpdate(p, ['062325-1', '062324', '062323', '062326', 'A2300', 'nope'])).toEqual([
      { sku: '062325-1', status: 'skipped', reason: 'not-managed' },
      { sku: '062324', status: 'skipped', reason: 'not-managed' },
      { sku: '062323', status: 'skipped', reason: 'not-managed' },
      { sku: '062326', status: 'skipped', reason: 'already-out-of-stock' },
      { sku: 'A2300', status: 'skipped', reason: 'configurable-parent' },
      { sku: 'nope', status: 'skipped', reason: 'sku-not-found' },
    ]);
    expect(p).toEqual(before);
  });

  test('simple product (no variants) is flipped on the product itself', () => {
    const p = { sku: '001811', availability: 'InStock', custom: { managedStock: '1' } };
    expect(planProductUpdate(p, ['001811'])).toEqual([{ sku: '001811', status: 'flip' }]);
    expect(p.availability).toBe('OutOfStock');
  });

  test('bundle parent with -VB variants is never flipped', () => {
    const p = {
      sku: 'VBND2SIB',
      type: 'bundle',
      availability: 'InStock',
      custom: { managedStock: '1', type: 'bundle' },
      bundleItems: [{ sku: '073511' }],
      variants: [{ sku: '073511-VB', availability: 'InStock', custom: { managedStock: '1' } }],
    };
    expect(planProductUpdate(p, ['VBND2SIB', '073511-VB', '073511']).map((r) => r.reason))
      .toEqual(['configurable-parent', 'bundle-component', 'sku-not-found']);
    expect(p.availability).toBe('InStock');
    expect(p.variants[0].availability).toBe('InStock');
  });

  test('no-variant bundle marked managed in product-admin is treated like a simple product', () => {
    const p = {
      sku: 'VBNDDCC', type: 'bundle', availability: 'InStock', custom: { managedStock: '1' }, bundleItems: [{}],
    };
    expect(planProductUpdate(p, ['VBNDDCC'])).toEqual([{ sku: 'VBNDDCC', status: 'flip' }]);
  });
});

describe('updateProductAvailability', () => {
  const ctx = {
    env: {
      EDGE_COMMERCE_API_BASE: 'https://api.test', ORG: 'aemsites', SITE: 'vitamix', EDGE_COMMERCE_API_CATALOG_TOKEN: 'cat-token',
    },
    log: { info: () => {}, warn: () => {} },
  };
  const URL = 'https://api.test/aemsites/sites/vitamix/catalog/us/en_us/products/x.json';
  const product = () => ({
    path: '/us/en_us/products/x',
    sku: 'X',
    variants: [{ sku: 'V1', availability: 'InStock', custom: { managedStock: '1', addToCart: 'Yes' } }],
  });

  afterEach(() => jest.restoreAllMocks());

  function mockFetch(putStatuses) {
    const calls = [];
    let get = 0;
    let put = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init = {}) => {
      calls.push({ url, init });
      if ((init.method || 'GET') === 'GET') {
        get += 1;
        return new Response(JSON.stringify(product()), { status: 200, headers: { ETag: `"etag-${get}"` } });
      }
      const status = putStatuses[put] ?? 200;
      put += 1;
      return new Response('{}', { status });
    });
    return calls;
  }

  test('GET → PUT with If-Match; writes only availability', async () => {
    const calls = mockFetch([200]);
    const res = await updateProductAvailability(ctx, '/us/en_us/products/x', ['V1']);
    expect(res.status).toBe('updated');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(URL);
    expect(calls[1].init.method).toBe('PUT');
    expect(calls[1].init.headers['If-Match']).toBe('"etag-1"');
    expect(calls[1].init.headers.Authorization).toBe('Bearer cat-token');
    const expected = product();
    expected.variants[0].availability = 'OutOfStock';
    expect(JSON.parse(calls[1].init.body)).toEqual(expected);
  });

  test('412 → re-GET and retry with the new ETag', async () => {
    const calls = mockFetch([412, 412, 200]);
    const res = await updateProductAvailability(ctx, '/us/en_us/products/x', ['V1']);
    expect(res).toMatchObject({ status: 'updated', attempts: 3 });
    const puts = calls.filter((c) => c.init.method === 'PUT');
    expect(puts.map((c) => c.init.headers['If-Match'])).toEqual(['"etag-1"', '"etag-2"', '"etag-3"']);
  });

  test(`gives up after ${MAX_412_RETRIES} retries`, async () => {
    const calls = mockFetch([412, 412, 412, 412, 412]);
    const res = await updateProductAvailability(ctx, '/us/en_us/products/x', ['V1']);
    expect(res.status).toBe('conflict');
    expect(calls.filter((c) => c.init.method === 'PUT')).toHaveLength(MAX_412_RETRIES + 1);
  });

  test('dryRun and no-op products never PUT', async () => {
    let calls = mockFetch([]);
    expect((await updateProductAvailability(ctx, '/us/en_us/products/x', ['V1'], { dryRun: true })).status).toBe('planned');
    expect(calls.some((c) => c.init.method === 'PUT')).toBe(false);
    jest.restoreAllMocks();
    calls = mockFetch([]);
    expect((await updateProductAvailability(ctx, '/us/en_us/products/x', ['OTHER'])).status).toBe('unchanged');
    expect(calls.some((c) => c.init.method === 'PUT')).toBe(false);
  });

  test('404 → not-found; other PUT errors throw', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    expect((await updateProductAvailability(ctx, '/us/en_us/products/x', ['V1'])).status).toBe('not-found');
    jest.restoreAllMocks();
    mockFetch([500]);
    await expect(updateProductAvailability(ctx, '/us/en_us/products/x', ['V1'])).rejects.toThrow('catalog PUT');
  });
});
