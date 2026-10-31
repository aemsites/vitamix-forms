/**
 * Operations-log events for inventory-sync.
 *
 * POST {EDGE_COMMERCE_API_BASE}/{ORG}/sites/{SITE}/operations-log
 *
 * The endpoint rejects unknown actions with 404 until
 * adobe-rnd/helix-commerce-api#585 adds `inventory-oversold` and
 * `inventory-out-of-stock` to its allowlist, so a 404 is logged at info and
 * ignored. Other failures warn. This never throws and never fails the run.
 */

import { errorInfo } from '../../utils.js';

export const OPS_LOG_TIMEOUT_MS = 10_000;

/**
 * @param {{ env: object, log: object }} ctx
 * @param {{ action: string } & Record<string, unknown>} event
 * @returns {Promise<'sent' | 'unsupported' | 'failed'>}
 */
export async function sendOpsEvent(ctx, event) {
  const { EDGE_COMMERCE_API_BASE, ORG, SITE } = ctx.env;
  const url = `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/operations-log`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(OPS_LOG_TIMEOUT_MS),
    });
    if (resp.ok) return 'sent';
    if (resp.status === 404) {
      ctx.log.info(`[inventory-sync] ops-log action "${event.action}" not supported yet (404, see helix-commerce-api#585): ${JSON.stringify(event)}`);
      return 'unsupported';
    }
    const body = await resp.text().catch(() => '');
    ctx.log.warn(`[inventory-sync] ops-log ${event.action} failed: ${resp.status} ${body}`);
    return 'failed';
  } catch (err) {
    ctx.log.warn(`[inventory-sync] ops-log ${event.action} failed`, errorInfo(err));
    return 'failed';
  }
}
