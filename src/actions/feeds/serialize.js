// Order in which known GMC `g:` fields are emitted. Unknown/structured fields
// are skipped (see itemXml) — the source feed is the authoritative field set.
const FIELD_ORDER = [
  'id',
  'title',
  'description',
  'link',
  'image_link',
  'additional_image_link',
  'condition',
  'availability',
  'availability_date',
  'price',
  'sale_price',
  'sale_price_effective_date',
  'brand',
  'gtin',
  'mpn',
  'identifier_exists',
  'google_product_category',
  'product_type',
  'color',
  'size',
  'item_group_id',
  'is_bundle',
];

const XML_ESCAPE = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * @param {unknown} value
 * @returns {string}
 */
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (c) => XML_ESCAPE[c]);

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
const el = (key, value) => {
  if (value === undefined || value === null || value === '') return '';
  return `    <g:${key}>${escapeXml(value)}</g:${key}>\n`;
};

/**
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
function itemXml(item) {
  let body = '';
  for (const key of FIELD_ORDER) {
    const value = item[key];
    if (Array.isArray(value)) {
      body += value.map((v) => el(key, v)).join('');
    } else if (value && typeof value === 'object') {
      // Structured fields (e.g. shipping) are not re-serialized in the scaffold.
      continue;
    } else {
      body += el(key, value);
    }
  }
  return `  <item>\n${body}  </item>`;
}

/**
 * Serialize a canonical feed to Google-style RSS with the `g:` namespace —
 * the format accepted by Google, Meta, Pinterest and Commission Junction.
 * @param {{ channel: { title?: string, link?: string, description?: string }, items: Record<string, unknown>[] }} feed
 * @returns {string}
 */
export function buildRssXml({ channel, items }) {
  const itemsXml = items.map(itemXml).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
  <title>${escapeXml(channel.title ?? '')}</title>
  <link>${escapeXml(channel.link ?? '')}</link>
  <description>${escapeXml(channel.description ?? '')}</description>
${itemsXml}
</channel>
</rss>`;
}
