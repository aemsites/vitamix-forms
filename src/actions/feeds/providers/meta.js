import { rssPlain } from './rss-plain.js';

/**
 * Meta (Facebook/Instagram — Advantage+/DPA) catalog feed.
 *
 * Meta reuses the same non-namespaced `<rss>` feed as Pinterest, so it shares the
 * rss-plain config. Kept as its own module so Meta-specific tweaks
 * (e.g. fb_product_category) can diverge later.
 */
export default { ...rssPlain };
