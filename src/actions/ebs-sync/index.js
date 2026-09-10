/**
 * Adobe I/O Runtime action — EBS order sync.
 *
 * Three invocation modes:
 *
 *   Scheduled (alarm rule, every 5 min)
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
    ebs: describeEbsConfig(params),
  });
}

/**
 * Non-secret fingerprint of the EBS target this deployment will actually use.
 *
 * Order sync always uses the deployment-default EBS_BASE_URL/EBS_API_KEY
 * (see ebs.js:syncOrderToEbs) — never the _STAGE pair. Both the default and the
 * _STAGE values are injected into every deployment, so a *prod* deployment whose
 * default equals the stage value is misconfigured: it will sync live orders to
 * the staging EBS. We detect that directly instead of guessing prod-ness from
 * the URL string (which assumes a naming convention that may not hold).
 *
 * Returns only booleans and the URL host — never the API key or full URL.
 *
 * @param {object} params - action params (env inputs injected by the Runtime)
 */
function describeEbsConfig(params) {
  const base = params.EBS_BASE_URL || '';
  const baseStage = params.EBS_BASE_URL_STAGE || '';
  const key = params.EBS_API_KEY || '';
  const keyStage = params.EBS_API_KEY_STAGE || '';

  let host = null;
  try {
    host = base ? new URL(base).host : null;
  } catch {
    host = 'invalid-url';
  }

  return {
    host,                                        // endpoint host, for eyeballing (no key)
    configured: Boolean(base && key),            // false → missing/empty secret at deploy
    targetsStage: base !== '' && base === baseStage,        // ← the prod→stage misroute
    apiKeyMatchesStage: key !== '' && key === keyStage,     // ← mismatched/stage key
  };
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
