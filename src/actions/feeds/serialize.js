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
 * @param {unknown} value scalar, or an object of sub-attributes (e.g. shipping)
 * @param {string} prefix tag namespace prefix, applied to sub-attributes too
 * @param {string} indent
 * @returns {string}
 */
const el = (tag, value, prefix = '', indent = '    ') => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'object') {
    const inner = Object.entries(value)
      .flatMap(([k, v]) => (Array.isArray(v) ? v : [v])
        .map((x) => el(`${prefix}${k}`, x, prefix, `${indent}  `)))
      .join('');
    return inner ? `${indent}<${tag}>\n${inner}${indent}</${tag}>\n` : '';
  }
  return `${indent}<${tag}>${escapeXml(value)}</${tag}>\n`;
};

/**
 * @param {Record<string, unknown>} item
 * @param {string[] | undefined} fields the fields to emit, in order; when
 *   omitted, every attribute on the item is emitted (pass-through)
 * @param {string} prefix tag namespace prefix ("g:" or "")
 * @param {Set<string>} emitEmpty fields emitted as an empty tag when unset
 * @returns {string}
 */
function itemXml(item, fields, prefix, emitEmpty) {
  let body = '';
  for (const key of fields ?? Object.keys(item)) {
    const tag = `${prefix}${key}`;
    const value = item[key];
    if (Array.isArray(value)) {
      body += value.map((v) => el(tag, v, prefix)).join('');
    } else if (value && typeof value === 'object' && fields) {
      // structured values (e.g. shipping) are only emitted in pass-through mode
      continue;
    } else if ((value === undefined || value === null || value === '') && emitEmpty.has(key)) {
      body += `    <${tag}></${tag}>\n`;
    } else {
      body += el(tag, value, prefix);
    }
  }
  return `  <item>\n${body}  </item>`;
}

/**
 * Serialize a canonical feed in a provider-specific shape.
 * @param {{ channel?: { title?: string, link?: string, description?: string }, items: Record<string, unknown>[] }} feed
 * @param {{ root: 'rss' | 'feed', namespaced: boolean, fields?: string[], emitEmpty?: string[] }} format
 *   - `root`: RSS (`<rss><channel>`) or a bare `<feed>` root (Commission Junction)
 *   - `namespaced`: emit `g:`-prefixed item tags (Google) vs plain tags (the rest)
 *   - `fields`: the item fields to emit, in order (omit to pass every field through)
 *   - `emitEmpty`: fields emitted as an empty tag when unset (normally omitted)
 * @returns {string}
 */
export function buildFeed({ channel = {}, items }, {
  root, namespaced, fields, emitEmpty = [],
}) {
  const prefix = namespaced ? 'g:' : '';
  const empty = new Set(emitEmpty);
  const itemsXml = items.map((item) => itemXml(item, fields, prefix, empty)).join('\n');

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
