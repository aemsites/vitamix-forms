/**
 * Shared catalog preparation applied to the GMC source feed before it is
 * serialized for a provider (all providers except Bazaarvoice — see
 * providers/bazaarvoice.js `raw`).
 *
 * The GMC feed mirrors the Edge product bus, which carries three Magento shapes:
 *   - simple        → one row, no variants
 *   - configurable  → one parent row (the PDP; sku is the Magento parent sku, often
 *                     a name like "Propel750") + one row per child simple, each with
 *                     `item_group_id` = parent sku
 *   - bundle        → one row (VBND… sku) + one row per selectable bundle option.
 *                     Those option rows are "-VB" SKUs: duplicate simples Magento
 *                     creates for bundles.
 *
 * To match the legacy Magento feeds we send the purchasable items only:
 *   - drop configurable parent rows (keep their simple variants, grouped)
 *   - drop "-VB" bundle-child rows (keep the bundle itself)
 *   - drop duplicate ids (a simple listed both standalone and as a variant)
 *
 * and clean up the content Paid Media flagged:
 *   - titles: "Vitamix" prefix, variant titles rebuilt as "<parent> - <color>",
 *     sanitized like the legacy feeds (ASCII alnum, space, - + .)
 *   - descriptions: fall back to the parent, then the first paragraph of the
 *     authored PDP content (<content-base><path>.plain.html), then a default
 */

const DEFAULT_CONTENT_BASE = 'https://main--vitamix--aemsites.aem.live';
const CONTENT_FETCH_CONCURRENCY = 4;
const CONTENT_FETCH_TIMEOUT_MS = 10000;

const DEFAULT_DESCRIPTION = {
  en: 'Description coming soon.',
  fr: 'Description à venir.',
};

const BRAND = 'Vitamix';

/** @param {unknown} id */
export const isBundleChild = (id) => /-VB$/i.test(String(id ?? ''));

/** @param {string} s */
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Title sanitization, following the legacy Magento feed
 * (`preg_replace('/[^(\x20-\x7F)]*[^A-Za-z0-9\-\+ ]/', '', $name)`), which keeps
 * only ASCII letters, digits, space, "-" and "+". Deviations (agreed):
 *   - "." is also kept, so "1.4-litre" doesn't become "14-litre"
 *   - accents are transliterated first ("é" → "e") rather than dropped
 * @param {string} value
 * @returns {string}
 */
export function sanitizeTitle(value) {
  return collapse(String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9\-+. ]/g, ''));
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** @param {string} s */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref) => {
    if (ref[0] === '#') {
      const code = ref[1].toLowerCase() === 'x'
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/**
 * Light description cleanup: plain text, no trademark symbols, ASCII
 * punctuation, collapsed whitespace. Unlike titles, letters (incl. accents,
 * for fr_ca) and sentence punctuation are kept.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeDescription(value) {
  return collapse(decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/[®™©℠]/g, '')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' '));
}

/**
 * First non-empty paragraph of an authored .plain.html document, as plain text.
 * @param {string} html
 * @returns {string}
 */
export function firstParagraph(html) {
  const re = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(html))) {
    const text = sanitizeDescription(m[1]);
    if (text) return text;
  }
  return '';
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Fetch the authored-content description for each PDP path (once per path).
 * Failures resolve to '' so a content hiccup never fails the feed.
 * @param {{ env: Record<string, string | undefined>, log: Console }} ctx
 * @param {string[]} paths
 * @returns {Promise<Map<string, string>>}
 */
async function fetchAuthoredDescriptions(ctx, paths) {
  const base = (ctx.env.FEED_CONTENT_BASE || DEFAULT_CONTENT_BASE).replace(/\/$/, '');
  const results = await mapLimit(paths, CONTENT_FETCH_CONCURRENCY, async (path) => {
    const url = `${base}${path}.plain.html`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(CONTENT_FETCH_TIMEOUT_MS) });
      if (!resp.ok) {
        ctx.log.warn(`no authored content for description: ${url} (${resp.status})`);
        return '';
      }
      return firstParagraph(await resp.text());
    } catch (err) {
      ctx.log.warn(`failed to fetch authored content ${url}: ${err.message}`);
      return '';
    }
  });
  return new Map(paths.map((p, i) => [p, results[i]]));
}

/** @param {unknown} link */
function pathOf(link) {
  try {
    return new URL(String(link)).pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

/**
 * Keep simple + bundle rows; drop configurable parents and -VB bundle children.
 * (Duplicate ids are resolved later, once descriptions are known — see dedupe.)
 * @param {Record<string, any>[]} items
 * @returns {Record<string, any>[]}
 */
export function selectItems(items) {
  /** @type {Map<string, string[]>} group id -> child ids */
  const children = new Map();
  for (const it of items) {
    if (!it.item_group_id) continue;
    const g = String(it.item_group_id);
    if (!children.has(g)) children.set(g, []);
    children.get(g).push(String(it.id));
  }
  // A parent with any non-"-VB" child is a configurable (its children are the
  // simples we send). A parent whose children are all "-VB" is a bundle.
  const isConfigurableParent = (it) => !it.item_group_id
    && (children.get(String(it.id)) ?? []).some((id) => !isBundleChild(id));

  return items.filter((it) => it.id && !isBundleChild(it.id) && !isConfigurableParent(it));
}

/**
 * One row per id. Among duplicates (e.g. a simple listed both standalone and as
 * a variant, or a stale second product record for the same sku) keep the
 * highest-scoring row, first one on ties.
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} idOf
 * @param {(row: T) => number} score
 * @returns {T[]}
 */
function dedupe(rows, idOf, score) {
  /** @type {Map<string, T>} */
  const best = new Map();
  for (const row of rows) {
    const id = idOf(row);
    const existing = best.get(id);
    if (!existing || score(row) > score(existing)) best.set(id, row);
  }
  return [...best.values()];
}

/**
 * @param {{ env: Record<string, string | undefined>, log: Console }} ctx
 * @param {{ channel?: object, items: Record<string, any>[] }} feed
 * @param {string} locale e.g. "us/en_us"
 * @returns {Promise<{ channel?: object, items: Record<string, any>[] }>}
 */
export async function prepareFeed(ctx, feed, locale) {
  const all = feed.items;
  const byId = new Map(all.map((it) => [String(it.id), it]));
  const selected = selectItems(all);

  const lang = String(locale || '').split('/')[1]?.split('_')[0];
  const defaultDescription = DEFAULT_DESCRIPTION[lang] || DEFAULT_DESCRIPTION.en;

  // Parent (configurable) context for variants: title + description fallback.
  const parentOf = (it) => (it.item_group_id ? byId.get(String(it.item_group_id)) : undefined);

  const needContent = new Set();
  // A description that merely repeats the title (the source does this for some
  // bundles/parents) is a placeholder — treat it as missing.
  const realDescription = (row) => {
    const d = sanitizeDescription(row?.description);
    return d && d.toLowerCase() !== sanitizeDescription(row?.title).toLowerCase() ? d : '';
  };
  const draft = selected.map((it) => {
    const parent = parentOf(it);
    const description = realDescription(it) || realDescription(parent);
    if (!description) {
      const path = pathOf(it.link);
      if (path) needContent.add(path);
    }
    return { it, parent, description };
  });

  const authored = needContent.size
    ? await fetchAuthoredDescriptions(ctx, [...needContent])
    : new Map();

  const resolved = draft.map(({ it, parent, description }) => {
    const base = parent?.title && it.color
      ? `${parent.title} - ${it.color}`
      : it.title;
    const withBrand = /vitamix/i.test(String(base ?? '')) ? base : `${BRAND} ${base ?? ''}`;
    const finalDescription = description || authored.get(pathOf(it.link));
    return {
      item: {
        ...it,
        title: sanitizeTitle(withBrand),
        description: finalDescription || defaultDescription,
      },
      hasDescription: Boolean(finalDescription),
    };
  });

  // Prefer the grouped (variant) row, then one with a real description.
  const items = dedupe(
    resolved,
    (r) => String(r.item.id),
    (r) => (r.item.item_group_id ? 2 : 0) + (r.hasDescription ? 1 : 0),
  ).map((r) => r.item);

  const missing = draft.filter((d) => !d.description).length;
  ctx.log.info(`prepared ${items.length}/${all.length} items for ${locale}`
    + ` (${needContent.size} authored-content lookups for ${missing} missing descriptions)`);

  return { ...feed, items };
}
