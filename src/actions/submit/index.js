import { errorResponse } from '../../utils.js';
import { publishEvent } from '../../events.js';
import makeContext from '../../context.js';

const MAX_PAYLOAD_SIZE = 16_000; // 16KB

/**
 * alphanumeric, underscores, hyphens, slashes allowed
 * but no trailing/leading slash, hyphen or underscore
 */
const FORM_ID_PATTERN = /^[a-zA-Z0-9]+[\/a-zA-Z0-9_-]*[a-zA-Z0-9]+$/;

/**
 * @param {Record<string, unknown>} data
 * @returns {string|undefined} error message if invalid
 */
function validatePayload(data) {
  if (!data.formId || typeof data.formId !== 'string') {
    return 'missing or invalid formId';
  }
  if (!data.data || typeof data.data !== 'object') {
    return 'missing or invalid data';
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
  Object.values(data.data).forEach((val) => {
    if (typeof val === 'object' && val !== null) {
      return 'payload contains nested data';
    }
  });
}

/**
 * HTTP action: receives form submissions, validates, and publishes a `form.submitted` event.
 * @param {Object} params
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

    const { formId, data } = ctx.data;
    log.info(`publishing form.submitted event for formId=${formId}`);
    await publishEvent(ctx, 'form.submitted', { formId, data });

    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: { formId },
    };
  } catch (error) {
    if (error.response) return error.response;
    console.error('fatal error: ', error);
    return errorResponse(500, 'server error');
  }
}
