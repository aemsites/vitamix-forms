import {
  describe, test, expect, jest, afterEach,
} from '@jest/globals';
import {
  sanitizeTitle, sanitizeDescription, firstParagraph, selectItems, prepareFeed,
} from '../../src/actions/feeds/prepare.js';

const log = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};
const ctx = { env: {}, log };

const item = (id, extra = {}) => ({
  id,
  title: id,
  description: `About ${id}`,
  link: `https://www.vitamix.com/us/en_us/products/${String(id).toLowerCase()}`,
  ...extra,
});

afterEach(() => jest.restoreAllMocks());

describe('sanitizeTitle', () => {
  test('keeps ASCII letters, digits, space, - + . (legacy Magento rule + ".")', () => {
    expect(sanitizeTitle('Ascent® X5 SmartPrep™ Kitchen System')).toBe('Ascent X5 SmartPrep Kitchen System');
    expect(sanitizeTitle('VX1™ + Personal Cup Adapter')).toBe('VX1 + Personal Cup Adapter');
    expect(sanitizeTitle('1.4-litre Container')).toBe('1.4-litre Container');
    expect(sanitizeTitle("Chef's Pick, US/CA (new)")).toBe('Chefs Pick USCA new');
  });

  test('collapses whitespace left by the source or by removed symbols', () => {
    expect(sanitizeTitle('7500 with Aer  Disc Black')).toBe('7500 with Aer Disc Black');
    expect(sanitizeTitle('Ascent®  X5 ™ Deluxe ')).toBe('Ascent X5 Deluxe');
  });

  test('transliterates accents instead of dropping the letter', () => {
    expect(sanitizeTitle('Récipient à mélanger')).toBe('Recipient a melanger');
  });
});

describe('sanitizeDescription', () => {
  test('plain text, no trademark symbols, ASCII punctuation, accents kept', () => {
    expect(sanitizeDescription('<b>Vitamix®</b> blenders&nbsp;— it’s “smart”…'))
      .toBe('Vitamix blenders - it\'s "smart"...');
    expect(sanitizeDescription('Dip &#x26; Spread &amp; more')).toBe('Dip & Spread & more');
    expect(sanitizeDescription('Parfait pour faire plusieurs portions à la fois.'))
      .toBe('Parfait pour faire plusieurs portions à la fois.');
  });
});

describe('firstParagraph', () => {
  test('returns the first non-empty <p> as plain text', () => {
    const html = `<div><h3>Features</h3>
      <p><picture><img src="x.jpg"></picture></p>
      <p>Designed for <a href="/x">large</a> batches &#x26; more.</p>
      <p>Second.</p></div>`;
    expect(firstParagraph(html)).toBe('Designed for large batches & more.');
  });

  test('empty when there is no paragraph', () => {
    expect(firstParagraph('<div><h3>Nothing</h3></div>')).toBe('');
  });
});

describe('selectItems', () => {
  test('keeps simples, variants and bundles; drops configurable parents and -VB rows', () => {
    const items = [
      item('064584'), // simple
      item('A2500'), // configurable parent
      item('061007', { item_group_id: 'A2500' }), // its simple variant
      item('VBNDP750'), // bundle
      item('071395-VB', { item_group_id: 'VBNDP750' }), // bundle option (dup simple)
      item('VBNDDCC'), // bundle with fixed contents only
    ];
    expect(selectItems(items).map((i) => i.id)).toEqual(['064584', '061007', 'VBNDP750', 'VBNDDCC']);
  });
});

describe('prepareFeed', () => {
  const mockContent = (pages) => jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const path = new URL(url).pathname.replace(/\.plain\.html$/, '');
    if (pages[path] instanceof Error) throw pages[path];
    return pages[path]
      ? { ok: true, status: 200, text: async () => pages[path] }
      : { ok: false, status: 404, text: async () => '' };
  });

  test('titles: Vitamix prefix; variants rebuilt from parent title + color', async () => {
    const feed = {
      items: [
        item('A2500', { title: 'A2500®' }),
        item('061007', { title: 'A2500 Black US', color: 'Black', item_group_id: 'A2500' }),
        item('069813', { title: 'Immersion Station®' }),
        item('075753', { title: 'FoodCycler by Vitamix Eco 5' }),
      ],
    };
    const { items } = await prepareFeed(ctx, feed, 'us/en_us');
    expect(items.map((i) => i.title)).toEqual([
      'Vitamix A2500 - Black',
      'Vitamix Immersion Station',
      'FoodCycler by Vitamix Eco 5',
    ]);
  });

  test('descriptions: own, then parent, then authored first <p>, then default', async () => {
    const fetchSpy = mockContent({
      '/us/en_us/products/whisk': '<div><p>Give your forearm a break.</p></div>',
    });
    const feed = {
      items: [
        item('P1', { description: 'Parent copy.' }),
        item('V1', { description: '', item_group_id: 'P1', color: 'Red' }),
        item('W1', { description: '', link: 'https://www.vitamix.com/us/en_us/products/whisk' }),
        item('W2', { description: '', link: 'https://www.vitamix.com/us/en_us/products/whisk' }),
        item('B1', { title: 'Bundle One', description: 'Bundle One' }), // placeholder = title
        item('X1', { description: '' }), // no authored page
      ],
    };
    const { items } = await prepareFeed(ctx, feed, 'us/en_us');
    const desc = Object.fromEntries(items.map((i) => [i.id, i.description]));
    expect(desc).toEqual({
      V1: 'Parent copy.',
      W1: 'Give your forearm a break.',
      W2: 'Give your forearm a break.',
      B1: 'Description coming soon.',
      X1: 'Description coming soon.',
    });
    // authored content fetched from aem.live, once per PDP path
    const urls = fetchSpy.mock.calls.map(([u]) => u);
    expect(urls).toContain('https://main--vitamix--aemsites.aem.live/us/en_us/products/whisk.plain.html');
    expect(urls.filter((u) => u.includes('/whisk.'))).toHaveLength(1);
  });

  test('a failing content fetch falls back to the (localized) default', async () => {
    mockContent({ '/ca/fr_ca/products/x1': new Error('boom') });
    const { items } = await prepareFeed(ctx, {
      items: [item('X1', { description: '', link: 'https://www.vitamix.com/ca/fr_ca/products/x1' })],
    }, 'ca/fr_ca');
    expect(items[0].description).toBe('Description à venir.');
  });

  test('FEED_CONTENT_BASE overrides the authored content host', async () => {
    const fetchSpy = mockContent({});
    await prepareFeed({ env: { FEED_CONTENT_BASE: 'https://stage.example/' }, log }, {
      items: [item('X1', { description: '' })],
    }, 'us/en_us');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://stage.example/us/en_us/products/x1.plain.html',
      expect.anything(),
    );
  });

  test('duplicate ids: keep the variant row, else the one with a description', async () => {
    mockContent({ '/ca/en_us/products/48ounce-container': '<p>Medium batches.</p>' });
    const { items } = await prepareFeed(ctx, {
      items: [
        item('P'),
        item('062327'), // standalone copy
        item('062327', { item_group_id: 'P', color: 'Black' }), // variant copy
        item('015399', { description: '', link: 'https://www.vitamix.com/ca/en_us/products/48-ounce-container-1' }),
        item('015399', { description: '', link: 'https://www.vitamix.com/ca/en_us/products/48ounce-container' }),
      ],
    }, 'ca/en_us');
    expect(items.map((i) => i.id)).toEqual(['062327', '015399']);
    expect(items[0].item_group_id).toBe('P');
    expect(items[1].description).toBe('Medium batches.');
  });
});
