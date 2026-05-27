import { errorResponse } from '../../utils.js';
import { publishEvent } from '../../events.js';
import makeContext from '../../context.js';
import { createProductRegistration, queryOrder } from '../../ebs.js';
import { proxyFetch } from '../../proxy.js';

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
 * @returns {any}
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
 * EBS JSON endpoint settings (newsletter, profile).
 * Separate from the XML/SOAP endpoint used by order sync and product registration.
 * @param {Context} ctx
 * @param {string} formId
 * @returns {Object}
 */
function getEbsJsonSettings(ctx, formId) {
  const baseUrl = formId.includes('stage/')
    ? ctx.env.EBS_JSON_BASE_URL_STAGE
    : ctx.env.EBS_JSON_BASE_URL;
  const apiKey = formId.includes('stage/')
    ? ctx.env.EBS_JSON_API_KEY_STAGE
    : ctx.env.EBS_JSON_API_KEY;
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
  if (!data || typeof data !== 'object') {
    return errorResponse(400, 'missing or invalid data');
  }

  const requiredFields = ['acceptTerms', 'address', 'city', 'postalCode', 'province', 'email', 'firstName', 'lastName', 'phone', 'purchasedFrom', 'purchasedOn', 'serialNumber'];
  for (const field of requiredFields) {
    if (!data[field]) {
      return errorResponse(400, `missing or invalid ${field}`, { details: [{ message: `missing or invalid ${field}` }] });
    }
  }
  // accept terms must be 'yes'
  if (data.acceptTerms !== 'yes') {
    return errorResponse(400, 'acceptTerms must be "yes"', { details: [{ message: 'acceptTerms must be "yes"' }] });
  }

  // check serial number, should be 18 digits
  if (!/^[0-9]{18}$/.test(data.serialNumber)) {
    return errorResponse(400, 'serialNumber must be 18 digits', { details: [{ message: 'invalid serial number' }] });
  }

  // pull country from formId
  const country = formId.replace(/^stage\//, '').split('/').shift();
  if (!['us', 'ca', 'mx', 'vr'].includes(country)) {
    return errorResponse(400, 'invalid country', { details: [{ message: 'invalid country' }] });
  }
  data.country = country.toUpperCase();

  // convert dd-mm-yyyy to ISO date string
  const purchasedOn = new Date(data.purchasedOn);
  if (isNaN(purchasedOn.getTime())) {
    return errorResponse(400, 'invalid purchasedOn');
  }
  data.purchasedOn = purchasedOn.toISOString();

  const opts = getEbsSettings(ctx, formId);

  // If the user opted in to marketing emails, subscribe them to the newsletter in parallel.
  // Accepts boolean true or the string "yes". Failure is non-fatal — log and continue.
  const marketingOptIn = data.marketingOptIn === true || data.marketingOptIn === 'yes';
  const newsletterPromise = marketingOptIn
    ? callNewsletterApi(ctx, formId, { ...data, emailOptIn: true }).catch(err => {
      log.warn(`newsletter subscription failed for product registration formId=${formId}: ${err.message}`);
    })
    : Promise.resolve();

  const [resp] = await Promise.all([
    createProductRegistration(ctx, data, opts),
    newsletterPromise,
  ]);
  const response = resp.body?.RegistrationResponse;
  if (response?.['@_Succeeded'] !== 'true') {
    log.error(`failed to create product registration for formId=${formId}: ${response?.Details?.['@_Message'] ?? 'unknown error'}`, resp.body);
    const message = response?.Details?.['@_Message'] ?? 'unknown error';
    const status = /no results found/i.test(message) ? 404 : 400;
    const details = response?.Details ? transformSoapKeys(response?.Details) : null;
    if (Array.isArray(details)) {
      details.forEach(detail => {
        delete detail.key;
      });
    }
    return errorResponse(status, message, { error: message, details });
  }
  return {
    body: transformSoapKeys(resp.body),
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

  const body = transformSoapKeys(response);

  // Detect cancellation from line item statuses. Cancelled orders may have no
  // delivery items; each cancelled line item shows Status="Closed".
  const lineItems = [].concat(body.order?.lineItem ?? []);
  if (lineItems.length > 0) {
    const closedCount = lineItems.filter(item => item?.status === 'Closed').length;
    if (closedCount === lineItems.length) {
      body.outcome = 'Cancelled';
    } else if (closedCount > 0) {
      body.outcome = 'Partially Cancelled';
    }
  }

  // remove PII from data
  delete body.order?.customer;
  delete body.order?.lineItem;
  delete body.order?.systemOfRecordKey;
  body.order?.delivery?.forEach(delivery => {
    delete delivery.systemOfRecordKey;
    delete delivery.trackingDetail;
  });

  return {
    body,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
  };
}

/**
 * Build the newsletter API payload and send it via the proxy.
 * Caller is responsible for ensuring data.email and data.emailOptIn are valid.
 * @param {Context} ctx
 * @param {string} formId
 * @param {Object} data
 * @returns {Promise<Response>}
 */
async function callNewsletterApi(ctx, formId, data) {
  const payload = {
    EBSPartyNumber: '',
    FirstName: '',
    MiddleName: '',
    LastName: '',
    LeadSource: 'edge-commerce',
    Country: 'US',
    Company: 'HOUSEHOLD',
    EmailAddress: data.email,
    EmailOptIn: data.emailOptIn,
    EmailPreferenceDate: '',
    Mobile: '',
    SMSOptIn: false,
    SMSPreferenceDate: '',
    Title: '',
    workFlowName: 'subscription',
  };

  if (data.firstName && typeof data.firstName === 'string') payload.FirstName = data.firstName;
  if (data.middleName && typeof data.middleName === 'string') payload.MiddleName = data.middleName;
  if (data.lastName && typeof data.lastName === 'string') payload.LastName = data.lastName;
  if (data.country && typeof data.country === 'string' && ['us', 'ca', 'mx', 'vr'].includes(data.country.toLowerCase())) {
    payload.Country = data.country.toUpperCase();
  }
  if (data.company && typeof data.company === 'string' && ['household', 'business'].includes(data.company.toLowerCase())) {
    payload.Company = data.company.toUpperCase();
  }
  if (data.title && typeof data.title === 'string') payload.Title = data.title;
  if (data.workFlowName && typeof data.workFlowName === 'string' && ['subscription', 'newsletter'].includes(data.workFlowName.toLowerCase())) {
    payload.workFlowName = data.workFlowName;
  }
  if (data.mobile && typeof data.mobile === 'string') {
    payload.Mobile = data.mobile;
    // infer opt-in from lack of explicit opt-out
    if (data.smsOptIn === undefined || data.smsOptIn === null) payload.SMSOptIn = true;
  }
  if (data.smsOptIn && typeof data.smsOptIn === 'boolean') payload.SMSOptIn = data.smsOptIn;
  if (data.smsPreferenceDate && typeof data.smsPreferenceDate === 'string') payload.SMSPreferenceDate = data.smsPreferenceDate;

  const { baseUrl, apiKey } = getEbsJsonSettings(ctx, formId);
  if (!baseUrl) {
    throw new Error(`newsletter API URL not configured for formId=${formId}`);
  }
  return proxyFetch(ctx, `${baseUrl}/VITNewsletterSignUp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Handle newsletter subscription submission
 * @param {Context} ctx
 * @param {string} formId
 * @param {Object} data
 * @returns {Promise<RuntimeResponse>}
 */
async function handleNewsletter(ctx, formId, data) {
  const { log } = ctx;
  log.info(`handling newsletter for formId=${formId}`);

  if (!data || typeof data !== 'object') {
    return errorResponse(400, 'missing or invalid data');
  }
  if (!data.email || typeof data.email !== 'string') {
    return errorResponse(400, 'missing or invalid emailAddress');
  }
  if (typeof data.emailOptIn !== 'boolean') {
    return errorResponse(400, 'missing or invalid emailOptIn');
  }

  const resp = await callNewsletterApi(ctx, formId, data);
  return {
    statusCode: resp.status,
    headers: { 'content-type': 'application/json' },
    body: await resp.json().catch(() => ({})),
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
    } else if (formId.endsWith('/newsletter')) {
      return await handleNewsletter(ctx, formId, data);
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
