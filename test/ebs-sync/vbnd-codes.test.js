/**
 * Unit tests for the virtual-bundle VBND product lookup used by the EBS sync.
 */

import { describe, test, expect, jest } from '@jest/globals';
import {
  VBND_CODE_PATTERN,
  PRODUCT_LOOKUP_TIMEOUT_MS,
  PRODUCT_HOST,
  normalizeProductPath,
  isProductPath,
  fetchBundleProduct,
  readVbndCode,
  resolveVbndCodes,
} from '../../src/actions/ebs-sync/vbnd-codes.js';
import { isRetriableError } from '../../src/actions/ebs-sync/ebs.js';

const CTX = { env: { ORG: 'aemsites', SITE: 'vitamix' } };
const SS_PATH = '/us/en_us/products/propel-750-plus-stainless-steel-container';
const NEW_PATH = '/us/en_us/products/brand-new-bundle';

const bundleLine = (overrides = {}) => ({
  sku: '071395-VB',
  path: SS_PATH,
  quantity: 1,
  price: { final: '629.95' },
  bundleItems: [{ sku: '067891-VB', quantity: 1 }, { sku: '071395-VB', quantity: 1 }],
  ...overrides,
});
const order = (...items) => ({ id: 'om1', items });
const product = ({ variants, custom } = {}) => ({ variants, ...(custom ? { custom } : {}) });
const withCode = (sku, code) => ({ sku, custom: { vbndCode: code } });

describe('normalizeProductPath', () => {
  test.each([
    ['/us/en_us/products/x', '/us/en_us/products/x'],
    ['/us/en_us/products/x.json', '/us/en_us/products/x'],
    ['/us/en_us/products/x/', '/us/en_us/products/x'],
    ['/us/en_us/products/x?a=1', '/us/en_us/products/x'],
    [undefined, ''],
    [null, ''],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeProductPath(input)).toBe(expected);
  });
});

describe('isProductPath', () => {
  test.each([
    '/us/en_us/products/propel-750-classic-bundle',
    '/ca/fr_ca/products/ascent-x5-deluxe-smartprep-kitchen-system',
    '/us/en_us/products/x.y_z-1',
  ])('accepts %s', (path) => {
    expect(isProductPath(path)).toBe(true);
  });

  test.each([
    // would change the host the product is read from
    ['a host suffix', '.attacker.example/x'],
    ['credentials', '@attacker.example/x'],
    ['a protocol-relative path', '//attacker.example/x'],
    ['a port', ':8080/x'],
    // would leave the product directory
    ['a parent segment', '/us/en_us/products/../../x'],
    ['an encoded parent segment', '/us/%2e%2e/x'],
    ['a backslash', '/us\\..\\x'],
    // not a path
    ['no leading slash', 'us/en_us/products/x'],
    ['whitespace', '/us/en_us/products/a b'],
    ['an empty string', ''],
  ])('rejects %s', (_label, path) => {
    expect(isProductPath(path)).toBe(false);
  });
});

describe('VBND_CODE_PATTERN', () => {
  test.each(['VBND1', 'VBND17', 'VBND17.1', 'VBND19.12'])('accepts %s', (code) => {
    expect(VBND_CODE_PATTERN.test(code)).toBe(true);
  });

  test.each(['', 'vbnd17', 'VBND', 'VBND17.', 'VBND17.a', 'VBNDP750', ' VBND17', '17'])('rejects "%s"', (code) => {
    expect(VBND_CODE_PATTERN.test(code)).toBe(false);
  });
});

describe('readVbndCode', () => {
  test('reads the code of the ordered variant', () => {
    const p = product({ variants: [withCode('a-VB', 'VBND17'), withCode('b-VB', 'VBND17.1')] });
    expect(readVbndCode(p, 'b-VB')).toEqual({ code: 'VBND17.1' });
  });

  test('falls back to the product-level code when the variant declares none', () => {
    const p = product({ variants: [{ sku: 'a-VB' }], custom: { vbndCode: 'VBND7' } });
    expect(readVbndCode(p, 'a-VB')).toEqual({ code: 'VBND7' });
  });

  test('uses the product-level code when the product has no variants', () => {
    expect(readVbndCode(product({ custom: { vbndCode: 'VBND7' } }), 'x')).toEqual({ code: 'VBND7' });
  });

  test('the variant code wins over the product code', () => {
    const p = product({ variants: [withCode('a-VB', 'VBND17')], custom: { vbndCode: 'VBND99' } });
    expect(readVbndCode(p, 'a-VB')).toEqual({ code: 'VBND17' });
  });

  test('trims the value', () => {
    expect(readVbndCode(product({ variants: [withCode('a-VB', '  VBND17 ')] }), 'a-VB')).toEqual({ code: 'VBND17' });
  });

  test('a variant of another SKU does not supply the code', () => {
    expect(readVbndCode(product({ variants: [withCode('a-VB', 'VBND17')] }), 'z-VB')).toEqual({});
  });

  test.each([
    ['blank', '   '],
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
  ])('a %s value declares nothing', (_label, value) => {
    expect(readVbndCode(product({ variants: [withCode('a-VB', value)] }), 'a-VB')).toEqual({});
  });

  test('a value that is not a VBND code is reported and not used, even if the product has a valid one', () => {
    const p = product({ variants: [withCode('a-VB', 'VBNDP750')], custom: { vbndCode: 'VBND7' } });
    expect(readVbndCode(p, 'a-VB')).toEqual({
      invalid: 'variant custom.vbndCode "VBNDP750" is not a VBND code',
    });
  });

  test('reports an invalid product-level value', () => {
    expect(readVbndCode(product({ custom: { vbndCode: '17' } }), 'a')).toEqual({
      invalid: 'product custom.vbndCode "17" is not a VBND code',
    });
  });

  test('returns {} for a missing product', () => {
    expect(readVbndCode(undefined, 'a')).toEqual({});
    expect(readVbndCode(null, 'a')).toEqual({});
  });
});

describe('fetchBundleProduct', () => {
  const respond = (status, body) => jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));

  test('reads the product from www.vitamix.com, cache-busted', async () => {
    const fetchImpl = respond(200, { sku: 'VBND' });
    const result = await fetchBundleProduct(CTX, `${SS_PATH}.json`, fetchImpl);
    expect(result).toEqual({ sku: 'VBND' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(PRODUCT_HOST).toBe('https://www.vitamix.com');
    expect(url).toMatch(
      new RegExp(`^https://www\\.vitamix\\.com${SS_PATH}\\.json\\?_=\\d+$`),
    );
    expect(new URL(url).host).toBe('www.vitamix.com');
    expect(init.headers['Cache-Control']).toBe('no-cache');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('returns null for a product that does not exist', async () => {
    expect(await fetchBundleProduct(CTX, SS_PATH, respond(404))).toBeNull();
  });

  test.each(['.attacker.example/x', '@attacker.example/x', '//attacker.example/x', '/us/../x'])(
    'never requests a path that is not a product path (%s)',
    async (path) => {
      const fetchImpl = respond(200, { custom: { vbndCode: 'VBND99' } });
      expect(await fetchBundleProduct(CTX, path, fetchImpl)).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test.each([500, 502, 503, 429, 403])('throws on HTTP %s, carrying the status', async (status) => {
    const err = await fetchBundleProduct(CTX, SS_PATH, respond(status)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.response).toEqual({ statusCode: status });
    expect(err.message).toContain(`returned ${status}`);
  });

  test('lets a network error propagate', async () => {
    const fetchImpl = jest.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(fetchBundleProduct(CTX, SS_PATH, fetchImpl)).rejects.toThrow('fetch failed');
  });

  test('uses a timeout that is shorter than the action budget', () => {
    expect(PRODUCT_LOOKUP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PRODUCT_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('resolveVbndCodes', () => {
  // DOMException (what a fetch timeout rejects with) is not an instance of the
  // test realm's Error, so it is checked separately.
  const productFetch = (products) => jest.fn(async (_ctx, path) => {
    const entry = products[path];
    if (entry instanceof Error || entry instanceof DOMException) throw entry;
    return entry ?? null;
  });

  test('does nothing, and reads nothing, for an order without a virtual bundle', async () => {
    const fetchProduct = jest.fn();
    const simple = { sku: '068051-04', path: '/us/en_us/products/x', quantity: 1, price: { final: '1' } };
    const result = await resolveVbndCodes(CTX, order(simple), { fetchProduct });
    expect(result).toEqual({
      codes: new Map(), issues: [], missing: [], fallbacks: [],
    });
    expect(fetchProduct).not.toHaveBeenCalled();
  });

  test('uses the code on the ordered variant', async () => {
    const line = bundleLine({ sku: '073294-VB' });
    const fetchProduct = productFetch({
      [SS_PATH]: product({ variants: [withCode('071395-VB', 'VBND17'), withCode('073294-VB', 'VBND17.1')] }),
    });
    const { codes, issues, missing } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(codes.get(line)).toBe('VBND17.1');
    expect(issues).toEqual([]);
    expect(missing).toEqual([]);
  });

  test('uses the product-level code for a bundle where one code covers every variant', async () => {
    const line = bundleLine({ path: NEW_PATH, sku: 'whatever-VB' });
    const fetchProduct = productFetch({ [NEW_PATH]: product({ custom: { vbndCode: 'VBND30' } }) });
    const { codes } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(codes.get(line)).toBe('VBND30');
  });

  test('product data wins over the built-in map', async () => {
    // 071395-VB on this bundle is VBND17 in the built-in map
    const line = bundleLine();
    const fetchProduct = productFetch({ [SS_PATH]: product({ variants: [withCode('071395-VB', 'VBND77')] }) });
    const { codes } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(codes.get(line)).toBe('VBND77');
  });

  test('a bundle that has no built-in code is covered by its product data alone', async () => {
    const line = bundleLine({ path: NEW_PATH, sku: 'new-VB' });
    const fetchProduct = productFetch({ [NEW_PATH]: product({ variants: [withCode('new-VB', 'VBND31')] }) });
    const { codes, missing } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(codes.get(line)).toBe('VBND31');
    expect(missing).toEqual([]);
  });

  test('falls back to the built-in map when the product declares no code', async () => {
    const line = bundleLine();
    const fetchProduct = productFetch({ [SS_PATH]: product({ variants: [{ sku: '071395-VB' }] }) });
    const { codes, missing } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(codes.get(line)).toBe('VBND17');
    expect(missing).toEqual([]);
  });

  test('falls back to the built-in map when the product does not exist (404)', async () => {
    const line = bundleLine();
    const { codes } = await resolveVbndCodes(CTX, order(line), { fetchProduct: productFetch({}) });
    expect(codes.get(line)).toBe('VBND17');
  });

  test('reports a bundle with no code anywhere as missing and sends no code', async () => {
    const line = bundleLine({ path: NEW_PATH, sku: 'new-VB' });
    const fetchProduct = productFetch({ [NEW_PATH]: product({ variants: [{ sku: 'new-VB' }] }) });
    const { codes, issues, missing } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(codes.size).toBe(0);
    expect(issues).toEqual([]);
    expect(missing).toEqual([`${NEW_PATH} (new-VB)`]);
  });

  test('reports a bundle whose product does not exist and has no built-in code as missing', async () => {
    const line = bundleLine({ path: NEW_PATH, sku: 'new-VB' });
    const { missing } = await resolveVbndCodes(CTX, order(line), { fetchProduct: productFetch({}) });
    expect(missing).toEqual([`${NEW_PATH} (new-VB)`]);
  });

  test('reports a value that is not a VBND code, and falls back to the built-in map', async () => {
    const line = bundleLine();
    const fetchProduct = productFetch({ [SS_PATH]: product({ variants: [withCode('071395-VB', 'VBNDP750SS')] }) });
    const { codes, issues, missing } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(codes.get(line)).toBe('VBND17');
    expect(issues).toEqual([`${SS_PATH} (071395-VB): variant custom.vbndCode "VBNDP750SS" is not a VBND code`]);
    expect(missing).toEqual([]);
  });

  test('reports an invalid value as an issue and the bundle as missing when there is no built-in code', async () => {
    const line = bundleLine({ path: NEW_PATH, sku: 'new-VB' });
    const fetchProduct = productFetch({ [NEW_PATH]: product({ variants: [withCode('new-VB', 'oops')] }) });
    const { codes, issues, missing } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(codes.size).toBe(0);
    expect(issues).toHaveLength(1);
    expect(missing).toEqual([`${NEW_PATH} (new-VB)`]);
  });

  test('uses the built-in code and reports the fallback when the product cannot be read', async () => {
    const line = bundleLine();
    const err = Object.assign(new Error('product lookup returned 503'), { response: { statusCode: 503 } });
    const {
      codes, issues, missing, fallbacks,
    } = await resolveVbndCodes(CTX, order(line), {
      fetchProduct: productFetch({ [SS_PATH]: err }),
    });
    expect(codes.get(line)).toBe('VBND17');
    expect(issues).toEqual([]);
    expect(missing).toEqual([]);
    expect(fallbacks).toEqual([
      `${SS_PATH} (071395-VB): product lookup returned 503; sent the built-in code VBND17`,
    ]);
  });

  test('reports a fallback after a timeout (a read-only DOMException) without throwing', async () => {
    const line = bundleLine();
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { codes, fallbacks } = await resolveVbndCodes(CTX, order(line), {
      fetchProduct: productFetch({ [SS_PATH]: timeout }),
    });
    expect(codes.get(line)).toBe('VBND17');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toContain('aborted due to timeout');
  });

  test('reports no fallback when the product was read', async () => {
    const line = bundleLine();
    const fetchProduct = productFetch({ [SS_PATH]: product({ variants: [{ sku: '071395-VB' }] }) });
    const { fallbacks } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(fallbacks).toEqual([]);
  });

  test.each([
    ['a 503', Object.assign(new Error('product lookup returned 503'), { response: { statusCode: 503 } })],
    ['a 429', Object.assign(new Error('product lookup returned 429'), { response: { statusCode: 429 } })],
    ['a timeout', new Error('The operation was aborted due to timeout')],
    ['a network error', new Error('fetch failed')],
  ])('throws a retriable error when the product cannot be read (%s) and there is no built-in code', async (_label, err) => {
    const line = bundleLine({ path: NEW_PATH, sku: 'new-VB' });
    const thrown = await resolveVbndCodes(CTX, order(line), {
      fetchProduct: productFetch({ [NEW_PATH]: err }),
    }).catch((e) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.cause).toBe(err);
    expect(thrown.message).toBe(`Order om1: VBND lookup for ${NEW_PATH} (new-VB) failed: ${err.message}`);
    expect(isRetriableError(thrown)).toBe(true);
    expect(thrown.vbndLookup).toBe(true);
    // the caught error is never modified
    expect(err.vbndLookup).toBeUndefined();
    expect(err.message).not.toContain('VBND lookup');
  });

  test('a real fetch timeout (read-only DOMException) is wrapped into a retriable vbnd_lookup error', async () => {
    const line = bundleLine({ path: NEW_PATH, sku: 'new-VB' });
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    // the bug this guards against: DOMException.message cannot be assigned
    expect(() => { 'use strict'; timeout.message = 'x'; }).toThrow(TypeError);
    const thrown = await resolveVbndCodes(CTX, order(line), {
      fetchProduct: productFetch({ [NEW_PATH]: timeout }),
    }).catch((e) => e);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(thrown.cause).toBe(timeout);
    expect(thrown.vbndLookup).toBe(true);
    expect(thrown.message).toContain('aborted due to timeout');
    expect(isRetriableError(thrown)).toBe(true);
  });

  test('keeps the HTTP status on the wrapped error, so a 403 is not retried', async () => {
    const line = bundleLine({ path: NEW_PATH, sku: 'new-VB' });
    const err = Object.assign(new Error('product lookup returned 403'), { response: { statusCode: 403 } });
    const thrown = await resolveVbndCodes(CTX, order(line), {
      fetchProduct: productFetch({ [NEW_PATH]: err }),
    }).catch((e) => e);
    expect(thrown.response).toEqual({ statusCode: 403 });
    expect(thrown.vbndLookup).toBe(true);
    expect(isRetriableError(thrown)).toBe(false);
  });

  test('reads each distinct product once, however many lines of it are ordered', async () => {
    const black = bundleLine({ sku: '071395-VB' });
    const red = bundleLine({ sku: '073294-VB' });
    const other = bundleLine({ path: NEW_PATH, sku: 'new-VB' });
    const fetchProduct = productFetch({
      [SS_PATH]: product({ variants: [withCode('071395-VB', 'VBND17'), withCode('073294-VB', 'VBND17.1')] }),
      [NEW_PATH]: product({ variants: [withCode('new-VB', 'VBND31')] }),
    });
    const { codes } = await resolveVbndCodes(CTX, order(black, red, other), { fetchProduct });
    expect(fetchProduct).toHaveBeenCalledTimes(2);
    expect([black, red, other].map((line) => codes.get(line))).toEqual(['VBND17', 'VBND17.1', 'VBND31']);
  });

  test('matches a path that carries a .json suffix to its product', async () => {
    const line = bundleLine({ path: `${SS_PATH}.json` });
    const fetchProduct = productFetch({ [SS_PATH]: product({ variants: [withCode('071395-VB', 'VBND88')] }) });
    const { codes } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(codes.get(line)).toBe('VBND88');
  });

  test('ignores warranty lines linked to a bundle and lines without bundleItems', async () => {
    const line = bundleLine();
    const warranty = bundleLine({ custom: { linkedTo: '071395-VB' } });
    const empty = bundleLine({ bundleItems: [] });
    const fetchProduct = productFetch({ [SS_PATH]: product({ variants: [withCode('071395-VB', 'VBND17')] }) });
    const { codes } = await resolveVbndCodes(CTX, order(warranty, empty, line), { fetchProduct });
    expect([...codes.keys()]).toEqual([line]);
  });

  test('never reads a path that is not a product path; reports it and uses the built-in code', async () => {
    // the built-in map has a code for this url-key, so the order still gets it
    const line = bundleLine({ path: '.attacker.example/products/propel-750-plus-stainless-steel-container' });
    const fetchProduct = jest.fn();
    const { codes, issues, missing } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(fetchProduct).not.toHaveBeenCalled();
    expect(codes.get(line)).toBe('VBND17');
    expect(issues).toEqual([
      '.attacker.example/products/propel-750-plus-stainless-steel-container (071395-VB): the order line path is not a product path; not looked up',
    ]);
    expect(missing).toEqual([]);
  });

  test('a bundle line without a path falls back to the built-in map, which has no entry for it', async () => {
    const line = bundleLine({ path: undefined });
    const fetchProduct = jest.fn();
    const { codes, missing } = await resolveVbndCodes(CTX, order(line), { fetchProduct });
    expect(fetchProduct).not.toHaveBeenCalled();
    expect(codes.size).toBe(0);
    expect(missing).toEqual(['undefined (071395-VB)']);
  });

  test('resolves several bundles on one order independently', async () => {
    const good = bundleLine();
    const broken = bundleLine({ path: NEW_PATH, sku: 'new-VB' });
    const fetchProduct = productFetch({
      [SS_PATH]: product({ variants: [withCode('071395-VB', 'VBND17')] }),
      [NEW_PATH]: product({ variants: [{ sku: 'new-VB' }] }),
    });
    const { codes, missing } = await resolveVbndCodes(CTX, order(good, broken), { fetchProduct });
    expect(codes.get(good)).toBe('VBND17');
    expect(codes.has(broken)).toBe(false);
    expect(missing).toEqual([`${NEW_PATH} (new-VB)`]);
  });
});
