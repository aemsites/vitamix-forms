import { errorWithResponse } from "./utils.js";

/**
 * Proxy URL for the org/site
 * @param {string} org 
 * @param {string} site 
 * @returns {string}
 */
const PROXY_URL = (org, site) => `https://lqmig3v5eb.execute-api.us-east-1.amazonaws.com/helix-services/proxy/v1/${org}/${site}`

/**
 * Fetch via proxy
 * @param {Context} ctx 
 * @param {string} url 
 * @param {RequestInit} opts 
 * @returns {Promise<Response>}
 */
export async function proxyFetch(ctx, url, opts) {
  const proxyUrl = PROXY_URL(ctx.env.ORG, ctx.env.SITE);
  console.log('proxy fetching:', opts.method ?? 'GET', url, '=>', proxyUrl);
  const resp = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ctx.env.PROXY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      ...(opts ?? {}),
    }),
  })
  if (!resp.ok) {
    // The proxy sets `x-upstream-status` to the status it got back from the target.
    // Absent means the proxy itself produced the error and never called the target —
    // which is what distinguishes a proxy-side 401 from one forwarded from EBS.
    const upstreamStatus = resp.headers.get('x-upstream-status') ?? 'none';
    const message = `failed to proxyFetch ${url}: ${resp.status} ${resp.statusText} (upstream: ${upstreamStatus})`;
    ctx.log.error(message);
    const err = errorWithResponse(message, resp.status, resp.statusText, await resp.text());
    // Always set (never undefined) so its presence marks the error as proxy-originated,
    // letting callers log it without having to sniff the message string.
    err.upstreamStatus = upstreamStatus;
    throw err;
  }
  return resp;
}