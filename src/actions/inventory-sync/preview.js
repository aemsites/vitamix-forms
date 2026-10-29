/**
 * Trigger an AEM preview of a DA document so aem.page reflects the source.
 *
 * NOTE (to verify in prod): this sends the AIO IMS server-to-server token as a
 * Bearer token to admin.hlx.page. Whether the admin API accepts that token for
 * aemsites/vitamix is not yet confirmed. A failure is logged and never fatal:
 * the DA source (which inventory-sync reads) is already updated.
 */

import { errorInfo } from '../../utils.js';

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
