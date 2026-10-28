import { rssPlain } from './rss-plain.js';
import { buildFeed } from '../serialize.js';
import { withProductType } from '../product-type.js';

/**
 * Pinterest catalog feed — non-namespaced `<rss>`, `availability` in the spaced
 * spec form. Same shape as the Meta feed (see rss-plain.js), plus:
 *   - `product_type` from the Edge product index (see ../product-type.js); the
 *     source feed doesn't carry it
 *   - `google_product_category` always present, empty when unset — as in the
 *     legacy Magento feed, per Pinterest's feedback
 */
export default {
  ...rssPlain,
  /**
   * @param {{ env: { FEED_SITE_BASE: string }, log: Console }} ctx
   * @param {{ channel?: object, items: Record<string, unknown>[] }} feed
   * @param {string} locale
   * @returns {Promise<string>}
   */
  build: async (ctx, feed, locale) => {
    const items = await withProductType(ctx, feed.items, locale);
    return buildFeed(
      { channel: feed.channel, items: items.map(rssPlain.transformItem) },
      { ...rssPlain, emitEmpty: ['google_product_category'] },
    );
  },
};
