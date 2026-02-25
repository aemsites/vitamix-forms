import { Core } from '@adobe/aio-sdk';
import { getAccessToken } from './auth.js';

/**
 * @param {Object} owParams 
 * @returns {Promise<Context>}
 */
export default async function createContext(owParams) {
  const {
    __ow_method: method,
    __ow_headers: headers,
    __ow_path: path,
    ORG,
    SITE,
    SHEET,
    LOG_LEVEL,
    AIO_S2S_API_KEY,
    AIO_S2S_CLIENT_SECRET,
    AIO_S2S_SCOPES,
    AIO_ORG_ID,
    AIO_EVENTS_PROVIDER_ID,
    ...data
  } = owParams;

  const token = await getAccessToken(AIO_S2S_API_KEY, AIO_S2S_CLIENT_SECRET, AIO_S2S_SCOPES);

  return {
    env: { ORG, SITE, SHEET },
    // @ts-ignore
    log: Core.Logger('main', { level: LOG_LEVEL }),
    data,
    info: {
      method: method?.toUpperCase(),
      headers,
      path,
    },
    events: {
      apiKey: AIO_S2S_API_KEY,
      token,
      orgId: AIO_ORG_ID,
      providerId: AIO_EVENTS_PROVIDER_ID,
    },
  }
}
