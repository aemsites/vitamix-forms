/**
 * DA source access for the inventory sheet, with optimistic concurrency.
 *
 * da-admin returns an `ETag` on `GET /source/...` and honours `If-Match` on
 * `PUT /source/...` (412 when the stored object changed). inventory-sync reads
 * the sheet with its ETag, applies decrements, and writes back conditionally;
 * on 412 it re-reads and re-applies, so an author's concurrent API/editor save
 * is never overwritten by a stale copy.
 *
 * Known limitation (documented, cannot be fixed here): DA's sheet editor saves
 * its whole in-memory copy without If-Match. An author who has the sheet open
 * from before our write and then edits it can overwrite our decrement.
 */

/** Per-request timeout for DA source calls. */
export const DA_TIMEOUT_MS = 30_000;

/** @param {{ env: object }} ctx */
function sourceUrl(ctx, path) {
  return `https://admin.da.live/source/${ctx.env.ORG}/${ctx.env.SITE}${path}`;
}

/** DA passes If-Match through to strong comparison; drop any weak prefix. */
function strongEtag(etag) {
  return etag ? etag.trim().replace(/^W\//, '') : null;
}

/**
 * @param {{ env: object, log: object, events: { token?: string } }} ctx
 * @param {string} path
 * @returns {Promise<{ sheet: object, etag: string | null }>}
 */
export async function fetchSourceSheet(ctx, path) {
  const url = sourceUrl(ctx, path);
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${ctx.events.token}`, 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(DA_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`DA source GET ${path} returned ${resp.status}${resp.headers.get('x-error') ? ` ${resp.headers.get('x-error')}` : ''}`);
  }
  return { sheet: await resp.json(), etag: strongEtag(resp.headers.get('etag')) };
}

/**
 * Conditional PUT of the sheet.
 * @param {{ env: object, log: object, events: { token?: string } }} ctx
 * @param {string} path
 * @param {object} sheet
 * @param {string} etag - ETag from the GET this sheet was derived from
 * @returns {Promise<'ok' | 'conflict'>} conflict = 412, re-read and retry
 */
export async function putSourceSheet(ctx, path, sheet, etag) {
  const url = sourceUrl(ctx, path);
  const body = new FormData();
  body.append('data', new Blob([JSON.stringify(sheet)], { type: 'application/json' }));
  const resp = await fetch(url, {
    method: 'PUT',
    body,
    headers: { Authorization: `Bearer ${ctx.events.token}`, 'If-Match': etag },
    signal: AbortSignal.timeout(DA_TIMEOUT_MS),
  });
  if (resp.status === 412) return 'conflict';
  if (!resp.ok) {
    throw new Error(`DA source PUT ${path} returned ${resp.status}${resp.headers.get('x-error') ? ` ${resp.headers.get('x-error')}` : ''}`);
  }
  return 'ok';
}
