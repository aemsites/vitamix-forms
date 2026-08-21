import { errorResponse } from '../../utils.js';
import { publishEvent } from '../../events.js';
import makeContext from '../../context.js';
import { createProductRegistration, queryOrder } from '../../ebs.js';
import { proxyFetch } from '../../proxy.js';
import { deriveOrderStatus } from '../../order-status.js';

const MAX_PAYLOAD_SIZE = 16_000; // 16KB

/**
 * alphanumeric, underscores, hyphens, slashes allowed
 * but no trailing/leading slash, hyphen or underscore
 */
const FORM_ID_PATTERN = /^[a-zA-Z0-9]+[/a-zA-Z0-9_-]*[a-zA-Z0-9]+$/;

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

  // Detect cancellation from line item statuses. Cancelled line items show
  // Status="Closed" AND Quantity="0" — Status="Closed" alone can also mean
  // shipped/fulfilled, so the zero quantity is what distinguishes cancellation.
  const lineItems = [].concat(body.order?.lineItem ?? []);
  if (lineItems.length > 0) {
    const isCancelled = item => item?.status === 'Closed' && item?.quantity === '0';
    const cancelledCount = lineItems.filter(isCancelled).length;
    if (cancelledCount === lineItems.length) {
      body.outcome = 'Cancelled';
    } else if (cancelledCount > 0) {
      body.outcome = 'Partially Cancelled';
    }
  }
  body.order.status = deriveOrderStatus(lineItems);

  // remove PII from data
  delete body.order?.customer;
  delete body.order?.lineItem;
  delete body.order?.systemOfRecordKey;
  if (body.order?.delivery) {
    // single-delivery responses arrive as an object, not an array — normalize
    body.order.delivery = [].concat(body.order.delivery);
    body.order.delivery.forEach(delivery => {
      delete delivery.systemOfRecordKey;
      delete delivery.trackingDetail;
    });
  }

  return {
    body,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
  };
}

/**
 * Interpret an SMS opt-in flag from a submitted form. It arrives either as a
 * boolean or as an HTML checkbox value. A checkbox only appears in the payload
 * when it was ticked, and its value is the checkbox's `value` attribute, which
 * differs per form — "yes" on product registration, but the entire consent
 * sentence on the newsletter popup. So treat any present, non-empty value that
 * is not an explicit negative as an opt-in; treat absent, empty, or negative
 * values as not opted in so a customer is never auto-opted-in.
 * @param {unknown} value - Raw opt-in flag as submitted by the form.
 * @returns {boolean} True when the customer explicitly opted in.
 */
function isOptedIn(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return false;
  return !['false', 'no', '0', 'off'].includes(normalized);
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
    LeadSource: (data.leadSource && typeof data.leadSource === 'string') ? data.leadSource : 'edge-commerce',
    Country: 'United States',
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
  if (data.country && typeof data.country === 'string'
    && ['us', 'ca', 'mx', 'vr'].includes(data.country.toLowerCase())) {
    const country = data.country.toUpperCase();
    if (country === 'US') {
      payload.Country = 'United States';
    } else if (country === 'CA') {
      payload.Country = 'Canada';
    } else {
      payload.Country = country;
    }
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
  }
  // SFDC records SMS consent as a "Mobile Opt Out" flag that is the inverse of
  // this opt-in. The checkbox arrives as a string ("yes"/"on") or is absent, so
  // normalise it here: an affirmative value opts the customer in; anything
  // absent or falsy leaves them opted out. Set unconditionally so registrations
  // (which send `phone` rather than `mobile`) still carry the correct flag.
  payload.SMSOptIn = isOptedIn(data.smsOptIn);
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
 * On stage, log the request/response pair for a submission to aid debugging.
 *
 * Gated to stage submissions (formId prefixed `stage/`, i.e. originating from a
 * non-production referer) so production submissions — which carry real PII — are
 * never logged. Best-effort: a logging failure must never affect the response.
 *
 * @param {Context} ctx
 * @param {string} formId
 * @param {unknown} request - the submission data as processed
 * @param {RuntimeResponse} response - the response returned to the caller
 */
function logStageSubmission(ctx, formId, request, response) {
  if (!formId || !formId.startsWith('stage/')) {
    return;
  }
  try {
    const { statusCode, body } = response?.error ?? response ?? {};
    ctx.log.info(`[stage-submission] ${JSON.stringify({ formId, request, response: { statusCode, body } })}`);
  } catch (err) {
    ctx.log.warn(`failed to log stage submission for formId=${formId}: ${err.message}`);
  }
}

/**
 * HTTP action: receives form submissions, validates, and publishes a `form.submitted` event.
 * @param {Object} params
 * @returns {Promise<RuntimeResponse>}
 */
export async function main(params) {
  /** @type {Context} */
  let ctx;
  /** @type {string} */
  let formId;
  /** @type {Record<string, unknown>} */
  let data;
  try {
    ctx = await makeContext(params);
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

    // @ts-ignore
    formId = ctx.data.formId;

    // if the origin of the submission isn't the production origin
    // add the `stage` prefix to the formId (if not present)
    if (!isProdReferer && !formId.startsWith('stage/')) {
      log.info(`adding stage prefix to formId=${formId} because origin is not production: ${ctx.info.headers['referer']}`);
      formId = `stage/${formId}`;
    }

    // get submission data, it may be in the data object or the root of the payload
    // @ts-ignore
    data = ctx.data.data;
    if (typeof data !== 'object') {
      data = ctx.data;
      delete data.formId;
    }

    /** @type {RuntimeResponse} */
    let response;
    if (formId.endsWith('/product-registration')) {
      response = await handleProductRegistration(ctx, formId, data);
    } else if (formId.endsWith('/order-status')) {
      response = await handleOrderStatus(ctx, formId, data);
    } else if (formId.endsWith('/newsletter')) {
      response = await handleNewsletter(ctx, formId, data);
    } else {
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

      response = {
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: { formId },
      };
    }

    logStageSubmission(ctx, formId, data, response);
    return response;
  } catch (error) {
    const response = error.response ?? errorResponse(500, 'server error');
    if (ctx) {
      logStageSubmission(ctx, formId, data, response);
    }
    if (error.response) {
      return error.response;
    }
    console.error('fatal error: ', error);
    return response;
  }
}
