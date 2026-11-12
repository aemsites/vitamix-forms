/**
 * Virtual-bundle Discount Reason Code (VBND) lookup for the EBS sync.
 *
 * The code lives with the bundle in the Product Bus: `custom.vbndCode` on the
 * ordered variant (codes are per colour/variant, e.g. VBND17, VBND17.1) or, for
 * a bundle where one code covers every variant, on the product itself. When an
 * order holds a virtual bundle the sync reads that product from the public
 * product host (the same host the inventory sync reads) and takes the code from
 * the variant whose SKU is on the order line, then from the product.
 *
 * Resolution order for each bundle line:
 *   1. the product's `custom.vbndCode` (variant first, then product);
 *   2. the static map in discount-reason-codes.js, the fallback while product
 *      data is being filled in (and the safety net when the product host is down);
 *   3. nothing: the line is reported as `missing` and the order is sent without a
 *      code, so a bundle that has no code is never silent.
 *
 * A product that cannot be read at all (timeout, 5xx) and has no static code is
 * retried later, because sending the order would silently drop the code.
 */

import { resolveVbndReasonCode } from './discount-reason-codes.js';

/** A VBND code as stored on the product: `VBND17`, `VBND17.1`. */
export const VBND_CODE_PATTERN = /^VBND[0-9]+(?:\.[0-9]+)*$/;

/** How long to wait for the product host before giving up on the lookup. */
export const PRODUCT_LOOKUP_TIMEOUT_MS = 8_000;

/**
 * Product path without a query string, `.json` suffix or trailing slash.
 *
 * @param {unknown} path
 * @returns {string} the normalized path, or '' when absent.
 */
export function normalizeProductPath(path) {
  return String(path ?? '').split('?')[0].replace(/\.json$/i, '').replace(/\/+$/, '').trim();
}

/**
 * Read a bundle product from the public product host.
 *
 * @param {{ env: { ORG: string, SITE: string } }} ctx
 * @param {string} path product path, e.g. `/us/en_us/products/vx3-plus-24-ounce-tumbler`
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object | null>} the product, or null when it does not exist.
 * @throws {Error} on a network error, a timeout or any other HTTP status; the error
 *   carries `response.statusCode` for HTTP failures so isRetriableError can classify it.
 */
export async function fetchBundleProduct(ctx, path, fetchImpl = fetch) {
  const { ORG, SITE } = ctx.env;
  // Cache-busted like the inventory sync's index read, so a code published in the
  // product admin is seen on the next order rather than when the CDN entry expires.
  const url = `https://main--${SITE}--${ORG}.aem.network${normalizeProductPath(path)}.json?_=${Date.now()}`;
  const res = await fetchImpl(url, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(PRODUCT_LOOKUP_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`product lookup ${normalizeProductPath(path)} returned ${res.status}`);
    err.response = { statusCode: res.status };
    throw err;
  }
  return res.json();
}

/**
 * The VBND code a product declares for an ordered variant: the variant's
 * `custom.vbndCode` first, then the product's. The first source that declares
 * a value decides; a value that is not a VBND code is reported, not used.
 *
 * @param {object} product Product Bus product
 * @param {string} [sku] variant SKU on the order line
 * @returns {{ code?: string, invalid?: string }} `{}` when the product declares no code.
 */
export function readVbndCode(product, sku) {
  const variant = Array.isArray(product?.variants)
    ? product.variants.find((v) => v?.sku === sku)
    : undefined;
  const sources = [
    ['variant', variant?.custom?.vbndCode],
    ['product', product?.custom?.vbndCode],
  ];
  for (const [source, value] of sources) {
    const code = String(value ?? '').trim();
    if (code) {
      return VBND_CODE_PATTERN.test(code)
        ? { code }
        : { invalid: `${source} custom.vbndCode "${code}" is not a VBND code` };
    }
  }
  return {};
}

/**
 * Resolve the VBND code of every virtual bundle on an order.
 *
 * @param {{ env: { ORG: string, SITE: string }, log?: Console }} ctx
 * @param {{ id?: string, items?: object[] }} order the stored order
 * @param {{ fetchProduct?: typeof fetchBundleProduct }} [deps] injectable I/O (tests)
 * @returns {Promise<{ codes: Map<object, string>, issues: string[], missing: string[] }>}
 *   codes: bundle parent line (the `order.items` object) -> code;
 *   issues: product data problems (a value that is not a VBND code), for a person to fix;
 *   missing: bundle lines for which no code could be found anywhere.
 * @throws {Error} a retriable error when a product cannot be read and the bundle has no
 *   static fallback; the caller retries the order later.
 */
export async function resolveVbndCodes(ctx, order, { fetchProduct = fetchBundleProduct } = {}) {
  const result = { codes: new Map(), issues: [], missing: [] };
  const bundles = (order.items ?? []).filter((item) => !item.custom?.linkedTo && item.bundleItems?.length);
  if (bundles.length === 0) return result;

  // One read per distinct product, however many lines or colours of it are ordered.
  const paths = [...new Set(bundles.map((item) => normalizeProductPath(item.path)).filter(Boolean))];
  const products = new Map();
  await Promise.all(paths.map(async (path) => {
    try {
      products.set(path, await fetchProduct(ctx, path));
    } catch (err) {
      products.set(path, err);
    }
  }));

  for (const item of bundles) {
    const label = `${item.path} (${item.sku})`;
    const fallback = resolveVbndReasonCode(item);
    const product = products.get(normalizeProductPath(item.path));
    let code = '';

    if (product instanceof Error) {
      if (!fallback) {
        product.message = `Order ${order.id}: VBND lookup for ${label} failed: ${product.message}`;
        // Lets the sync label the failure (it is the product host, not EBS).
        product.vbndLookup = true;
        throw product;
      }
      ctx.log?.warn?.(`[ebs-sync] Order ${order.id}: could not read ${item.path} (${product.message}); using the built-in VBND code ${fallback}.`);
      code = fallback;
    } else if (product) {
      const read = readVbndCode(product, item.sku);
      if (read.invalid) result.issues.push(`${label}: ${read.invalid}`);
      code = read.code || fallback;
    } else {
      code = fallback;
    }

    if (code) result.codes.set(item, code);
    else result.missing.push(label);
  }
  return result;
}
