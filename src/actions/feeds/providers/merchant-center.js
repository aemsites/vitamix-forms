/**
 * Google Merchant Center feed.
 *
 * The source feed is already GMC-shaped (`<rss>` with `g:`-namespaced items), so
 * this provider re-emits it in the same shape after the shared catalog
 * preparation (../prepare.js): every source attribute is passed through as-is
 * (no field list), including repeated (additional_image_link) and structured
 * (e.g. shipping) values. Point Merchant Center at this URL instead of the
 * unfiltered source feed.
 */
export default {
  contentType: 'application/xml',
  root: 'rss',
  namespaced: true,
  // no `fields`: pass through every attribute on the item, in source order
  transformItem: (item) => item,
};
