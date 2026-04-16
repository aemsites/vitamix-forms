/**
 * Commerce API client for the EBS sync job.
 *
 * Wraps the four operations needed:
 *   1. Read the global orders journal (with chunking for windows > 11 hours)
 *   2. Read the per-order journal for a specific order
 *   3. Fetch a single order by ID
 *   4. PATCH an order's custom data
 */

/** Journal API enforces a 12-hour max range. Stay safely under it. */
const JOURNAL_CHUNK_HOURS = 11;

/**
 * Fetch all journal entries since the given ISO timestamp, chunking the
 * request into ≤11-hour windows if the full range exceeds the API limit.
 *
 * @param {object} params - Action params containing COMMERCE_* env vars
 * @param {string | null} since - ISO 8601 timestamp, or null to default to 1h ago
 * @returns {Promise<object[]>} Flat array of journal entries, oldest first
 */
export async function getJournalEntries(params, since) {
  const { EDGE_COMMERCE_API_BASE, EDGE_COMMERCE_API_ORDERS_TOKEN, ORG, SITE } = params;
  const baseUrl = `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/orders/journal`;

  const sinceDate = since
    ? new Date(since)
    : new Date(Date.now() - 60 * 60 * 1000); // default: 1 hour ago
  const untilDate = new Date();

  const rangeMs = untilDate.getTime() - sinceDate.getTime();
  const chunkMs = JOURNAL_CHUNK_HOURS * 60 * 60 * 1000;

  const allEntries = [];

  if (rangeMs <= chunkMs) {
    const entries = await fetchJournalChunk(baseUrl, EDGE_COMMERCE_API_ORDERS_TOKEN, sinceDate, untilDate);
    allEntries.push(...entries);
  } else {
    // Break into JOURNAL_CHUNK_HOURS windows
    let chunkStart = new Date(sinceDate);
    while (chunkStart < untilDate) {
      const chunkEnd = new Date(Math.min(
        chunkStart.getTime() + chunkMs,
        untilDate.getTime(),
      ));
      const entries = await fetchJournalChunk(baseUrl, EDGE_COMMERCE_API_ORDERS_TOKEN, chunkStart, chunkEnd);
      allEntries.push(...entries);
      chunkStart = chunkEnd;
    }
  }

  return allEntries;
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {Date} since
 * @param {Date} until
 * @returns {Promise<object[]>}
 */
async function fetchJournalChunk(baseUrl, token, since, until) {
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
  return data.entries ?? [];
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
    `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/orders/${encodeURIComponent(orderId)}/journal`,
  );
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
