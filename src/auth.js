const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** @type {{ token: string, expiresAt: number } | null} */
let cached = null;

/**
 * Generate an OAuth Server-to-Server access token from Adobe IMS.
 * Caches the token and reuses it until close to expiration.
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} scopes - comma-separated scopes
 * @returns {Promise<string>} access token
 */
export async function getAccessToken(clientId, clientSecret, scopes) {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const resp = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: scopes,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`IMS token request failed: ${resp.status} ${text}`);
  }

  const { access_token, expires_in } = await resp.json();
  cached = {
    token: access_token,
    expiresAt: Date.now() + (expires_in * 1000) - EXPIRY_BUFFER_MS,
  };
  return access_token;
}
