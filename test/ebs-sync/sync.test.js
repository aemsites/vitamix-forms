/**
 * Unit tests for the ebs-sync orchestration around custom.syncedAt updates:
 * the patch is retried, and if it keeps failing the order goes into
 * state.pendingCustomUpdates so it is never resent to EBS.
 */

import {
  describe, test, expect, jest, beforeEach, afterEach,
} from '@jest/globals';

const ORDER_ID = 'order-1';

let storedState;
const callOrder = [];
const releaseLock = jest.fn(async () => { callOrder.push('releaseLock'); });
const allocateInventoryOutboxSeq = jest.fn(async () => 7);
const putInventoryOutboxEntry = jest.fn(async () => { callOrder.push('putEntry'); });
const publishInventoryOutboxHead = jest.fn(async () => { callOrder.push('publishHead'); });
const saveState = jest.fn(async (updates) => {
  storedState = { ...storedState, ...updates };
  return storedState;
});

jest.unstable_mockModule('../../src/actions/ebs-sync/state.js', () => ({
  loadState: jest.fn(async () => ({
    ...storedState,
    pendingCustomUpdates: { ...(storedState.pendingCustomUpdates || {}) },
  })),
  saveState,
  acquireLock: jest.fn(async () => true),
  releaseLock,
  allocateInventoryOutboxSeq,
  putInventoryOutboxEntry,
  publishInventoryOutboxHead,
  inventoryOutboxEntryExists: jest.fn(async () => false),
}));

const getJournalEntries = jest.fn();
const getOrderJournalEntries = jest.fn(async () => [{ event: 'payment_completed' }]);
const getOrder = jest.fn(async (_p, id) => ({ id, state: 'payment_completed', custom: {} }));
const updateOrderCustom = jest.fn();
const logOrderSync = jest.fn(async () => {});

jest.unstable_mockModule('../../src/actions/ebs-sync/commerce.js', () => ({
  getJournalEntries, getOrderJournalEntries, getOrder, updateOrderCustom, logOrderSync,
}));

const syncOrderToEbs = jest.fn(async () => ({ status: 200, xml: '<xml/>' }));
jest.unstable_mockModule('../../src/actions/ebs-sync/ebs.js', () => ({
  syncOrderToEbs,
  isRetriableError: () => false,
  stripBundleSuffix: (sku) => String(sku || '').replace(/-VB$/, ''),
}));

/** Captured log lines (Core.Logger is mocked so tests can assert on logs). */
const logLines = [];
const capture = (level) => (...args) => logLines.push(`${level}: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
jest.unstable_mockModule('@adobe/aio-sdk', () => ({
  Core: {
    Logger: () => ({
      debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error'),
    }),
  },
}));

const { run } = await import('../../src/actions/ebs-sync/sync.js');

async function runSync(extra = {}) {
  const p = run({ LOG_LEVEL: 'error', ...extra });
  await jest.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  callOrder.length = 0;
  logLines.length = 0;
  storedState = { since: null, pendingCustomUpdates: {} };
  getJournalEntries.mockResolvedValue({
    entries: [{ orderId: ORDER_ID, event: 'payment_completed' }],
    until: '2026-01-01T00:00:00.000Z',
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ebs-sync custom update handling', () => {
  test('retries the custom update and succeeds without marking pending', async () => {
    updateOrderCustom
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});

    const { body } = await runSync();

    expect(syncOrderToEbs).toHaveBeenCalledTimes(1);
    expect(updateOrderCustom).toHaveBeenCalledTimes(2);
    expect(body.processedOrders).toEqual([ORDER_ID]);
    expect(body.pendingCustomUpdates).toEqual([]);
    expect(storedState.pendingCustomUpdates).toEqual({});
  });

  test('stores pending update after 3 failures and does not resend to EBS next run', async () => {
    updateOrderCustom.mockRejectedValue(new Error('patch down'));

    const first = await runSync();
    expect(syncOrderToEbs).toHaveBeenCalledTimes(1);
    expect(updateOrderCustom).toHaveBeenCalledTimes(3);
    expect(first.body.pendingCustomUpdates).toEqual([ORDER_ID]);
    expect(first.body.halted).toBe(false);
    const pending = storedState.pendingCustomUpdates[ORDER_ID];
    expect(pending).toMatchObject({ error: 'patch down' });
    expect(pending.syncedAt).toBeTruthy();

    // Next run: patch still failing, order reappears in the journal — must not resend.
    jest.clearAllMocks();
    await runSync();
    expect(syncOrderToEbs).not.toHaveBeenCalled();
    expect(updateOrderCustom).toHaveBeenCalledTimes(3);
    expect(storedState.pendingCustomUpdates[ORDER_ID]).toBeTruthy();

    // Next run: patch recovers, pending entry cleared with the original syncedAt.
    jest.clearAllMocks();
    updateOrderCustom.mockResolvedValue({});
    getOrder.mockResolvedValueOnce({
      id: ORDER_ID, state: 'payment_completed', custom: { syncedAt: pending.syncedAt },
    });
    await runSync();
    expect(updateOrderCustom).toHaveBeenCalledWith(
      expect.anything(),
      ORDER_ID,
      { syncedAt: pending.syncedAt, syncError: null },
    );
    expect(syncOrderToEbs).not.toHaveBeenCalled();
    expect(storedState.pendingCustomUpdates).toEqual({});
  });
});

describe('ebs-sync managed inventory outbox', () => {
  const ENABLED = { INVENTORY_SYNC_ENABLED: 'true' };

  function orderWithItems(id, extra = {}) {
    return {
      id,
      state: 'payment_completed',
      country: 'US',
      custom: {},
      items: [
        { sku: '001811', quantity: 2, path: '/us/en_us/products/x' },
        {
          sku: 'VBND2SIB',
          quantity: 1,
          bundleItems: [{ sku: '073511-VB', quantity: 1 }, { sku: '061724-04-VB', quantity: 1 }],
        },
        { sku: '001314', quantity: 1, custom: { linkedTo: '001811' } },
      ],
      ...extra,
    };
  }

  test('queues deltas only after syncedAt is patched (never inside the EBS-resend window)', async () => {
    updateOrderCustom.mockResolvedValue({});
    getOrder.mockImplementation(async (_p, id) => orderWithItems(id));

    const { body } = await runSync(ENABLED);

    expect(body.inventoryOutboxSeqs).toEqual([7]);
    expect(updateOrderCustom).toHaveBeenCalledWith(expect.anything(), ORDER_ID, expect.objectContaining({ syncedAt: expect.any(String) }));
    // EBS accept → syncedAt patch → outbox write; first outbox state call after the patch
    expect(syncOrderToEbs.mock.invocationCallOrder[0])
      .toBeLessThan(updateOrderCustom.mock.invocationCallOrder[0]);
    expect(updateOrderCustom.mock.invocationCallOrder[0])
      .toBeLessThan(allocateInventoryOutboxSeq.mock.invocationCallOrder[0]);
    expect(putInventoryOutboxEntry).toHaveBeenCalledTimes(1);
    const payload = putInventoryOutboxEntry.mock.calls[0][1];
    expect(payload.orderIds).toEqual([ORDER_ID]);
    expect(payload.deltas).toEqual([
      { sku: '001811', market: 'us', units: 2, orderId: ORDER_ID },
      { sku: '073511', market: 'us', units: 1, orderId: ORDER_ID },
      { sku: '061724-04', market: 'us', units: 1, orderId: ORDER_ID },
    ]);
    expect(callOrder).toEqual(['putEntry', 'publishHead', 'releaseLock']);
  });

  test('only accepted orders are queued (rejected / cancelled / already-synced are not)', async () => {
    updateOrderCustom.mockResolvedValue({});
    getJournalEntries.mockResolvedValue({
      entries: [
        { orderId: 'ok-1', event: 'payment_completed' },
        { orderId: 'cancelled', event: 'payment_cancelled' },
        { orderId: 'synced', event: 'payment_completed' },
        { orderId: 'ok-2', event: 'payment_completed' },
      ],
      until: '2026-01-01T00:00:00.000Z',
    });
    getOrder.mockImplementation(async (_p, id) => {
      if (id === 'cancelled') return orderWithItems(id, { state: 'payment_cancelled' });
      if (id === 'synced') return orderWithItems(id, { custom: { syncedAt: 'x' } });
      return orderWithItems(id);
    });

    await runSync(ENABLED);

    // one entry per accepted order
    expect(putInventoryOutboxEntry.mock.calls.map((c) => c[1].orderIds)).toEqual([['ok-1'], ['ok-2']]);
    putInventoryOutboxEntry.mock.calls.forEach(([, entry]) => {
      expect(new Set(entry.deltas.map((d) => d.orderId))).toEqual(new Set(entry.orderIds));
    });
  });

  test('a run killed mid-order (no finally) has already queued earlier orders, and logged them', async () => {
    updateOrderCustom.mockResolvedValue({});
    getJournalEntries.mockResolvedValue({
      entries: [
        { orderId: 'ok-1', event: 'payment_completed' },
        { orderId: 'hangs', event: 'payment_completed' },
      ],
      until: '2026-01-01T00:00:00.000Z',
    });
    getOrder.mockImplementation(async (_p, id) => orderWithItems(id));
    syncOrderToEbs.mockImplementation(async (_ctx, _p, order) => {
      if (order.id === 'hangs') return new Promise(() => {}); // Runtime kills the action here
      return { status: 200, xml: '<xml/>' };
    });

    run({ LOG_LEVEL: 'info', ...ENABLED }); // never settles
    await jest.runAllTimersAsync();

    expect(putInventoryOutboxEntry.mock.calls.map((c) => c[1].orderIds)).toEqual([['ok-1']]);
    expect(publishInventoryOutboxHead).toHaveBeenCalledTimes(1);
    expect(releaseLock).not.toHaveBeenCalled(); // finally never ran
    expect(logLines.some((l) => l.startsWith('info:') && l.includes('Inventory deltas for ok-1') && l.includes('"sku":"001811"'))).toBe(true);
    syncOrderToEbs.mockImplementation(async () => ({ status: 200, xml: '<xml/>' }));
  });

  test('writes the outbox on a halted run for orders accepted before the halt', async () => {
    updateOrderCustom.mockResolvedValue({});
    getJournalEntries.mockResolvedValue({
      entries: [
        { orderId: 'ok-1', event: 'payment_completed' },
        { orderId: 'bad', event: 'payment_completed' },
        { orderId: 'never', event: 'payment_completed' },
      ],
      until: '2026-01-01T00:00:00.000Z',
    });
    getOrder.mockImplementation(async (_p, id) => orderWithItems(id));
    syncOrderToEbs.mockImplementation(async (_ctx, _p, order) => {
      if (order.id === 'bad') throw new Error('EBS rejected order');
      return { status: 200, xml: '<xml/>' };
    });

    const { body } = await runSync(ENABLED);

    expect(body.halted).toBe(true);
    expect(putInventoryOutboxEntry).toHaveBeenCalledTimes(1);
    expect(putInventoryOutboxEntry.mock.calls[0][1].orderIds).toEqual(['ok-1']);
    syncOrderToEbs.mockImplementation(async () => ({ status: 200, xml: '<xml/>' }));
  });

  test('writes the outbox when the run throws after accepting orders', async () => {
    updateOrderCustom.mockResolvedValue({});
    getOrder.mockImplementation(async (_p, id) => orderWithItems(id));
    saveState.mockRejectedValueOnce(new Error('state down'));

    const p = run({ LOG_LEVEL: 'error', ...ENABLED }).catch((err) => err);
    await jest.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('state down');
    expect(putInventoryOutboxEntry).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['putEntry', 'publishHead', 'releaseLock']);
  });

  test('does not write the outbox when disabled', async () => {
    updateOrderCustom.mockResolvedValue({});
    getOrder.mockImplementation(async (_p, id) => orderWithItems(id));

    const { body } = await runSync({ INVENTORY_SYNC_ENABLED: '' });

    expect(body.processedOrders).toEqual([ORDER_ID]);
    expect(putInventoryOutboxEntry).not.toHaveBeenCalled();
    expect(body.inventoryOutboxSeqs).toBeUndefined();
  });

  test('does not write the outbox when no orders were accepted', async () => {
    getJournalEntries.mockResolvedValue({ entries: [], until: '2026-01-01T00:00:00.000Z' });
    await runSync(ENABLED);
    expect(putInventoryOutboxEntry).not.toHaveBeenCalled();
  });

  test('syncedAt patch fails: pending update is persisted first, then the order is still queued', async () => {
    updateOrderCustom.mockRejectedValue(new Error('patch down'));
    getOrder.mockImplementation(async (_p, id) => orderWithItems(id));

    const { body } = await runSync(ENABLED);

    expect(body.pendingCustomUpdates).toEqual([ORDER_ID]);
    expect(body.inventoryOutboxSeqs).toEqual([7]);
    const pendingSave = saveState.mock.calls.findIndex(([u]) => u.pendingCustomUpdates?.[ORDER_ID]);
    expect(pendingSave).toBeGreaterThanOrEqual(0);
    expect(saveState.mock.invocationCallOrder[pendingSave])
      .toBeLessThan(allocateInventoryOutboxSeq.mock.invocationCallOrder[0]);
    updateOrderCustom.mockReset();
  });

  test('outbox write failure is retried, then logged without failing the run', async () => {
    updateOrderCustom.mockResolvedValue({});
    getOrder.mockImplementation(async (_p, id) => orderWithItems(id));
    putInventoryOutboxEntry.mockRejectedValue(new Error('state down'));

    const { body } = await runSync(ENABLED);

    expect(putInventoryOutboxEntry).toHaveBeenCalledTimes(3);
    expect(allocateInventoryOutboxSeq).toHaveBeenCalledTimes(1);
    expect(publishInventoryOutboxHead).not.toHaveBeenCalled();
    expect(body.inventoryOutboxSeqs).toEqual([null]);
    // nothing was stored → only then tell ops to apply manually
    expect(logLines.filter((l) => l.startsWith('error:') && l.includes('entry not stored, apply manually'))).toHaveLength(1);
    expect(body.processedOrders).toEqual([ORDER_ID]);
    expect(releaseLock).toHaveBeenCalled();
    putInventoryOutboxEntry.mockImplementation(async () => { callOrder.push('putEntry'); });
  });

  test('head write failure: retry reuses the seq and does not rewrite the entry', async () => {
    updateOrderCustom.mockResolvedValue({});
    getOrder.mockImplementation(async (_p, id) => orderWithItems(id));
    publishInventoryOutboxHead.mockRejectedValueOnce(new Error('head put failed'));

    const { body } = await runSync(ENABLED);

    expect(body.inventoryOutboxSeqs).toEqual([7]);
    expect(allocateInventoryOutboxSeq).toHaveBeenCalledTimes(1);
    expect(putInventoryOutboxEntry).toHaveBeenCalledTimes(1);
    expect(publishInventoryOutboxHead.mock.calls).toEqual([[7], [7]]);
  });

  test('entry write failure: retry rewrites the same seq', async () => {
    updateOrderCustom.mockResolvedValue({});
    getOrder.mockImplementation(async (_p, id) => orderWithItems(id));
    putInventoryOutboxEntry.mockRejectedValueOnce(new Error('ambiguous'));

    await runSync(ENABLED);

    expect(allocateInventoryOutboxSeq).toHaveBeenCalledTimes(1);
    expect(putInventoryOutboxEntry.mock.calls.map((c) => c[0])).toEqual([7, 7]);
    expect(putInventoryOutboxEntry.mock.calls[0][1]).toBe(putInventoryOutboxEntry.mock.calls[1][1]);
    expect(publishInventoryOutboxHead.mock.calls).toEqual([[7]]);
  });
});
