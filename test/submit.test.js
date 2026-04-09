import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockPublishEvent = jest.fn();
const mockMakeContext = jest.fn();
const mockQueryOrder = jest.fn();

jest.unstable_mockModule('../src/events.js', () => ({
  publishEvent: mockPublishEvent,
}));

jest.unstable_mockModule('../src/context.js', () => ({
  default: mockMakeContext,
}));

jest.unstable_mockModule('../src/ebs.js', () => ({
  queryOrder: mockQueryOrder,
  createProductRegistration: jest.fn(),
}));

const { main } = await import('../src/actions/submit/index.js');

function makeCtx(overrides = {}) {
  return {
    env: { ORG: 'test-org', SITE: 'test-site', SHEET: '', EMAIL_TOKEN: '', EMAIL_RECIPIENT: '' },
    log: { info: jest.fn(), debug: jest.fn(), error: jest.fn() },
    data: { formId: 'contact-us', data: { name: 'John', email: 'john@test.com' } },
    info: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', referer: 'https://www.vitamix.com' },
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

    test('accepts flat payload (no nested data object)', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { formId: 'test-form', name: 'Alice', email: 'alice@test.com' },
      }));
      const result = await main({});
      expect(result.statusCode).toBe(201);
    });

    test('accepts flat payload where data field is a non-object', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { formId: 'test-form', data: 'string', name: 'Bob' },
      }));
      const result = await main({});
      expect(result.statusCode).toBe(201);
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

    test('publishes flat payload properties as form data (formId stripped)', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { formId: 'test-form', name: 'Alice', email: 'alice@test.com' },
      }));
      await main({});

      const eventData = mockPublishEvent.mock.calls[0][2];
      expect(eventData.formId).toBe('test-form');
      expect(eventData.data.name).toBe('Alice');
      expect(eventData.data.email).toBe('alice@test.com');
      expect(eventData.data).not.toHaveProperty('formId');
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

    test('prefixes formId with stage/ when referer is not production origin', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        info: { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', referer: 'https://staging.vitamix.com' }, path: '/submit' },
      }));
      await main({});

      const eventData = mockPublishEvent.mock.calls[0][2];
      expect(eventData.formId).toBe('stage/contact-us');
    });

    test('prefixes formId with stage/ when referer is absent', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        info: { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, path: '/submit' },
      }));
      await main({});

      const eventData = mockPublishEvent.mock.calls[0][2];
      expect(eventData.formId).toBe('stage/contact-us');
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

  // -- order-status --------------------------------------------------------

  describe('order-status', () => {
    function makeOrderCtx(orderNumber = 'om2101481269') {
      return makeCtx({
        data: { formId: 'vitamix/order-status', data: { orderNumber } },
        env: {
          ORG: 'test-org', SITE: 'test-site',
          EBS_BASE_URL: 'https://ebs.example.com',
          EBS_API_KEY: 'key',
        },
      });
    }

    const successBody = {
      Response: {
        '@_Id': 'abc-123',
        '@_Outcome': 'Success',
        '@_Succeeded': 'true',
        'Order': {
          '@_Key': 'om2101481269',
          '@_Currency': 'USD',
          'Customer': { '@_Key': '12186251', 'First': 'RACHEL', 'Last': 'NATAL' },
          'Delivery': [{ '@_SystemOfRecordKey': '13024544' }],
          'LineItem': [{ '@_Key': '19213953', '@_Quantity': '1' }],
        },
      },
    };

    const notFoundBody = {
      Response: {
        '@_Id': 'd5824822',
        '@_Outcome': 'ValidationError',
        '@_Succeeded': 'false',
        'Details': { '@_Key': 'ORDER-ERR-201', '@_Message': 'No results found' },
      },
    };

    test('returns 400 for missing orderNumber', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { formId: 'vitamix/order-status', data: {} },
      }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('missing or invalid orderNumber');
    });

    test('returns transformed body on success', async () => {
      mockMakeContext.mockResolvedValue(makeOrderCtx());
      mockQueryOrder.mockResolvedValue({ status: 200, body: successBody });

      const result = await main({});
      expect(result.statusCode).toBe(200);
      expect(result.body.id).toBe('abc-123');
      expect(result.body.outcome).toBe('Success');
      expect(result.body.succeeded).toBe(true);
      expect(result.body.order.key).toBe('om2101481269');
      expect(result.body.order.currency).toBe('USD');
      expect(result.body.order.customer.key).toBe('12186251');
      expect(result.body.order.customer.first).toBe('RACHEL');
      expect(result.body.order.delivery).toHaveLength(1);
      expect(result.body.order.lineItem[0].key).toBe('19213953');
      expect(result.body.order.lineItem[0].quantity).toBe('1');
    });

    test('returns 404 for "No results found" validation error', async () => {
      mockMakeContext.mockResolvedValue(makeOrderCtx('unknown-order'));
      mockQueryOrder.mockResolvedValue({ status: 200, body: notFoundBody });

      const result = await main({});
      expect(result.error.statusCode).toBe(404);
      expect(result.error.headers['x-error']).toBe('No results found');
      expect(result.error.body.error).toBe('No results found');
    });

    test('returns 400 for other validation errors', async () => {
      mockMakeContext.mockResolvedValue(makeOrderCtx('bad-order'));
      mockQueryOrder.mockResolvedValue({
        status: 200,
        body: {
          Response: {
            '@_Outcome': 'ValidationError',
            '@_Succeeded': 'false',
            'Details': { '@_Key': 'ORDER-ERR-999', '@_Message': 'Invalid order key format' },
          },
        },
      });

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('Invalid order key format');
    });

    test('strips @_ prefix from all keys recursively', async () => {
      mockMakeContext.mockResolvedValue(makeOrderCtx());
      mockQueryOrder.mockResolvedValue({ status: 200, body: successBody });

      const result = await main({});
      const json = JSON.stringify(result.body);
      expect(json).not.toContain('@_');
    });

    test('converts succeeded string to boolean', async () => {
      mockMakeContext.mockResolvedValue(makeOrderCtx());
      mockQueryOrder.mockResolvedValue({ status: 200, body: successBody });

      const result = await main({});
      expect(typeof result.body.succeeded).toBe('boolean');
      expect(result.body.succeeded).toBe(true);
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
