/**
 * Managed-inventory pieces of ebs-sync: sold-unit collection per accepted order
 * and the outbox write (entry first, then head).
 */

import {
  describe, test, expect, jest, beforeEach, afterEach,
} from '@jest/globals';

const store = new Map();
const ops = [];
/** Keys whose next put() should write the value and then throw (ambiguous failure). */
const failAfterPut = new Set();
jest.unstable_mockModule('@adobe/aio-lib-state', () => ({
  init: async () => ({
    get: async (key) => (store.has(key) ? { value: store.get(key) } : null),
    put: async (key, value) => {
      ops.push(['put', key]);
      store.set(key, value);
      if (failAfterPut.delete(key)) throw new Error(`put ${key} failed`);
    },
    delete: async (key) => { ops.push(['delete', key]); store.delete(key); },
  }),
}));

const { collectOrderDeltas, isInventorySyncEnabled } = await import('../../src/actions/ebs-sync/inventory.js');
const {
  allocateInventoryOutboxSeq, putInventoryOutboxEntry, publishInventoryOutboxHead,
} = await import('../../src/actions/ebs-sync/state.js');
const { queueInventoryDeltas } = await import('../../src/actions/ebs-sync/sync.js');
const { mergeDeltas, applyDeltas } = await import('../../src/actions/inventory-sync/sheet.js');

describe('collectOrderDeltas', () => {
  test('simple items, bundle components (-VB stripped), warranty lines skipped', () => {
    const order = {
      id: 'o1',
      country: 'ca',
      items: [
        {
          sku: '001372-1093-VB',
          path: '/ca/en_ca/products/5200-legacy-bundle',
          quantity: 2,
          bundleItems: [
            { sku: '061724-04-VB', quantity: 2 },
            { sku: '001372-1093-VB', quantity: 2 },
          ],
        },
        { sku: '001314', quantity: 1, custom: { linkedTo: '001372-1093-VB' } },
        { sku: ' 062327 ', quantity: 3 },
      ],
    };
    expect(collectOrderDeltas(order)).toEqual([
      { sku: '061724-04', market: 'ca', units: 2, orderId: 'o1' },
      { sku: '001372-1093', market: 'ca', units: 2, orderId: 'o1' },
      { sku: '062327', market: 'ca', units: 3, orderId: 'o1' },
    ]);
  });

  test('market falls back to the item path locale prefix', () => {
    const order = {
      id: 'o2',
      items: [
        { sku: 'A', quantity: 1, path: '/ca/fr_ca/products/a' },
        { sku: 'B', quantity: 1, path: '/us/en_us/products/b' },
        { sku: 'C', quantity: 1 },
      ],
    };
    expect(collectOrderDeltas(order).map((d) => d.market)).toEqual(['ca', 'us', '']);
  });

  test('skips items with no sku or a non-positive quantity', () => {
    const order = { id: 'o3', country: 'US', items: [{ sku: '', quantity: 1 }, { sku: 'X', quantity: 0 }] };
    expect(collectOrderDeltas(order)).toEqual([]);
  });

  test('isInventorySyncEnabled only for "true"', () => {
    expect(isInventorySyncEnabled({ INVENTORY_SYNC_ENABLED: 'true' })).toBe(true);
    expect(isInventorySyncEnabled({ INVENTORY_SYNC_ENABLED: 'TRUE ' })).toBe(true);
    expect(isInventorySyncEnabled({ INVENTORY_SYNC_ENABLED: '' })).toBe(false);
    expect(isInventorySyncEnabled({})).toBe(false);
    expect(isInventorySyncEnabled({ INVENTORY_SYNC_ENABLED: '1' })).toBe(false);
  });
});

describe('inventory outbox state', () => {
  beforeEach(() => {
    store.clear();
    ops.length = 0;
    failAfterPut.clear();
  });

  const entry = {
    activationId: 'act-1', createdAt: 't', orderIds: ['o1'], deltas: [{ sku: 'A', market: 'us', units: 1, orderId: 'o1' }],
  };

  test('first entry: allocates 1, writes the entry, then head', async () => {
    const seq = await allocateInventoryOutboxSeq();
    expect(seq).toBe(1);
    await putInventoryOutboxEntry(seq, entry);
    await publishInventoryOutboxHead(seq);
    expect(ops).toEqual([['put', 'inventory:outbox:1'], ['put', 'inventory:outbox:head']]);
    expect(JSON.parse(store.get('inventory:outbox:1'))).toEqual({ seq: 1, ...entry });
    expect(store.get('inventory:outbox:head')).toBe('1');
  });

  test('allocates after the current head', async () => {
    store.set('inventory:outbox:head', '41');
    expect(await allocateInventoryOutboxSeq()).toBe(42);
  });

  test('never reuses an orphaned entry from an earlier run past head', async () => {
    store.set('inventory:outbox:head', '5');
    store.set('inventory:outbox:6', JSON.stringify({ seq: 6, orphan: true }));
    expect(await allocateInventoryOutboxSeq()).toBe(7);
    expect(JSON.parse(store.get('inventory:outbox:6')).orphan).toBe(true);
  });
});

describe('queueInventoryDeltas retries are idempotent', () => {
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const order = { orderIds: ['o1'], deltas: [{ sku: 'A', market: 'us', units: 1, orderId: 'o1' }] };

  beforeEach(() => {
    jest.useFakeTimers();
    store.clear();
    ops.length = 0;
    failAfterPut.clear();
  });
  afterEach(() => jest.useRealTimers());

  async function queue() {
    const p = queueInventoryDeltas(order, log);
    await jest.runAllTimersAsync();
    return p;
  }

  function consume(qty) {
    const head = Number(store.get('inventory:outbox:head'));
    const entries = [];
    for (let seq = 1; seq <= head; seq++) {
      if (store.has(`inventory:outbox:${seq}`)) entries.push(JSON.parse(store.get(`inventory:outbox:${seq}`)));
    }
    const sheet = {
      data: [{
        SKU: 'A', Availability: 'InStock', 'Managed Stock': 'Yes', Qty: String(qty), Market: '',
      }],
    };
    applyDeltas(sheet, mergeDeltas(entries));
    return sheet.data[0];
  }

  test('entry written, head write fails, retry succeeds → one entry, single decrement', async () => {
    failAfterPut.add('inventory:outbox:head');
    expect(await queue()).toBe(1);
    expect([...store.keys()].filter((k) => /^inventory:outbox:\d+$/.test(k))).toEqual(['inventory:outbox:1']);
    expect(store.get('inventory:outbox:head')).toBe('1');
    expect(consume(2)).toMatchObject({ Qty: '1', Availability: 'InStock' });
  });

  test('head write that persisted but threw → retry does not publish a second entry', async () => {
    failAfterPut.add('inventory:outbox:head'); // value is stored, then the put throws
    await queue();
    expect(ops.filter(([, k]) => k === 'inventory:outbox:1')).toHaveLength(1);
    expect(store.has('inventory:outbox:2')).toBe(false);
  });

  test('entry write that persisted but threw → rewritten in place at the same seq', async () => {
    failAfterPut.add('inventory:outbox:1');
    expect(await queue()).toBe(1);
    expect(store.has('inventory:outbox:2')).toBe(false);
    expect(store.get('inventory:outbox:head')).toBe('1');
    expect(consume(2).Qty).toBe('1');
  });

  test('an orphan from an earlier run is still preserved and published', async () => {
    store.set('inventory:outbox:head', '3');
    store.set('inventory:outbox:4', JSON.stringify({ seq: 4, orderIds: ['old'], deltas: [{ sku: 'A', market: 'us', units: 1, orderId: 'old' }] }));
    expect(await queue()).toBe(5);
    expect(JSON.parse(store.get('inventory:outbox:4')).orderIds).toEqual(['old']);
    expect(store.get('inventory:outbox:head')).toBe('5');
  });
});
