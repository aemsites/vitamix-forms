/**
 * Pinterest catalog feed.
 *
 * Pinterest accepts the Google `g:` format but differs in one detail: the
 * `availability` value uses spaces, not underscores. It also *requires*
 * `google_product_category` and `product_type` — these now flow from the GMC
 * feed (sourced from the ProductBus `custom` bag in the indexer), so no
 * enrichment is done here; items missing them are a source-data problem.
 */
const AVAILABILITY = {
  in_stock: 'in stock',
  out_of_stock: 'out of stock',
  preorder: 'preorder',
  backorder: 'backorder',
};

export default {
  contentType: 'application/xml',
  /**
   * @param {Record<string, unknown>} item
   * @returns {Record<string, unknown>}
   */
  transformItem: (item) => ({
    ...item,
    availability: AVAILABILITY[/** @type {string} */ (item.availability)] ?? item.availability,
  }),
};
