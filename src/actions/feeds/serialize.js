const XML_ESCAPE = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * @param {unknown} value
 * @returns {string}
 */
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (c) => XML_ESCAPE[c]);

/**
 * @param {string} tag
 * @param {unknown} value
 * @returns {string}
 */
const el = (tag, value) => {
  if (value === undefined || value === null || value === '') return '';
  return `    <${tag}>${escapeXml(value)}</${tag}>\n`;
};

/**
 * @param {Record<string, unknown>} item
 * @param {string[]} fields
 * @param {string} prefix tag namespace prefix ("g:" or "")
 * @returns {string}
 */
function itemXml(item, fields, prefix) {
  let body = '';
  for (const key of fields) {
    const tag = `${prefix}${key}`;
    const value = item[key];
    if (Array.isArray(value)) {
      body += value.map((v) => el(tag, v)).join('');
    } else if (value && typeof value === 'object') {
      // structured values (e.g. shipping) are not serialized in the scaffold
      continue;
    } else {
      body += el(tag, value);
    }
  }
  return `  <item>\n${body}  </item>`;
}

/**
 * Serialize a canonical feed in a provider-specific shape.
 * @param {{ channel?: { title?: string, link?: string, description?: string }, items: Record<string, unknown>[] }} feed
 * @param {{ root: 'rss' | 'feed', namespaced: boolean, fields: string[] }} format
 *   - `root`: RSS (`<rss><channel>`) or a bare `<feed>` root (Commission Junction)
 *   - `namespaced`: emit `g:`-prefixed item tags (Google) vs plain tags (the rest)
 *   - `fields`: the item fields to emit, in order
 * @returns {string}
 */
export function buildFeed({ channel = {}, items }, { root, namespaced, fields }) {
  const prefix = namespaced ? 'g:' : '';
  const itemsXml = items.map((item) => itemXml(item, fields, prefix)).join('\n');

  if (root === 'feed') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<feed>
${itemsXml}
</feed>`;
  }

  // The reference RSS feeds declare the g: namespace on <rss> even when items use
  // plain tags, so keep it for parity.
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>${escapeXml(channel.title ?? '')}</title>
  <link>${escapeXml(channel.link ?? '')}</link>
  <description>${escapeXml(channel.description ?? '')}</description>
${itemsXml}
</channel>
</rss>`;
}
