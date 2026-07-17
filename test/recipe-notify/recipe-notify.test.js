import { describe, test, expect, jest, afterEach } from '@jest/globals';
import { parseRecipes } from '../../src/actions/recipe-notify/recipes.js';
import { detectNewRecipes } from '../../src/actions/recipe-notify/detect.js';
import { resolveLinks } from '../../src/actions/recipe-notify/links.js';
import { renderDigestTable } from '../../src/actions/recipe-notify/notify.js';
import { resolveDigestTemplate } from '../../src/emails.js';

// ---------------------------------------------------------------------------
// Fixtures — trimmed from the live GetUpdatedRecipes response (2026-07-17)
// ---------------------------------------------------------------------------

const XML = `<?xml version="1.0" encoding="utf-8"?>
<ws_GetUpdatedRecipes>
  <Recipes Code="17279" Number="R00830" Name="Lemon Bars" Status="Updated" DateCreated="2015-12-10T17:22:00" DateUpdated="2026-07-17T04:10:12.850">
    <Brands>
      <Brand><BrandName>48-ounce</BrandName><Brand>1316</Brand><Classification>Primary</Classification></Brand>
      <Brand><BrandName>64-ounce Classic</BrandName><Brand>1306</Brand><Classification>Primary</Classification></Brand>
    </Brands>
  </Recipes>
  <Recipes Code="23991" Number="R000004856" Name="Peanut Blossom Cookies" Status="New" DateCreated="2026-07-17T04:40:00" DateUpdated="2026-07-17T04:44:14.967">
    <Brands>
      <Brand><BrandName>48-ounce</BrandName><Brand>1316</Brand><Classification>Primary</Classification></Brand>
    </Brands>
  </Recipes>
  <Recipes Code="99999" Number="R00001" Name="Gone" Status="Deleted" DateCreated="2015-01-01T00:00:00" DateUpdated="2026-07-17T05:00:00.000">
  </Recipes>
</ws_GetUpdatedRecipes>`;

const XML_SINGLE = `<?xml version="1.0" encoding="utf-8"?>
<ws_GetUpdatedRecipes>
  <Recipes Code="1" Number="R1" Name="Only One" Status="New" DateCreated="2026-07-17T01:00:00" DateUpdated="2026-07-17T02:00:00.000"/>
</ws_GetUpdatedRecipes>`;

const XML_EMPTY = `<?xml version="1.0" encoding="utf-8"?><ws_GetUpdatedRecipes></ws_GetUpdatedRecipes>`;

// ---------------------------------------------------------------------------
// parseRecipes
// ---------------------------------------------------------------------------

describe('parseRecipes', () => {
  test('parses multiple recipes with attributes and brands', () => {
    const recipes = parseRecipes(XML);
    expect(recipes).toHaveLength(3);
    expect(recipes[0]).toMatchObject({
      code: '17279',
      number: 'R00830',
      name: 'Lemon Bars',
      status: 'Updated',
      dateCreated: '2015-12-10T17:22:00',
      dateUpdated: '2026-07-17T04:10:12.850',
      brands: ['48-ounce', '64-ounce Classic'],
    });
  });

  test('normalizes a single recipe into an array', () => {
    const recipes = parseRecipes(XML_SINGLE);
    expect(recipes).toHaveLength(1);
    expect(recipes[0].number).toBe('R1');
    expect(recipes[0].brands).toEqual([]);
  });

  test('returns [] for an empty document', () => {
    expect(parseRecipes(XML_EMPTY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectNewRecipes
// ---------------------------------------------------------------------------

describe('detectNewRecipes', () => {
  const recipes = parseRecipes(XML);

  test('keeps only recipes strictly newer than the cursor', () => {
    // cursor at the Lemon Bars update — it must be excluded (strict >).
    const { changed } = detectNewRecipes(recipes, '2026-07-17T04:10:12.850');
    expect(changed.map((r) => r.number)).toEqual(['R000004856', 'R00001']);
  });

  test('classifies Status="New" only', () => {
    const { newRecipes } = detectNewRecipes(recipes, '2026-07-17T00:00:00');
    expect(newRecipes.map((r) => r.number)).toEqual(['R000004856']);
  });

  test('advances the cursor to the batch max across ALL statuses', () => {
    // Deleted row (05:00) is the latest; cursor must move past it too.
    const { maxUpdated } = detectNewRecipes(recipes, '2026-07-17T00:00:00');
    expect(maxUpdated).toBe('2026-07-17T05:00:00.000');
  });

  test('cold start (null cursor) treats everything as changed', () => {
    const { changed, newRecipes, maxUpdated } = detectNewRecipes(recipes, null);
    expect(changed).toHaveLength(3);
    expect(newRecipes).toHaveLength(1);
    expect(maxUpdated).toBe('2026-07-17T05:00:00.000');
  });

  test('empty batch leaves the cursor unchanged', () => {
    const { changed, maxUpdated } = detectNewRecipes([], '2026-07-17T04:00:00');
    expect(changed).toEqual([]);
    expect(maxUpdated).toBe('2026-07-17T04:00:00');
  });
});

// ---------------------------------------------------------------------------
// resolveLinks
// ---------------------------------------------------------------------------

describe('resolveLinks', () => {
  const ctx = {
    env: { RECIPE_SITE_BASE: 'https://www.vitamix.com', RECIPE_LINK_LOCALE: 'us/en_us' },
    log: { warn: () => {} },
  };

  afterEach(() => { jest.restoreAllMocks(); });

  test('resolves the URL by Number suffix, null on miss', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { path: '/us/en_us/recipes/peanut-blossom-cookies-r000004856' },
          { path: '/us/en_us/recipes/lemon-bars-r00830' },
        ],
      }),
    });

    const out = await resolveLinks(ctx, [
      { number: 'R000004856', name: 'Peanut Blossom Cookies' },
      { number: 'R999999', name: 'Missing' },
    ]);
    expect(out[0].url).toBe('https://www.vitamix.com/us/en_us/recipes/peanut-blossom-cookies-r000004856');
    expect(out[1].url).toBeNull();
  });

  test('index fetch failure → all links null, no throw', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 });
    const out = await resolveLinks(ctx, [{ number: 'R00830', name: 'Lemon Bars' }]);
    expect(out[0].url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderDigestTable
// ---------------------------------------------------------------------------

describe('renderDigestTable', () => {
  test('links the name, escapes HTML, and renders the thumbnail', () => {
    const html = renderDigestTable([
      { name: 'Lemon & Bars', number: 'R00830', code: '17279', dateCreated: '2015-12-10T17:22:00', brands: ['48-ounce'], url: 'https://x/y', image: 'https://img/lemon.jpg' },
      { name: 'No Link', number: 'R2', code: '2', dateCreated: null, brands: [], url: null, image: null },
    ]);
    // linked name with escaped ampersand
    expect(html).toContain('href="https://x/y"');
    expect(html).toContain('>Lemon &amp; Bars</a>');
    // thumbnail image rendered
    expect(html).toContain('<img src="https://img/lemon.jpg"');
    // no-link name renders as a span, no image → placeholder (no <img>)
    expect(html).toContain('>No Link</span>');
    expect(html).toContain('2015-12-10');
    // number + code shown in the meta line
    expect(html).toContain('R00830');
    expect(html).toContain('#17279');
  });
});

// ---------------------------------------------------------------------------
// resolveDigestTemplate ({{digest}} placeholder)
// ---------------------------------------------------------------------------

describe('resolveDigestTemplate', () => {
  const TEMPLATE = `<body><main><div>
    <p>To: a@vitamix.com, b@vitamix.com</p>
    <p>cc: c@vitamix.com</p>
    <p>Subject: New recipes ({{count}})</p>
    <p>The following new recipes were published on {{date}}:</p>
    <p>{{digest}}</p>
  </div></main></body>`;

  test('parses recipients/subject, injects digest, substitutes vars, passes prose', async () => {
    const ctx = {
      env: { ORG: 'aemsites', SITE: 'vitamix' },
      events: { token: 't' },
      log: { info: () => {}, error: () => {} },
    };
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => TEMPLATE });

    const out = await resolveDigestTemplate(ctx, '/config/recipes/digest-template', '<table>DIGEST</table>', { count: '3', date: '2026-07-17' });
    expect(out.toEmail).toEqual(['a@vitamix.com', 'b@vitamix.com']);
    expect(out.cc).toEqual(['c@vitamix.com']);
    expect(out.subject).toBe('New recipes (3)');
    expect(out.html).toContain('<p>The following new recipes were published on 2026-07-17:</p>');
    expect(out.html).toContain('<table>DIGEST</table>');
    jest.restoreAllMocks();
  });

  test('returns null when the template document is missing (404)', async () => {
    const ctx = { env: { ORG: 'aemsites', SITE: 'vitamix' }, events: { token: 't' }, log: { info: () => {}, error: () => {} } };
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } });
    const out = await resolveDigestTemplate(ctx, '/missing', '<table/>');
    expect(out).toBeNull();
    jest.restoreAllMocks();
  });
});
