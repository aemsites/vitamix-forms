import { Core } from '@adobe/aio-sdk';

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
    AIO_S2S_TOKEN,
    AIO_ORG_ID,
    AIO_EVENTS_PROVIDER_ID,
    AIO_JOURNAL_URL,
    ...data
  } = owParams;
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
      token: AIO_S2S_TOKEN,
      orgId: AIO_ORG_ID,
      providerId: AIO_EVENTS_PROVIDER_ID,
      journalUrl: AIO_JOURNAL_URL,
    },
  }
}
