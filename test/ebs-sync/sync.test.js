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
  releaseLock: jest.fn(async () => {}),
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
}));

const { run } = await import('../../src/actions/ebs-sync/sync.js');

async function runSync() {
  const p = run({ LOG_LEVEL: 'error' });
  await jest.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
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
