import { RSS_PLAIN_FIELDS } from './rss-plain.js';

/**
 * Commission Junction (CJ Affiliate) product feed.
 *
 * CJ uses a bare `<feed>` root with non-namespaced tags. It follows the Google
 * Shopping spec, so `availability` keeps the underscore form (`in_stock`) and
 * `google_product_category` is not included. `gtin` (required by CJ for branded
 * goods) flows from the source feed. Point CJ's HTTP data-import at this endpoint
 * to replace the SFTP drop.
 *
 * Matches the legacy feed:
 *   - no `item_group_id`: CJ only accepts letters, digits, `_` and `-`, and the
 *     source group id is the parent sku, often a product name
 *   - `identifier_exists` is `no` when an item has neither `gtin` nor `mpn`;
 *     CJ assumes `yes` otherwise and rejects the item
 */
export default {
  contentType: 'application/xml',
  root: 'feed',
  namespaced: false,
  fields: RSS_PLAIN_FIELDS.filter((field) => !['google_product_category', 'item_group_id'].includes(field)),
  transformItem: (item) => (item.gtin || item.mpn ? item : { ...item, identifier_exists: 'no' }),
};
