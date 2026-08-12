import meta from './meta.js';
import pinterest from './pinterest.js';
import cj from './cj.js';
import bazaarvoice from './bazaarvoice.js';
import openai from './openai.js';

/**
 * Registry of supported providers. A provider is either "simple" (a `{ root,
 * namespaced, fields, transformItem }` descriptor serialized by buildFeed) or
 * "custom" (supplies an async `build(ctx, feed, locale)` — e.g. bazaarvoice and
 * openai, whose formats differ from the Google shapes). A provider may also pin
 * `locale` (openai is US-only).
 *
 * Not included:
 * - google: no separate feed — Google Ads serves from the linked Merchant
 *   Center account, i.e. the GMC feed itself.
 */
export const PROVIDERS = {
  meta,
  pinterest,
  cj,
  bazaarvoice,
  openai,
};
