/**
 * Adobe I/O Runtime action — recipe-notify.
 *
 * Sends a daily digest of newly published recipes. Runs in PRODUCTION ONLY,
 * gated by RECIPE_NOTIFY_ENABLED === "true" (see sync.js).
 *
 * Three invocation modes:
 *
 *   Scheduled (alarm rule, daily)
 *     params.__ow_method is absent. Runs the full job via run().
 *
 *   HTTP GET (web action) — status
 *     Requires:  Authorization: Bearer {RECIPE_NOTIFY_TOKEN}
 *     Returns:   JSON metadata about the last/current run.
 *
 *   HTTP POST (web action) — manual trigger
 *     Requires:  Authorization: Bearer {RECIPE_NOTIFY_TOKEN}
 *     Body:      { "since"?: "<ISO 8601>", "dryRun"?: true }
 *     `dryRun` computes the new-recipe set (with resolved links) without sending
 *     and without advancing the cursor — and bypasses the prod gate, so stage
 *     can be exercised on demand.
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

/**
 * Validate the shared status/trigger Bearer token.
 * If no token is configured, all HTTP access is denied.
 * @returns {object | null} JSON error response if invalid, null if OK
 */
function requireAuth(params) {
  const authHeader = (params.__ow_headers || {}).authorization || '';
  const provided = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!params.RECIPE_NOTIFY_TOKEN || !provided || provided !== params.RECIPE_NOTIFY_TOKEN) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }
  return null;
}

/** GET — return current state metadata. */
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
    lastRun: state.lastRun,
    status: state.status,
    processedCount: state.processedCount,
    lastError: state.lastError,
  });
}

/**
 * POST — manually trigger a run.
 * Body: { "since"?: "<ISO 8601>", "dryRun"?: true }
 */
async function handleTriggerRequest(params) {
  const authErr = requireAuth(params);
  if (authErr) return authErr;

  const body = parseBody(params);

  if (body.since !== undefined && body.since !== null && isNaN(Date.parse(body.since))) {
    return jsonResponse(400, { error: 'Invalid "since" ISO 8601 timestamp' });
  }

  const result = await run(params, {
    dryRun: body.dryRun === true,
    sinceOverride: body.since ?? undefined,
  });
  return jsonResponse(result.body?.error ? 500 : 200, result.body);
}

/** Extract body fields from params (auto-parsed JSON) or __ow_body (base64). */
function parseBody(params) {
  if (params.since !== undefined || params.dryRun !== undefined) {
    return { since: params.since, dryRun: params.dryRun };
  }
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
