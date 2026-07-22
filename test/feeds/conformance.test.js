/**
 * Conformance tests: compare the feeds action's output against the reference
 * feeds currently produced for each provider (test/feeds/fixtures/expected-*.xml).
 *
 * The reference `expected-google.xml` is itself a Google Merchant `g:` feed, so
 * it doubles as the SOURCE the action transforms — we feed it in and compare the
 * action's per-provider output to the corresponding reference fixture.
 *
 * Findings are encoded two ways:
 *   - `test(...)`          — behaviour that already conforms (guards regressions).
 *   - `test.failing(...)`  — a KNOWN divergence we still owe. It stays green while
 *                            the gap exists and flips red once fixed, prompting us
 *                            to promote it to a normal test. Each is labelled
 *                            CRITICAL (breaks ingestion/continuity) or BENIGN.
 */
import {
  describe, test, expect, jest, beforeAll, afterEach,
} from '@jest/globals';
import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { main } from '../../src/actions/feeds/index.js';

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });
const norm = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');

/** Parse any of the feed shapes into a comparable structure. */
function parseFeed(xml) {
  const namespaced = /<g:/.test(xml);
  const root = /<feed[\s>]/i.test(xml) ? 'feed' : (/<Feed[\s>]/.test(xml) ? 'Feed' : 'rss');
  const doc = parser.parse(xml);
  const container = doc?.rss?.channel ?? doc?.feed ?? doc?.rss ?? {};
  const raw = container.item ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const fields = new Set();
  const byTitle = new Map();
  for (const it of arr) {
    const o = {};
    for (const [k, v] of Object.entries(it)) {
      o[k] = Array.isArray(v) ? v.map(norm) : norm(v);
      fields.add(k);
    }
    byTitle.set(norm(o.title), o);
  }
  return {
    root, namespaced, count: arr.length, fields, byTitle,
  };
}

const GOOGLE_SOURCE = fixture('expected-google.xml');

/** Run the action for a provider, using the google fixture as the source feed. */
async function outputFor(provider, source = GOOGLE_SOURCE) {
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => source });
  const res = await main({ __ow_method: 'GET', provider, LOG_LEVEL: 'error' });
  expect(res.statusCode).toBe(200);
  return parseFeed(res.body);
}

// The merchant fields the action carries through today and that every provider
// fixture also contains.
const SHARED_FIELDS = [
  'id', 'title', 'description', 'link', 'image_link',
  'condition', 'availability', 'price', 'brand', 'gtin', 'identifier_exists',
];
const SAMPLE = 'Under Blade Scraper';

afterEach(() => jest.restoreAllMocks());

describe.each([
  // meta reuses the pinterest fixture (same non-namespaced <rss> format)
  ['meta', 'expected-pinterest.xml'],
  ['pinterest', 'expected-pinterest.xml'],
])('conformance: %s', (provider, expectedFile) => {
  let mine;
  const exp = parseFeed(fixture(expectedFile));
  beforeAll(async () => { mine = await outputFor(provider); });

  test('produces one item per source product', () => {
    expect(mine.count).toBe(exp.count);
  });

  test('carries the shared merchant fields', () => {
    for (const f of SHARED_FIELDS) expect(mine.fields.has(f)).toBe(true);
  });

  test('preserves gtin verbatim (leading zeros intact)', () => {
    expect(mine.byTitle.get(SAMPLE).gtin).toBe(exp.byTitle.get(SAMPLE).gtin);
  });

  test('emits non-namespaced tags (meta/pinterest feed omits g:)', () => {
    expect(mine.namespaced).toBe(false);
  });

  test.failing('id is the SKU, not the product name', () => {
    // Source-driven: the google fixture uses the name as id ("Under Blade
    // Scraper") vs the reference SKU ("064584"). The live helix feed already
    // sets id = sku, so this resolves in production.
    expect(mine.byTitle.get(SAMPLE).id).toBe(exp.byTitle.get(SAMPLE).id);
  });

  test.failing('carries product_type (Pinterest requires it)', () => {
    // Empty here only because the google source fixture lacks product_type;
    // resolved once the indexer populates it (helix-product-indexer#41).
    expect(mine.byTitle.get(SAMPLE).product_type).toBe(exp.byTitle.get(SAMPLE).product_type);
  });
});

describe('conformance: cj', () => {
  let mine;
  const exp = parseFeed(fixture('expected-cj.xml'));
  beforeAll(async () => { mine = await outputFor('cj'); });

  test('produces one item per source product', () => {
    expect(mine.count).toBe(exp.count);
  });

  test('carries the shared merchant fields', () => {
    for (const f of SHARED_FIELDS) expect(mine.fields.has(f)).toBe(true);
  });

  test('uses a <feed> root element', () => {
    expect(mine.root).toBe('feed');
  });

  test('emits non-namespaced tags (CJ feed omits g:)', () => {
    expect(mine.namespaced).toBe(false);
  });

  test('excludes google_product_category (not part of the CJ feed)', () => {
    expect(mine.fields.has('google_product_category')).toBe(false);
  });

  test.failing('id is the SKU, not the product name', () => {
    // Source-driven — see the meta/pinterest note; resolves with the helix feed.
    expect(mine.byTitle.get(SAMPLE).id).toBe(exp.byTitle.get(SAMPLE).id);
  });
});

describe('benign differences (documented, not bugs)', () => {
  let mine;
  const exp = parseFeed(fixture('expected-pinterest.xml'));
  beforeAll(async () => { mine = await outputFor('pinterest'); });

  test('description is fuller than the reference (name-only) — an improvement', () => {
    const m = mine.byTitle.get(SAMPLE).description;
    const e = exp.byTitle.get(SAMPLE).description;
    expect(m.length).toBeGreaterThan(e.length);
  });

  test('mpn is populated where the reference left it empty — an improvement', () => {
    expect(mine.byTitle.get(SAMPLE).mpn).not.toBe('');
    expect(exp.byTitle.get(SAMPLE).mpn).toBe('');
  });
});

describe('unsupported providers (gaps to close)', () => {
  test('google is not served — Google Ads reads from linked Merchant Center', async () => {
    const res = await main({ __ow_method: 'GET', provider: 'google', LOG_LEVEL: 'error' });
    expect(res.statusCode).toBe(400);
  });

  test('bazaarvoice is not served — needs the BV ProductFeed schema, not the GMC feed', async () => {
    const res = await main({ __ow_method: 'GET', provider: 'bazaarvoice', LOG_LEVEL: 'error' });
    expect(res.statusCode).toBe(400);
    // The reference is a completely different schema:
    const bv = fixture('expected-bazaarvoice.xml');
    expect(bv).toContain('bazaarvoice.com/xs/PRR/ProductFeed');
  });
});

describe('locale plumbing', () => {
  test('cj honors a non-default locale (ca/en_us)', async () => {
    const mine = await outputFor('cj', fixture('expected-google-ca.xml'));
    const exp = parseFeed(fixture('expected-cj-ca.xml'));
    expect(mine.count).toBe(exp.count);
  });
});
