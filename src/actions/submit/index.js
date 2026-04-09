import { errorResponse } from '../../utils.js';
import { publishEvent } from '../../events.js';
import makeContext from '../../context.js';
import { createProductRegistration, queryOrder } from '../../ebs.js';

const MAX_PAYLOAD_SIZE = 16_000; // 16KB

/**
 * alphanumeric, underscores, hyphens, slashes allowed
 * but no trailing/leading slash, hyphen or underscore
 */
const FORM_ID_PATTERN = /^[a-zA-Z0-9]+[\/a-zA-Z0-9_-]*[a-zA-Z0-9]+$/;

/**
 * Origin of the production site, as seen in referer header
 */
const PROD_ORIGIN = 'www.vitamix.com';

/**
 * @param {Record<string, unknown>} data
 * @returns {string|undefined} error message if invalid
 */
function validatePayload(data) {
  if (!data || typeof data !== 'object') {
    return 'invalid payload';
  }

  if (!data.formId || typeof data.formId !== 'string') {
    return 'missing or invalid formId';
  }

  // check that formId looks valid
  // these are further validated in the processor action
  if (!FORM_ID_PATTERN.test(data.formId)) {
    return 'invalid formId';
  }

  // reject form data that seems sus
  // too large
  const payloadStr = JSON.stringify(data);
  if (payloadStr.length > MAX_PAYLOAD_SIZE) {
    return 'payload too large';
  }

  // contains HTML
  if (payloadStr.includes('<')) {
    return 'payload contains invalid characters';
  }

  // nested properties in data
  Object.values(data.data ?? data ?? {}).forEach((val) => {
    if (typeof val === 'object' && val !== null) {
      return 'payload contains nested data';
    }
  });
}

/**
 * Recursively transform SOAP XML parsed keys:
 * - Strip `@_` attribute prefix
 * - Lowercase first character of each key
 * - Convert "true"/"false" strings to booleans
 * @param {unknown} obj
 * @returns {unknown}
 */
function transformSoapKeys(obj) {
  if (Array.isArray(obj)) return obj.map(transformSoapKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([key, val]) => {
        const clean = key.startsWith('@_') ? key.slice(2) : key;
        const camel = clean.charAt(0).toLowerCase() + clean.slice(1);
        return [camel, transformSoapKeys(val)];
      })
    );
  }
  if (obj === 'true') return true;
  if (obj === 'false') return false;
  return obj;
}

/**
 * Get EBS settings for the given formId
 * @param {Context} ctx 
 * @param {string} formId 
 * @returns {Object}
 */
function getEbsSettings(ctx, formId) {
  const baseUrl = formId.includes('stage/')
    ? ctx.env.EBS_BASE_URL_STAGE
    : ctx.env.EBS_BASE_URL;
  const apiKey = formId.includes('stage/')
    ? ctx.env.EBS_API_KEY_STAGE
    : ctx.env.EBS_API_KEY;
  return { baseUrl, apiKey };
}

/**
 * Handle product registration submission
 * @param {Context} ctx 
 * @param {string} formId
 * @param {Object} data 
 * @returns {Promise<RuntimeResponse>}
 */
async function handleProductRegistration(ctx, formId, data) {
  const { log } = ctx;
  log.info(`handling product registration for formId=${formId}`);
  // TODO: validate payload
  const opts = getEbsSettings(ctx, formId);
  const resp = await createProductRegistration(ctx, data, opts);
  // TODO: parse response into HTTP status codes and appropriate messages
  return {
    body: JSON.stringify(resp.body),
    statusCode: resp.status,
    headers: {
      'content-type': 'application/json'
    }
  };
}

/** 
 * Handle order status submission
 * @param {Context} ctx 
 * @param {string} formId
 * @param {Object} data 
 * @returns {Promise<RuntimeResponse>}
 */
async function handleOrderStatus(ctx, formId, data) {
  const { log } = ctx;
  if (!data.orderNumber || typeof data.orderNumber !== 'string') {
    return errorResponse(400, 'missing or invalid orderNumber');
  }

  log.info(`handling order status for formId=${formId}`);
  const opts = getEbsSettings(ctx, formId);
  const resp = await queryOrder(ctx, data.orderNumber, opts);

  const response = resp.body?.Response;
  if (response?.['@_Succeeded'] !== 'true') {
    const message = response?.Details?.['@_Message'] ?? 'unknown error';
    const status = /no results found/i.test(message) ? 404 : 400;
    return errorResponse(status, message, { error: message });
  }

  return {
    body: transformSoapKeys(response),
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
  };
}

/**
 * HTTP action: receives form submissions, validates, and publishes a `form.submitted` event.
 * @param {Object} params
 * @returns {Promise<RuntimeResponse>}
 */
export async function main(params) {
  try {
    const ctx = await makeContext(params);
    const { log } = ctx;

    if (ctx.info.method !== 'POST') {
      return errorResponse(405, 'method not allowed');
    }
    if (ctx.info.headers['content-type'] !== 'application/json') {
      return errorResponse(415, 'invalid content-type');
    }

    const error = validatePayload(ctx.data);
    if (error) {
      return errorResponse(400, error);
    }

    const isProdReferer = ctx.info.headers['referer']?.includes(PROD_ORIGIN) || false;

    /** @type {string} */
    // @ts-ignore
    let formId = ctx.data.formId;

    // if the origin of the submission isn't the production origin
    // add the `stage` prefix to the formId (if not present)
    if (!isProdReferer && !formId.startsWith('stage/')) {
      log.info(`adding stage prefix to formId=${formId} because origin is not production: ${ctx.info.headers['referer']}`);
      formId = `stage/${formId}`;
    }

    // get submission data, it may be in the data object or the root of the payload
    /** @type {Record<string, unknown>} */
    // @ts-ignore
    let data = ctx.data.data;
    if (typeof data !== 'object') {
      data = ctx.data;
      delete data.formId;
    }

    if (formId.endsWith('/product-registration')) {
      return await handleProductRegistration(ctx, formId, data);
    } else if (formId.endsWith('/order-status')) {
      return await handleOrderStatus(ctx, formId, data);
    }

    // add timestamp and IP - these can't be set by the payload
    delete data.IP;
    delete data.timestamp;
    data = {
      timestamp: new Date().toISOString(),
      IP: ctx.info.headers['x-forwarded-for'] || ctx.info.headers['x-real-ip'] || ctx.info.headers['cf-connecting-ip'] || 'unknown',
      ...data,
    };

    log.info(`publishing form.submitted event for formId=${formId}`);
    await publishEvent(ctx, 'form.submitted', { formId, data });

    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: { formId },
    };
  } catch (error) {
    if (error.response) {
      return error.response;
    }
    console.error('fatal error: ', error);
    return errorResponse(500, 'server error');
  }
}
