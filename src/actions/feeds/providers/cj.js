import { RSS_PLAIN_FIELDS } from './rss-plain.js';

/**
 * Commission Junction (CJ Affiliate) product feed.
 *
 * CJ uses a bare `<feed>` root with non-namespaced tags. It follows the Google
 * Shopping spec, so `availability` keeps the underscore form (`in_stock`) and
 * `google_product_category` is not included. `gtin` (required by CJ for branded
 * goods) flows from the source feed. Point CJ's HTTP data-import at this endpoint
 * to replace the SFTP drop.
 */
export default {
  contentType: 'application/xml',
  root: 'feed',
  namespaced: false,
  fields: RSS_PLAIN_FIELDS.filter((field) => field !== 'google_product_category'),
  transformItem: (item) => item,
};
