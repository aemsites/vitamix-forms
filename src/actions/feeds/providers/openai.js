/**
 * OpenAI commerce "ads" product feed (CSV, US only).
 *
 * Spec: https://developers.openai.com/commerce/specs/file-upload/products
 * Mapping: docs/vitamix-openai-ads-feed-mapping.xlsx (GMC -> OpenAI, near 1:1).
 *
 * Columns match docs/vitamix-openai-ads-feed-SAMPLE.csv exactly. Most fields are
 * a direct copy of a GMC attribute; the rest are static launch config or derived
 * (availability remap, item_group_title via a parent-title lookup).
 *
 * Pinned to us/en_us — this is a US-only feed (target_countries/store_country=US).
 */

const COLUMNS = [
  'item_id', 'title', 'description', 'url', 'brand', 'image_url', 'price',
  'availability', 'seller_name', 'seller_url', 'return_policy', 'target_countries',
  'store_country', 'is_eligible_search', 'is_eligible_checkout', 'is_eligible_ads',
  'gtin', 'mpn', 'product_category', 'condition', 'color', 'sale_price',
  'sale_price_start_date', 'sale_price_end_date', 'additional_image_urls',
  'item_group_title',
];

// Static launch config (see mapping "static" rows). Constants for now — promote
// to env vars if ops needs to change them without a deploy.
const SELLER_NAME = 'Vitamix';
const SELLER_URL = 'https://www.vitamix.com';
const RETURN_POLICY = 'https://www.vitamix.com/us/en_us/returns';
const TARGET_COUNTRIES = 'US';
const STORE_COUNTRY = 'US';
const IS_ELIGIBLE_SEARCH = 'true';
const IS_ELIGIBLE_CHECKOUT = 'false'; // no in-chat checkout in beta
const IS_ELIGIBLE_ADS = 'true';

// GMC availability -> OpenAI availability (only 'preorder' differs).
const AVAILABILITY = {
  in_stock: 'in_stock',
  out_of_stock: 'out_of_stock',
  preorder: 'pre_order',
  backorder: 'backorder',
};

/** RFC 4180 CSV cell: quote when it contains a comma, quote or newline. */
const csvCell = (value) => {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');

/**
 * @param {{ items: Record<string, unknown>[] }} feed
 * @returns {string[]} data rows
 */
function buildRows(feed) {
  const { items } = feed;
  const titleBySku = new Map(items.map((it) => [String(it.id), it.title]));
  // Parents are skus referenced by a variant's item_group_id.
  const parentSkus = new Set(
    items.map((it) => it.item_group_id).filter(Boolean).map(String),
  );

  return items.map((it) => {
    // Group variants with their parent, and parents with themselves, by title.
    const groupSku = it.item_group_id
      || (parentSkus.has(String(it.id)) ? it.id : undefined);
    const additional = Array.isArray(it.additional_image_link)
      ? it.additional_image_link.join(',')
      : (it.additional_image_link || '');

    return csvRow([
      it.id, // item_id
      it.title,
      it.description,
      it.link, // url
      it.brand,
      it.image_link, // image_url
      it.price,
      AVAILABILITY[/** @type {string} */ (it.availability)] || 'unknown',
      SELLER_NAME,
      SELLER_URL,
      RETURN_POLICY,
      TARGET_COUNTRIES,
      STORE_COUNTRY,
      IS_ELIGIBLE_SEARCH,
      IS_ELIGIBLE_CHECKOUT,
      IS_ELIGIBLE_ADS,
      it.gtin,
      it.mpn,
      it.google_product_category || it.product_type, // product_category
      it.condition,
      it.color,
      it.sale_price,
      '', // sale_price_start_date — GMC feed carries no effective-date range yet
      '', // sale_price_end_date
      additional, // additional_image_urls (comma-joined)
      groupSku ? (titleBySku.get(String(groupSku)) || '') : '', // item_group_title
    ]);
  });
}

export default {
  contentType: 'text/csv; charset=utf-8',
  locale: 'us/en_us', // US-only feed
  /**
   * @param {object} ctx
   * @param {{ items: Record<string, unknown>[] }} feed
   * @returns {Promise<string>}
   */
  build: async (ctx, feed) => [csvRow(COLUMNS), ...buildRows(feed)].join('\n'),
};
