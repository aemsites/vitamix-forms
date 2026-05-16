import makeContext from '../../context.js';
import { errorResponse } from '../../utils.js';
import { proxyFetch } from '../../proxy.js';

const PROD_ORIGIN = 'www.vitamix.com';

/**
 * @param {string | undefined} cookieHeader
 * @param {string} name
 * @returns {string | null}
 */
function getCookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * @param {Record<string, string>} headers
 * @returns {string | null}
 */
function extractAuthToken(headers) {
  const cookie = headers.cookie ?? headers.Cookie;
  const cookieToken = getCookieValue(cookie, 'auth_token');
  if (cookieToken) return cookieToken;
  const auth = headers.authorization ?? headers.Authorization;
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return null;
}

/**
 * Decode a JWT's payload (no signature verification).
 * @param {string} token
 * @returns {Record<string, unknown> | null}
 */
function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * @param {Context} ctx
 * @param {string} email
 * @param {string} token
 * @returns {Promise<Response>}
 */
async function fetchCustomer(ctx, email, token) {
  const { EDGE_COMMERCE_API_BASE, ORG, SITE } = ctx.env;
  const url = `${EDGE_COMMERCE_API_BASE}/${ORG}/sites/${SITE}/customers/${encodeURIComponent(email)}`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * @param {Context} ctx
 * @param {string} email
 * @param {boolean} isProd
 * @returns {Promise<Response>}
 */
async function fetchProfileStatus(ctx, email, isProd) {
  const baseUrl = isProd ? ctx.env.NEWSLETTER_BASE_URL : ctx.env.NEWSLETTER_BASE_URL_STAGE;
  const apiKey = isProd ? ctx.env.NEWSLETTER_API_KEY : ctx.env.NEWSLETTER_API_KEY_STAGE;
  if (!baseUrl) throw new Error('newsletter base URL not configured');
  const url = `${baseUrl}/VITProfileStatus?EmailAddress=${encodeURIComponent(email)}`;
  return proxyFetch(ctx, url, {
    method: 'GET',
    headers: { 'x-api-key': apiKey },
  });
}

/**
 * HTTP action: returns the current user's profile by stitching together the
 * edge commerce customer record with their newsletter subscription status.
 * @param {Object} params
 * @returns {Promise<RuntimeResponse>}
 */
export async function main(params) {
  try {
    const ctx = await makeContext(params);
    const { log } = ctx;

    if (ctx.info.method !== 'GET') {
      return errorResponse(405, 'method not allowed');
    }

    const token = extractAuthToken(ctx.info.headers || {});
    if (!token) {
      return errorResponse(401, 'missing auth token');
    }

    const payload = decodeJwtPayload(token);
    const email = payload && typeof payload.email === 'string' ? payload.email : null;
    if (!email) {
      return errorResponse(401, 'invalid auth token');
    }

    const customerResp = await fetchCustomer(ctx, email, token);
    if (!customerResp.ok) {
      const errBody = await customerResp.text().catch(() => '');
      return errorResponse(customerResp.status, 'customer lookup failed', errBody);
    }
    const customer = await customerResp.json();

    const isProd = ctx.info.headers?.referer?.includes(PROD_ORIGIN) || false;
    let newsletter = null;
    try {
      const statusResp = await fetchProfileStatus(ctx, email, isProd);
      newsletter = await statusResp.json().catch(() => null);
    } catch (err) {
      log.warn(`profile status fetch failed for ${email}: ${err.message}`);
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: { customer, newsletter },
    };
  } catch (error) {
    if (error.response) return error.response;
    console.error('fatal error:', error);
    return errorResponse(500, 'server error');
  }
}
