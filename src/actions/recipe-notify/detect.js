/**
 * Change detection.
 *
 * `Status` is sticky (a recipe reads "New" for as long as it stays in that
 * lifecycle state, regardless of the query cursor), so it cannot mean "new since
 * last run" on its own. What makes a recipe *newly detected* is its
 * `dateUpdated` crossing the persisted cursor. So we:
 *   1. keep only recipes whose full-precision `dateUpdated` is strictly greater
 *      than the cursor (dedupes the date-granular re-fetch of the boundary day),
 *   2. classify the survivors — for v1 we notify `Status === "New"` only,
 *   3. compute the batch's max `dateUpdated` (across ALL recipes, including the
 *      ignored Updated/Deleted rows) so the cursor advances past everything we
 *      inspected and nothing is re-examined next run.
 */

/**
 * @param {import('./recipes.js').Recipe[]} recipes
 * @param {string | null} since - cursor timestamp, or null on cold start
 * @returns {{
 *   changed: import('./recipes.js').Recipe[],
 *   newRecipes: import('./recipes.js').Recipe[],
 *   maxUpdated: string | null,
 * }}
 */
export function detectNewRecipes(recipes, since) {
  const sinceMs = since ? Date.parse(since) : NaN;

  const changed = recipes.filter((r) => {
    const t = Date.parse(r.dateUpdated);
    if (Number.isNaN(t)) return false;
    return Number.isNaN(sinceMs) ? true : t > sinceMs;
  });

  const newRecipes = changed.filter((r) => r.status.toLowerCase() === 'new');

  // Max dateUpdated across the whole batch, preserving the original string form.
  let maxUpdated = since;
  let maxMs = sinceMs;
  for (const r of recipes) {
    const t = Date.parse(r.dateUpdated);
    if (!Number.isNaN(t) && (Number.isNaN(maxMs) || t > maxMs)) {
      maxMs = t;
      maxUpdated = r.dateUpdated;
    }
  }

  return { changed, newRecipes, maxUpdated };
}
