/**
 * Pre-upload validation for feeds-push. An upload replaces the provider's
 * catalog, so a feed that fails any check is never pushed.
 */

import { XMLValidator } from 'fast-xml-parser';
import { MIN_ITEMS, MAX_SHRINK } from './config.js';

/**
 * Item ids in a serialized feed (XML `<id>` or the CSV `id` column).
 * @param {string} body
 * @param {string} contentType
 * @returns {string[]}
 */
export function extractIds(body, contentType) {
  if (/xml/.test(contentType)) {
    return [...body.matchAll(/<(?:g:)?id>([^<]*)<\/(?:g:)?id>/g)].map((m) => m[1].trim());
  }
  return [];
}

/**
 * @param {{ body: string, contentType: string, itemCount: number }} built
 * @param {{
 *   idPattern?: RegExp,
 *   previousCount?: number | null,
 *   force?: boolean,
 *   minItems?: number,
 *   maxShrink?: number,
 * }} [opts]
 * @returns {string[]} problems; empty when the feed may be uploaded
 */
export function validateFeed(built, {
  idPattern, previousCount, force = false, minItems = MIN_ITEMS, maxShrink = MAX_SHRINK,
} = {}) {
  const problems = [];
  const { body, contentType, itemCount } = built;

  if (!body || !body.trim()) {
    return ['feed body is empty'];
  }

  if (/xml/.test(contentType)) {
    const result = XMLValidator.validate(body);
    if (result !== true) {
      problems.push(`invalid XML: ${result.err?.msg || 'parse error'} (line ${result.err?.line})`);
    }
  } else if (/csv/.test(contentType)) {
    const header = body.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
    if (!header || !header.includes(',')) {
      problems.push('CSV has no header row');
    }
  }

  if (itemCount < minItems) {
    problems.push(`only ${itemCount} items (minimum ${minItems})`);
  }

  if (!force && previousCount && itemCount < previousCount * maxShrink) {
    problems.push(
      `item count dropped from ${previousCount} to ${itemCount} (more than ${Math.round((1 - maxShrink) * 100)}%); `
      + 're-run with force=true if this is intended',
    );
  }

  if (idPattern) {
    const bad = extractIds(body, contentType).filter((id) => !idPattern.test(id));
    if (bad.length) {
      problems.push(`${bad.length} ids don't match ${idPattern}: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', …' : ''}`);
    }
  }

  return problems;
}
