/**
 * In-memory stand-in for the commerce API routes ebs-sync uses, served
 * through a mocked global fetch. All data is synthetic.
 *
 * Journal entries carry a `visibleAt` time: the global journal and the
 * per-order journal only return an entry once the fake clock has reached it,
 * which models journal buckets that land late (or never, with visibleAt
 * Infinity).
 */

export const BASE = 'https://commerce.example.com';
export const PARAMS = {
  LOG_LEVEL: 'error',
  ORG: 'org',
  SITE: 'site',
  EDGE_COMMERCE_API_BASE: BASE,
  EDGE_COMMERCE_API_ORDERS_TOKEN: 'token',
};

const MAX_JOURNAL_RANGE_MS = 12 * 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

export function createFakeCommerceApi() {
  const orders = new Map();
  const journal = [];
  const opsLog = [];
  const requests = [];
  const failures = {
    list: null, journal: null, getOrder: null, opsLog: 0, patch: null,
  };

  /**
   * Add a synthetic order that completed (or was cancelled) at `completedAt`.
   * @param {object} o
   * @param {string} o.id
   * @param {number} o.completedAt - ms
   * @param {number} [o.visibleAt] - when its journal entries become readable (ms, Infinity = never)
   * @param {string} [o.state]
   * @param {object} [o.custom]
   * @param {object} [o.listMeta] - overrides for the listing metadata only (stale metadata)
   * @param {boolean} [o.inGlobal] - false: only the per-order journal has the entries
   * @param {object[]} [o.items]
   */
  function addOrder({
    id, completedAt, visibleAt = completedAt, state = 'payment_completed', custom = {}, listMeta,
    inGlobal = true, items,
  }) {
    const createdAt = completedAt - 2 * 60 * 1000;
    orders.set(id, {
      id,
      state,
      country: 'US',
      createdAt: iso(createdAt),
      updatedAt: iso(completedAt),
      custom: { ...custom },
      ...(items ? { items } : {}),
      listMeta,
    });
    const terminal = state === 'payment_cancelled' ? 'payment_cancelled' : 'payment_completed';
    journal.push(
      {
        visibleAt,
        inGlobal,
        entry: {
          id: `${id}-create`, orderId: id, event: 'create', timestamp: iso(createdAt),
        },
      },
      {
        visibleAt,
        inGlobal,
        entry: {
          id: `${id}-terminal`, orderId: id, event: terminal, timestamp: iso(completedAt), provider: 'chase',
        },
      },
    );
  }

  /** Make an order's journal entries readable from `at` (e.g. after a replay). */
  function setVisibleAt(id, at) {
    journal.filter((j) => j.entry.orderId === id).forEach((j) => { j.visibleAt = at; });
  }

  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const now = Date.now();
    const path = url.pathname.replace('/org/sites/site', '');
    const q = Object.fromEntries(url.searchParams);
    requests.push({ method, path, query: q });

    if (path === '/operations-log' && method === 'POST') {
      if (failures.opsLog > 0) {
        failures.opsLog -= 1;
        return json(503, { message: 'ops log down' });
      }
      opsLog.push(JSON.parse(init.body));
      return json(200, {});
    }

    if (path === '/orders/journal' && method === 'GET') {
      const since = Date.parse(q.since);
      const until = Date.parse(q.until);
      const visibleJ = journal.filter((j) => j.visibleAt <= now);
      if (q.orderId) {
        return json(200, {
          entries: visibleJ.map((j) => j.entry).filter((e) => e.orderId === q.orderId
            && Date.parse(e.timestamp) >= since && Date.parse(e.timestamp) <= until),
        });
      }
      if (failures.journal) return json(failures.journal, { message: 'journal failure' });
      if (until - since > MAX_JOURNAL_RANGE_MS) return json(400, { message: 'range too large' });
      const visible = visibleJ.filter((j) => j.inGlobal).map((j) => j.entry);
      return json(200, {
        entries: visible.filter((e) => Date.parse(e.timestamp) >= since && Date.parse(e.timestamp) <= until),
      });
    }

    if (path === '/orders' && method === 'GET') {
      if (failures.list) return json(failures.list, { message: 'forbidden' });
      const since = Date.parse(q.since);
      const until = Date.parse(q.until);
      const list = [...orders.values()]
        .filter((o) => (!q.state || o.state === q.state)
          && Date.parse(o.updatedAt) >= since && Date.parse(o.updatedAt) <= until)
        .map((o) => ({
          id: o.id,
          state: o.state,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
          ...(o.custom.syncedAt ? { syncedAt: o.custom.syncedAt } : {}),
          ...(o.custom.syncError ? { syncError: o.custom.syncError } : {}),
          ...o.listMeta,
        }));
      return json(200, { orders: list });
    }

    const custom = path.match(/^\/orders\/([^/]+)\/custom$/);
    if (custom && method === 'PATCH') {
      if (failures.patch) return json(failures.patch, { message: 'patch failure' });
      const order = orders.get(decodeURIComponent(custom[1]));
      if (!order) return json(404, {});
      Object.assign(order.custom, JSON.parse(init.body));
      order.updatedAt = iso(now);
      return json(200, { order });
    }

    const one = path.match(/^\/orders\/([^/]+)$/);
    if (one && method === 'GET') {
      if (typeof failures.getOrder === 'function' ? failures.getOrder(decodeURIComponent(one[1])) : failures.getOrder) {
        return json(503, { message: 'order read failure' });
      }
      const order = orders.get(decodeURIComponent(one[1]));
      if (!order) return json(404, {});
      const rest = { ...order };
      delete rest.listMeta;
      return json(200, { order: structuredClone(rest) });
    }

    return json(404, { message: `unexpected ${method} ${path}` });
  }

  return {
    fetch, addOrder, setVisibleAt, orders, opsLog, requests, failures,
  };
}

/** In-memory aio-lib-state replacement with real lock semantics. */
export function createFakeState() {
  const store = {
    state: null, lock: false, outbox: [], seq: 0, failSave: null,
  };
  return {
    store,
    module: {
      loadState: async () => {
        const s = store.state ? structuredClone(store.state) : {};
        return {
          since: null,
          lastProcessedOrderId: null,
          lastError: null,
          lastRun: null,
          processedCount: 0,
          failedCount: 0,
          status: 'idle',
          ...s,
          pendingCustomUpdates: { ...(s.pendingCustomUpdates || {}) },
        };
      },
      saveState: async (updates) => {
        if (store.failSave?.(updates)) throw new Error('state store down');
        store.state = structuredClone({ ...(store.state || {}), ...updates });
        return store.state;
      },
      acquireLock: async () => {
        if (store.lock) return false;
        store.lock = true;
        return true;
      },
      releaseLock: async () => { store.lock = false; },
      allocateInventoryOutboxSeq: async () => { store.seq += 1; return store.seq; },
      putInventoryOutboxEntry: async (seq, entry) => { store.outbox.push({ seq, ...entry }); },
      publishInventoryOutboxHead: async () => {},
      inventoryOutboxEntryExists: async () => false,
    },
  };
}
