/**
 * Managed-inventory pieces of ebs-sync: sold-unit collection per accepted order
 * and the outbox write (entry first, then head).
 */

import {
  describe, test, expect, jest, beforeEach,
} from '@jest/globals';

const store = new Map();
const ops = [];
jest.unstable_mockModule('@adobe/aio-lib-state', () => ({
  init: async () => ({
    get: async (key) => (store.has(key) ? { value: store.get(key) } : null),
    put: async (key, value) => { ops.push(['put', key]); store.set(key, value); },
    delete: async (key) => { ops.push(['delete', key]); store.delete(key); },
  }),
}));

const { collectOrderDeltas, isInventorySyncEnabled } = await import('../../src/actions/ebs-sync/inventory.js');
const { writeInventoryOutbox } = await import('../../src/actions/ebs-sync/state.js');

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

describe('writeInventoryOutbox', () => {
  beforeEach(() => {
    store.clear();
    ops.length = 0;
  });

  const payload = { activationId: 'act-1', orderIds: ['o1'], deltas: [{ sku: 'A', market: 'us', units: 1, orderId: 'o1' }] };

  test('first entry: writes inventory:outbox:1 then head', async () => {
    const seq = await writeInventoryOutbox(payload);
    expect(seq).toBe(1);
    expect(ops).toEqual([['put', 'inventory:outbox:1'], ['put', 'inventory:outbox:head']]);
    const entry = JSON.parse(store.get('inventory:outbox:1'));
    expect(entry).toMatchObject({ seq: 1, activationId: 'act-1', orderIds: ['o1'], deltas: payload.deltas });
    expect(entry.createdAt).toBeTruthy();
    expect(store.get('inventory:outbox:head')).toBe('1');
  });

  test('appends after the current head', async () => {
    store.set('inventory:outbox:head', '41');
    expect(await writeInventoryOutbox(payload)).toBe(42);
    expect(store.get('inventory:outbox:head')).toBe('42');
  });

  test('never overwrites an orphaned entry past head (earlier head write failed)', async () => {
    store.set('inventory:outbox:head', '5');
    store.set('inventory:outbox:6', JSON.stringify({ seq: 6, orphan: true }));
    expect(await writeInventoryOutbox(payload)).toBe(7);
    expect(JSON.parse(store.get('inventory:outbox:6')).orphan).toBe(true);
    expect(store.get('inventory:outbox:head')).toBe('7');
  });
});
