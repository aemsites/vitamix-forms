import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockPublishEvent = jest.fn();
const mockMakeContext = jest.fn();
const mockQueryOrder = jest.fn();
const mockCreateProductRegistration = jest.fn();
const mockProxyFetch = jest.fn();

jest.unstable_mockModule('../src/events.js', () => ({
  publishEvent: mockPublishEvent,
}));

jest.unstable_mockModule('../src/context.js', () => ({
  default: mockMakeContext,
}));

jest.unstable_mockModule('../src/ebs.js', () => ({
  queryOrder: mockQueryOrder,
  createProductRegistration: mockCreateProductRegistration,
}));

jest.unstable_mockModule('../src/proxy.js', () => ({
  proxyFetch: mockProxyFetch,
}));

const { main } = await import('../src/actions/submit/index.js');

function makeCtx(overrides = {}) {
  return {
    env: { ORG: 'test-org', SITE: 'test-site', SHEET: '', EMAIL_TOKEN: '', EMAIL_RECIPIENT: '' },
    log: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
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
          '@_SystemOfRecordKey': '14192624',
          'Customer': { '@_Key': '12186251', 'First': 'RACHEL', 'Last': 'NATAL' },
          'Delivery': [{ '@_SystemOfRecordKey': '13024544', 'TrackingDetail': { 'TrackingNumber': '1Z88Y66W' } }],
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
      expect(result.body.order.delivery).toHaveLength(1);
    });

    test('omits PII fields from response', async () => {
      mockMakeContext.mockResolvedValue(makeOrderCtx());
      mockQueryOrder.mockResolvedValue({ status: 200, body: successBody });

      const result = await main({});
      expect(result.body.order).not.toHaveProperty('customer');
      expect(result.body.order).not.toHaveProperty('lineItem');
      expect(result.body.order).not.toHaveProperty('systemOfRecordKey');
      expect(result.body.order.delivery[0]).not.toHaveProperty('systemOfRecordKey');
      expect(result.body.order.delivery[0]).not.toHaveProperty('trackingDetail');
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

  // -- product-registration ------------------------------------------------

  describe('product-registration', () => {
    const validData = {
      acceptTerms: 'yes',
      serialNumber: '067881201029626223',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@test.com',
      phone: '2165551212',
      address: '123 Main St',
      city: 'Cleveland',
      province: 'OH',
      postalCode: '44101',
      purchasedFrom: 'Amazon',
      purchasedOn: '2026-01-15',
    };

    function makeRegistrationCtx(dataOverride = {}) {
      return makeCtx({
        data: { formId: 'us/product-registration', data: { ...validData, ...dataOverride } },
        env: {
          ORG: 'test-org', SITE: 'test-site',
          EBS_BASE_URL: 'https://ebs.example.com',
          EBS_API_KEY: 'prod-key',
          EBS_BASE_URL_STAGE: 'https://ebs-stage.example.com',
          EBS_API_KEY_STAGE: 'stage-key',
        },
      });
    }

    const successBody = {
      RegistrationResponse: {
        '@_Succeeded': 'true',
        '@_Outcome': 'Success',
        '@_Id': 'reg-abc123',
      },
    };

    test.each([
      'acceptTerms', 'address', 'city', 'postalCode', 'province',
      'email', 'firstName', 'lastName', 'phone', 'purchasedFrom',
      'purchasedOn', 'serialNumber',
    ])('returns 400 for missing %s', async (field) => {
      const ctx = makeRegistrationCtx();
      delete ctx.data.data[field];
      mockMakeContext.mockResolvedValue(ctx);

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toMatch(field);
    });

    test('returns 400 when acceptTerms is not "yes"', async () => {
      mockMakeContext.mockResolvedValue(makeRegistrationCtx({ acceptTerms: 'no' }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('acceptTerms must be "yes"');
    });

    test.each(['12345', '12345678901234567x', '1234567890123456789'])(
      'returns 400 for invalid serial number: %s',
      async (serialNumber) => {
        mockMakeContext.mockResolvedValue(makeRegistrationCtx({ serialNumber }));
        const result = await main({});
        expect(result.error.statusCode).toBe(400);
        expect(result.error.headers['x-error']).toBe('serialNumber must be 18 digits');
      },
    );

    test('returns 400 for invalid country in formId', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { formId: 'invalid/product-registration', data: validData },
        env: { ORG: 'test-org', SITE: 'test-site', EBS_BASE_URL: 'https://ebs.example.com', EBS_API_KEY: 'key' },
      }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('invalid country');
    });

    test('returns 400 for invalid purchasedOn date', async () => {
      mockMakeContext.mockResolvedValue(makeRegistrationCtx({ purchasedOn: 'not-a-date' }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('invalid purchasedOn');
    });

    test('returns transformed body on success', async () => {
      mockMakeContext.mockResolvedValue(makeRegistrationCtx());
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });

      const result = await main({});
      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.body.registrationResponse.succeeded).toBe(true);
      expect(result.body.registrationResponse.outcome).toBe('Success');
      expect(result.body.registrationResponse.id).toBe('reg-abc123');
    });

    test('returns 404 for "no results found" API error', async () => {
      mockMakeContext.mockResolvedValue(makeRegistrationCtx());
      mockCreateProductRegistration.mockResolvedValue({
        status: 200,
        body: {
          RegistrationResponse: {
            '@_Succeeded': 'false',
            'Details': { '@_Key': 'ERR-001', '@_Message': 'No results found for serial number' },
          },
        },
      });

      const result = await main({});
      expect(result.error.statusCode).toBe(404);
      expect(result.error.headers['x-error']).toBe('No results found for serial number');
    });

    test('returns 400 with error message and details for other API errors', async () => {
      mockMakeContext.mockResolvedValue(makeRegistrationCtx());
      mockCreateProductRegistration.mockResolvedValue({
        status: 200,
        body: {
          RegistrationResponse: {
            '@_Succeeded': 'false',
            'Details': { '@_Key': 'ERR-002', '@_Message': 'Duplicate registration' },
          },
        },
      });

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('Duplicate registration');
      expect(result.error.body.error).toBe('Duplicate registration');
    });

    test('uses stage EBS settings when referer is not production', async () => {
      const ctx = makeRegistrationCtx();
      ctx.info.headers.referer = 'https://staging.vitamix.com';
      mockMakeContext.mockResolvedValue(ctx);
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });

      await main({});

      expect(mockCreateProductRegistration).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { baseUrl: 'https://ebs-stage.example.com', apiKey: 'stage-key' },
      );
    });

    test('uses prod EBS settings when referer is production', async () => {
      mockMakeContext.mockResolvedValue(makeRegistrationCtx());
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });

      await main({});

      expect(mockCreateProductRegistration).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { baseUrl: 'https://ebs.example.com', apiKey: 'prod-key' },
      );
    });

    test('fires newsletter subscription when marketingOptIn is "yes"', async () => {
      const ctx = makeRegistrationCtx({ marketingOptIn: 'yes' });
      ctx.env.NEWSLETTER_BASE_URL = 'https://newsletter.example.com/prod';
      ctx.env.NEWSLETTER_API_KEY = 'nl-prod-key';
      mockMakeContext.mockResolvedValue(ctx);
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });
      mockProxyFetch.mockResolvedValue({ status: 200, json: jest.fn().mockResolvedValue({}) });

      const result = await main({});

      expect(result.statusCode).toBe(200);
      expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      const [, , opts] = mockProxyFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.EmailAddress).toBe('jane@test.com');
      expect(body.EmailOptIn).toBe(true);
      expect(body.FirstName).toBe('Jane');
      expect(body.LastName).toBe('Doe');
      expect(body.Country).toBe('US');
    });

    test('fires newsletter subscription when marketingOptIn is boolean true', async () => {
      const ctx = makeRegistrationCtx({ marketingOptIn: true });
      ctx.env.NEWSLETTER_BASE_URL = 'https://newsletter.example.com/prod';
      ctx.env.NEWSLETTER_API_KEY = 'nl-prod-key';
      mockMakeContext.mockResolvedValue(ctx);
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });
      mockProxyFetch.mockResolvedValue({ status: 200, json: jest.fn().mockResolvedValue({}) });

      await main({});

      expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    });

    test('does not fire newsletter when marketingOptIn is absent', async () => {
      mockMakeContext.mockResolvedValue(makeRegistrationCtx());
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });

      await main({});

      expect(mockProxyFetch).not.toHaveBeenCalled();
    });

    test('does not fire newsletter when marketingOptIn is "no"', async () => {
      mockMakeContext.mockResolvedValue(makeRegistrationCtx({ marketingOptIn: 'no' }));
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });

      await main({});

      expect(mockProxyFetch).not.toHaveBeenCalled();
    });

    test('returns registration response even when newsletter subscription fails', async () => {
      const ctx = makeRegistrationCtx({ marketingOptIn: 'yes' });
      ctx.env.NEWSLETTER_BASE_URL = 'https://newsletter.example.com/prod';
      ctx.env.NEWSLETTER_API_KEY = 'nl-prod-key';
      mockMakeContext.mockResolvedValue(ctx);
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });
      mockProxyFetch.mockRejectedValue(new Error('newsletter API unavailable'));

      const result = await main({});

      expect(result.statusCode).toBe(200);
      expect(result.body.registrationResponse.succeeded).toBe(true);
    });

    test('returns registration response even when newsletter URL is not configured', async () => {
      const ctx = makeRegistrationCtx({ marketingOptIn: 'yes' });
      // no NEWSLETTER_BASE_URL set — callNewsletterApi will throw before proxyFetch
      mockMakeContext.mockResolvedValue(ctx);
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });

      const result = await main({});

      expect(result.statusCode).toBe(200);
      expect(result.body.registrationResponse.succeeded).toBe(true);
      expect(mockProxyFetch).not.toHaveBeenCalled();
    });

    test('sample payload: flat format with marketingOptIn fires newsletter with mapped fields', async () => {
      const ctx = makeCtx({
        data: {
          serialNumber: '123456789123456789',
          planToUse: 'at-home',
          purchasedFrom: 'best-buy',
          purchasedOn: '1992-01-01',
          firstName: '1',
          lastName: '2',
          address: '123 v',
          addressLine2: '123',
          city: 'wihjdfnw',
          province: 'NB',
          postalCode: '23456',
          phone: '12345678',
          email: 'ab@cd.ef',
          marketingOptIn: 'yes',
          acceptTerms: 'yes',
          formId: 'ca/fr_ca/product-registration',
          pageUrl: 'https://ebs-forms--vitamix--aemsites.aem.network/ca/fr_ca/customer-service/product-registration',
        },
        env: {
          ORG: 'test-org', SITE: 'test-site',
          EBS_BASE_URL: 'https://ebs.example.com',
          EBS_API_KEY: 'ebs-prod-key',
          EBS_BASE_URL_STAGE: 'https://ebs-stage.example.com',
          EBS_API_KEY_STAGE: 'ebs-stage-key',
          NEWSLETTER_BASE_URL: 'https://newsletter.example.com/prod',
          NEWSLETTER_API_KEY: 'nl-prod-key',
          NEWSLETTER_BASE_URL_STAGE: 'https://newsletter.example.com/stage',
          NEWSLETTER_API_KEY_STAGE: 'nl-stage-key',
        },
        info: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            referer: 'https://ebs-forms--vitamix--aemsites.aem.network/ca/fr_ca/customer-service/product-registration',
          },
          path: '/submit',
        },
      });
      mockMakeContext.mockResolvedValue(ctx);
      mockCreateProductRegistration.mockResolvedValue({ status: 200, body: successBody });
      mockProxyFetch.mockResolvedValue({ status: 200, json: jest.fn().mockResolvedValue({}) });

      const result = await main({});

      expect(result.statusCode).toBe(200);
      expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      const [, url, opts] = mockProxyFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      // non-prod referer → stage/ca/fr_ca/product-registration → stage newsletter endpoint
      expect(url).toBe('https://newsletter.example.com/stage');
      // marketingOptIn: 'yes' mapped to EmailOptIn: true
      expect(body.EmailOptIn).toBe(true);
      expect(body.EmailAddress).toBe('ab@cd.ef');
      expect(body.FirstName).toBe('1');
      expect(body.LastName).toBe('2');
      // country extracted from formId 'ca/...'
      expect(body.Country).toBe('CA');
    });
  });

  // -- newsletter ----------------------------------------------------------

  describe('newsletter', () => {
    function makeNewsletterCtx(dataOverride = {}) {
      return makeCtx({
        data: { formId: 'us/newsletter', data: { email: 'test@example.com', emailOptIn: true, ...dataOverride } },
        env: {
          ORG: 'test-org', SITE: 'test-site',
          NEWSLETTER_BASE_URL: 'https://newsletter.example.com/prod',
          NEWSLETTER_API_KEY: 'prod-key',
          NEWSLETTER_BASE_URL_STAGE: 'https://newsletter.example.com/stage',
          NEWSLETTER_API_KEY_STAGE: 'stage-key',
        },
      });
    }

    test('returns 400 for missing emailAddress', async () => {
      const ctx = makeNewsletterCtx();
      delete ctx.data.data.email;
      mockMakeContext.mockResolvedValue(ctx);

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('missing or invalid emailAddress');
    });

    test('returns 400 for non-string emailAddress', async () => {
      mockMakeContext.mockResolvedValue(makeNewsletterCtx({ email: 12345 }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('missing or invalid emailAddress');
    });

    test('returns 400 when emailOptIn is missing', async () => {
      const ctx = makeNewsletterCtx();
      delete ctx.data.data.emailOptIn;
      mockMakeContext.mockResolvedValue(ctx);

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('missing or invalid emailOptIn');
    });

    test('returns 400 when emailOptIn is a string instead of boolean', async () => {
      mockMakeContext.mockResolvedValue(makeNewsletterCtx({ emailOptIn: 'true' }));
      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('missing or invalid emailOptIn');
    });

    test('accepts emailOptIn: false', async () => {
      mockMakeContext.mockResolvedValue(makeNewsletterCtx({ emailOptIn: false }));
      mockProxyFetch.mockResolvedValue({ status: 200, json: jest.fn().mockResolvedValue({}) });

      const result = await main({});
      expect(result.statusCode).toBe(200);
    });

    test('sends correctly mapped JSON payload via proxy', async () => {
      mockMakeContext.mockResolvedValue(makeNewsletterCtx());
      mockProxyFetch.mockResolvedValue({ status: 200, json: jest.fn().mockResolvedValue({}) });

      await main({});

      const [, url, opts] = mockProxyFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(url).toBe('https://newsletter.example.com/prod');
      expect(opts.method).toBe('POST');
      expect(opts.headers['content-type']).toBe('application/json');
      expect(opts.headers['x-api-key']).toBe('prod-key');
      expect(body.EmailAddress).toBe('test@example.com');
      expect(body.EmailOptIn).toBe(true);
      expect(body.workFlowName).toBe('subscription');
    });

    test('returns proxied response body and status', async () => {
      mockMakeContext.mockResolvedValue(makeNewsletterCtx());
      const apiResponse = { subscriptionId: 'sub-123', status: 'subscribed' };
      mockProxyFetch.mockResolvedValue({ status: 201, json: jest.fn().mockResolvedValue(apiResponse) });

      const result = await main({});
      expect(result.statusCode).toBe(201);
      expect(result.body).toEqual(apiResponse);
    });

    test('uses stage endpoint when referer is not production', async () => {
      const ctx = makeNewsletterCtx();
      ctx.info.headers.referer = 'https://staging.vitamix.com';
      mockMakeContext.mockResolvedValue(ctx);
      mockProxyFetch.mockResolvedValue({ status: 200, json: jest.fn().mockResolvedValue({}) });

      await main({});

      const [, url, opts] = mockProxyFetch.mock.calls[0];
      expect(url).toBe('https://newsletter.example.com/stage');
      expect(opts.headers['x-api-key']).toBe('stage-key');
    });

    test('uses prod endpoint when referer is production', async () => {
      mockMakeContext.mockResolvedValue(makeNewsletterCtx());
      mockProxyFetch.mockResolvedValue({ status: 200, json: jest.fn().mockResolvedValue({}) });

      await main({});

      const [, url, opts] = mockProxyFetch.mock.calls[0];
      expect(url).toBe('https://newsletter.example.com/prod');
      expect(opts.headers['x-api-key']).toBe('prod-key');
    });

    test('returns 500 when newsletter URL is not configured', async () => {
      const ctx = makeNewsletterCtx();
      delete ctx.env.NEWSLETTER_BASE_URL;
      delete ctx.env.NEWSLETTER_BASE_URL_STAGE;
      mockMakeContext.mockResolvedValue(ctx);

      const result = await main({});

      expect(result.error.statusCode).toBe(500);
      expect(mockProxyFetch).not.toHaveBeenCalled();
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
