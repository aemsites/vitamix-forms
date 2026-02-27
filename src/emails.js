import { fetchHTML } from "./da.js";

const EMAIL_API_URL = 'https://api.adobecommerce.live';

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
      const messageTable = Object.entries(variables).map(([key, value]) => `<tr><td>${key}</td><td>${value}</td></tr>`).join('');
      html += `<table>${messageTable}</table>`;
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