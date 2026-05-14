/**
 * Adobe I/O Runtime action — EBS order sync.
 *
 * Three invocation modes:
 *
 *   Scheduled (alarm rule, every 10 min)
 *     params.__ow_method is absent.
 *     Runs the full sync job via sync.run().
 *
 *   HTTP GET (web action) — status
 *     Requires:  Authorization: Bearer {SYNC_STATUS_TOKEN}
 *     Returns:   JSON metadata about the last/current sync run.
 *
 *   HTTP POST (web action) — manual trigger
 *     Requires:  Authorization: Bearer {SYNC_STATUS_TOKEN}
 *     Body:      { "since": "<ISO 8601 timestamp>" }
 *     Runs the sync using the provided timestamp as the cursor start,
 *     allowing re-processing of orders from a specific point in time.
 *     The persisted cursor advances normally after a successful run.
 */

import { run } from './sync.js';
import { loadState } from './state.js';

export async function main(params) {
  // Web-action invocations carry __ow_method; scheduled invocations do not.
  if (params.__ow_method) {
    const method = params.__ow_method.toUpperCase();
    if (method === 'GET') return handleStatusRequest(params);
    if (method === 'POST') return handleTriggerRequest(params);
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  return run(params);
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

/**
 * Validate the shared status/trigger Bearer token.
 * @returns {object | null} JSON error response if invalid, null if OK
 */
function requireAuth(params) {
  const authHeader = (params.__ow_headers || {}).authorization || '';
  const provided = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!params.SYNC_STATUS_TOKEN || !provided || provided !== params.SYNC_STATUS_TOKEN) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }
  return null;
}

/** GET — return current sync state metadata. */
async function handleStatusRequest(params) {
  const authErr = requireAuth(params);
  if (authErr) return authErr;

  let state;
  try {
    state = await loadState();
  } catch (err) {
    return jsonResponse(500, { error: 'Failed to read state', detail: err.message });
  }

  return jsonResponse(200, {
    since: state.since,
    lastProcessedOrderId: state.lastProcessedOrderId,
    lastRun: state.lastRun,
    status: state.status,
    processedCount: state.processedCount,
    failedCount: state.failedCount,
    lastError: state.lastError,
  });
}

/**
 * POST — manually trigger a sync run.
 * Body: { "since": "<ISO 8601 timestamp>" }
 *
 * The `since` field overrides the persisted cursor for this run only,
 * allowing a superuser to re-process orders from a specific point in time.
 */
async function handleTriggerRequest(params) {
  const authErr = requireAuth(params);
  if (authErr) return authErr;

  let body;
  try {
    const raw = params.__ow_body ?? '';
    const decoded = typeof raw === 'string' ? Buffer.from(raw, 'base64').toString('utf-8') : '';
    body = decoded ? JSON.parse(decoded) : {};
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON in request body' });
  }

  const { since } = body;
  if (!since || isNaN(Date.parse(since))) {
    return jsonResponse(400, { error: 'Missing or invalid "since" ISO 8601 timestamp in request body' });
  }

  return run({ ...params, sinceOverride: since });
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
