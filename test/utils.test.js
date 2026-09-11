import { describe, test, expect } from '@jest/globals';
import { errorResponse, errorInfo } from '../src/utils.js';

describe('errorResponse', () => {
  test('returns error with statusCode and x-error header', () => {
    const result = errorResponse(400, 'bad request');
    expect(result).toEqual({
      error: {
        statusCode: 400,
        headers: { 'x-error': 'bad request' },
      },
    });
  });

  test('includes content-type header when body is an object', () => {
    const result = errorResponse(500, 'server error', { detail: 'oops' });
    expect(result).toEqual({
      error: {
        statusCode: 500,
        headers: {
          'x-error': 'server error',
          'content-type': 'application/json',
        },
        body: { detail: 'oops' },
      },
    });
  });

  test('omits content-type header when body is not provided', () => {
    const { headers } = errorResponse(404, 'not found').error;
    expect(headers).not.toHaveProperty('content-type');
  });

  test('omits content-type header when body is a non-object', () => {
    const { headers } = errorResponse(400, 'error', 'string body').error;
    expect(headers).not.toHaveProperty('content-type');
  });

  test('omits content-type header when body is null', () => {
    const { headers } = errorResponse(400, 'error', null).error;
    expect(headers).not.toHaveProperty('content-type');
  });

  test('preserves the exact status code', () => {
    expect(errorResponse(200, 'ok').error.statusCode).toBe(200);
    expect(errorResponse(503, 'unavailable').error.statusCode).toBe(503);
    expect(errorResponse(0, 'zero').error.statusCode).toBe(0);
  });

  test('passes body through to the response', () => {
    const body = { errors: ['a', 'b'] };
    expect(errorResponse(422, 'validation', body).error.body).toEqual(body);
  });
});

describe('errorInfo', () => {
  test('extracts name, message, and stack from an Error instance', () => {
    const err = new TypeError('boom');
    const info = errorInfo(err);
    expect(info.name).toBe('TypeError');
    expect(info.message).toBe('boom');
    expect(typeof info.stack).toBe('string');
    expect(info.stack).toContain('boom');
  });

  test('preserves the subclass name for custom Error types', () => {
    class SyncError extends Error {}
    const err = new SyncError('nope');
    err.name = 'SyncError';
    expect(errorInfo(err)).toMatchObject({ name: 'SyncError', message: 'nope' });
  });

  test('non-Error throwable → only message (String-coerced), no name/stack', () => {
    const info = errorInfo('just a string');
    expect(info).toEqual({ message: 'just a string' });
    expect(info).not.toHaveProperty('name');
    expect(info).not.toHaveProperty('stack');
  });

  test('coerces non-Error objects and other primitives to a message string', () => {
    expect(errorInfo({ code: 42 })).toEqual({ message: '[object Object]' });
    expect(errorInfo(null)).toEqual({ message: 'null' });
    expect(errorInfo(undefined)).toEqual({ message: 'undefined' });
    expect(errorInfo(500)).toEqual({ message: '500' });
  });
});
