/**
 * Adobe I/O Runtime action — EBS order sync.
 *
 * Two invocation modes:
 *
 *   Scheduled (alarm rule, every 10 min)
 *     params.__ow_method is absent.
 *     Runs the full sync job via sync.run().
 *
 *   HTTP GET (web action)
 *     params.__ow_method === 'GET'
 *     Requires:  Authorization: Bearer {STATUS_TOKEN}
 *     Returns:   JSON metadata about the last/current sync run.
 *
 * Required env vars (injected as action inputs in app.config.yaml):
 *   COMMERCE_API_BASE   — e.g. https://api.adobecommerce.live
 *   COMMERCE_API_TOKEN  — service token with orders:read + orders:custom:write
 *   COMMERCE_ORG        — org slug
 *   COMMERCE_SITE       — site slug
 *   EBS_ENDPOINT        — EBS SOAP endpoint URL
 *   STATUS_TOKEN        — UUID used to authenticate the HTTP status endpoint
 */

import { run } from './sync.js';
import { loadState } from './state.js';

export async function main(params) {
  // Web-action invocations carry __ow_method; scheduled invocations do not.
  if (params.__ow_method) {
    return handleStatusRequest(params);
  }

  return run(params);
}

// ---------------------------------------------------------------------------
// HTTP status handler
// ---------------------------------------------------------------------------

async function handleStatusRequest(params) {
  // Only GET is supported.
  if (params.__ow_method.toUpperCase() !== 'GET') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  // Validate Bearer token.
  const authHeader = (params.__ow_headers || {}).authorization || '';
  const provided = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!params.SYNC_STATUS_TOKEN || !provided || provided !== params.SYNC_STATUS_TOKEN) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  // Return current sync state as metadata.
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

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
