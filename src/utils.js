/**
 * @param {number} statusCode - status code
 * @param {string} xError - the error message. exposed as x-error header
 * @param {Record<string, unknown> | string} [body] - body to return
 * @returns {RuntimeResponse} the error object, as returned from Runtime function
 */
export function errorResponse(statusCode, xError, body) {
  return {
    error: {
      statusCode,
      headers: {
        'x-error': xError,
        ...(
          body && typeof body === 'object'
            ? { 'content-type': 'application/json' }
            : {}
        )
      },
      body
    }
  }
}

/**
 * @param {string} message - the error message
 * @param {number} statusCode 
 * @param {string} xError 
 * @param {string | Record<string, unknown>} [body] 
 * @returns {Error & { response: RuntimeResponse }} the error object, as returned from Runtime function
 */
export function errorWithResponse(message, statusCode, xError, body) {
  /** @type {Error & { response: RuntimeResponse }} */
  // @ts-ignore
  const err = new Error(message);
  err.response = errorResponse(statusCode, xError, body);
  return err;
}