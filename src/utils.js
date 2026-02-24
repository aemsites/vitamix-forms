/**
 * @param {number} statusCode - status code
 * @param {string} xError - the error message. exposed as x-error header
 * @param {Record<string, unknown>} [body] - body to return
 * @returns {*} the error object, as returned from Runtime function
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
