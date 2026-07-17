import { fetchHTML } from "./da.js";

const EMAIL_API_URL = 'https://api.adobecommerce.live';
const PREFERRED_MESSAGE_KEYS = ['firstName', 'lastName', 'email', 'timestamp'];

/**
 * @typedef {{
 *   toEmail: string | string[];
 *   subject: string;
 *   html: string;
 *   cc?: string[];
 *   bcc?: string[];
 * }} EmailPayload
 */

/**
 * Get email template from DA file at some path
 * Parse template from HTML string
 * Resolve template from variables provided
 * 
 * Format for the template is:
 * ```html
 * <body>
 *   <header></header>
 *   <main>
 *     <div>
 *       <p>To: household@vitamix.com, this@example.com</p>
 *       <p>cc: test@vitamix.com</p>
 *       <p>bcc: test@vitamix.com</p>
 *       <p>Subject: New Media Contact Request</p>
 *       <p>{{message}}</p>
 *     </div>
 *   </main>
 *   <footer></footer>
 * </body>
 * ```
 * 
 * @param {Context} ctx 
 * @param {string} path 
 * @param {Record<string, string>} variables
 * @returns {Promise<EmailPayload>}
 */
export async function resolveEmailTemplate(ctx, path, variables) {
  const templateHtml = await fetchHTML(ctx, path);
  if (!templateHtml) {
    return null;
  }

  // get each `p` element using regex
  // only extract the text inside the `p` element
  const pElements = templateHtml.match(/<p>(.*?)<\/p>/g).map((element) => element.replace(/<p>/g, '').replace(/<\/p>/g, '').trim());

  /** @type {string[]} ex. ["<p>{{message}}</p>"]*/
  const templateElements = [];

  // for each element, if it starts with `string:`, split on `:`, the first part is the key, the second part is the value
  const data = pElements.reduce((acc, element) => {
    // if the element looks like a template variable, add to template elements
    if (/\{\{(.*?)\}\}/.test(element)) {
      templateElements.push(element);
      return acc;
    }

    const [rkey, rvalue] = element.split(':');
    if (!rkey || !rvalue) {
      return acc;
    }

    let key = rkey.toLowerCase().trim();
    /** @type {string | string[]} */
    let value = rvalue.trim();
    if (['to', 'cc', 'bcc'].includes(key)) {
      // parse value into array of strings
      value = value.split(',').map((v) => v.trim());
      // and convert to proper key
      if (key === 'to') {
        key = 'toEmail';
      }
    }

    acc[key] = value;
    return acc;
  }, {
    toEmail: '',
    cc: [],
    bcc: [],
    subject: '',
    html: '',
  });

  // create html from template elements
  // for each {{variable}} in the template elements, replace with the variable value
  // for {{message}}, replace it with a table of all variables
  // ex. <table><tr><td>Key1</td><td>Value1</td></tr><tr><td>Key2</td><td>Value2</td></tr></table>
  let html = '<div>';
  templateElements.forEach((element) => {
    const variable = element.replace(/{{/g, '').replace(/}}/g, '');
    if (variable === 'message') {
      const rows = [];
      for (const key of PREFERRED_MESSAGE_KEYS) {
        if (variables[key]) {
          rows.push(`<tr><td>${key}</td><td>${variables[key]}</td></tr>`);
        }
      }
      Object.entries(variables).forEach(([key, value]) => {
        if (!PREFERRED_MESSAGE_KEYS.includes(key)) {
          rows.push(`<tr><td>${key}</td><td>${value}</td></tr>`);
        }
      })
      html += `<table>${rows.join('')}</table>`;
    } else {
      // for regular variables, just insert as a <p> element
      html += `<p>${variables[variable]}</p>`;
    }
  });
  html += '</div>';

  return {
    ...data,
    html,
  }
}

const HEADER_KEYS = ['to', 'cc', 'bcc', 'subject'];

/**
 * Extract the trimmed text of each `<p>` element from a template HTML string.
 * @param {string} templateHtml
 * @returns {string[]}
 */
function extractParagraphs(templateHtml) {
  const matches = templateHtml.match(/<p>([\s\S]*?)<\/p>/g);
  if (!matches) {
    return [];
  }
  return matches.map((el) => el.replace(/<\/?p>/g, '').trim());
}

/**
 * Replace `{{key}}` tokens in a string from a variables map.
 * Leaves unknown tokens untouched. `{{digest}}` is never substituted here.
 * @param {string} str
 * @param {Record<string, string>} variables
 * @returns {string}
 */
function applyVariables(str, variables) {
  return str.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (match, key) => {
    if (key === 'digest') {
      return match;
    }
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

/**
 * Resolve a digest email template from DA.
 *
 * Same document format as {@link resolveEmailTemplate} — `To:`/`cc:`/`bcc:`/
 * `Subject:` are parsed from `<p>` lines — but with two differences:
 *   - a dedicated `{{digest}}` placeholder is replaced with the caller-supplied
 *     `digestHtml` (pre-rendered HTML, e.g. a table), and
 *   - any other non-header paragraph passes through as literal body copy
 *     (with `{{count}}`/`{{date}}`-style variables substituted).
 *
 * Returns null if the template document does not exist (404), so callers can
 * skip the send and retry later.
 *
 * @param {Context} ctx
 * @param {string} path
 * @param {string} digestHtml - pre-rendered HTML inserted at `{{digest}}`
 * @param {Record<string, string>} [variables] - tokens for subject/body copy
 * @returns {Promise<EmailPayload | null>}
 */
export async function resolveDigestTemplate(ctx, path, digestHtml, variables = {}) {
  const templateHtml = await fetchHTML(ctx, path);
  if (!templateHtml) {
    return null;
  }

  /** @type {EmailPayload} */
  const result = { toEmail: '', cc: [], bcc: [], subject: '', html: '' };
  const bodyParts = [];

  for (const paragraph of extractParagraphs(templateHtml)) {
    if (!paragraph) {
      continue;
    }

    // Standalone placeholder line, e.g. "{{digest}}".
    const placeholder = paragraph.match(/^\{\{\s*([\w-]+)\s*\}\}$/);
    if (placeholder) {
      if (placeholder[1].toLowerCase() === 'digest') {
        bodyParts.push(digestHtml);
      }
      continue;
    }

    // Header line, e.g. "To: a@b.com, c@d.com" / "Subject: ...".
    const colon = paragraph.indexOf(':');
    if (colon !== -1) {
      const key = paragraph.slice(0, colon).toLowerCase().trim();
      if (HEADER_KEYS.includes(key)) {
        const value = applyVariables(paragraph.slice(colon + 1).trim(), variables);
        if (key === 'to') {
          result.toEmail = value.split(',').map((v) => v.trim()).filter(Boolean);
        } else if (key === 'subject') {
          result.subject = value;
        } else {
          result[key] = value.split(',').map((v) => v.trim()).filter(Boolean);
        }
        continue;
      }
    }

    // Anything else is literal body copy.
    bodyParts.push(`<p>${applyVariables(paragraph, variables)}</p>`);
  }

  result.html = `<div>${bodyParts.join('')}</div>`;
  return result;
}

/**
 * Send an email via Productbus Email service
 * @param {Context} ctx
 * @param {string|string[]} toEmail
 * @param {string} subject
 * @param {string} html
 * @param {string[]} [cc]
 * @param {string[]} [bcc]
 * @returns {Promise<void>}
 */
export async function sendEmail(ctx, toEmail, subject, html, cc, bcc) {
  const {
    env: {
      ORG,
      SITE,
      EMAIL_TOKEN,
    },
    log
  } = ctx;
  /** @type {EmailPayload} */
  const data = {
    toEmail,
    subject,
    html,
    cc,
    bcc,
  }
  const resp = await fetch(`${EMAIL_API_URL}/${ORG}/sites/${SITE}/emails`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${EMAIL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!resp.ok) {
    log.error('failed to send email: ', resp.status, resp.headers.get('x-error'));
    throw new Error('failed to send email');
  }
}