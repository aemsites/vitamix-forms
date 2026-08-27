import { Core } from '@adobe/aio-sdk';
import crypto from 'crypto';
import { getJournalEntries, getOrder } from '../ebs-sync/commerce.js';
import { init } from '@adobe/aio-lib-state';

/** @type {import('@adobe/aio-lib-state').AdobeState | null} */
let _client = null;

/** @type {ReturnType<typeof Core.Logger> | null} */
let _log = null;

/**
 * Returns (or lazily initialises) the shared logger instance.
 * @param {string} [level]
 */
function getLogger(level = 'info') {
  if (!_log) _log = Core.Logger('meta-capi', { level });
  return _log;
}

async function client() {
  if (!_client) _client = await init();
  return _client;
}

/**
 * Main entry point for the Adobe I/O Runtime action.
 * Meta CAPI server to server call to fire Purchase event.
 * @param {*} params 
 * @returns 
 */
export async function main(params) {
  const authErr = requireAuth(params);
  if (authErr) return authErr;

  const log = getLogger(params.LOG_LEVEL ?? 'info');

  try {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 1);

    const untilDate = new Date();

    const { entries, until } = await getJournalEntries(
        params, sinceDate.toISOString(), log, untilDate.toISOString()
    );

    const TERMINAL_EVENTS = new Set(['payment_completed']);
    const terminalEntries = entries.filter(
      (e) => e.orderId && TERMINAL_EVENTS.has(e.event),
    );

    // Deduplicate to unique orderIds, preserving oldest-first order.
    const seen = new Set();
    const orderIds = [];
    for (const e of terminalEntries) {
      if (!seen.has(e.orderId)) {
        seen.add(e.orderId);
        orderIds.push(e.orderId);
      }
    }

    if (entries.length > 0 && terminalEntries.length === 0) {
      // Entries came back but none were terminal — log event type breakdown to diagnose.
      const eventCounts = {};
      for (const e of entries) {
        eventCounts[e.event ?? '(missing)'] = (eventCounts[e.event ?? '(missing)'] || 0) + 1;
      }
      log.info(`[meta-capi] No terminal events found. Event breakdown: ${JSON.stringify(eventCounts)}`);
    }

    log.info(
      `[meta-capi] ${terminalEntries.length} terminal entries, ${orderIds.length} unique order IDs to evaluate${orderIds.length > 0 ? `: ${orderIds.join(', ')}` : ''}`,
    );

    const runId = `cron-${Date.now()}`;
    for (const order of orderIds) {
      const orderValue = order.split('-').pop();
      const claimed = await claimOrder(orderValue, runId);
      if (!claimed) continue;
      try {
          const payload = await buildMetaRequestPayload(params, order);
          const response = await sendToMeta(payload, params, log);
          await completeOrder(orderValue);
          log.info('Successfully fired Meta CAPI event for order', {
            orderIdProcessed: orderValue, metaStatus: response.status, metaResponse: response.body
          });
      } catch (error) {
          log.error('Error occurred while processing order', { orderId: orderValue, error: JSON.stringify(error) });
          await failOrder(orderValue, error);
          continue;
      }
    }
  } catch (error) {
    log.error('meta-capi consumer failed', { error: error.message });
    return jsonResponse(500, {
      error: 'meta_capi_failed',
      detail: error.message,
    });
  }
  return jsonResponse(200, { message: 'Successfully pushed the orders to Meta CAPI' });
}

/**
 * Validate the shared status/trigger Bearer token
 * @param {*} params 
 * @returns 
 */
function requireAuth(params) {
  const authHeader = (params.__ow_headers || {}).authorization || '';
  const provided = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!params.SYNC_STATUS_TOKEN || !provided || provided !== params.SYNC_STATUS_TOKEN) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }
  return null;
}

/**
 * This is to claim order for processing, to avoid multiple workers processing the same order at the same time.
 * It uses a distributed lock mechanism with a TTL to ensure that only one worker can process an order at a time.
 * If the order is already being processed or has been processed, it will return false.
 * If the order is successfully claimed for processing, it will return true.
 * @param {*} orderId 
 * @param {*} runId 
 * @returns 
 */
async function claimOrder(orderId, runId) {
  const c = await client();
  const key = `meta-capi:${orderId}`;
  const existing = await c.get(key);
  if (existing && existing.value?.status === "PROCESSED") {
    return false;
  }

  if (
    existing &&
    existing.value?.status === "PROCESSING" &&
    new Date(existing.value.lockedUntil) > new Date()
  ) {
    return false;
  }

  await c.put(key,
    {
      orderId,
      status: "PROCESSING",
      lockedBy: runId,
      lockedUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    },
    { ttl: 600 }
  );
  return true;
}

/**
 * Completes the processing of an order and updates its status.
 * @param {*} orderId 
 */
async function completeOrder(orderId) {
  const state = await client();

  await state.put(`meta-capi:${orderId}`,
    {
      orderId,
      status: "PROCESSED",
      processedAt: new Date().toISOString()
    },
    { ttl: -1 }
  );
}

/**
 * This function marks an order as failed and records the error message.
 * It is used to track orders that could not be processed successfully.
 * The order will be marked as "FAILED" and the error message will be stored for debugging purposes. 
 * @param {*} orderId 
 * @param {*} error 
 */
async function failOrder(orderId, error) {
  const state = await client();
  await state.put(`meta-capi:${orderId}`,
    {
        orderId: orderId,
        status: "FAILED",
        lockedBy: null,
        error: error.message,
        failedAt: new Date().toISOString()
    },
    { ttl: -1 }
  );
}

/**
 * Builds the request payload for the Meta Conversion API.
 * @param {*} params
 * @param {*} orderValue
 * @returns 
 */
async function buildMetaRequestPayload(params, orderValue) {

  const [timestamp, orderId] = orderValue.split("Z-");
  const actualTimestamp = `${timestamp}Z`;
  //eventId.split('-').pop()

  const orderData = await getOrder(params, orderValue);
  const event_time =
  actualTimestamp &&
  !isNaN(Date.parse(actualTimestamp))
    ? Math.floor(new Date(actualTimestamp).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const hashValue = (value) => {
    if (!value) return null;
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  };
  return {
    data: [
      {
        event_name: 'Purchase',
        event_time: event_time,
        event_id: orderId,
        action_source: 'website',
        user_data: {
            em: [hashValue(orderData?.customer?.email || '')],
            ph: [hashValue(orderData?.customer?.phone || '')],
            fn: [hashValue(orderData?.customer?.firstName || '')],
            ln: [hashValue(orderData?.customer?.lastName || '')],
        },
        custom_data: normalizeCustomData(orderData),
      },
    ],
  };
}

/**
 * This function populates the custom data for Meta Conversion API compatibility.
 * It ensures that the currency is uppercase, the value is a number, and the contents
 * array is properly structured.
 * @param {*} customData 
 * @returns 
 */
function normalizeCustomData(customData) {
    const metaCustomData = {};
    const currency = customData?.payment?.currency || 'USD';
    if (typeof currency === 'string') {
        metaCustomData['currency'] = currency.toUpperCase();
    }
    metaCustomData['value'] = customData?.payment?.amount || customData?.amount || 0;
    metaCustomData['content_type'] = 'product';
    const orderItems = Array.isArray(customData?.items) ? customData?.items : []

    if (orderItems.length > 0 ) {
        const contents = orderItems.map((item) => {
            return {
                id: item?.sku ? item.sku : '',
                quantity: Number(item?.quantity || item?.qty || 1) || 1,
                price: parseFloat(item?.price.final)
            };
        });
        metaCustomData['contents'] = contents;
    }
    return metaCustomData;
}

/**
 * Sends the payload to the Meta Conversion API.
 * @param {Record<string, unknown>} payload 
 * @param {Record<string, unknown>} params
 * @param {ReturnType<typeof Core.Logger>} log
 * @returns {Promise<Record<string, unknown>>}
 */
async function sendToMeta(payload, params, log) {
  const NAMESPACE = process.env.AIO_RUNTIME_NAMESPACE;
  const WORKSPACE_NAME = process.env.AIO_PROJECT_WORKSPACE_NAME;
  
  const isProd = NAMESPACE?.includes('prod') || WORKSPACE_NAME?.toLowerCase() === 'production';
  const isStage = NAMESPACE?.includes('stage') || WORKSPACE_NAME?.toLowerCase() === 'stage';
  const isUat = NAMESPACE?.includes('uat') || WORKSPACE_NAME?.toLowerCase() === 'uat';

  let metaPixelId = '';
  
  if (isProd) {
    metaPixelId = params.META_PIXEL_ID;
  } else if (isStage) {
    metaPixelId = params.META_PIXEL_ID_STAGE;
  } else if (isUat) {
    metaPixelId = params.META_PIXEL_ID_UAT;
  } else {
    metaPixelId = params.META_PIXEL_ID_UAT; // default to UAT if not prod or stage
  }
  const pixelId = metaPixelId;
  const metaBaseUrl = params.META_BASE_URL || 'https://graph.facebook.com';
  const accessToken = params.META_ACCESS_TOKEN;
  const apiVersion = params.META_API_VERSION || 'v22.0';

  log.info(`Meta CAPI consumer: isProd=${isProd}, isStage=${isStage}, pixelId=${pixelId}, apiVersion=${apiVersion}`);

  if (!pixelId || !accessToken) {
    throw new Error('Missing META_PIXEL_ID or META_ACCESS_TOKEN');
  }

  const url = `${metaBaseUrl}/${apiVersion}/${pixelId}/events`;

  let response;
  let body;
  let parsedBody;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        access_token: accessToken,
        ...payload,
      }),
    });
    body = await response.text();
  } catch (networkError) {
    const errMsg = networkError instanceof Error ? networkError.message : String(networkError);
    log.error('[meta-capi] Network error calling Meta API', { url, error: errMsg });
    throw new Error(`Meta API network error: ${errMsg}`);
  }
  try {
    parsedBody = JSON.parse(body);
  } catch {
    log.error('[meta-capi] Failed to parse Meta API response', { body });
    parsedBody = body;
  }

  if (!response.ok || parsedBody?.error) {
    log.error('[meta-capi] Meta API returned error', {body: parsedBody});
    throw new Error(`Meta API responded with status : ${JSON.stringify(parsedBody)}`);
  }

  return {
    status: parsedBody?.events_received,
    body: {
      metaStatus: parsedBody?.events_received,
      metaResponse: parsedBody,
    },
  };
}

/**
 * Creates a JSON response object.
 * @param {number} statusCode 
 * @param {Record<string, unknown>} body 
 * @returns {Record<string, unknown>}
 */
function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
