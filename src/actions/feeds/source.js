import { XMLParser } from 'fast-xml-parser';
import { errorWithResponse } from '../../utils.js';

// Strip the `g:` namespace prefix so items expose clean keys (id, title, ...).
// parseTagValue:false keeps every value a string — critical for identifiers like
// GTIN where a leading zero must not be lost to numeric coercion.
const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
});

// Fields that can legitimately repeat within an item and must be arrays.
const MULTI_FIELDS = new Set(['additional_image_link']);

/**
 * Normalize one parsed `<item>` into a flat record.
 * - trims scalar values (the source wraps descriptions in whitespace/newlines)
 * - coerces repeatable fields to arrays
 * - leaves structured values (e.g. shipping) untouched
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
function normalizeItem(raw) {
  /** @type {Record<string, unknown>} */
  const item = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (MULTI_FIELDS.has(key)) {
      item[key] = (Array.isArray(value) ? value : [value])
        .map((v) => String(v).trim())
        .filter(Boolean);
    } else if (typeof value === 'object') {
      item[key] = value;
    } else {
      item[key] = String(value).trim();
    }
  }
  return item;
}

/**
 * Fetch and parse the Google Merchant Center feed for a locale into a canonical
 * shape the provider serializers consume.
 * @param {{ env: { FEED_SITE_BASE: string }, log: Console }} ctx
 * @param {string} locale e.g. "us/en_us"
 * @returns {Promise<{ channel: { title?: string, link?: string, description?: string }, items: Record<string, unknown>[] }>}
 */
export async function fetchGmcFeed(ctx, locale) {
  const base = ctx.env.FEED_SITE_BASE.replace(/\/$/, '');
  const url = `${base}/${locale}/products/merchant-center-feed.xml`;
  ctx.log.info(`fetching GMC feed: ${url}`);

  const resp = await fetch(url);
  if (!resp.ok) {
    throw errorWithResponse(
      `failed to fetch GMC feed ${url}: ${resp.status}`,
      502,
      'failed to fetch source feed',
    );
  }

  const parsed = parser.parse(await resp.text());
  const channel = parsed?.rss?.channel ?? {};
  const rawItems = channel.item ?? [];
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems]).map(normalizeItem);

  return {
    channel: {
      title: channel.title,
      link: channel.link,
      description: channel.description,
    },
    items,
  };
}
