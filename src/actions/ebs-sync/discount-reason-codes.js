/**
 * Virtual-bundle "Discount Reason Code" lookup for the EBS sync.
 *
 * EBS stamps a Discount Reason Code descriptive flexfield (DFF) on each virtual
 * bundle order line, sourced from the line's `<ns2:PromotionCode>` element. In
 * the legacy Magento sync this value came from a per-bundle "VBND" cart price
 * rule whose Description was the code (e.g. `VBND8.1`); the rule was auto-applied
 * to the order and its description stamped onto the bundle child lines. The
 * commerce stack computes bundle discounts through price allocation and has no
 * such rule, so the mapping is reproduced here as static data.
 *
 * The code is keyed by `${bundleUrlKey}|${variantSku}`:
 *   - `bundleUrlKey`  identifies the bundle product (the last segment of the
 *     bundle page path, e.g. `ascent-x5-smartprep-kitchen-system`).
 *   - `variantSku`    identifies the chosen colour/variant (the `-VB` SKU).
 *
 * Both keys are present on the stored order line (`item.path` and `item.sku`).
 * The bundle *parent* SKU is deliberately not used: it is not forwarded onto
 * the order line, and it is not consistent between Magento and Product Bus
 * (e.g. Magento `VBNDAX4KS` vs Product Bus `X4 Kitchen System`). Variant SKUs,
 * by contrast, match across both systems and uniquely combine with the bundle
 * page to identify one rule.
 *
 * Source of truth: Magento Admin -> Marketing -> Cart Price Rules, the active
 * rules whose Description matches /^VBND/ with `order_level_promotion = 1`.
 */

/**
 * Map of `${bundleUrlKey}|${variantSku}` -> VBND reason code.
 *
 * Only active Magento VBND rules are represented. Bundles absent from this map
 * emit no PromotionCode (matching pre-fix behaviour) rather than a wrong code.
 *
 * @type {Record<string, string>}
 */
export const VBND_REASON_CODES = {
  // Propel 750 Classic Bundle (VBNDP750). White (073295-VB / VBND1.2) is an
  // inactive rule and intentionally omitted.
  'propel-750-classic-bundle|071395-VB': 'VBND1',
  'propel-750-classic-bundle|073294-VB': 'VBND1.1',
  'propel-750-classic-bundle|073296-VB': 'VBND1.3',

  // E310 + Personal Cup Adapter (VBNDE310)
  'e310-and-pca-bundle|065971-VB': 'VBND5',
  'e310-and-pca-bundle|066071-VB': 'VBND5.1',
  'e310-and-pca-bundle|065755-VB': 'VBND5.2',

  // X5 SmartPrep Kitchen System (VBNDAX5KS)
  'ascent-x5-smartprep-kitchen-system|073495-04-VB': 'VBND8',
  'ascent-x5-smartprep-kitchen-system|074104-04-VB': 'VBND8.1',
  'ascent-x5-smartprep-kitchen-system|075805-04-VB': 'VBND8.2',
  'ascent-x5-smartprep-kitchen-system|075807-04-VB': 'VBND8.3',

  // X4 Gourmet SmartPrep Kitchen System (VBNDAX4KS)
  'ascent-x4-gourmet-smartprep-kitchen-system|073494-04-VB': 'VBND9',
  'ascent-x4-gourmet-smartprep-kitchen-system|074100-04-VB': 'VBND9.1',
  'ascent-x4-gourmet-smartprep-kitchen-system|074101-04-VB': 'VBND9.2',
  'ascent-x4-gourmet-smartprep-kitchen-system|074102-04-VB': 'VBND9.3',

  // 5200 Legacy Bundle (VBND5200LB)
  '5200-legacy-bundle|001372-1093-VB': 'VBND10',
  '5200-legacy-bundle|001371-1092-VB': 'VBND10.1',
  '5200-legacy-bundle|001392-1138-VB': 'VBND10.2',

  // 5200 + Stainless Steel Container (VBND5200SS). Shares blender variant SKUs
  // with the 5200 Legacy Bundle above; the bundle url-key disambiguates.
  '5200-plus-stainless-steel-container|001372-1093-VB': 'VBND11.1',
  '5200-plus-stainless-steel-container|001371-1092-VB': 'VBND11.2',
  '5200-plus-stainless-steel-container|001392-1138-VB': 'VBND11.3',

  // Ascent X5 + Stainless Steel Container (VBNDX5SS). Shares blender variant
  // SKUs with X5 SmartPrep above; the bundle url-key disambiguates.
  'ascent-x5-plus-stainless-steel-container|073495-04-VB': 'VBND12',
  'ascent-x5-plus-stainless-steel-container|074104-04-VB': 'VBND12.1',
  'ascent-x5-plus-stainless-steel-container|075805-04-VB': 'VBND12.2',
  'ascent-x5-plus-stainless-steel-container|075807-04-VB': 'VBND12.3',

  // VX1 + Personal Cup Adapter (VBNDVX1). Both variants map to VBND13.
  'vx1-and-pca-bundle|075804-04-VB': 'VBND13',
  'vx1-and-pca-bundle|075861-04-VB': 'VBND13',

  // Propel 510 + Simply Entertaining Cookbook (VBNDP510SEC)
  'propel-510-plus-simply-entertaining-cookbook|071394-VB': 'VBND16',
};

/**
 * Bundle-level reason codes for bundles whose Magento VBND rule matched on the
 * parent SKU only (no per-variant condition), so every child line of the
 * bundle receives the same code regardless of the selected variant.
 *
 * @type {Record<string, string>}
 */
export const VBND_REASON_CODES_BY_BUNDLE = {
  // Immersion Blender Complete Bundle (VBNDIBCB)
  '5-speed-immersion-blender-complete-bundle': 'VBND7',
};

/**
 * Derive the bundle url-key (last path segment) from an order line `path`.
 *
 * 1. Coerce to string and drop a query string if present.
 * 2. Strip a trailing `.json` and any trailing slash.
 * 3. Return the final path segment (the product url-key).
 *
 * @param {string} [path] - order line `path`, e.g. `/us/en_us/products/foo`.
 * @returns {string} the url-key (`foo`), or `''` when path is missing.
 */
export function bundleUrlKey(path) {
  if (!path) return '';
  const clean = String(path).split('?')[0].replace(/\.json$/, '').replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? clean : clean.slice(slash + 1);
}

/**
 * Resolve the VBND Discount Reason Code for a bundle order line.
 *
 * The reason code applies to the whole bundle, so every virtual bundle child
 * line receives the parent line's code.
 *
 * 1. Derive the bundle url-key from `item.path`.
 * 2. Prefer a per-variant match on `${urlKey}|${item.sku}`.
 * 3. Fall back to a bundle-level code for parent-only rules.
 * 4. Return `''` when nothing matches so callers can omit the element.
 *
 * @param {{ path?: string, sku?: string }} item - bundle parent order line.
 * @returns {string} the VBND code (e.g. `VBND8.1`), or `''` when unmapped.
 */
export function resolveVbndReasonCode(item) {
  const urlKey = bundleUrlKey(item?.path);
  if (!urlKey) return '';
  const sku = item?.sku;
  if (sku && VBND_REASON_CODES[`${urlKey}|${sku}`]) {
    return VBND_REASON_CODES[`${urlKey}|${sku}`];
  }
  return VBND_REASON_CODES_BY_BUNDLE[urlKey] || '';
}
