/**
 * Adobe I/O Runtime action: consumes Adobe I/O Events CloudEvents and forwards
 * them to Meta Conversion API as purchase events.
 *
 * Expected request shape:
 *   {
 *     "__ow_body": "<base64-encoded CloudEvent JSON>",
 *     ...or a raw JSON body
 *   }
 *
 * This action is intended as the downstream consumer for the event emitted by
 * the EBS sync flow (type: meta.capi.purchase).
 */
import { Core } from '@adobe/aio-sdk';
import crypto from 'crypto';
import { getJournalEntries, getOrder } from '../ebs-sync/commerce.js';
import { init } from '@adobe/aio-lib-state';

/** @type {import('@adobe/aio-lib-state').AdobeState | null} */
let _client = null;

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
  //return jsonResponse(202, { message: 'done for now'});
  const authorize = requireAuth(params);
  
  if (!authorize) {
    return jsonResponse(400, { error: 'Missing required parameters for commerce API' });
  }

  let log = null;
  log = Core.Logger('meta-capi', { level: params.LOG_LEVEL ?? 'info' });

  try {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 1);

    const untilDate = new Date();

    const { entries, until } = await getJournalEntries(
        params, sinceDate.toISOString(), log, untilDate.toISOString()
    );

    const uniqueEntries = Object.values(
      entries.reduce((acc, entry) => {
        if (!entry.orderId) return acc;

        acc[entry.orderId] ??= entry;
        return acc;
      }, {})
      
    );
    const runId = `cron-${Date.now()}`;
    for (const order of uniqueEntries) {
      const orderNumber = order.orderId;
      const orderValue = orderNumber.split('-').pop();
      const claimed = await claimOrder(orderValue, runId);
      
      if (!claimed) continue;
      try {
          const payload = await buildMetaRequestPayload(params, order);
          const response = await sendToMeta(payload, params);
          await completeOrder(orderValue);
          log.info('Successfully fired Meta CAPI event for order', {orderIdProcessed: orderValue, metaStatus: response.status, metaResponse: response.body});
      } catch (error) {
          log.error('Error occurred while processing order', { orderId: orderValue, error: error.message });
          await failOrder(orderValue, error);
          return jsonResponse(500, { 
            error: 'meta_capi_failed', 
            detail: error.message 
          });
      }
    }
  } catch (error) {
    log.error('meta-capi consumer failed', error);
    return jsonResponse(500, {
      error: 'meta_capi_failed',
      detail: error.message,
    });
  }
  return jsonResponse(200, { message: 'Successfully pushed the orders to Meta CAPI' });
}

/**
 * Check the authorization to use the commerce API and its resources.
 * @param {*} params 
 * @returns 
 */
function requireAuth(params) {

  let log = null;
  log = Core.Logger('meta-capi', { level: params.LOG_LEVEL ?? 'info' });

  const EDGE_COMMERCE_API_BASE = params.EDGE_COMMERCE_API_BASE;
  const EDGE_COMMERCE_API_ORDERS_TOKEN = params.EDGE_COMMERCE_API_ORDERS_TOKEN;
  const ORG = params.ORG;
  const SITE = params.SITE;

  if (!EDGE_COMMERCE_API_BASE || !EDGE_COMMERCE_API_ORDERS_TOKEN || !ORG || !SITE) {
    log.error('Missing required parameters for commerce API');
    return false;
  }
  return true;
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
  const key = `${orderId}`;
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
      lockedUntil: new Date(
        Date.now() + 15 * 60 * 1000
      ).toISOString()
    },
    {
      ttl: 600
    }
  );
  return true;
}

/**
 * Completes the processing of an order and updates its status.
 * @param {*} orderId 
 */
async function completeOrder(orderId) {
  const state = await client();

  await state.put(`${orderId}`,
    {
      orderId,
      status: "PROCESSED",
      processedAt: new Date().toISOString()
    },
    {
      ttl: -1
    }
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
  await state.put(`${orderId}`,
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
 * @returns 
 */
async function buildMetaRequestPayload(params, order) {
  const eventId = order.orderId;
  const orderData = await getOrder(params, eventId);

  const hashValue = (value) => {
    if (!value) return null;
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  };
  return {
    data: [
      {
        event_name: 'Purchase',
        event_time: new Date().toISOString(),
        event_id: eventId.split('-').pop(),
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
                price: parseFloat(item.price.final)
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
 * @returns {Promise<Record<string, unknown>>}
 */
async function sendToMeta(payload, params) {

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
  let log = null;
  const pixelId = metaPixelId;
  const metaBaseUrl = params.META_BASE_URL || 'https://graph.facebook.com';
  const accessToken = params.META_ACCESS_TOKEN;
  const apiVersion = params.META_API_VERSION || 'v22.0';
  log = Core.Logger('meta-capi', { level: params.LOG_LEVEL ?? 'info' });

  log.info(`Meta CAPI consumer: isProd=${isProd}, isStage=${isStage}, pixelId=${pixelId}, apiVersion=${apiVersion}`);

  if (!pixelId || !accessToken) {
    throw new Error('Missing META_PIXEL_ID or META_ACCESS_TOKEN');
  }

  const url = `${metaBaseUrl}/${apiVersion}/${pixelId}/events`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      access_token: accessToken,
      ...payload,
    }),
  });
  log.info(`[meta-capi] Meta API response status: ${response.status}`);
  const body = await response.text();
  let parsedBody = body;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    log.error('Failed to parse Meta API response', { body });
  }
  return {
    status: response.ok ? 200 : response.status,
    body: {
      ok: response.ok,
      metaStatus: response.status,
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
