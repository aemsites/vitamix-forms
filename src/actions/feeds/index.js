/**
 * Adobe I/O Runtime action — feeds.
 *
 * Serves product-catalog feeds for downstream service providers over HTTP, from
 * a single endpoint. The source is the (enriched) Google Merchant Center feed
 * published per locale; each provider gets it in the format it expects.
 *
 *   GET /feeds/feeds?provider=<provider>&locale=<cc/ll_cc>[&raw=true]
 *
 * Every provider gets the shared catalog preparation (./prepare.js) by default.
 * `raw=true` skips it and serves the source feed as-is in the provider's format
 * (e.g. the pre-preparation Bazaarvoice feed), so both can be reviewed.
 *
 * Providers fetch this URL on their own schedule (pull model). When FEEDS_TOKEN
 * is set, the URL is gated by `Authorization: Bearer <token>` or `?token=<token>`
 * (the latter for providers that only accept a plain URL).
 */

import { Core } from '@adobe/aio-sdk';
import { buildProviderFeed, resolveFeedEnv } from './build.js';
import { PROVIDERS } from './providers/index.js';
import { errorInfo } from '../../utils.js';

const DEFAULT_LOCALE = 'us/en_us';

/**
 * @param {string | undefined} value
 * @returns {string | null} the normalized locale, or null if malformed
 */
function normalizeLocale(value) {
  if (!value) return DEFAULT_LOCALE;
  const locale = String(value).trim().toLowerCase();
  return /^[a-z]{2}\/[a-z]{2}_[a-z]{2}$/.test(locale) ? locale : null;
}

/**
 * @param {unknown} value a query param
 * @returns {boolean} true for "true"/"1"/"yes" (case-insensitive)
 */
const isTrue = (value) => /^(true|1|yes)$/i.test(String(value ?? '').trim());

/**
 * @param {number} statusCode
 * @param {string} message
 * @returns {object}
 */
function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'x-error': message },
    body: JSON.stringify({ error: message }),
  };
}

export async function main(params) {
  const log = Core.Logger('feeds', { level: params.LOG_LEVEL || 'info' });

  const method = (params.__ow_method || 'get').toUpperCase();
  if (method !== 'GET') {
    return errorResponse(405, 'Method Not Allowed');
  }

  // Optional bearer/token gate — enabled only when FEEDS_TOKEN is configured.
  if (params.FEEDS_TOKEN) {
    const authHeader = (params.__ow_headers || {}).authorization || '';
    const provided = authHeader.replace(/^Bearer\s+/i, '').trim() || params.token;
    if (provided !== params.FEEDS_TOKEN) {
      return errorResponse(401, 'Unauthorized');
    }
  }

  const provider = String(params.provider || '').toLowerCase();
  const serializer = PROVIDERS[provider];
  if (!serializer) {
    return errorResponse(
      400,
      `unknown provider "${provider}"; supported: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }

  // A provider may pin its locale (e.g. openai is US-only); otherwise honor the
  // request (default us/en_us).
  const locale = serializer.locale || normalizeLocale(params.locale);
  if (!locale) {
    return errorResponse(400, 'invalid locale; expected form "cc/ll_cc" e.g. "us/en_us"');
  }

  const ctx = { env: resolveFeedEnv(params), log };

  // `raw=true` opts out of the shared catalog preparation for this request.
  const raw = isTrue(params.raw);

  try {
    const { body } = await buildProviderFeed(ctx, provider, locale, { raw });

    // Only ungated feeds may be shared-cached. When FEEDS_TOKEN gates access, the
    // response is Bearer-authenticated, so keep it out of shared/CDN caches.
    const cacheControl = params.FEEDS_TOKEN
      ? 'private, no-store'
      : 'max-age=3600, must-revalidate';

    return {
      statusCode: 200,
      headers: {
        'content-type': serializer.contentType,
        'cache-control': cacheControl,
      },
      body,
    };
  } catch (err) {
    log.error(`failed to build ${provider} feed for ${locale}`, errorInfo(err));
    const statusCode = err.response?.error?.statusCode || 500;
    const message = err.response?.error?.headers?.['x-error']
      || `failed to build feed: ${err.message}`;
    return errorResponse(statusCode, message);
  }
}
