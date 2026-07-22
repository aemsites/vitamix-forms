/**
 * Meta (Facebook/Instagram — Advantage+/DPA) catalog feed.
 *
 * Meta ingests the Google RSS/`g:` format directly, so the enriched GMC feed is
 * reused as-is. Point a Meta scheduled feed fetch at this endpoint.
 *
 * Future value-add (not needed for a valid feed): `fb_product_category`,
 * `quantity_to_sell_on_facebook` for onsite checkout.
 */
export default {
  contentType: 'application/xml',
  /**
   * @param {Record<string, unknown>} item
   * @returns {Record<string, unknown>}
   */
  transformItem: (item) => item,
};
