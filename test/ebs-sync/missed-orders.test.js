/**
 * Missed-order protection in ebs-sync, against an in-memory commerce API with
 * synthetic orders (no EBS, no network):
 *   - 60-minute journal look-back for late journal buckets
 *   - cursor handling on deadline / max-retries / manual backfills
 *   - journal-independent reconciliation with operations-log alerts
 *   - locks and already-synced orders (never sent to EBS twice)
 */

import {
  describe, test, expect, jest, beforeEach, afterEach,
} from '@jest/globals';
import { createFakeCommerceApi, createFakeState, PARAMS } from './fake-commerce-api.js';

const fakeState = createFakeState();
jest.unstable_mockModule('../../src/actions/ebs-sync/state.js', () => fakeState.module);

/** Orders "sent to EBS" (the EBS call is mocked; nothing leaves the test). */
const sent = [];
const ebsHooks = {
  onSend: null, failIds: new Set(), attempts: [],
};
jest.unstable_mockModule('../../src/actions/ebs-sync/ebs.js', () => ({
  syncOrderToEbs: jest.fn(async (_ctx, _params, order, journal, opts) => {
    ebsHooks.attempts.push({ id: order.id, at: Date.now(), signal: opts?.signal });
    if (!journal.some((e) => e.event === 'payment_completed')) {
      throw new Error(`Order ${order.id}: cannot build payment snapshot`);
    }
    await ebsHooks.onSend?.(order);
    if (ebsHooks.failIds.has(order.id)) {
      const err = new Error('EBS rejected order: synthetic');
      err.ebsStatus = 200;
      throw err;
    }
    sent.push(order.id);
    return { status: 200, xml: '<xml/>' };
  }),
  isRetriableError: (err) => Boolean(err?.retriable),
  stripBundleSuffix: (sku) => String(sku || '').replace(/-VB$/, ''),
}));

jest.unstable_mockModule('@adobe/aio-sdk', () => ({
  Core: {
    Logger: () => ({
      debug() {}, info() {}, warn() {}, error() {},
    }),
  },
}));

const { main } = await import('../../src/actions/ebs-sync/index.js');
const {
  terminalOrders, nextCursor, DEADLINE_MS, ACTION_TIMEOUT_MS, EBS_ATTEMPT_TIMEOUT_MS, AFTER_SEND_RESERVE_MS,
} = await import('../../src/actions/ebs-sync/sync.js');
const {
  RECONCILE_MAX_ORDERS, RECONCILE_INTERVAL_MS, RECONCILE_MAX_AUTO_SYNC_AGE_MS, RECONCILE_MIN_AGE_MS,
} = await import('../../src/actions/ebs-sync/reconcile.js');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let api;

function at(ms) {
  jest.setSystemTime(ms);
}

/** Reconciliation ships disabled; most tests here exercise it switched on. */
const ON = { EBS_RECONCILE_ENABLED: 'true' };

async function scheduledRun(extra = ON) {
  return (await main({ ...PARAMS, ...extra })).body;
}

/** Scheduled runs every 5 minutes in [from, to]. Returns the bodies. */
async function runEvery5Min(from, to, extra = ON) {
  const bodies = [];
  for (let t = from; t <= to; t += 5 * MIN) {
    at(t);
    // eslint-disable-next-line no-await-in-loop
    bodies.push(await scheduledRun(extra));
  }
  return bodies;
}

async function manualRun(body) {
  const res = await main({
    ...PARAMS,
    ...ON,
    SYNC_STATUS_TOKEN: 'secret',
    __ow_method: 'post',
    __ow_headers: { authorization: 'Bearer secret' },
    __ow_body: Buffer.from(JSON.stringify(body)).toString('base64'),
  });
  return res.statusCode ? { statusCode: res.statusCode, body: JSON.parse(res.body) } : res;
}

const alerts = (reason) => api.opsLog.filter((e) => e.reason === reason).map((e) => e.id);
const persisted = () => fakeState.store.state;

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  api = createFakeCommerceApi();
  global.fetch = api.fetch;
  fakeState.store.state = null;
  fakeState.store.lock = false;
  sent.length = 0;
  ebsHooks.onSend = null;
  ebsHooks.failIds = new Set();
  ebsHooks.attempts = [];
  fakeState.store.outbox = [];
  fakeState.store.seq = 0;
});

afterEach(() => {
  jest.useRealTimers();
  delete global.fetch;
});

describe('reconciliation switch', () => {
  test('is off unless EBS_RECONCILE_ENABLED is "true": no listing, no reports', async () => {
    api.addOrder({ id: 'synth-lost-off', completedAt: T0 - 2 * 60 * MIN, visibleAt: Infinity });
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    for (const extra of [{}, { EBS_RECONCILE_ENABLED: '' }, { EBS_RECONCILE_ENABLED: 'false' }]) {
      // eslint-disable-next-line no-await-in-loop
      const body = await scheduledRun(extra);
      expect(body.reconcile).toEqual({ skipped: 'disabled' });
    }
    expect(api.requests.some((r) => r.path === '/orders')).toBe(false);
    expect(api.opsLog).toEqual([]);
    expect(persisted().reconcile).toBeUndefined();
  });

  test('journal-pass fixes work with reconciliation off', async () => {
    api.addOrder({ id: 'synth-late-off', completedAt: T0 + 14 * MIN, visibleAt: T0 + 32 * MIN });
    for (let t = T0; t <= T0 + 60 * MIN; t += 5 * MIN) {
      at(t);
      // eslint-disable-next-line no-await-in-loop
      await scheduledRun({});
    }
    expect(sent).toEqual(['synth-late-off']);
  });
});

describe('delayed journal buckets', () => {
  test('an entry that lands 18 minutes late is still found by the 60-minute look-back', async () => {
    // Same shape as the incident: completed at :14, its bucket landed at :32.
    // With a 15-minute look-back the :35 run would start at :15 and miss it.
    api.addOrder({ id: 'synth-late-18', completedAt: T0 + 14 * MIN, visibleAt: T0 + 32 * MIN });

    await runEvery5Min(T0, T0 + 60 * MIN);

    expect(sent).toEqual(['synth-late-18']);
    expect(api.orders.get('synth-late-18').custom.syncedAt).toBeTruthy();
    expect(api.opsLog.filter((e) => e.source === 'ebs-sync-reconcile')).toEqual([]);
  });

  test('the journal query starts 60 minutes before the cursor', async () => {
    fakeState.store.state = { since: iso(T0) };
    at(T0 + 5 * MIN);
    await scheduledRun();
    const q = api.requests.find((r) => r.path === '/orders/journal' && !r.query.orderId).query;
    expect(q.since).toBe(iso(T0 - 60 * MIN));
    expect(q.until).toBe(iso(T0 + 5 * MIN));
  });

  test('an entry later than the look-back is missed by the journal pass, then synced by reconciliation', async () => {
    api.addOrder({ id: 'synth-late-90', completedAt: T0 + 2 * MIN, visibleAt: T0 + 92 * MIN });

    // Reconciliation leaves orders younger than the look-back + 10 min to the
    // journal pass, so there's no early (false) report while it's in flight.
    await runEvery5Min(T0, T0 + 90 * MIN);
    expect(sent).toEqual([]);
    expect(api.opsLog).toEqual([]);

    // Lands at +92: the journal pass has moved on (cursor - 60 min > +2 min).
    await runEvery5Min(T0 + 95 * MIN, T0 + 110 * MIN);
    expect(sent).toEqual([]);

    // Next hourly pass (+120) syncs it and reports it.
    await runEvery5Min(T0 + 115 * MIN, T0 + 180 * MIN);
    expect(sent).toEqual(['synth-late-90']);
    expect(api.opsLog.filter((e) => e.source).map((e) => e.reason)).toEqual(['reconciled']);
    expect(persisted().reconcile.alerted).toEqual({});
  });
});

describe('missing journal entries', () => {
  test('never-journaled order is reported once and never sent', async () => {
    api.addOrder({ id: 'synth-lost', completedAt: T0 + 2 * MIN, visibleAt: Infinity });

    await runEvery5Min(T0, T0 + 5 * 60 * MIN);

    expect(sent).toEqual([]);
    expect(alerts('journal_missing_payment')).toEqual(['synth-lost']);
    const [alert] = api.opsLog.filter((e) => e.reason === 'journal_missing_payment');
    expect(alert).toMatchObject({ action: 'order-sync', source: 'ebs-sync-reconcile', error: expect.any(String) });
    // no syncError, so it stays a candidate and is sent once the entry is replayed
    expect(api.orders.get('synth-lost').custom.syncError).toBeUndefined();

    api.setVisibleAt('synth-lost', T0 + 5 * 60 * MIN);
    await runEvery5Min(T0 + 5 * 60 * MIN + 5 * MIN, T0 + 6 * 60 * MIN + 5 * MIN);
    expect(sent).toEqual(['synth-lost']);
  });

  test('order completed longer ago than the auto-sync limit is reported, not sent', async () => {
    const completedAt = T0 - RECONCILE_MAX_AUTO_SYNC_AGE_MS - 30 * MIN;
    api.addOrder({ id: 'synth-stale', completedAt, visibleAt: completedAt });
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };

    await runEvery5Min(T0, T0 + 2 * 60 * MIN);

    expect(sent).toEqual([]);
    expect(alerts('too_old_for_auto_sync')).toEqual(['synth-stale']);
  });

  test('orders with syncError are left to the journal pass / people, not reconciled', async () => {
    api.addOrder({
      id: 'synth-failed', completedAt: T0 - 2 * 60 * MIN, visibleAt: Infinity, custom: { syncError: 'ebs_rejected' },
    });
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    await scheduledRun();
    expect(sent).toEqual([]);
    expect(api.opsLog).toEqual([]);
  });

  test('journal_fetch_failed is not an EBS failure, so reconciliation retries it', async () => {
    const completedAt = T0 - 2 * 60 * MIN;
    api.addOrder({ id: 'synth-jff', completedAt, custom: { syncError: 'journal_fetch_failed' } });
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    await scheduledRun();
    expect(sent).toEqual(['synth-jff']);
    expect(api.orders.get('synth-jff').custom).toMatchObject({ syncError: null, syncedAt: expect.any(String) });
  });

  test('a listing failure is reported and retried on the next hourly pass, not every run', async () => {
    api.failures.list = 403;
    await runEvery5Min(T0, T0 + 55 * MIN);
    expect(alerts('list_failed')).toEqual(['ebs-sync-reconcile']);
    at(T0 + RECONCILE_INTERVAL_MS);
    await scheduledRun();
    expect(alerts('list_failed')).toHaveLength(2);
  });

  test('a failed reconciliation send sets syncError, alerts, and stops the pass', async () => {
    for (const id of ['synth-r1', 'synth-r2']) {
      api.addOrder({ id, completedAt: T0 - 2 * 60 * MIN, visibleAt: T0 - 2 * 60 * MIN });
    }
    ebsHooks.failIds.add('synth-r1');
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };

    const body = await scheduledRun();

    expect(body.reconcile).toMatchObject({ failedOrderId: 'synth-r1', checked: 1, deferred: 1 });
    expect(api.orders.get('synth-r1').custom.syncError).toBe('ebs_rejected');
    expect(alerts('reconcile_failed')).toEqual(['synth-r1']);
    expect(persisted().status).toBe('error');
    expect(sent).toEqual([]);
  });
});

describe('already-synced orders are never resent', () => {
  test('journal pass and reconciliation skip orders with syncedAt (even if listing metadata is stale)', async () => {
    const completedAt = T0 - 2 * 60 * MIN;
    api.addOrder({
      id: 'synth-done', completedAt, custom: { syncedAt: iso(completedAt + MIN) },
    });
    api.addOrder({
      id: 'synth-stale-meta', completedAt, custom: { syncedAt: iso(completedAt + MIN) }, listMeta: { syncedAt: undefined },
    });
    api.addOrder({
      id: 'synth-legacy', completedAt, custom: { syncedToEbs: 'true' },
    });

    fakeState.store.state = { since: iso(completedAt) }; // journal pass sees all three
    const body = await scheduledRun();

    expect(sent).toEqual([]);
    expect(body.reconcile.checked).toBe(2); // stale metadata + legacy flag re-checked on the full order
    expect(api.opsLog).toEqual([]);
  });

  test('an order whose syncedAt patch is pending is not resent by either path', async () => {
    const completedAt = T0 - 2 * 60 * MIN;
    api.addOrder({ id: 'synth-pending', completedAt });
    fakeState.store.state = {
      since: iso(completedAt),
      pendingCustomUpdates: { 'synth-pending': { syncedAt: iso(completedAt + MIN), failedAt: iso(completedAt + MIN), error: 'x' } },
    };
    // patch keeps failing, so the order stays pending through the run
    const realFetch = api.fetch;
    global.fetch = async (url, init) => (init?.method === 'PATCH'
      ? { ok: false, status: 503, text: async () => 'down' }
      : realFetch(url, init));

    const p = scheduledRun();
    await jest.runAllTimersAsync();
    const body = await p;

    expect(sent).toEqual([]);
    expect(body.reconcile.candidates).toBe(0);
  });

  test('cancelled orders are skipped', async () => {
    api.addOrder({ id: 'synth-cancelled', completedAt: T0 - 10 * MIN, state: 'payment_cancelled' });
    fakeState.store.state = { since: iso(T0 - 15 * MIN) };
    await scheduledRun();
    expect(sent).toEqual([]);
  });
});

describe('cursor on deadline', () => {
  test('stops before the deadline and resumes from the first order not handled', async () => {
    const ids = ['synth-d1', 'synth-d2', 'synth-d3', 'synth-d4'];
    ids.forEach((id, i) => api.addOrder({ id, completedAt: T0 - (40 - i) * MIN }));
    fakeState.store.state = { since: iso(T0 - 45 * MIN) };
    ebsHooks.onSend = () => at(Date.now() + 4 * MIN); // each EBS call takes 4 minutes

    const body = await scheduledRun();

    expect(sent).toEqual(['synth-d1', 'synth-d2', 'synth-d3']);
    expect(body).toMatchObject({ halted: true, haltReason: 'deadline', cursorPersisted: true });
    expect(body.nextSince).toBe(iso(T0 - 37 * MIN)); // synth-d4's payment_completed
    expect(persisted().since).toBe(iso(T0 - 37 * MIN));
    expect(body.reconcile).toEqual({ skipped: 'deadline' });

    ebsHooks.onSend = null;
    at(Date.now() + 5 * MIN);
    const next = await scheduledRun();
    expect(sent).toEqual([...ids.slice(0, 3), 'synth-d4']);
    expect(next.halted).toBe(false);
    expect(persisted().since).toBe(iso(Date.now()));
  });

  test('a deadline before any order is handled resumes from the first order', async () => {
    api.addOrder({ id: 'synth-x', completedAt: T0 - 10 * MIN });
    api.addOrder({ id: 'other', completedAt: T0 - 5 * 60 * MIN });
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    // flushing a pending patch eats the whole budget
    fakeState.store.state.pendingCustomUpdates = { other: { syncedAt: iso(T0), failedAt: iso(T0), error: 'x' } };
    const realFetch = api.fetch;
    global.fetch = async (url, init) => {
      if (init?.method === 'PATCH') at(Date.now() + DEADLINE_MS + 1);
      return realFetch(url, init);
    };

    const body = await scheduledRun();

    expect(sent).toEqual([]);
    expect(body.haltReason).toBe('deadline');
    expect(persisted().since).toBe(iso(T0 - 10 * MIN)); // synth-x's entry, before the old cursor
  });

  test('max-retries halt keeps the cursor', async () => {
    api.addOrder({ id: 'synth-bad', completedAt: T0 - 10 * MIN });
    ebsHooks.failIds.add('synth-bad');
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };

    const body = await scheduledRun();

    expect(body.haltReason).toBe('max-retries');
    expect(persisted().since).toBe(iso(T0 - 5 * MIN));
  });

  test('nextCursor / terminalOrders', () => {
    const entries = [
      { orderId: 'b', event: 'payment_completed', timestamp: '2026-11-01T10:05:00.000Z' },
      { orderId: 'a', event: 'payment_completed', timestamp: '2026-11-01T10:01:00.000Z' },
      { orderId: 'b', event: 'payment_cancelled', timestamp: '2026-11-01T10:03:00.000Z' },
      { orderId: 'c', event: 'create', timestamp: '2026-11-01T10:00:00.000Z' },
      { orderId: 'd', event: 'payment_completed' },
    ];
    const queue = terminalOrders(entries);
    expect(queue.map((q) => q.orderId)).toEqual(['d', 'a', 'b']);
    expect(queue[2].ts).toBe(Date.parse('2026-11-01T10:03:00.000Z'));

    const base = { scanSince: 'S', batchUntil: '2026-11-01T11:00:00.000Z', queue };
    expect(nextCursor({ ...base, failed: false, stoppedAt: -1 })).toBe(base.batchUntil);
    expect(nextCursor({ ...base, failed: true, stoppedAt: -1 })).toBe('S');
    expect(nextCursor({ ...base, failed: false, stoppedAt: 0 })).toBe('S'); // unknown ts
    expect(nextCursor({ ...base, failed: false, stoppedAt: 2 })).toBe('2026-11-01T10:03:00.000Z');
  });
});

describe('manual backfill', () => {
  test('does not move the scheduled cursor by default, and never reconciles', async () => {
    api.addOrder({ id: 'synth-old', completedAt: T0 - 48 * 60 * MIN });
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };

    const { body } = await manualRun({ since: iso(T0 - 48 * 60 * MIN - 5 * MIN), duration: 10 });

    expect(sent).toEqual(['synth-old']);
    expect(body).toMatchObject({
      manual: true, cursorPersisted: false, nextSince: iso(T0 - 48 * 60 * MIN + 5 * MIN), reconcile: { skipped: 'manual' },
    });
    expect(persisted().since).toBe(iso(T0 - 5 * MIN));
    expect(api.requests.some((r) => r.path === '/orders')).toBe(false);
  });

  test('persistCursor: true saves nextSince', async () => {
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    const { body } = await manualRun({ since: iso(T0 - 3 * 60 * MIN), until: iso(T0 - 2 * 60 * MIN), persistCursor: true });
    expect(body.cursorPersisted).toBe(true);
    expect(persisted().since).toBe(iso(T0 - 2 * 60 * MIN));
  });

  test('a backfill cut by the deadline returns where to resume, cursor untouched', async () => {
    ['synth-m1', 'synth-m2', 'synth-m3', 'synth-m4'].forEach((id, i) => api.addOrder({ id, completedAt: T0 - 5 * 60 * MIN + i * MIN }));
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    ebsHooks.onSend = () => at(Date.now() + 4 * MIN);

    const { body } = await manualRun({ since: iso(T0 - 5 * 60 * MIN - MIN), duration: 30 });

    expect(body.haltReason).toBe('deadline');
    expect(body.nextSince).toBe(iso(T0 - 5 * 60 * MIN + 3 * MIN));
    expect(persisted().since).toBe(iso(T0 - 5 * MIN));
  });

  test('long ranges are read in ≤11h journal chunks', async () => {
    api.addOrder({ id: 'synth-early', completedAt: T0 - 20 * 60 * MIN });
    api.addOrder({ id: 'synth-mid', completedAt: T0 - 9 * 60 * MIN });
    api.addOrder({ id: 'synth-late', completedAt: T0 - 60 * MIN });

    await manualRun({ since: iso(T0 - 21 * 60 * MIN) });

    const chunks = api.requests.filter((r) => r.path === '/orders/journal' && !r.query.orderId).map((r) => r.query);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].since).toBe(iso(T0 - 22 * 60 * MIN));
    expect(chunks[0].until).toBe(chunks[1].since);
    expect(chunks[1].until).toBe(iso(T0));
    expect(sent).toEqual(['synth-early', 'synth-mid', 'synth-late']);
  });

  test('rejects a non-boolean persistCursor', async () => {
    const res = await manualRun({ since: iso(T0 - 60 * MIN), persistCursor: 'yes' });
    expect(res.statusCode).toBe(400);
  });
});

describe('locks', () => {
  test('a held lock skips the run without reading the journal or touching state', async () => {
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    fakeState.store.lock = true;
    const body = await scheduledRun();
    expect(body.skipped).toBe(true);
    expect(api.requests).toEqual([]);
    expect(persisted()).toEqual({ since: iso(T0 - 5 * MIN) });
  });

  test('a manual run during a scheduled run is skipped; the lock is released afterwards', async () => {
    api.addOrder({ id: 'synth-slow', completedAt: T0 - 10 * MIN });
    fakeState.store.state = { since: iso(T0 - 15 * MIN) };
    let release;
    ebsHooks.onSend = () => new Promise((resolve) => { release = resolve; });

    const first = scheduledRun();
    await jest.advanceTimersByTimeAsync(0);
    expect(release).toBeDefined();

    const { body } = await manualRun({ since: iso(T0 - 60 * MIN) });
    expect(body.skipped).toBe(true);

    release();
    await first;
    expect(fakeState.store.lock).toBe(false);
    expect(sent).toEqual(['synth-slow']);
  });

  test('the lock is released and the cursor kept when the journal API fails', async () => {
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    api.failures.journal = 500;
    await expect(scheduledRun()).rejects.toThrow('Journal API 500');
    expect(fakeState.store.lock).toBe(false);
    expect(persisted().since).toBe(iso(T0 - 5 * MIN));
  });
});

describe('reconciliation bounds', () => {
  test(`checks at most ${RECONCILE_MAX_ORDERS} orders per pass and continues on the next run`, async () => {
    const n = RECONCILE_MAX_ORDERS + 5;
    for (let i = 0; i < n; i++) {
      const completedAt = T0 - 3 * 60 * MIN + i * MIN;
      api.addOrder({ id: `synth-b${String(i).padStart(2, '0')}`, completedAt, visibleAt: completedAt });
    }
    fakeState.store.state = { since: iso(T0 - 5 * MIN) }; // journal pass sees none of them

    const first = await scheduledRun();
    expect(first.reconcile).toMatchObject({ checked: RECONCILE_MAX_ORDERS, deferred: 5, complete: false });
    expect(sent).toHaveLength(RECONCILE_MAX_ORDERS);
    expect(sent[0]).toBe('synth-b00'); // oldest first
    expect(persisted().reconcile.lastRunAt).toBeNull();

    at(T0 + 5 * MIN);
    const second = await scheduledRun();
    expect(second.reconcile).toMatchObject({ checked: 5, deferred: 0, complete: true });
    expect(new Set(sent).size).toBe(n);
    expect(alerts('reconciled')).toHaveLength(n);

    at(T0 + 10 * MIN);
    expect((await scheduledRun()).reconcile).toEqual({ skipped: 'not-due' });
  });

  test('already-reported orders are checked after new ones and do not hold the pass open', async () => {
    for (let i = 0; i < RECONCILE_MAX_ORDERS; i++) {
      api.addOrder({ id: `synth-lost${String(i).padStart(2, '0')}`, completedAt: T0 - 3 * 60 * MIN + i * MIN, visibleAt: Infinity });
    }
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    await scheduledRun();
    expect(alerts('journal_missing_payment')).toHaveLength(RECONCILE_MAX_ORDERS);

    // A new missed order appears; it is checked first despite being the newest.
    api.addOrder({ id: 'synth-new', completedAt: T0 - 90 * MIN, visibleAt: T0 - 90 * MIN });
    at(T0 + RECONCILE_INTERVAL_MS);
    const body = await scheduledRun();
    expect(sent).toEqual(['synth-new']);
    expect(body.reconcile).toMatchObject({ deferred: 1, complete: true });
    expect(alerts('journal_missing_payment')).toHaveLength(RECONCILE_MAX_ORDERS); // no repeats
  });
});

describe('time budget for EBS attempts', () => {
  const lastAttemptStart = ACTION_TIMEOUT_MS - EBS_ATTEMPT_TIMEOUT_MS - AFTER_SEND_RESERVE_MS;

  test('each EBS attempt gets a timeout signal', async () => {
    api.addOrder({ id: 'synth-sig', completedAt: T0 - 10 * MIN });
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    await scheduledRun();
    expect(ebsHooks.attempts).toHaveLength(1);
    expect(ebsHooks.attempts[0].signal).toBeInstanceOf(AbortSignal);
  });

  test('no attempt starts too close to the action timeout; the order is left for the next run', async () => {
    ['synth-t1', 'synth-t2', 'synth-t3', 'synth-t4'].forEach((id, i) => api.addOrder({ id, completedAt: T0 - (40 - i) * MIN }));
    fakeState.store.state = { since: iso(T0 - 45 * MIN) };
    ebsHooks.onSend = () => at(Date.now() + 3 * MIN);

    const body = await scheduledRun();

    expect(ebsHooks.attempts.every((a) => a.at - T0 <= lastAttemptStart)).toBe(true);
    expect(sent).toEqual(['synth-t1', 'synth-t2', 'synth-t3']);
    expect(body).toMatchObject({ haltReason: 'deadline', nextSince: iso(T0 - 37 * MIN) });
    expect(api.orders.get('synth-t4').custom.syncError).toBeUndefined();
  });

  test('a retry is not started without time for it; no syncError is set', async () => {
    api.addOrder({ id: 'synth-slow-retry', completedAt: T0 - 10 * MIN });
    fakeState.store.state = { since: iso(T0 - 15 * MIN) };
    ebsHooks.onSend = () => {
      at(Date.now() + 5 * MIN);
      const err = new Error('The operation was aborted due to timeout');
      err.retriable = true;
      throw err;
    };

    const p = scheduledRun();
    await jest.runAllTimersAsync();
    const body = await p;

    expect(ebsHooks.attempts).toHaveLength(2);
    expect(body).toMatchObject({ haltReason: 'deadline', nextSince: iso(T0 - 10 * MIN) });
    expect(api.orders.get('synth-slow-retry').custom.syncError).toBeUndefined();
    expect(persisted().status).toBe('idle');
  });
});

describe('manual single order (POST { orderId })', () => {
  test('sends an order missing from the global journal, cursor untouched', async () => {
    api.addOrder({ id: 'synth-one', completedAt: T0 - 3 * 60 * MIN, inGlobal: false });
    fakeState.store.state = { since: iso(T0 - 5 * MIN), status: 'idle' };

    const { body } = await manualRun({ orderId: 'synth-one' });

    expect(body).toMatchObject({ orderId: 'synth-one', outcome: 'synced', reconcile: { skipped: 'manual' } });
    expect(sent).toEqual(['synth-one']);
    expect(persisted().since).toBe(iso(T0 - 5 * MIN));
    expect(api.requests.some((r) => r.path === '/orders/journal' && !r.query.orderId)).toBe(false);
  });

  test('retries an order with syncError, skips synced ones', async () => {
    api.addOrder({ id: 'synth-err', completedAt: T0 - 60 * MIN, custom: { syncError: 'ebs_http_502' } });
    api.addOrder({ id: 'synth-ok', completedAt: T0 - 60 * MIN, custom: { syncedAt: iso(T0 - 59 * MIN) } });

    expect((await manualRun({ orderId: 'synth-err' })).body.outcome).toBe('synced');
    const skipped = (await manualRun({ orderId: 'synth-ok' })).body;
    expect(skipped).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('already synced') });
    expect(sent).toEqual(['synth-err']);
  });

  test('validates the body', async () => {
    expect((await manualRun({ orderId: 'x', since: iso(T0) })).statusCode).toBe(400);
    expect((await manualRun({ orderId: '' })).statusCode).toBe(400);
    expect((await manualRun({ orderId: 42 })).statusCode).toBe(400);
  });
});

describe('manual runs and the scheduled status', () => {
  test('a failed manual run keeps the scheduled status and is recorded for GET', async () => {
    api.addOrder({ id: 'synth-mfail', completedAt: T0 - 3 * 60 * MIN });
    ebsHooks.failIds.add('synth-mfail');
    fakeState.store.state = { since: iso(T0 - 5 * MIN), status: 'idle', lastError: null };

    const { body } = await manualRun({ since: iso(T0 - 3 * 60 * MIN - MIN), duration: 5 });
    expect(body.haltReason).toBe('max-retries');
    expect(persisted()).toMatchObject({ status: 'idle', lastError: null });
    expect(persisted().lastManualRun).toMatchObject({ haltReason: 'max-retries', nextSince: body.since });

    const status = await main({
      ...PARAMS, SYNC_STATUS_TOKEN: 'secret', __ow_method: 'get', __ow_headers: { authorization: 'Bearer secret' },
    });
    expect(JSON.parse(status.body).lastManualRun).toMatchObject({ haltReason: 'max-retries', finishedAt: expect.any(String) });
  });

  test('a manual run that throws is recorded too', async () => {
    api.failures.journal = 500;
    const res = manualRun({ since: iso(T0 - 60 * MIN) });
    await expect(res).rejects.toThrow('Journal API 500');
    expect(persisted().lastManualRun).toMatchObject({ lastError: expect.stringContaining('Journal API 500') });
  });
});

describe('reconciliation guards', () => {
  test('does not start after the journal pass failed', async () => {
    api.addOrder({ id: 'synth-jfail', completedAt: T0 - 10 * MIN });
    api.addOrder({ id: 'synth-missed', completedAt: T0 - 3 * 60 * MIN, inGlobal: false });
    ebsHooks.failIds.add('synth-jfail');
    fakeState.store.state = { since: iso(T0 - 15 * MIN) };

    const body = await scheduledRun();

    expect(body.reconcile).toEqual({ skipped: 'journal-pass-failed' });
    expect(api.requests.some((r) => r.path === '/orders')).toBe(false);
    expect(sent).toEqual([]);
  });

  test('stops checking at the run deadline and continues next run', async () => {
    for (let i = 0; i < 4; i++) {
      api.addOrder({ id: `synth-dl${i}`, completedAt: T0 - 3 * 60 * MIN + i * MIN, visibleAt: Infinity });
    }
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };
    const realFetch = api.fetch;
    global.fetch = async (url, init) => {
      if (/\/orders\/synth-dl\d$/.test(new URL(url).pathname)) at(Date.now() + 3.3 * MIN);
      return realFetch(url, init);
    };

    const body = await scheduledRun();

    expect(body.reconcile).toMatchObject({ checked: 3, deferred: 1, complete: false });
    expect(Date.now() - T0).toBeLessThan(ACTION_TIMEOUT_MS);
    expect(persisted().reconcile.lastRunAt).toBeNull();
  });

  test('candidates younger than the look-back are left to the journal pass', () => {
    expect(RECONCILE_MIN_AGE_MS).toBeGreaterThan(60 * MIN);
  });

  test('orders skipped on the full re-fetch do not hold the pass open', async () => {
    const n = RECONCILE_MAX_ORDERS + 5;
    for (let i = 0; i < n; i++) {
      const completedAt = T0 - 3 * 60 * MIN + i * MIN;
      api.addOrder({
        id: `synth-meta${String(i).padStart(2, '0')}`, completedAt, custom: { syncedAt: iso(completedAt + MIN) }, listMeta: { syncedAt: undefined },
      });
    }
    fakeState.store.state = { since: iso(T0 - 5 * MIN) };

    expect((await scheduledRun()).reconcile).toMatchObject({ checked: RECONCILE_MAX_ORDERS, complete: false });
    at(T0 + 5 * MIN);
    // never-checked first, then the least recently checked; nothing new left → done
    expect((await scheduledRun()).reconcile).toMatchObject({ checked: RECONCILE_MAX_ORDERS, complete: true });
    at(T0 + 10 * MIN);
    expect((await scheduledRun()).reconcile).toEqual({ skipped: 'not-due' });

    // a real miss shows up later: checked first on the next pass
    api.addOrder({ id: 'synth-real-miss', completedAt: T0 - 2 * 60 * MIN, inGlobal: false });
    at(T0 + 5 * MIN + RECONCILE_INTERVAL_MS);
    await scheduledRun();
    expect(sent).toEqual(['synth-real-miss']);
    expect(api.requests.filter((r) => r.method === 'GET' && /^\/orders\/synth-/.test(r.path)).length)
      .toBeLessThanOrEqual(3 * RECONCILE_MAX_ORDERS);
  });
});

describe('managed inventory with both passes', () => {
  const ITEMS = [{ sku: '001811', quantity: 2, path: '/us/en_us/products/x' }];

  test('each order is queued once, whichever pass sends it', async () => {
    api.addOrder({ id: 'synth-inv-journal', completedAt: T0 - 10 * MIN, items: ITEMS });
    api.addOrder({
      id: 'synth-inv-reconcile', completedAt: T0 - 3 * 60 * MIN, items: ITEMS, inGlobal: false,
    });
    fakeState.store.state = { since: iso(T0 - 15 * MIN) };

    const INV = { ...ON, INVENTORY_SYNC_ENABLED: 'true' };
    await runEvery5Min(T0, T0 + 2 * 60 * MIN, INV);
    await runEvery5Min(T0 + 2 * 60 * MIN + 5 * MIN, T0 + 3 * 60 * MIN, INV);

    expect(sent.sort()).toEqual(['synth-inv-journal', 'synth-inv-reconcile']);
    expect(fakeState.store.outbox.map((e) => e.orderIds)).toEqual([['synth-inv-journal'], ['synth-inv-reconcile']]);
    expect(fakeState.store.outbox[1].deltas).toEqual([{
      sku: '001811', market: 'us', units: 2, orderId: 'synth-inv-reconcile',
    }]);
  });
});
