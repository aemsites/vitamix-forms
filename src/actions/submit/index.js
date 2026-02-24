import { errorResponse } from '../../utils.js';
import { publishEvent } from '../../events.js';
import makeContext from '../../context.js';
import config from './config.js';
import Ajv from 'ajv';

/**
 * @param {Record<string, unknown>} data
 * @returns {string|import('ajv').ErrorObject[]|undefined} error message if invalid
 */
function validatePayload(data) {
  if (!data.formId || typeof data.formId !== 'string') {
    return 'missing or invalid formId';
  }
  if (!data.data || typeof data.data !== 'object') {
    return 'missing or invalid data';
  }
  const formConfig = config[data.formId];
  if (!formConfig) {
    return 'form not found';
  }

  const { path, schema } = formConfig;

  // require destination sheet path
  if (!path) {
    return 'missing or invalid destination sheet path';
  }

  // validate against schema
  const ajv = new Ajv();
  const validate = ajv.compile(schema)
  const valid = validate(data)
  if (!valid) {
    return validate.errors;
  }
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

    const errors = validatePayload(ctx.data);
    if (errors) {
      if (typeof errors === 'string') {
        return errorResponse(400, errors);
      }
      return errorResponse(400, 'invalid payload', { errors });
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
