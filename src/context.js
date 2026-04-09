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
    AIO_CLIENTID,
    AIO_CLIENTSECRET,
    AIO_SCOPES,
    AIO_IMSORGID,
    AIO_EVENTS_PROVIDER_ID,
    EMAIL_TOKEN,
    PROXY_TOKEN,
    EBS_BASE_URL,
    EBS_BASE_URL_STAGE,
    EBS_API_KEY,
    EBS_API_KEY_STAGE,
    ...data
  } = owParams;

  const token = await getAccessToken(AIO_CLIENTID, AIO_CLIENTSECRET, AIO_SCOPES);

  return {
    env: {
      ORG,
      SITE,
      SHEET,
      EMAIL_TOKEN,
      PROXY_TOKEN,
      EBS_BASE_URL,
      EBS_BASE_URL_STAGE,
      EBS_API_KEY,
      EBS_API_KEY_STAGE
    },
    // @ts-ignore
    log: Core.Logger('main', { level: LOG_LEVEL }),
    data,
    info: {
      method: method?.toUpperCase(),
      headers,
      path,
    },
    events: {
      apiKey: AIO_CLIENTID,
      token,
      orgId: AIO_IMSORGID,
      providerId: AIO_EVENTS_PROVIDER_ID,
    },
  }
}
