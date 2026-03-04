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
    throw new Error(`Proxy fetch failed: ${resp.status} ${resp.statusText} - ${resp.headers.get('x-error') ?? ''}`);
  }
  return resp;
}