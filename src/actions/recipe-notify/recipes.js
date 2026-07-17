/**
 * Fetch and parse the CalcMenu recipe journal.
 *
 * The `GetUpdatedRecipes` endpoint is a "since" journal: `DateUpdated=YYYY-MM-DD`
 * returns every recipe changed on or after that calendar day. The input is
 * date-granular (any time component is ignored) but the response carries
 * full-precision `DateUpdated` timestamps, and each recipe is classified with a
 * `Status` of `New` / `Updated` / `Deleted`.
 */

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/**
 * @typedef {{
 *   code: string,
 *   number: string,
 *   name: string,
 *   status: string,
 *   dateCreated: string | null,
 *   dateUpdated: string | null,
 *   brands: string[],
 * }} Recipe
 */

/**
 * Parse the XML response into a normalized list of recipes.
 * @param {string} xml
 * @returns {Recipe[]}
 */
export function parseRecipes(xml) {
  const doc = parser.parse(xml);
  const raw = doc?.ws_GetUpdatedRecipes?.Recipes;
  if (!raw) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [raw];

  return list.map((r) => {
    const brandNode = r.Brands?.Brand;
    const brandList = brandNode ? (Array.isArray(brandNode) ? brandNode : [brandNode]) : [];
    return {
      code: String(r['@_Code'] ?? ''),
      number: String(r['@_Number'] ?? ''),
      name: String(r['@_Name'] ?? '').trim(),
      status: String(r['@_Status'] ?? ''),
      dateCreated: r['@_DateCreated'] != null ? String(r['@_DateCreated']) : null,
      dateUpdated: r['@_DateUpdated'] != null ? String(r['@_DateUpdated']) : null,
      brands: brandList
        .map((b) => String(b?.BrandName ?? '').trim())
        .filter(Boolean),
    };
  });
}

/**
 * Fetch the journal since the given date.
 * @param {Context} ctx
 * @param {string} sinceDate - `YYYY-MM-DD`
 * @returns {Promise<Recipe[]>}
 */
export async function fetchRecipes(ctx, sinceDate) {
  const { env, log } = ctx;
  const url = new URL(env.RECIPE_API_URL);
  url.searchParams.set('ID', env.RECIPE_API_ID);
  url.searchParams.set('PSWD', env.RECIPE_API_PSWD);
  url.searchParams.set('Kiosk', 'Website');
  url.searchParams.set('CodeTranslation', '1');
  url.searchParams.set('DateUpdated', sinceDate);

  log.info(`[recipe-notify] Fetching recipes updated since ${sinceDate}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    log.error(`[recipe-notify] Recipe API failed: ${resp.status}`);
    throw new Error(`recipe API request failed: ${resp.status}`);
  }

  const xml = await resp.text();
  const recipes = parseRecipes(xml);
  log.info(`[recipe-notify] Parsed ${recipes.length} recipes from journal`);
  return recipes;
}
