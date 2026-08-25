import { errorWithResponse } from '../../../utils.js';

/**
 * Bazaarvoice product feed (ProductFeed.xml).
 *
 * BV uses its own schema — not the Google `g:`/`<feed>` shapes — so this provider
 * supplies a custom async `build` instead of the field/format descriptor the
 * other providers use.
 *
 * The one input the GMC feed can't provide is the category taxonomy, so it's
 * loaded at runtime from a published DA sheet (see dev/extract-bv-categories.mjs):
 *   - categories: externalId, parentExternalId, name, url_us, url_ca
 *   - products:   sku -> categoryExternalId
 */

const DEFAULT_SHEET_URL = 'https://main--vitamix--aemsites.aem.live/config/feeds/bv-categories.json';
const BV_NAMESPACE = 'http://www.bazaarvoice.com/xs/PRR/ProductFeed/14.7';

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// CDATA-wrap, splitting any literal "]]>" so the section stays well-formed.
const cdata = (v) => `<![CDATA[${String(v ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

/**
 * Fetch + reshape the published category sheet.
 * @param {{ log: Console }} ctx
 * @param {string} url
 * @returns {Promise<{ categories: Record<string, { name: string, parent?: string, url: { us?: string, ca?: string } }>, productCategory: Record<string, string> }>}
 */
async function loadCategoryData(ctx, url) {
  ctx.log.info(`fetching BV category sheet: ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw errorWithResponse(
      `failed to fetch BV category sheet ${url}: ${resp.status}`,
      502,
      'failed to fetch category sheet',
    );
  }
  const doc = await resp.json();
  /** @type {Record<string, { name: string, parent?: string, url: { us?: string, ca?: string } }>} */
  const categories = {};
  for (const row of doc.categories?.data ?? []) {
    if (!row.externalId) continue;
    categories[row.externalId] = {
      name: row.name,
      parent: row.parentExternalId || undefined,
      url: { us: row.url_us || undefined, ca: row.url_ca || undefined },
    };
  }
  /** @type {Record<string, string>} */
  const productCategory = {};
  for (const row of doc.products?.data ?? []) {
    if (row.sku) productCategory[row.sku] = row.categoryExternalId;
  }
  return { categories, productCategory };
}

/**
 * @param {string} id
 * @param {{ name: string, parent?: string, url: { us?: string, ca?: string } }} cat
 * @param {'us' | 'ca'} store
 */
function categoryXml(id, cat, store) {
  const url = store === 'ca' ? (cat.url.ca ?? cat.url.us) : (cat.url.us ?? cat.url.ca);
  return `    <Category>
      <ExternalId>${esc(id)}</ExternalId>${cat.parent ? `
      <ParentExternalId>${esc(cat.parent)}</ParentExternalId>` : ''}
      <Name>${cdata(cat.name)}</Name>
      <CategoryPageUrl>${cdata(url)}</CategoryPageUrl>
    </Category>`;
}

/**
 * @param {Record<string, unknown>} item a normalized GMC item
 * @param {Record<string, string>} productCategory
 * @param {Record<string, unknown>} categories
 */
function productXml(item, productCategory, categories) {
  const id = String(item.id);
  const categoryId = productCategory[id];
  // Only reference a category that actually exists in the feed — BV rejects a
  // CategoryExternalId with no matching <Category> (e.g. the dangling id 223).
  const hasCategory = categoryId && categories[categoryId];
  // Group variants with their parent for shared reviews. GMC carries the parent
  // sku as item_group_id; standalone products family to themselves.
  const familyKey = item.item_group_id || id;

  return `    <Product>
      <ExternalId>${esc(id)}</ExternalId>
      <Name>${cdata(item.title)}</Name>${item.description ? `
      <Description>${cdata(item.description)}</Description>` : ''}${hasCategory ? `
      <CategoryExternalId>${esc(categoryId)}</CategoryExternalId>` : ''}
      <ProductPageUrl>${cdata(item.link)}</ProductPageUrl>
      <ImageUrl>${cdata(item.image_link)}</ImageUrl>${item.gtin ? `
      <UPCs>
        <UPC>${cdata(item.gtin)}</UPC>
      </UPCs>` : ''}
      <Attributes>
        <Attribute id="BV_FE_FAMILY">
          <Value>${esc(familyKey)}</Value>
        </Attribute>
        <Attribute id="BV_FE_EXPAND">
          <Value>BV_FE_FAMILY:${esc(familyKey)}</Value>
        </Attribute>
      </Attributes>
    </Product>`;
}

export default {
  contentType: 'application/xml',
  /**
   * @param {{ env: Record<string, string>, log: Console }} ctx
   * @param {{ items: Record<string, unknown>[] }} feed
   * @param {string} locale
   * @returns {Promise<string>}
   */
  build: async (ctx, feed, locale) => {
    const url = ctx.env.BV_CATEGORY_SHEET_URL || DEFAULT_SHEET_URL;
    const { categories, productCategory } = await loadCategoryData(ctx, url);
    const store = String(locale || '').split('/')[0] === 'ca' ? 'ca' : 'us';
    const extractDate = new Date().toISOString();

    const categoriesXml = Object.entries(categories)
      .map(([id, cat]) => categoryXml(id, cat, store)).join('\n');
    const productsXml = feed.items
      .map((item) => productXml(item, productCategory, categories)).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Feed xmlns="${BV_NAMESPACE}" name="vitamix" incremental="false" extractDate="${extractDate}" generator="vitamix-forms">
  <Categories>
${categoriesXml}
  </Categories>
  <Products>
${productsXml}
  </Products>
</Feed>`;
  },
};
