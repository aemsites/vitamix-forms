/**
 * Unit tests for the commerce API helpers in ebs-sync/commerce.js.
 */

import {
  describe, test, expect, beforeEach, afterAll,
} from '@jest/globals';
import { getActivePromotionNames } from '../../src/actions/ebs-sync/commerce.js';

const PARAMS = {
  EDGE_COMMERCE_API_BASE: 'https://api.example.com',
  EDGE_COMMERCE_API_ORDERS_TOKEN: 'orders-token',
  ORG: 'org',
  SITE: 'site',
};

const origFetch = global.fetch;
let calls;

function mockFetch(status, body) {
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

beforeEach(() => {
  calls = [];
});

afterAll(() => {
  global.fetch = origFetch;
});

describe('getActivePromotionNames', () => {
  test('reads the public active catalog without a token', async () => {
    mockFetch(200, { promotions: [] });
    await getActivePromotionNames(PARAMS);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/org/sites/site/price-rules/catalog?active=true');
    expect(calls[0].init.headers).toBeUndefined();
  });

  test('maps promotion ids to names, skipping malformed entries', async () => {
    mockFetch(200, {
      promotions: [
        { id: 'a', name: 'Promo A' },
        { id: 'b' },
        { id: 7, name: 'Numeric id' },
        { id: 'c', name: { en: 'Object' } },
        null,
        { id: 'd', name: 'Promo D' },
      ],
    });
    const names = await getActivePromotionNames(PARAMS);
    expect([...names]).toEqual([['a', 'Promo A'], ['d', 'Promo D']]);
  });

  test.each([
    ['no promotions field', {}],
    ['a non-array promotions field', { promotions: 'x' }],
    ['a null body', null],
  ])('returns an empty map for %s', async (_label, body) => {
    mockFetch(200, body);
    expect((await getActivePromotionNames(PARAMS)).size).toBe(0);
  });

  test('throws on a non-2xx response', async () => {
    mockFetch(503, { error: 'down' });
    await expect(getActivePromotionNames(PARAMS)).rejects.toThrow('Price rules API 503');
  });
});
