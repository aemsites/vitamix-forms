/**
 * Shared config for the non-namespaced `<rss>` feed used by both Meta and
 * Pinterest (the reference feed for these two is identical). Item tags are plain
 * (no `g:` prefix) and `availability` uses the spaced spec form (`in stock`).
 */

// Item fields, in the order the reference feed emits them.
export const RSS_PLAIN_FIELDS = [
  'availability',
  'link',
  'title',
  'description',
  'price',
  'sale_price',
  'id',
  'gtin',
  'mpn',
  'identifier_exists',
  'condition',
  'brand',
  'image_link',
  'product_type',
  'google_product_category',
];

const AVAILABILITY = {
  in_stock: 'in stock',
  out_of_stock: 'out of stock',
  preorder: 'preorder',
  backorder: 'backorder',
};

/** @type {{ contentType: string, root: 'rss', namespaced: boolean, fields: string[], transformItem: (item: Record<string, unknown>) => Record<string, unknown> }} */
export const rssPlain = {
  contentType: 'application/xml',
  root: 'rss',
  namespaced: false,
  fields: RSS_PLAIN_FIELDS,
  transformItem: (item) => ({
    ...item,
    availability: AVAILABILITY[/** @type {string} */ (item.availability)] ?? item.availability,
  }),
};
