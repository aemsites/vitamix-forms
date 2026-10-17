import meta from './meta.js';
import pinterest from './pinterest.js';
import cj from './cj.js';
import bazaarvoice from './bazaarvoice.js';
import openai from './openai.js';
import merchantCenter from './merchant-center.js';

/**
 * Registry of supported providers. A provider is either "simple" (a `{ root,
 * namespaced, fields, transformItem }` descriptor serialized by buildFeed) or
 * "custom" (supplies an async `build(ctx, feed, locale)` — e.g. bazaarvoice and
 * openai, whose formats differ from the Google shapes). A provider may also pin
 * `locale` (openai is US-only).
 *
 * All providers receive the prepared feed (../prepare.js) unless the request
 * passes `raw=true` (see ../index.js).
 *
 * Not included:
 * - google: no separate feed — Google Ads serves from the linked Merchant
 *   Center account, which reads the `merchant-center` feed below.
 */
export const PROVIDERS = {
  meta,
  pinterest,
  cj,
  bazaarvoice,
  openai,
  'merchant-center': merchantCenter,
};
