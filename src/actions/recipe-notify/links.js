/**
 * Deep-link resolution.
 *
 * A recipe's public page URL is `{base}/{locale}/recipes/{slug}-{number}` where
 * the trailing segment is the recipe `Number` lowercased. Rather than
 * reconstruct the slug (fragile with trademarks/accents/punctuation), we resolve
 * the authoritative path from the published `query-index.json` by matching the
 * `Number` suffix. New recipes are typically already present in the index at
 * notification time; if a recipe isn't found, its link is left null.
 */

/**
 * The index also carries each recipe's `image` (the same asset used for the page
 * `og:image`), so we resolve a small thumbnail URL from it here — no extra
 * requests needed.
 *
 * @param {Context} ctx
 * @param {import('./recipes.js').Recipe[]} recipes
 * @returns {Promise<(import('./recipes.js').Recipe & { url: string | null, image: string | null })[]>}
 */
export async function resolveLinks(ctx, recipes) {
  const { env, log } = ctx;
  const base = env.RECIPE_SITE_BASE;
  const locale = env.RECIPE_LINK_LOCALE;

  /** @type {Map<string, { path: string, image: string | null }>} number(lowercased) → entry */
  const byNumber = new Map();
  try {
    const resp = await fetch(`${base}/${locale}/recipes/query-index.json`);
    if (resp.ok) {
      const data = await resp.json();
      for (const entry of data?.data ?? []) {
        const path = entry?.path;
        if (typeof path === 'string') {
          const dash = path.lastIndexOf('-');
          if (dash !== -1) {
            byNumber.set(path.slice(dash + 1).toLowerCase(), {
              path,
              image: typeof entry.image === 'string' && entry.image ? entry.image : null,
            });
          }
        }
      }
    } else {
      log.warn(`[recipe-notify] query-index fetch failed: ${resp.status} — links will be omitted`);
    }
  } catch (err) {
    log.warn(`[recipe-notify] query-index fetch error: ${err.message} — links will be omitted`);
  }

  return recipes.map((r) => {
    const entry = byNumber.get(r.number.toLowerCase());
    return {
      ...r,
      url: entry ? `${base}${entry.path}` : null,
      image: entry ? thumbnailUrl(entry.image) : null,
    };
  });
}

/**
 * Turn an index image URL into a small, email-friendly thumbnail: constrain the
 * width and force JPEG (`format=pjpg`) since AVIF isn't reliably rendered by
 * email clients. Returns null if there's no image.
 * @param {string | null} image
 * @param {number} [width]
 * @returns {string | null}
 */
export function thumbnailUrl(image, width = 240) {
  if (!image) return null;
  try {
    const url = new URL(image);
    url.searchParams.set('width', String(width));
    url.searchParams.set('format', 'pjpg');
    url.searchParams.set('optimize', 'medium');
    return url.toString();
  } catch {
    return image;
  }
}
