import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockListFolder = jest.fn();
const mockFetchSheet = jest.fn();
const mockUpdateSheet = jest.fn();
const mockMakeContext = jest.fn();
const mockResolveEmailTemplate = jest.fn();
const mockSendEmail = jest.fn();

jest.unstable_mockModule('../src/da.js', () => ({
  listFolder: mockListFolder,
  fetchSheet: mockFetchSheet,
  updateSheet: mockUpdateSheet,
}));

jest.unstable_mockModule('../src/context.js', () => ({
  default: mockMakeContext,
}));

jest.unstable_mockModule('../src/emails.js', () => ({
  resolveEmailTemplate: mockResolveEmailTemplate,
  sendEmail: mockSendEmail,
}));

const { main } = await import('../src/actions/processor/index.js');

const YEAR = new Date().getFullYear();

function makeCtx(overrides = {}) {
  return {
    env: { ORG: 'test-org', SITE: 'test-site', SHEET: '', EMAIL_TOKEN: '', EMAIL_RECIPIENT: '' },
    log: { info: jest.fn(), debug: jest.fn(), error: jest.fn() },
    data: {
      data: {
        formId: 'contact-us',
        data: { timestamp: '2024-01-01T00:00:00Z', IP: '1.2.3.4', name: 'John', email: 'john@test.com' },
      },
    },
    info: { method: 'POST', headers: {}, path: '/' },
    events: { apiKey: 'key', token: 'token', orgId: 'org', providerId: 'provider' },
    ...overrides,
  };
}

function makeEntries({ sheetExists = true, emailTemplate = false } = {}) {
  const entries = [];
  entries.push({
    path: '/test-org/test-site/incoming/contact-us/2024.json',
    name: '2024.json',
    ext: 'json',
    lastModified: 0,
  });
  if (sheetExists) {
    entries.push({
      path: `/test-org/test-site/incoming/contact-us/${YEAR}.json`,
      name: `${YEAR}.json`,
      ext: 'json',
      lastModified: 0,
    });
  }
  if (emailTemplate) {
    entries.push({
      path: '/test-org/test-site/incoming/contact-us/email-template.html',
      name: 'email-template.html',
      ext: 'html',
      lastModified: 0,
    });
  }
  return entries;
}

function makeExistingSheet(records = []) {
  return {
    ':private': {
      'private-data': {
        total: records.length,
        limit: records.length,
        offset: 0,
        data: records,
      },
    },
  };
}

describe('processor action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateSheet.mockResolvedValue(undefined);
    mockSendEmail.mockResolvedValue(undefined);
  });

  // -- payload validation --------------------------------------------------

  describe('payload validation', () => {
    test('rejects missing formId', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { data: { data: { name: 'test' } } },
      }));

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('invalid event payload');
    });

    test('rejects missing data', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { data: { formId: 'test-form' } },
      }));

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('invalid event payload');
    });

    test('rejects non-object data', async () => {
      mockMakeContext.mockResolvedValue(makeCtx({
        data: { data: { formId: 'test-form', data: 'string' } },
      }));

      const result = await main({});
      expect(result.error.statusCode).toBe(400);
      expect(result.error.headers['x-error']).toBe('invalid event payload');
    });

    test('accepts event data nested under ctx.data.data', async () => {
      const ctx = makeCtx();
      mockMakeContext.mockResolvedValue(ctx);
      mockListFolder.mockResolvedValue(makeEntries());
      mockFetchSheet.mockResolvedValue(makeExistingSheet([
        { timestamp: '', IP: '', name: '', email: '' },
      ]));

      const result = await main({});
      expect(result.statusCode).toBe(200);
      expect(mockListFolder).toHaveBeenCalledWith(ctx, '/incoming/contact-us');
    });
  });

  // -- sheet operations ----------------------------------------------------

  describe('sheet operations', () => {
    test('fetches existing sheet and appends record', async () => {
      const ctx = makeCtx();
      mockMakeContext.mockResolvedValue(ctx);
      mockListFolder.mockResolvedValue(makeEntries());

      const existingSheet = makeExistingSheet([
        { timestamp: '2024-01-01', IP: '0.0.0.0', name: 'Jane', email: 'jane@test.com' },
      ]);
      mockFetchSheet.mockResolvedValue(existingSheet);

      const result = await main({});

      expect(result.statusCode).toBe(200);
      expect(mockFetchSheet).toHaveBeenCalledWith(ctx, `/incoming/contact-us/${YEAR}.json`);
      expect(mockUpdateSheet).toHaveBeenCalledWith(
        ctx,
        `/incoming/contact-us/${YEAR}.json`,
        expect.objectContaining({
          ':private': expect.objectContaining({
            'private-data': expect.objectContaining({
              total: 2,
              data: expect.arrayContaining([
                expect.objectContaining({ name: 'Jane' }),
                expect.objectContaining({ name: 'John' }),
              ]),
            }),
          }),
        }),
      );
    });

    test('preserves key order from first record (header row)', async () => {
      mockMakeContext.mockResolvedValue(makeCtx());
      mockListFolder.mockResolvedValue(makeEntries());

      const existingSheet = makeExistingSheet([
        { timestamp: '2024-01-01', IP: '0.0.0.0', name: 'Jane', email: 'jane@test.com' },
      ]);
      mockFetchSheet.mockResolvedValue(existingSheet);
      await main({});

      const updatedSheet = mockUpdateSheet.mock.calls[0][2];
      const appendedRecord = updatedSheet[':private']['private-data'].data[1];
      const keys = Object.keys(appendedRecord);
      expect(keys[0]).toBe('timestamp');
      expect(keys[1]).toBe('IP');
    });

    test('adds new keys to header row when record has extra fields', async () => {
      const ctx = makeCtx({
        data: {
          data: {
            formId: 'contact-us',
            data: { name: 'John', email: 'john@test.com', phone: '555-1234' },
          },
        },
      });
      mockMakeContext.mockResolvedValue(ctx);
      mockListFolder.mockResolvedValue(makeEntries());

      const existingSheet = makeExistingSheet([
        { timestamp: '2024-01-01', IP: '0.0.0.0', name: 'Jane', email: 'jane@test.com' },
      ]);
      mockFetchSheet.mockResolvedValue(existingSheet);
      await main({});

      const updatedSheet = mockUpdateSheet.mock.calls[0][2];
      const headerRow = updatedSheet[':private']['private-data'].data[0];
      expect(headerRow).toHaveProperty('phone');
    });

    test('replaces header row when all values are empty (first submission)', async () => {
      mockMakeContext.mockResolvedValue(makeCtx());
      mockListFolder.mockResolvedValue(makeEntries());

      const existingSheet = makeExistingSheet([
        { timestamp: '', IP: '', name: '', email: '' },
      ]);
      mockFetchSheet.mockResolvedValue(existingSheet);
      await main({});

      const updatedSheet = mockUpdateSheet.mock.calls[0][2];
      const sheetData = updatedSheet[':private']['private-data'];
      expect(sheetData.total).toBe(1);
      expect(sheetData.data[0].name).toBe('John');
    });

    test('uses deadletter path when folder has no entries', async () => {
      mockMakeContext.mockResolvedValue(makeCtx());
      mockListFolder.mockResolvedValue([]);

      const result = await main({});
      // empty entries → deadletter path; also means new sheet (INITIAL_SHEET)
      // which has an empty data array, causing appendToSheet to error
      expect(result.error.statusCode).toBe(500);
    });
  });

  // -- email notifications -------------------------------------------------

  describe('email notifications', () => {
    test('sends email when email-template.html entry exists', async () => {
      const ctx = makeCtx();
      mockMakeContext.mockResolvedValue(ctx);
      mockListFolder.mockResolvedValue(makeEntries({ emailTemplate: true }));
      mockFetchSheet.mockResolvedValue(makeExistingSheet([
        { timestamp: '', IP: '', name: '', email: '' },
      ]));
      mockResolveEmailTemplate.mockResolvedValue({
        toEmail: 'admin@test.com',
        subject: 'New Submission',
        html: '<div>test</div>',
        cc: [],
        bcc: [],
      });

      await main({});

      expect(mockResolveEmailTemplate).toHaveBeenCalledWith(
        ctx,
        '/incoming/contact-us/email-template.html',
        expect.objectContaining({ name: 'John' }),
      );
      expect(mockSendEmail).toHaveBeenCalledWith(
        ctx,
        'admin@test.com',
        'New Submission',
        '<div>test</div>',
        [],
        [],
      );
    });

    test('skips email when no email-template.html entry', async () => {
      mockMakeContext.mockResolvedValue(makeCtx());
      mockListFolder.mockResolvedValue(makeEntries({ emailTemplate: false }));
      mockFetchSheet.mockResolvedValue(makeExistingSheet([
        { timestamp: '', IP: '', name: '', email: '' },
      ]));

      await main({});

      expect(mockResolveEmailTemplate).not.toHaveBeenCalled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test('skips sendEmail when resolveEmailTemplate returns null', async () => {
      mockMakeContext.mockResolvedValue(makeCtx());
      mockListFolder.mockResolvedValue(makeEntries({ emailTemplate: true }));
      mockFetchSheet.mockResolvedValue(makeExistingSheet([
        { timestamp: '', IP: '', name: '', email: '' },
      ]));
      mockResolveEmailTemplate.mockResolvedValue(null);

      await main({});

      expect(mockResolveEmailTemplate).toHaveBeenCalled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });

  // -- error handling ------------------------------------------------------

  describe('error handling', () => {
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

    test('returns 500 when updateSheet fails', async () => {
      mockMakeContext.mockResolvedValue(makeCtx());
      mockListFolder.mockResolvedValue(makeEntries());
      mockFetchSheet.mockResolvedValue(makeExistingSheet([
        { timestamp: '', IP: '', name: '', email: '' },
      ]));
      mockUpdateSheet.mockRejectedValue(new Error('write failed'));

      const result = await main({});
      expect(result.error.statusCode).toBe(500);
    });
  });
});
