import { rssPlain } from './rss-plain.js';

/**
 * Pinterest catalog feed — non-namespaced `<rss>`, `availability` in the spaced
 * spec form. Requires `google_product_category` and `product_type`, which flow
 * from the source feed. Same shape as the Meta feed (see rss-plain.js).
 */
export default { ...rssPlain };
