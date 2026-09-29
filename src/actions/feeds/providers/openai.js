/**
 * OpenAI commerce "ads" product feed (CSV, US only).
 *
 * Spec: https://developers.openai.com/commerce/specs/file-upload/products
 * Mapping: docs/vitamix-openai-ads-feed-mapping.xlsx (GMC -> OpenAI, near 1:1).
 *
 * Columns match docs/vitamix-openai-ads-feed-SAMPLE.csv exactly. Most fields are
 * a direct copy of a (prepared, see ../prepare.js) GMC attribute; the rest are
 * static launch config or derived (availability remap, variant grouping, sale
 * window split).
 *
 * Pinned to us/en_us — this is a US-only feed (target_countries/store_country=US).
 */

const COLUMNS = [
  'item_id', 'title', 'description', 'url', 'brand', 'image_url', 'price',
  'availability', 'seller_name', 'seller_url', 'return_policy', 'target_countries',
  'store_country', 'is_eligible_search', 'is_eligible_checkout', 'is_ads_eligible',
  'gtin', 'mpn', 'product_category', 'condition', 'color', 'sale_price',
  'sale_price_start_date', 'sale_price_end_date', 'additional_image_urls',
  'group_id', 'listing_has_variations', 'variant_dict',
];

// UTF-8 byte order mark: lets spreadsheet tools (Excel) detect the encoding, so
// non-ASCII text (e.g. accents, curly quotes) isn't shown as "Ã©"/"Â®" mojibake.
const BOM = '\uFEFF';

// Static launch config (see mapping "static" rows). Constants for now — promote
// to env vars if ops needs to change them without a deploy.
const SELLER_NAME = 'Vitamix';
const SELLER_URL = 'https://www.vitamix.com';
const RETURN_POLICY = 'https://www.vitamix.com/us/en_us/returns';
const TARGET_COUNTRIES = 'US';
const STORE_COUNTRY = 'US';
const IS_ELIGIBLE_SEARCH = 'true';
const IS_ELIGIBLE_CHECKOUT = 'false'; // no in-chat checkout in beta
const IS_ADS_ELIGIBLE = 'true';

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
  return feed.items.map((it) => {
    // Variants (simples of a configurable) share the parent sku as group_id and
    // are distinguished by color. Standalone items and bundles carry no group.
    const isVariant = Boolean(it.item_group_id) && String(it.item_group_id) !== String(it.id);
    const variantDict = isVariant && it.color ? JSON.stringify({ color: it.color }) : '';
    // GMC sale_price_effective_date is "start/end" (ISO 8601).
    const [saleStart = '', saleEnd = ''] = String(it.sale_price_effective_date || '').split('/');
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
      IS_ADS_ELIGIBLE,
      it.gtin,
      it.mpn,
      it.google_product_category || it.product_type, // product_category
      it.condition,
      it.color,
      it.sale_price,
      saleStart, // sale_price_start_date
      saleEnd, // sale_price_end_date
      additional, // additional_image_urls (comma-joined)
      isVariant ? it.item_group_id : '', // group_id
      isVariant ? 'true' : '', // listing_has_variations
      variantDict, // variant_dict (JSON)
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
  build: async (ctx, feed) => BOM + [csvRow(COLUMNS), ...buildRows(feed)].join('\n'),
};
