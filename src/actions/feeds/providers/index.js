import meta from './meta.js';
import pinterest from './pinterest.js';
import cj from './cj.js';

/**
 * Registry of supported providers.
 *
 * Not yet included:
 * - google:      no separate feed — Google Ads serves from the linked Merchant
 *                Center account, i.e. the GMC feed itself.
 * - bazaarvoice: needs a distinct ProductFeed.xml schema (ExternalId, category
 *                hierarchy, review families) that the GMC feed does not carry;
 *                planned as a dedicated feed type in the indexer.
 *
 * @type {Record<string, { contentType: string, transformItem: (item: Record<string, unknown>) => Record<string, unknown> }>}
 */
export const PROVIDERS = {
  meta,
  pinterest,
  cj,
};
