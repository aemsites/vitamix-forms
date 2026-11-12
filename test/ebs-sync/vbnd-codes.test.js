/**
 * Unit tests for the virtual-bundle VBND product lookup used by the EBS sync.
 */

import { describe, test, expect, jest, afterEach } from '@jest/globals';
import {
  VBND_CODE_PATTERN,
  PRODUCT_LOOKUP_TIMEOUT_MS,
  normalizeProductPath,
  fetchBundleProduct,
  readVbndCode,
  resolveVbndCodes,
} from '../../src/actions/ebs-sync/vbnd-codes.js';
import { isRetriableError } from '../../src/actions/ebs-sync/ebs.js';

const CTX = { env: { ORG: 'aemsites', SITE: 'vitamix' }, log: { warn: jest.fn() } };
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

afterEach(() => {
  CTX.log.warn.mockClear();
});

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

  test('reads the product from the public product host, cache-busted', async () => {
    const fetchImpl = respond(200, { sku: 'VBND' });
    const result = await fetchBundleProduct(CTX, `${SS_PATH}.json`, fetchImpl);
    expect(result).toEqual({ sku: 'VBND' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(
      new RegExp(`^https://main--vitamix--aemsites\\.aem\\.network${SS_PATH}\\.json\\?_=\\d+$`),
    );
    expect(init.headers['Cache-Control']).toBe('no-cache');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('returns null for a product that does not exist', async () => {
    expect(await fetchBundleProduct(CTX, SS_PATH, respond(404))).toBeNull();
  });

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
  const productFetch = (products) => jest.fn(async (_ctx, path) => {
    const entry = products[path];
    if (entry instanceof Error) throw entry;
    return entry ?? null;
  });

  test('does nothing, and reads nothing, for an order without a virtual bundle', async () => {
    const fetchProduct = jest.fn();
    const simple = { sku: '068051-04', path: '/us/en_us/products/x', quantity: 1, price: { final: '1' } };
    const result = await resolveVbndCodes(CTX, order(simple), { fetchProduct });
    expect(result).toEqual({ codes: new Map(), issues: [], missing: [] });
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

  test('uses the built-in code and warns when the product cannot be read', async () => {
    const line = bundleLine();
    const err = Object.assign(new Error('product lookup returned 503'), { response: { statusCode: 503 } });
    const { codes, issues, missing } = await resolveVbndCodes(CTX, order(line), {
      fetchProduct: productFetch({ [SS_PATH]: err }),
    });
    expect(codes.get(line)).toBe('VBND17');
    expect(issues).toEqual([]);
    expect(missing).toEqual([]);
    expect(CTX.log.warn).toHaveBeenCalledTimes(1);
    expect(CTX.log.warn.mock.calls[0][0]).toContain('using the built-in VBND code VBND17');
  });

  test('does not need a logger to fall back', async () => {
    const line = bundleLine();
    const err = new Error('fetch failed');
    const { codes } = await resolveVbndCodes({ env: CTX.env }, order(line), {
      fetchProduct: productFetch({ [SS_PATH]: err }),
    });
    expect(codes.get(line)).toBe('VBND17');
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
    expect(thrown).toBe(err);
    expect(thrown.message).toContain(`Order om1: VBND lookup for ${NEW_PATH} (new-VB) failed`);
    expect(isRetriableError(thrown)).toBe(true);
    expect(thrown.vbndLookup).toBe(true);
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
