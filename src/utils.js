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
 * Normalizes any thrown value into a consistent, loggable shape:
 * `{ name, message, stack }`. Pass the result as the structured metadata
 * argument of the Runtime logger (`log.error('msg', errorInfo(err))`) so every
 * logged error carries its stack — which V8 embeds file/line/column into —
 * instead of just its message.
 *
 * Safe on non-Error throwables (strings, plain objects): `name`/`stack` are
 * simply omitted. Do NOT put the result in an HTTP response body returned to
 * clients — stacks are internal diagnostics only.
 *
 * @param {*} error - an Error or any thrown value
 * @returns {{ name?: string, message: string, stack?: string }}
 */
export function errorInfo(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
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