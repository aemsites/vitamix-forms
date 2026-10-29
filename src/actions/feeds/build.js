/**
 * Shared feed build pipeline: fetch the source (GMC) feed, apply the shared
 * catalog preparation, and serialize it for a provider.
 *
 * Used by the `feeds` web action (serves the feed over HTTP) and the
 * `feeds-push` action (uploads it to providers on a schedule), so what gets
 * pushed is exactly what the feed URL serves.
 */

import { fetchGmcFeed } from './source.js';
import { prepareFeed } from './prepare.js';
import { buildFeed } from './serialize.js';
import { PROVIDERS } from './providers/index.js';

// Production public domain — serves the merchant feed and is reachable from the
// runtime (a direct fetch of the aem.network host fails at runtime: "fetch failed").
export const DEFAULT_FEED_SITE_BASE = 'https://www.vitamix.com';

/**
 * Use an env value only when it's a real http(s) URL — this tolerates the var
 * being unset (empty) or left as an unsubstituted "$VAR" literal by the deploy,
 * falling back to the in-code default in both cases.
 * @param {unknown} value
 * @returns {string | undefined}
 */
const httpUrl = (value) => (/^https?:\/\//.test(String(value || '')) ? String(value) : undefined);

/**
 * Resolve the feed-build env from action params.
 * @param {Record<string, unknown>} params
 * @returns {{ FEED_SITE_BASE: string, FEED_CONTENT_BASE?: string, BV_CATEGORY_SHEET_URL?: string }}
 */
export function resolveFeedEnv(params) {
  return {
    FEED_SITE_BASE: httpUrl(params.FEED_SITE_BASE) || DEFAULT_FEED_SITE_BASE,
    // authored PDP content, for descriptions missing from the source feed
    FEED_CONTENT_BASE: httpUrl(params.FEED_CONTENT_BASE),
    BV_CATEGORY_SHEET_URL: httpUrl(params.BV_CATEGORY_SHEET_URL),
  };
}

/**
 * Build one provider's feed for a locale.
 *
 * Throws on failure (errors from the source fetch carry `err.response` with an
 * HTTP status, see ../../utils.js#errorWithResponse).
 *
 * @param {{ env: ReturnType<typeof resolveFeedEnv>, log: any }} ctx
 * @param {string} provider key in PROVIDERS
 * @param {string} locale e.g. "us/en_us"; ignored when the provider pins a locale
 * @param {{ raw?: boolean }} [opts] raw=true skips the shared preparation
 * @returns {Promise<{ body: string, contentType: string, itemCount: number, locale: string }>}
 */
export async function buildProviderFeed(ctx, provider, locale, { raw = false } = {}) {
  const serializer = PROVIDERS[provider];
  if (!serializer) {
    throw new Error(`unknown provider "${provider}"`);
  }
  // A provider may pin its locale (e.g. openai is US-only).
  const effectiveLocale = serializer.locale || locale;

  const source = await fetchGmcFeed(ctx, effectiveLocale);
  // Shared catalog cleanup (product selection, titles, descriptions), unless
  // the unprepared source feed was requested.
  const feed = raw ? source : await prepareFeed(ctx, source, effectiveLocale);
  // Custom-schema providers (e.g. bazaarvoice) supply their own async builder;
  // the rest use the shared field/format serializer.
  const body = serializer.build
    ? await serializer.build(ctx, feed, effectiveLocale)
    : buildFeed(
      { channel: feed.channel, items: feed.items.map(serializer.transformItem) },
      serializer,
    );

  return {
    body,
    contentType: serializer.contentType,
    itemCount: feed.items.length,
    locale: effectiveLocale,
  };
}
