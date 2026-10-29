/**
 * inventory-sync orchestration: outbox cursor/head, sheet read/write via the DA
 * source, preview, product check, ops-log events, status, dryRun and the prod gate.
 */

import {
  describe, test, expect, jest, beforeEach, afterEach,
} from '@jest/globals';

const store = new Map();
const stateOps = [];
jest.unstable_mockModule('@adobe/aio-lib-state', () => ({
  init: async () => ({
    get: async (key) => (store.has(key) ? { value: store.get(key) } : null),
    put: async (key, value) => { stateOps.push(['put', key]); store.set(key, value); },
    delete: async (key) => { stateOps.push(['delete', key]); store.delete(key); },
  }),
}));

const { run } = await import('../../src/actions/inventory-sync/sync.js');
const { main } = await import('../../src/actions/inventory-sync/index.js');

const PARAMS = {
  LOG_LEVEL: 'error',
  ORG: 'aemsites',
  SITE: 'vitamix',
  EDGE_COMMERCE_API_BASE: 'https://api.test',
  EDGE_COMMERCE_API_CATALOG_TOKEN: 'cat-token',
  AIO_CLIENTID: 'id',
  AIO_CLIENTSECRET: 'secret',
  AIO_SCOPES: 'scopes',
  SYNC_STATUS_TOKEN: 'status-token',
  INVENTORY_SYNC_ENABLED: 'true',
};

const DA_URL = 'https://admin.da.live/source/aemsites/vitamix/us/en_us/products/config/inventory.json';
const PREVIEW_URL = 'https://admin.hlx.page/preview/aemsites/vitamix/main/us/en_us/products/config/inventory.json';
const OPS_URL = 'https://api.test/aemsites/sites/vitamix/operations-log';

const sheetRow = (SKU, Qty, extra = {}) => ({
  SKU, Title: SKU, Variant: '', Availability: 'InStock', 'Managed Stock': 'Yes', Qty, Market: '', ...extra,
});

let sheet;
let products;
let indexes;
let calls;
let responses;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

beforeEach(() => {
  store.clear();
  stateOps.length = 0;
  responses = { daPut: 200, preview: 200, ops: 404 };
  sheet = {
    total: 3,
    ':type': 'sheet',
    ':colWidths': [1, 2, 3],
    data: [
      sheetRow('001811', '2'),
      sheetRow('074592', '0', { Availability: 'OutOfStock' }),
      sheetRow('UNMANAGED', '', { 'Managed Stock': 'No' }),
    ],
  };
  products = {
    '/us/en_us/products/recon-standard': {
      path: '/us/en_us/products/recon-standard', sku: '001811', availability: 'InStock', custom: { managedStock: '1' },
    },
    '/us/en_us/products/recon-750': {
      path: '/us/en_us/products/recon-750',
      sku: 'P750',
      availability: 'InStock',
      variants: [{ sku: '074592', availability: 'InStock', custom: { managedStock: '1' } }],
    },
  };
  const usIndex = {
    columns: ['sku', 'urlKey', 'url', 'availability', 'parentSku', 'managedStock'],
    data: [
      { sku: '001811', urlKey: 'recon-standard', availability: 'InStock', managedStock: '1' },
      { sku: 'P750', urlKey: 'recon-750', availability: 'InStock' },
      { sku: '074592', parentSku: 'P750', availability: 'InStock', managedStock: '1' },
    ],
  };
  indexes = {
    'us/en_us': usIndex,
    'ca/en_us': { columns: usIndex.columns, data: [] },
    'ca/fr_ca': { columns: usIndex.columns, data: [] },
  };
  calls = [];

  jest.spyOn(global, 'fetch').mockImplementation(async (url, init = {}) => {
    const method = init.method || 'GET';
    const call = { url: String(url), method, init };
    calls.push(call);
    const u = String(url);
    if (u.startsWith('https://ims-na1.adobelogin.com')) return json({ access_token: 'ims-token', expires_in: 86400 });
    if (u === DA_URL && method === 'GET') return json(sheet);
    if (u === DA_URL && method === 'PUT') {
      call.sheet = JSON.parse(await init.body.get('data').text());
      return new Response('', { status: responses.daPut });
    }
    if (u === PREVIEW_URL) return new Response('', { status: responses.preview });
    if (u === OPS_URL) {
      call.event = JSON.parse(init.body);
      return new Response('', { status: responses.ops });
    }
    const idx = /aem\.network\/(.+)\/products\/index\.json/.exec(u);
    if (idx) return json(indexes[idx[1]]);
    const cat = /^https:\/\/api\.test\/aemsites\/sites\/vitamix\/catalog(.+)\.json$/.exec(u);
    if (cat) {
      const product = products[cat[1]];
      if (!product) return new Response('', { status: 404 });
      if (method === 'GET') return json(product, { headers: { ETag: '"e1"' } });
      call.product = JSON.parse(init.body);
      products[cat[1]] = call.product;
      return json({});
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  });
});

afterEach(() => jest.restoreAllMocks());

function queue(seq, deltas, orderIds = deltas.map((d) => d.orderId)) {
  store.set(`inventory:outbox:${seq}`, JSON.stringify({
    seq, activationId: 'a', createdAt: 'now', orderIds, deltas,
  }));
}

const writes = () => calls.filter((c) => c.method !== 'GET' && !c.url.startsWith('https://ims-na1'));

describe('prod gate', () => {
  test('disabled: no fetches and no state writes', async () => {
    const res = await run({ ...PARAMS, INVENTORY_SYNC_ENABLED: '' });
    expect(res.body).toEqual({ skipped: true, reason: 'disabled' });
    expect(calls).toEqual([]);
    expect(stateOps).toEqual([]);
  });

  test('scheduled invocation via main() also no-ops when disabled', async () => {
    const res = await main({ ...PARAMS, INVENTORY_SYNC_ENABLED: undefined });
    expect(res.body.skipped).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('run', () => {
  test('applies the backlog, writes the sheet, advances the cursor and flips products', async () => {
    store.set('inventory:cursor', '4');
    store.set('inventory:outbox:head', '7');
    queue(5, [{ sku: '001811', market: 'us', units: 1, orderId: 'o1' }]);
    // seq 6 missing → logged and skipped
    queue(7, [{ sku: '001811', market: 'us', units: 1, orderId: 'o2' }, { sku: '074592', market: 'ca', units: 1, orderId: 'o2' }]);

    const { body } = await run(PARAMS);

    expect(body.error).toBeUndefined();
    expect(body.missingSeqs).toEqual([6]);
    expect(body.appliedSeqs).toEqual([5, 7]);

    // sheet: 001811 2 → 0 + OutOfStock; 074592 already 0 → oversold; everything else preserved
    const put = calls.find((c) => c.url === DA_URL && c.method === 'PUT');
    expect(put.init.headers.Authorization).toBe('Bearer ims-token');
    const expectedSheet = JSON.parse(JSON.stringify(sheet));
    expectedSheet.data[0].Qty = '0';
    expectedSheet.data[0].Availability = 'OutOfStock';
    expect(put.sheet).toEqual(expectedSheet);
    expect(calls.some((c) => c.url === PREVIEW_URL && c.method === 'POST')).toBe(true);
    expect(body.previewed).toBe(true);

    // cursor advanced to head, applied entries deleted
    expect(store.get('inventory:cursor')).toBe('7');
    expect(store.has('inventory:outbox:5')).toBe(false);
    expect(store.has('inventory:outbox:7')).toBe(false);
    const cursorPut = stateOps.findIndex(([op, k]) => op === 'put' && k === 'inventory:cursor');
    const firstDelete = stateOps.findIndex(([op, k]) => op === 'delete' && k.startsWith('inventory:outbox:'));
    expect(cursorPut).toBeLessThan(firstDelete);

    // product check: both sold-out managed rows flipped via If-Match PUT
    expect(products['/us/en_us/products/recon-standard'].availability).toBe('OutOfStock');
    expect(products['/us/en_us/products/recon-standard'].custom.managedStock).toBe('1');
    expect(products['/us/en_us/products/recon-750'].variants[0].availability).toBe('OutOfStock');
    expect(products['/us/en_us/products/recon-750'].availability).toBe('InStock');
    const catalogPuts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/catalog/'));
    expect(catalogPuts).toHaveLength(2);
    catalogPuts.forEach((c) => expect(c.init.headers['If-Match']).toBe('"e1"'));

    // indexes fetched once per locale
    const indexFetches = calls.filter((c) => c.url.includes('/products/index.json'));
    expect(indexFetches).toHaveLength(3);

    // ops-log: 404 tolerated
    const events = calls.filter((c) => c.url === OPS_URL).map((c) => c.event);
    expect(events).toEqual([
      {
        action: 'inventory-oversold', sku: '074592', market: 'ca', available: 0, sold: 1, oversold: 1, orderIds: ['o2'],
      },
      {
        action: 'inventory-out-of-stock',
        sku: '001811',
        market: '',
        orderIds: ['o1', 'o2'],
        locales: ['us/en_us', 'ca/en_us', 'ca/fr_ca'],
        paths: ['/us/en_us/products/recon-standard'],
      },
    ]);
    expect(body.events.map((e) => e.result)).toEqual(['unsupported', 'unsupported']);

    // status saved, lock released
    const state = JSON.parse(store.get('inventory-sync:state'));
    expect(state).toMatchObject({
      status: 'idle', lastError: null, lastAppliedSeq: 7, appliedEntries: 2, sheetUpdates: 1, productsUpdated: 2,
    });
    expect(store.has('inventory-sync:lock')).toBe(false);
  });

  test('no backlog: no sheet write, product check still runs', async () => {
    const { body } = await run(PARAMS);
    expect(calls.some((c) => c.url === DA_URL && c.method === 'PUT')).toBe(false);
    expect(store.has('inventory:cursor')).toBe(false);
    // 074592 (Qty 0 + OutOfStock) self-heals
    expect(products['/us/en_us/products/recon-750'].variants[0].availability).toBe('OutOfStock');
    expect(body.products.map((p) => p.status)).toEqual(['updated']);
  });

  test('backlog with only unmanaged SKUs: cursor advances without a sheet write', async () => {
    store.set('inventory:outbox:head', '1');
    queue(1, [{ sku: 'UNMANAGED', market: 'us', units: 1, orderId: 'o1' }]);
    await run(PARAMS);
    expect(calls.some((c) => c.url === DA_URL && c.method === 'PUT')).toBe(false);
    expect(store.get('inventory:cursor')).toBe('1');
    expect(store.has('inventory:outbox:1')).toBe(false);
  });

  test('sheet PUT failure: cursor not advanced, entries kept, status error, lock released', async () => {
    responses.daPut = 500;
    store.set('inventory:outbox:head', '1');
    queue(1, [{ sku: '001811', market: 'us', units: 1, orderId: 'o1' }]);
    const { body } = await run(PARAMS);
    expect(body.error).toBe('failed to write sheet');
    expect(store.has('inventory:cursor')).toBe(false);
    expect(store.has('inventory:outbox:1')).toBe(true);
    expect(JSON.parse(store.get('inventory-sync:state')).status).toBe('error');
    expect(store.has('inventory-sync:lock')).toBe(false);
  });

  test('preview failure is not fatal', async () => {
    responses.preview = 401;
    store.set('inventory:outbox:head', '1');
    queue(1, [{ sku: '001811', market: 'us', units: 1, orderId: 'o1' }]);
    const { body } = await run(PARAMS);
    expect(body.error).toBeUndefined();
    expect(body.previewed).toBe(false);
    expect(store.get('inventory:cursor')).toBe('1');
  });

  test('ops-log success and other failures never fail the run', async () => {
    responses.ops = 500;
    store.set('inventory:outbox:head', '1');
    queue(1, [{ sku: '074592', market: 'us', units: 1, orderId: 'o1' }]);
    const { body } = await run(PARAMS);
    expect(body.error).toBeUndefined();
    expect(body.events.map((e) => e.result)).toEqual(['failed']);
  });

  test('held lock: skipped without touching anything', async () => {
    store.set('inventory-sync:lock', '{}');
    const { body } = await run(PARAMS);
    expect(body).toEqual({ skipped: true, reason: 'locked' });
    expect(calls).toEqual([]);
  });

  test('dryRun: reads everything, writes nothing (even when disabled)', async () => {
    store.set('inventory:outbox:head', '1');
    queue(1, [{ sku: '001811', market: 'us', units: 2, orderId: 'o1' }]);
    const snapshot = new Map(store);

    const { body } = await run({ ...PARAMS, INVENTORY_SYNC_ENABLED: '' }, { dryRun: true });

    expect(body.dryRun).toBe(true);
    expect(body.sheetChanges).toEqual([expect.objectContaining({ sku: '001811', before: 2, after: 0 })]);
    expect(body.products.map((p) => [p.path, p.status])).toEqual([
      ['/us/en_us/products/recon-standard', 'planned'],
      ['/us/en_us/products/recon-750', 'planned'],
    ]);
    expect(body.events.map((e) => e.result)).toEqual(['dryRun']);
    expect(writes()).toEqual([]);
    expect(stateOps).toEqual([]);
    expect(store).toEqual(snapshot);
  });
});

describe('HTTP handlers', () => {
  const headers = { authorization: 'Bearer status-token' };

  test('GET status requires the bearer token', async () => {
    expect((await main({ ...PARAMS, __ow_method: 'get', __ow_headers: {} })).statusCode).toBe(401);
    expect((await main({ ...PARAMS, __ow_method: 'get', __ow_headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  test('GET status reports cursor, head and backlog', async () => {
    store.set('inventory:cursor', '3');
    store.set('inventory:outbox:head', '8');
    const res = await main({ ...PARAMS, __ow_method: 'get', __ow_headers: headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      enabled: true, cursor: 3, head: 8, backlog: 5, status: 'idle', lastRun: null, lastError: null,
    });
  });

  test('POST { dryRun: true } runs a dry run (base64 body)', async () => {
    const res = await main({
      ...PARAMS,
      INVENTORY_SYNC_ENABLED: '',
      __ow_method: 'post',
      __ow_headers: headers,
      __ow_body: Buffer.from(JSON.stringify({ dryRun: true })).toString('base64'),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).dryRun).toBe(true);
    expect(writes()).toEqual([]);
    expect(stateOps).toEqual([]);
  });

  test('POST without dryRun respects the prod gate', async () => {
    const res = await main({
      ...PARAMS, INVENTORY_SYNC_ENABLED: '', __ow_method: 'post', __ow_headers: headers,
    });
    expect(JSON.parse(res.body)).toEqual({ skipped: true, reason: 'disabled' });
    expect(calls).toEqual([]);
  });

  test('other methods → 405', async () => {
    expect((await main({ ...PARAMS, __ow_method: 'delete', __ow_headers: headers })).statusCode).toBe(405);
  });
});
