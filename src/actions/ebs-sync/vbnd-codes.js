/**
 * Virtual-bundle Discount Reason Code (VBND) lookup for the EBS sync.
 *
 * The code lives with the bundle in the Product Bus: `custom.vbndCode` on the
 * ordered variant (codes are per colour/variant, e.g. VBND17, VBND17.1) or, for
 * a bundle where one code covers every variant, on the product itself. When an
 * order holds a virtual bundle the sync reads that product's published JSON from
 * www.vitamix.com and takes the code from the variant whose SKU is on the order
 * line, then from the product.
 *
 * Resolution order for each bundle line:
 *   1. the product's `custom.vbndCode` (variant first, then product);
 *   2. the static map in discount-reason-codes.js, the fallback while product
 *      data is being filled in (and the safety net when the product host is down);
 *   3. nothing: the line is reported as `missing` and the order is sent without a
 *      code, so a bundle that has no code is never silent.
 *
 * A product that cannot be read at all (timeout, 5xx) and has no static code is
 * retried later, because sending the order would silently drop the code. When it
 * has a static code, that code is used and the fallback is reported, so a product
 * host that cannot be reached does not go unnoticed.
 */

import { resolveVbndReasonCode } from './discount-reason-codes.js';

/** A VBND code as stored on the product: `VBND17`, `VBND17.1`. */
export const VBND_CODE_PATTERN = /^VBND[0-9]+(?:\.[0-9]+)*$/;

/** How long to wait for the product host before giving up on the lookup. */
export const PRODUCT_LOOKUP_TIMEOUT_MS = 8_000;

/**
 * Where the sync reads published product JSON. The production domain, because
 * the runtime cannot reach the aem.network host (see feeds/build.js and commit
 * 5a58040); it serves the same `<path>.json` documents.
 */
export const PRODUCT_HOST = 'https://www.vitamix.com';

/** A product path: a leading `/`, then only URL path characters, no `..` or `//`. */
const PRODUCT_PATH_PATTERN = /^\/[A-Za-z0-9_\-./]+$/;

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
 * Whether a normalized path is safe to append to the product host: it can only
 * address a path on PRODUCT_HOST, never another host (e.g. `.attacker.example/x`
 * or `@attacker.example/x`) or a parent directory.
 *
 * @param {string} path normalized product path
 * @returns {boolean}
 */
export function isProductPath(path) {
  return PRODUCT_PATH_PATTERN.test(path)
    && !path.includes('//')
    && !path.split('/').includes('..');
}

/**
 * Read a bundle product's published JSON from the product host.
 *
 * @param {object} _ctx unused; kept so callers and tests share one signature
 * @param {string} path product path, e.g. `/us/en_us/products/vx3-plus-24-ounce-tumbler`
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object | null>} the product, or null when it does not exist or the
 *   path is not a product path.
 * @throws {Error} on a network error, a timeout or any other HTTP status; the error
 *   carries `response.statusCode` for HTTP failures so isRetriableError can classify it.
 */
export async function fetchBundleProduct(_ctx, path, fetchImpl = fetch) {
  const productPath = normalizeProductPath(path);
  if (!isProductPath(productPath)) return null;
  // Cache-busted, so a code published in the product admin is seen on the next
  // order rather than when the CDN entry expires.
  const url = `${PRODUCT_HOST}${productPath}.json?_=${Date.now()}`;
  const res = await fetchImpl(url, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(PRODUCT_LOOKUP_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`product lookup ${productPath} returned ${res.status}`);
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
 * @param {object} ctx action context (passed through to fetchProduct)
 * @param {{ id?: string, items?: object[] }} order the stored order
 * @param {{ fetchProduct?: typeof fetchBundleProduct }} [deps] injectable I/O (tests)
 * @returns {Promise<{
 *   codes: Map<object, string>, issues: string[], missing: string[], fallbacks: string[]
 * }>}
 *   codes: bundle parent line (the `order.items` object) -> code;
 *   issues: data problems for a person to fix (a value that is not a VBND code, or an
 *   order line path that is not a product path);
 *   missing: bundle lines for which no code could be found anywhere;
 *   fallbacks: bundle lines whose product could not be read, sent with the built-in code.
 * @throws {Error} a retriable error (`vbndLookup: true`, the read failure as `cause`)
 *   when a product cannot be read and the bundle has no static fallback; the caller
 *   retries the order later.
 */
export async function resolveVbndCodes(ctx, order, { fetchProduct = fetchBundleProduct } = {}) {
  const result = {
    codes: new Map(), issues: [], missing: [], fallbacks: [],
  };
  const bundles = (order.items ?? []).filter((item) => !item.custom?.linkedTo && item.bundleItems?.length);
  if (bundles.length === 0) return result;

  // One read per distinct product, however many lines or colours of it are ordered.
  // A path that is not a product path is never fetched (it could address another host).
  const paths = [...new Set(bundles.map((item) => normalizeProductPath(item.path)))]
    .filter(isProductPath);
  // path -> { product } | { error }. Kept apart explicitly rather than by
  // `instanceof Error`: a timeout rejects with a DOMException, which is not an
  // instance of this module's Error in every realm.
  const reads = new Map();
  await Promise.all(paths.map(async (path) => {
    try {
      reads.set(path, { product: await fetchProduct(ctx, path) });
    } catch (error) {
      reads.set(path, { error });
    }
  }));

  for (const item of bundles) {
    const label = `${item.path} (${item.sku})`;
    const fallback = resolveVbndReasonCode(item);
    const path = normalizeProductPath(item.path);
    const { product, error } = reads.get(path) ?? {};
    let code = '';

    if (path && !isProductPath(path)) {
      result.issues.push(`${label}: the order line path is not a product path; not looked up`);
    }

    if (error) {
      const reason = error?.message ?? String(error);
      if (!fallback) {
        // Wrap rather than mutate: a timeout rejects with a DOMException, whose
        // message is read-only. The wrapped message keeps the original text, so
        // isRetriableError still recognizes a timeout or a network failure.
        const err = new Error(`Order ${order.id}: VBND lookup for ${label} failed: ${reason}`, { cause: error });
        if (error?.response) err.response = error.response;
        // Lets the sync label the failure (it is the product host, not EBS).
        err.vbndLookup = true;
        throw err;
      }
      result.fallbacks.push(`${label}: ${reason}; sent the built-in code ${fallback}`);
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
