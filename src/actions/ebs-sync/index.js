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
 *     Body:      { "since": "<ISO 8601>", "until"?: "<ISO 8601>", "duration"?: <minutes> }
 *     Runs the sync using the provided timestamp as the cursor start.
 *     Optionally cap the window with `until` (timestamp) or `duration` (minutes
 *     from since). Only one of until/duration may be provided; omit both to
 *     scan up to the current time. Cursor advances normally after a successful run.
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
 * Body: { "since": "<ISO 8601>", "until"?: "<ISO 8601>", "duration"?: <minutes> }
 *
 * `since` is required — overrides the persisted cursor for this run only.
 * `until`  — optional upper bound timestamp (defaults to now).
 * `duration` — optional window in minutes from `since` (e.g. 30 → since + 30 min).
 * Only one of `until` / `duration` may be provided.
 */
async function handleTriggerRequest(params) {
  const authErr = requireAuth(params);
  if (authErr) return authErr;

  // The Runtime may deliver the body in two ways depending on Content-Type:
  //   application/json → parsed and merged into params directly
  //   other / raw      → base64-encoded in __ow_body
  const body = parseBody(params);

  const { since } = body;
  if (!since || isNaN(Date.parse(since))) {
    return jsonResponse(400, { error: 'Missing or invalid "since" ISO 8601 timestamp in request body' });
  }

  const hasUntil = body.until !== undefined && body.until !== null;
  const hasDuration = body.duration !== undefined && body.duration !== null;

  if (hasUntil && hasDuration) {
    return jsonResponse(400, { error: 'Provide "until" or "duration", not both' });
  }

  let untilOverride;
  if (hasUntil) {
    if (isNaN(Date.parse(body.until))) {
      return jsonResponse(400, { error: 'Invalid "until" ISO 8601 timestamp' });
    }
    untilOverride = body.until;
  } else if (hasDuration) {
    const minutes = Number(body.duration);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return jsonResponse(400, { error: '"duration" must be a positive number of minutes' });
    }
    untilOverride = new Date(new Date(since).getTime() + minutes * 60_000).toISOString();
  }

  return run({ ...params, sinceOverride: since, untilOverride });
}

/** Extract body fields from params (auto-parsed JSON) or __ow_body (base64). */
function parseBody(params) {
  if (params.since) return params;
  if (!params.__ow_body) return {};
  try {
    return JSON.parse(Buffer.from(params.__ow_body, 'base64').toString('utf-8'));
  } catch {
    return {};
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
