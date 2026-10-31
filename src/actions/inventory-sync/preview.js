/**
 * Trigger an AEM preview of a DA document so aem.page reflects the source.
 *
 * Best effort only. inventory-sync and authors both work from the DA source;
 * authors review the sheet in DA and preview it themselves before the next
 * product-admin ingest. This uses the AIO IMS server-to-server token as a
 * Bearer token; if admin.hlx.page rejects it, the failure is logged as a
 * warning and the run continues.
 */

import { errorInfo } from '../../utils.js';

export const PREVIEW_TIMEOUT_MS = 15_000;

/**
 * @param {{ env: object, log: object, events: { token?: string } }} ctx
 * @param {string} path - e.g. `/us/en_us/products/config/inventory.json`
 * @returns {Promise<boolean>} true if preview succeeded
 */
export async function triggerPreview(ctx, path) {
  const { ORG, SITE } = ctx.env;
  const url = `https://admin.hlx.page/preview/${ORG}/${SITE}/main${path}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.events.token}` },
      signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
    });
    if (resp.ok) {
      ctx.log.info(`[inventory-sync] preview ${resp.status}: ${url}`);
      return true;
    }
    ctx.log.warn(`[inventory-sync] preview failed ${resp.status}${resp.headers.get('x-error') ? ` ${resp.headers.get('x-error')}` : ''}: ${url}`);
    return false;
  } catch (err) {
    ctx.log.warn(`[inventory-sync] preview failed: ${url}`, errorInfo(err));
    return false;
  }
}
