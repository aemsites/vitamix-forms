/**
 * Adobe I/O Runtime action — managed inventory sync (prod only).
 *
 * Applies sold-unit decrements queued by ebs-sync to the managed inventory
 * sheet and flips sold-out managed products to OutOfStock.
 *
 *   Scheduled (alarm rule): params.__ow_method absent → run().
 *     No-op unless INVENTORY_SYNC_ENABLED is "true".
 *
 *   HTTP GET — status
 *     Authorization: Bearer {SYNC_STATUS_TOKEN}
 *     Returns cursor, head, backlog (head − cursor), lastRun, lastError, counters.
 *
 *   HTTP POST — manual run
 *     Authorization: Bearer {SYNC_STATUS_TOKEN}
 *     Body (optional): { "dryRun": true } → read everything, log planned sheet
 *     changes / product flips / events, write nothing (bypasses the prod flag).
 */

import { run, isEnabled } from './sync.js';
import { loadState, getCursor, getHead } from './state.js';

export async function main(params) {
  if (params.__ow_method) {
    const method = params.__ow_method.toUpperCase();
    if (method === 'GET') return handleStatus(params);
    if (method === 'POST') return handleTrigger(params);
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }
  return run(params);
}

function requireAuth(params) {
  const authHeader = (params.__ow_headers || {}).authorization || '';
  const provided = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!params.SYNC_STATUS_TOKEN || !provided || provided !== params.SYNC_STATUS_TOKEN) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }
  return null;
}

async function handleStatus(params) {
  const authErr = requireAuth(params);
  if (authErr) return authErr;
  try {
    const [state, cursor, head] = await Promise.all([loadState(), getCursor(), getHead()]);
    return jsonResponse(200, {
      enabled: isEnabled(params),
      cursor,
      head,
      backlog: Math.max(0, head - cursor),
      ...state,
    });
  } catch (err) {
    return jsonResponse(500, { error: 'Failed to read state', detail: err.message });
  }
}

async function handleTrigger(params) {
  const authErr = requireAuth(params);
  if (authErr) return authErr;
  const body = parseBody(params);
  const dryRun = body.dryRun === true || body.dryRun === 'true';
  const result = await run(params, { dryRun });
  return jsonResponse(200, result.body);
}

/** Body fields from params (auto-parsed JSON) or __ow_body (base64). */
function parseBody(params) {
  if (params.dryRun !== undefined) return params;
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
