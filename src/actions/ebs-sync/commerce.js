/**
 * Commerce API client for the EBS sync job.
 *
 * Wraps the four operations needed:
 *   1. Read the global orders journal — used to discover terminal events
 *      (payment_completed / payment_cancelled) and their orderIds
 *   2. Read the per-order journal for a specific order (complete entries)
 *   3. Fetch a single order by ID
 *   4. PATCH an order's custom data
 */

/** Journal API enforces a 12-hour max range. Stay safely under it. */
const JOURNAL_CHUNK_HOURS = 11;

/**
 * Fetch all journal entries since the given ISO timestamp, chunking the
 * request into ≤11-hour windows if the full range exceeds the API limit.
 *
 * Returns the queried `until` timestamp alongside the entries so the caller
 * can advance its cursor to the boundary of what was examined — necessary
 * because empty batches and pre-cursor entries would otherwise leave the
 * cursor stuck at the previous value.
 *
 * @param {object} params - Action params containing COMMERCE_* env vars
 * @param {string | null} since - ISO 8601 timestamp, or null to default to 1h ago
 * @param {object} log - Logger instance (ctx.log)
 * @param {string} [until] - ISO 8601 upper bound, defaults to now
 * @returns {Promise<{ entries: object[], until: string }>}
 */
export async function getJournalEntries(params, since, log, until) {
  const { EDGE_COMMERCE_API_BASE, EDGE_COMMERCE_API_ORDERS_TOKEN, ORG, SITE } = params;
  const baseUrl = `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/orders/journal`;

  // Look back 15 minutes before the cursor to catch late-arriving journal
  // entries. The journal writer runs on its own ~10-minute cron, so entries
  // can appear in the global index after the sync cursor has already advanced
  // past their event timestamp. Already-synced orders are skipped cheaply via
  // the custom.syncedToEbs check, so the overlap is harmless.
  const OVERLAP_MS = 15 * 60 * 1000;
  const sinceDate = since
    ? new Date(new Date(since).getTime() - OVERLAP_MS)
    : new Date(Date.now() - 60 * 60 * 1000); // default: 1 hour ago
  const untilDate = until ? new Date(until) : new Date();
  log.info(`[ebs-sync] Querying journal: ${baseUrl} since=${sinceDate.toISOString()} until=${untilDate.toISOString()}`);

  const rangeMs = untilDate.getTime() - sinceDate.getTime();
  const chunkMs = JOURNAL_CHUNK_HOURS * 60 * 60 * 1000;

  const allEntries = [];

  if (rangeMs <= chunkMs) {
    const entries = await fetchJournalChunk(baseUrl, EDGE_COMMERCE_API_ORDERS_TOKEN, sinceDate, untilDate, log);
    allEntries.push(...entries);
  } else {
    // Break into JOURNAL_CHUNK_HOURS windows
    let chunkStart = new Date(sinceDate);
    while (chunkStart < untilDate) {
      const chunkEnd = new Date(Math.min(
        chunkStart.getTime() + chunkMs,
        untilDate.getTime(),
      ));
      const entries = await fetchJournalChunk(baseUrl, EDGE_COMMERCE_API_ORDERS_TOKEN, chunkStart, chunkEnd, log);
      allEntries.push(...entries);
      chunkStart = chunkEnd;
    }
  }

  return { entries: allEntries, until: untilDate.toISOString() };
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {Date} since
 * @param {Date} until
 * @param {object} log
 * @returns {Promise<object[]>}
 */
async function fetchJournalChunk(baseUrl, token, since, until, log) {
  const url = new URL(baseUrl);
  url.searchParams.set('since', since.toISOString());
  url.searchParams.set('until', until.toISOString());

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Journal API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const entries = data.entries ?? [];
  log.info(`[ebs-sync] Journal chunk returned ${entries.length} entries (${since.toISOString()} – ${until.toISOString()})`);
  if (entries.length > 0) {
    const summary = entries.map((e) => `${e.event}:${e.orderId?.slice(-8) ?? '?'}`).join(', ');
    log.info(`[ebs-sync] Chunk entries: [${summary}]`);
  }
  return entries;
}

/**
 * Fetch a single order by ID.
 *
 * @param {object} params
 * @param {string} orderId
 * @returns {Promise<object | null>} Order object or null if not found
 */
export async function getOrder(params, orderId) {
  const { EDGE_COMMERCE_API_BASE, EDGE_COMMERCE_API_ORDERS_TOKEN, ORG, SITE } = params;
  const url = `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/orders/${encodeURIComponent(orderId)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${EDGE_COMMERCE_API_ORDERS_TOKEN}` },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Get order API ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.order ?? data;
}

/**
 * Merge custom data into an order.
 *
 * @param {object} params
 * @param {string} orderId
 * @param {Record<string, string>} custom - Key/value pairs to merge (all values must be strings)
 * @returns {Promise<object>} Updated order
 */
export async function updateOrderCustom(params, orderId, custom) {
  const { EDGE_COMMERCE_API_BASE, EDGE_COMMERCE_API_ORDERS_TOKEN, ORG, SITE } = params;
  const url = `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/orders/${encodeURIComponent(orderId)}/custom`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${EDGE_COMMERCE_API_ORDERS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(custom),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Update order custom API ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Log an order-sync operation to the commerce API operations log.
 *
 * Fire-and-forget from the caller's perspective — errors are caught and
 * logged so that a logging failure never blocks the sync itself.
 *
 * @param {object} params
 * @param {{ action: string, status: number, error?: string, response?: string }} payload
 */
export async function logOrderSync(params, payload) {
  const { EDGE_COMMERCE_API_BASE, ORG, SITE } = params;
  const url = `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/operations-log`;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Fetch all journal entries for a specific order within a time window.
 *
 * Called for orders confirmed to be in a terminal state (payment_completed)
 * to retrieve the complete journal needed for building the EBS XML payload.
 *
 * @param {object} params
 * @param {string} orderId
 * @param {string} since - ISO 8601 start timestamp (typically order.createdAt)
 * @param {string} until - ISO 8601 end timestamp (typically now)
 * @returns {Promise<object[]>}
 */
export async function getOrderJournalEntries(params, orderId, since, until) {
  const { EDGE_COMMERCE_API_BASE, EDGE_COMMERCE_API_ORDERS_TOKEN, ORG, SITE } = params;
  const url = new URL(
    `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/orders/journal`,
  );
  url.searchParams.set('orderId', orderId);
  url.searchParams.set('since', since);
  url.searchParams.set('until', until);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${EDGE_COMMERCE_API_ORDERS_TOKEN}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Order journal API ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.entries ?? [];
}
