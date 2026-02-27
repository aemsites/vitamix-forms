import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockPublishEvent = jest.fn();
const mockMakeContext = jest.fn();

jest.unstable_mockModule('../src/events.js', () => ({
  publishEvent: mockPublishEvent,
}));

jest.unstable_mockModule('../src/context.js', () => ({
  default: mockMakeContext,
}));

const { main } = await import('../src/actions/submit/index.js');

function makeCtx(overrides = {}) {
  return {
    env: { ORG: 'test-org', SITE: 'test-site', SHEET: '', EMAIL_TOKEN: '', EMAIL_RECIPIENT: '' },
    log: { info: jest.fn(), debug: jest.fn(), error: jest.fn() },
    data: { formId: 'contact-us', data: { name: 'John', email: 'john@test.com' } },
    info: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      path: '/submit',
    },
    events: { apiKey: 'key', token: 'token', orgId: 'org', providerId: 'provider' },
    ...overrides,
  };
}

describe('submit action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPublishEvent.mockResolvedValue({ ok: true });
  });

  // -- request validation --------------------------------------------------

  describe('request validation', () => {
    test('rejects non-POST requests with 405', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        info: { method: 'GET', headers: { 'content-type': 'application/json' }, path: '/' },
      }));

      const result = await main({});
      expect(result.error.statusCode).toBe(405);
      expect(result.error.headers['x-error']).toBe('method not allowed');
    });

    test('rejects non-JSON content-type with 415', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        info: { method: 'POST', headers: { 'content-type': 'text/plain' }, path: '/' },
      }));

      const result = await main({});
      expect(result.error.statusCode).toBe(415);
      expect(result.error.headers['x-error']).toBe('invalid content-type');
    });
  });

  // -- payload validation --------------------------------------------------

  describe('payload validation', () => {
    test('rejects missing formId', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({ data: { data: { name: 'test' } } }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('missing or invalid formId');
    });

    test('rejects non-string formId', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({ data: { formId: 123, data: { name: 'test' } } }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('missing or invalid formId');
    });

    test('rejects missing data', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({ data: { formId: 'test-form' } }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('missing or invalid data');
    });

    test('rejects non-object data', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({ data: { formId: 'test-form', data: 'string' } }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('missing or invalid data');
    });

    test.each([
      '/leading-slash',
      'trailing-slash/',
      'has spaces',
      'special@char',
      '-leading-hyphen',
      'a',
    ])('rejects invalid formId: %s', async (formId) => {
      mockMakeContext.mockResolvedValue(makeCtx({ data: { formId, data: { name: 'test' } } }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('invalid formId');
    });

    test.each([
      'contact-us',
      'org/form-name',
      'ab',
      'form_name/sub',
    ])('accepts valid formId: %s', async (formId) => {
      mockMakeContext.mockResolvedValue(makeCtx({ data: { formId, data: { name: 'test' } } }));
      const result = await main({});
      expect(result.statusCode).toBe(201);
    });

    test('rejects oversized payloads', async () => {
      const largeData = {};
      for (let i = 0; i < 1000; i++) largeData[`field${i}`] = 'x'.repeat(20);
      mockMakeContext.mockResolvedValue(makeCtx({ data: { formId: 'test-form', data: largeData } }));

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('payload too large');
    });

    test('rejects payloads containing HTML angle brackets', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { formId: 'test-form', data: { msg: '<script>alert(1)</script>' } },
      }));

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('payload contains invalid characters');
    });
  });

  // -- event publishing ----------------------------------------------------

  describe('event publishing', () => {
    test('publishes form.submitted event with form data', async () => {
      mockMakeContext.mockResolvedValue(makeCtx());
      await main({});

      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.anything(),
        'form.submitted',
        expect.objectContaining({
          formId: 'contact-us',
          data: expect.objectContaining({
            name: 'John',
            email: 'john@test.com',
          }),
        }),
      );
    });

    test('adds server-generated timestamp and IP', async () => {
      mockMakeContext.mockResolvedValue(makeCtx());
      await main({});

      const eventData = mockPublishEvent.mock.calls[0][2];
      expect(eventData.data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(eventData.data.IP).toBe('1.2.3.4');
    });

    test('resolves IP from x-real-ip when x-forwarded-for is absent', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        info: { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '5.6.7.8' }, path: '/' },
      }));
      await main({});
      expect(mockPublishEvent.mock.calls[0][2].data.IP).toBe('5.6.7.8');
    });

    test('resolves IP from cf-connecting-ip as last resort', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        info: { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.10.11.12' }, path: '/' },
      }));
      await main({});
      expect(mockPublishEvent.mock.calls[0][2].data.IP).toBe('9.10.11.12');
    });

    test('uses "unknown" when no IP headers present', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        info: { method: 'POST', headers: { 'content-type': 'application/json' }, path: '/' },
      }));
      await main({});
      expect(mockPublishEvent.mock.calls[0][2].data.IP).toBe('unknown');
    });

    test('overrides client-supplied IP and timestamp', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { formId: 'test-form', data: { name: 'John', IP: 'spoofed', timestamp: 'spoofed' } },
      }));
      await main({});

      const eventData = mockPublishEvent.mock.calls[0][2];
      expect(eventData.data.IP).not.toBe('spoofed');
      expect(eventData.data.timestamp).not.toBe('spoofed');
    });
  });

  // -- response ------------------------------------------------------------

  describe('response', () => {
    test('returns 201 with formId on success', async () => {
      mockMakeContext.mockResolvedValue(makeCtx());
      const result = await main({});

      expect(result.statusCode).toBe(201);
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.body.formId).toBe('contact-us');
    });

    test('returns 500 on unexpected error', async () => {
      mockMakeContext.mockRejectedValue(new Error('boom'));
      const result = await main({});

      expect(result.error.statusCode).toBe(500);
      expect(result.error.headers['x-error']).toBe('server error');
    });

    test('returns error.response when error carries one', async () => {
      const err = new Error('custom');
      err.response = { statusCode: 503, body: 'unavailable' };
      mockMakeContext.mockRejectedValue(err);

      const result = await main({});
      expect(result).toEqual({ statusCode: 503, body: 'unavailable' });
    });
  });
});
