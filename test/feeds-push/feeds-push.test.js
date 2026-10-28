import {
  describe, test, expect, jest, beforeEach, afterEach,
} from '@jest/globals';

// In-memory aio-lib-state so the shrink guard's counts persist across runs.
const store = new Map();
const stateMock = {
  get: jest.fn(async (k) => (store.has(k) ? { value: store.get(k) } : undefined)),
  put: jest.fn(async (k, v) => { store.set(k, v); return k; }),
};
jest.unstable_mockModule('@adobe/aio-lib-state', () => ({ init: async () => stateMock }));

const { run, listJobs } = await import('../../src/actions/feeds-push/run.js');
const { main } = await import('../../src/actions/feeds-push/index.js');
const {
  CONFIG, NAMESPACES, resolveEnvironment, resolveCredentials,
} = await import('../../src/actions/feeds-push/config.js');
const { validateFeed } = await import('../../src/actions/feeds-push/validate.js');
const { parseRecipients, buildAlert } = await import('../../src/actions/feeds-push/alert.js');
const { PROVIDERS } = await import('../../src/actions/feeds/providers/index.js');

const STAGE_NS = '60038-161ivoryjackal-stage';
const PROD_NS = '60038-161ivoryjackal';

/** Source feed with `n` simple products. */
const sourceFeed = (n, idPrefix = 'SKU') => `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel><title>Vitamix</title>
${Array.from({ length: n }, (_, i) => `<item>
  <g:id>${idPrefix}${i}</g:id><g:title>Product ${i}</g:title><g:description>Desc ${i}</g:description>
  <g:link>https://www.vitamix.com/us/en_us/products/p${i}</g:link>
  <g:image_link>https://www.vitamix.com/img/${i}.jpg</g:image_link>
  <g:condition>new</g:condition><g:availability>in_stock</g:availability>
  <g:price>9.95 USD</g:price><g:brand>Vitamix</g:brand>
</item>`).join('\n')}
</channel></rss>`;

/** Route fetch: merchant-center feed per locale, email API. */
function mockFetch({ feeds = {}, emailOk = true } = {}) {
  const emails = [];
  const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('/emails')) {
      emails.push(JSON.parse(init.body));
      return { ok: emailOk, status: emailOk ? 200 : 500, headers: { get: () => null } };
    }
    const m = u.match(/vitamix\.com\/([a-z]{2}\/[a-z]{2}_[a-z]{2})\/products\/merchant-center-feed\.xml/);
    const feed = m && feeds[m[1]];
    if (feed === undefined) return { ok: false, status: 404, text: async () => '' };
    if (feed instanceof Error) throw feed;
    return { ok: true, status: 200, text: async () => feed };
  });
  return { spy, emails };
}

/** Fake SFTP client factory recording uploads. */
function mockSftp({ connectError, putError } = {}) {
  const uploads = [];
  const connects = [];
  let ended = 0;
  const createClient = () => ({
    connect: jest.fn(async (opts) => {
      connects.push(opts);
      if (connectError) throw connectError;
    }),
    put: jest.fn(async (buf, path) => {
      if (putError) throw putError;
      uploads.push({ path, body: buf.toString('utf-8') });
    }),
    end: jest.fn(async () => { ended += 1; }),
  });
  return {
    createClient, uploads, connects, ended: () => ended,
  };
}

const SECRETS = {
  LOG_LEVEL: 'error',
  CJ_SFTP_USERNAME: 'cj-user',
  CJ_SFTP_PASSWORD: 'cj-pass',
  ALERT_FEED_FAIL_EMAILS: 'a@example.com, b@example.com',
  EMAIL_TOKEN: 'email-token',
};

/** A config with CJ US + CA on stage, for multi-locale tests. */
const twoLocaleConfig = () => ({
  ...CONFIG,
  stage: {
    enabled: true,
    targets: {
      cj: {
        ...CONFIG.stage.targets.cj,
        locales: {
          'us/en_us': { file: 'vitamix_us_edge.xml' },
          'ca/en_us': { file: 'vitamix_ca_edge.xml' },
        },
      },
    },
  },
});

beforeEach(() => store.clear());
afterEach(() => jest.restoreAllMocks());

describe('config', () => {
  test('maps the stage and prod namespaces exactly', () => {
    expect(resolveEnvironment(STAGE_NS)).toBe('stage');
    expect(resolveEnvironment(PROD_NS)).toBe('prod');
    expect(resolveEnvironment('60038-161ivoryjackal-stage-dev')).toBeNull();
    expect(resolveEnvironment(undefined)).toBeNull();
  });

  test('every configured target uses a known provider and every locale has a file name', () => {
    for (const env of Object.values(NAMESPACES)) {
      for (const target of Object.values(CONFIG[env].targets)) {
        expect(PROVIDERS[target.provider]).toBeDefined();
        expect(target.credentials).toMatch(/^[A-Z][A-Z0-9_]*$/);
        for (const [locale, l] of Object.entries(target.locales)) {
          expect(locale).toMatch(/^[a-z]{2}\/[a-z]{2}_[a-z]{2}$/);
          expect(l.file).toMatch(/^[^/\s]+\.[a-z]+$/);
        }
      }
    }
  });

  test('stage pushes the CJ US test feed; prod is off', () => {
    expect(CONFIG.stage.enabled).toBe(true);
    expect(CONFIG.stage.targets.cj.locales['us/en_us'].file).toBe('vitamix_us_edge.xml');
    expect(CONFIG.stage.targets.cj.remoteDir).toBe('/');
    expect(CONFIG.prod.enabled).toBe(false);
  });

  test('resolveCredentials treats empty and unsubstituted vars as missing', () => {
    expect(resolveCredentials(SECRETS, 'CJ')).toEqual({ username: 'cj-user', password: 'cj-pass' });
    expect(resolveCredentials({ CJ_SFTP_USERNAME: 'u' }, 'CJ')).toBeNull();
    expect(resolveCredentials({ CJ_SFTP_USERNAME: 'u', CJ_SFTP_PASSWORD: '' }, 'CJ')).toBeNull();
    expect(resolveCredentials({ CJ_SFTP_USERNAME: '$CJ_SFTP_USERNAME', CJ_SFTP_PASSWORD: 'p' }, 'CJ')).toBeNull();
    // a real password may start with "$"
    expect(resolveCredentials({ CJ_SFTP_USERNAME: 'u', CJ_SFTP_PASSWORD: '$ecret' }, 'CJ'))
      .toEqual({ username: 'u', password: '$ecret' });
  });
});

describe('listJobs', () => {
  test('honors target/locale enabled flags, filters and credential overrides', () => {
    const envConfig = {
      enabled: true,
      targets: {
        cj: {
          provider: 'cj',
          credentials: 'CJ',
          locales: {
            'us/en_us': { file: 'us.xml' },
            'ca/en_us': { file: 'ca.xml', credentials: 'CJ_CA' },
            'ca/fr_ca': { file: 'fr.xml', enabled: false },
          },
        },
        openai: { provider: 'openai', credentials: 'OPENAI', enabled: false, locales: { 'us/en_us': { file: 'o.csv' } } },
      },
    };
    const all = listJobs(envConfig);
    expect(all.map((j) => [j.targetKey, j.locale, j.credentials])).toEqual([
      ['cj', 'us/en_us', 'CJ'],
      ['cj', 'ca/en_us', 'CJ_CA'],
    ]);
    expect(listJobs(envConfig, { locale: 'ca/en_us' }).map((j) => j.locale)).toEqual(['ca/en_us']);
    expect(listJobs(envConfig, { target: 'openai' })).toEqual([]);
  });
});

describe('run — gating', () => {
  test('unknown namespace does nothing', async () => {
    const { spy } = mockFetch();
    const res = await run(SECRETS, { namespace: 'someone-elses-ns' });
    expect(res).toEqual({ skipped: true, reason: 'unknown-namespace' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('prod is disabled: nothing is built or uploaded', async () => {
    const { spy } = mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: PROD_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(res).toEqual({ skipped: true, reason: 'disabled', environment: 'prod' });
    expect(spy).not.toHaveBeenCalled();
    expect(sftp.connects).toHaveLength(0);
  });

  test('a disabled environment with a dryRun builds and validates without SFTP', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp();
    const config = { ...CONFIG, stage: { ...CONFIG.stage, enabled: false } };
    const res = await run({ LOG_LEVEL: 'error' }, {
      namespace: STAGE_NS, dryRun: true, config, sftpDeps: { createClient: sftp.createClient },
    });
    expect(res.ok).toBe(true);
    expect(res.results).toEqual([expect.objectContaining({
      target: 'cj', locale: 'us/en_us', status: 'validated', itemCount: 3, remotePath: '/vitamix_us_edge.xml',
    })]);
    expect(sftp.connects).toHaveLength(0);
  });
});

describe('run — stage push', () => {
  test('uploads the CJ US feed to /vitamix_us_edge.xml with the built body', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(4) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });

    expect(res.ok).toBe(true);
    expect(res.environment).toBe('stage');
    expect(res.results).toEqual([expect.objectContaining({
      target: 'cj', locale: 'us/en_us', file: 'vitamix_us_edge.xml', status: 'uploaded', itemCount: 4,
    })]);
    expect(sftp.connects).toEqual([expect.objectContaining({
      host: 'datatransfer.cj.com',
      port: 22,
      username: 'cj-user',
      password: 'cj-pass',
      algorithms: { serverHostKey: { append: ['ssh-dss'] } },
    })]);
    expect(sftp.uploads).toHaveLength(1);
    expect(sftp.uploads[0].path).toBe('/vitamix_us_edge.xml');
    expect(sftp.uploads[0].body).toMatch(/^<\?xml[\s\S]*<feed>[\s\S]*<id>SKU0<\/id>/);
    expect(sftp.ended()).toBe(1);
    // successful count recorded for the shrink guard
    expect(JSON.parse(store.get('feeds-push.counts'))['cj|us/en_us'].count).toBe(4);
  });

  test('missing credentials fail the job and alert, without connecting', async () => {
    const { emails } = mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp();
    const res = await run({ ...SECRETS, CJ_SFTP_PASSWORD: '' }, {
      namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient },
    });
    expect(res.ok).toBe(false);
    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'config' });
    expect(res.results[0].error).toContain('CJ_SFTP_PASSWORD');
    expect(sftp.connects).toHaveLength(0);
    expect(emails).toHaveLength(1);
  });

  test('source fetch failure fails the build step and sends one alert', async () => {
    const { emails } = mockFetch({ feeds: {} }); // 404
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'build' });
    expect(res.alert).toBe('sent');
    expect(emails).toHaveLength(1);
    expect(emails[0].toEmail).toEqual(['a@example.com', 'b@example.com']);
    expect(emails[0].subject).toBe('[stage] Feed push failed: cj us/en_us');
    expect(sftp.uploads).toHaveLength(0);
  });

  test('no ALERT_FEED_FAIL_EMAILS: failures are logged only', async () => {
    const { emails } = mockFetch({ feeds: {} });
    const sftp = mockSftp();
    const noAlerts = { ...SECRETS };
    delete noAlerts.ALERT_FEED_FAIL_EMAILS;
    const res = await run(noAlerts, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(res.ok).toBe(false);
    expect(res.alert).toBe('no-recipients');
    expect(emails).toHaveLength(0);
  });

  test('alert send failure does not throw', async () => {
    mockFetch({ feeds: {}, emailOk: false });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(res.alert).toBe('send-failed');
    expect(res.results[0].status).toBe('failed');
  });

  test('connect failure is retried, then reported', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp({ connectError: new Error('auth failed') });
    const res = await run(SECRETS, {
      namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient, retries: 1 },
    });
    expect(sftp.connects).toHaveLength(2);
    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'connect', error: 'auth failed' });
  });

  test('upload failure is reported and not retried', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp({ putError: new Error('permission denied') });
    const res = await run(SECRETS, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'upload', error: 'permission denied' });
    expect(store.has('feeds-push.counts')).toBe(false);
  });

  test('one locale failing does not stop the others; one connection is shared', async () => {
    const { emails } = mockFetch({ feeds: { 'ca/en_us': sourceFeed(2) } }); // US 404s
    const sftp = mockSftp();
    const res = await run(SECRETS, {
      namespace: STAGE_NS, config: twoLocaleConfig(), sftpDeps: { createClient: sftp.createClient },
    });
    expect(res.results.map((r) => [r.locale, r.status])).toEqual([
      ['us/en_us', 'failed'],
      ['ca/en_us', 'uploaded'],
    ]);
    expect(sftp.uploads.map((u) => u.path)).toEqual(['/vitamix_ca_edge.xml']);
    expect(sftp.connects).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });

  test('target/locale filters limit a manual run', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2), 'ca/en_us': sourceFeed(2) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, {
      namespace: STAGE_NS, config: twoLocaleConfig(), locale: 'ca/en_us', sftpDeps: { createClient: sftp.createClient },
    });
    expect(res.results.map((r) => r.locale)).toEqual(['ca/en_us']);
  });

  test('per-locale credentials override opens a separate connection', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2), 'ca/en_us': sourceFeed(2) } });
    const sftp = mockSftp();
    const config = twoLocaleConfig();
    config.stage.targets.cj.locales['ca/en_us'].credentials = 'CJ_CA';
    const res = await run({ ...SECRETS, CJ_CA_SFTP_USERNAME: 'ca-user', CJ_CA_SFTP_PASSWORD: 'ca-pass' }, {
      namespace: STAGE_NS, config, sftpDeps: { createClient: sftp.createClient },
    });
    expect(res.ok).toBe(true);
    expect(sftp.connects.map((c) => c.username)).toEqual(['cj-user', 'ca-user']);
  });

  test('dryRun never connects and never alerts', async () => {
    const { emails } = mockFetch({ feeds: {} });
    const sftp = mockSftp();
    const res = await run({ LOG_LEVEL: 'error', ALERT_FEED_FAIL_EMAILS: 'a@example.com' }, {
      namespace: STAGE_NS, dryRun: true, sftpDeps: { createClient: sftp.createClient },
    });
    expect(res.results[0].status).toBe('failed');
    expect(sftp.connects).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });
});

describe('run — shrink guard', () => {
  test('blocks an upload under 50% of the last successful count; force bypasses it', async () => {
    store.set('feeds-push.counts', JSON.stringify({ 'cj|us/en_us': { count: 10, at: '2026-10-27T05:00:00Z' } }));
    mockFetch({ feeds: { 'us/en_us': sourceFeed(4) } });
    const sftp = mockSftp();

    const blocked = await run(SECRETS, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(blocked.results[0]).toMatchObject({ status: 'failed', step: 'validate' });
    expect(blocked.results[0].error).toMatch(/dropped from 10 to 4/);
    expect(sftp.uploads).toHaveLength(0);

    const forced = await run(SECRETS, { namespace: STAGE_NS, force: true, sftpDeps: { createClient: sftp.createClient } });
    expect(forced.results[0].status).toBe('uploaded');
    // the forced count becomes the new baseline
    expect(JSON.parse(store.get('feeds-push.counts'))['cj|us/en_us'].count).toBe(4);
  });

  test('exactly 50% is allowed', async () => {
    store.set('feeds-push.counts', JSON.stringify({ 'cj|us/en_us': { count: 8 } }));
    mockFetch({ feeds: { 'us/en_us': sourceFeed(4) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(res.results[0].status).toBe('uploaded');
  });

  test('a state outage skips the guard with a warning (fail open)', async () => {
    stateMock.get.mockRejectedValueOnce(new Error('state down'));
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(res.results[0].status).toBe('uploaded');
    expect(res.warnings[0]).toMatch(/shrink guard skipped: state down/);
  });
});

describe('validateFeed', () => {
  const xml = (ids) => `<?xml version="1.0"?><feed>${ids.map((id) => `<item><id>${id}</id></item>`).join('')}</feed>`;
  const built = (ids) => ({ body: xml(ids), contentType: 'application/xml', itemCount: ids.length });

  test('passes a good feed', () => {
    expect(validateFeed(built(['a-1', 'B_2']), { idPattern: /^[A-Za-z0-9_-]+$/ })).toEqual([]);
  });

  test('rejects empty body, invalid XML, too few items, and bad CJ ids', () => {
    expect(validateFeed({ body: '  ', contentType: 'application/xml', itemCount: 0 })).toEqual(['feed body is empty']);
    expect(validateFeed({ body: '<feed><item></feed>', contentType: 'application/xml', itemCount: 1 })[0])
      .toMatch(/invalid XML/);
    expect(validateFeed(built([]))).toEqual(['only 0 items (minimum 1)']);
    expect(validateFeed(built(['ok', 'bad id', 'bad.id']), { idPattern: /^[A-Za-z0-9_-]+$/ })[0])
      .toMatch(/2 ids don't match .*: bad id, bad\.id/);
  });

  test('checks CSV feeds for a header row', () => {
    expect(validateFeed({ body: '\uFEFFid,title\n1,x\n', contentType: 'text/csv', itemCount: 1 })).toEqual([]);
    expect(validateFeed({ body: 'nothing', contentType: 'text/csv', itemCount: 1 })).toEqual(['CSV has no header row']);
  });
});

describe('alert', () => {
  test('parseRecipients', () => {
    expect(parseRecipients(' a@x.com, ,b@x.com ')).toEqual(['a@x.com', 'b@x.com']);
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients('$ALERT_FEED_FAIL_EMAILS')).toEqual([]);
  });

  test('buildAlert escapes errors and lists every result', () => {
    const { subject, html } = buildAlert('stage', [
      { target: 'cj', locale: 'us/en_us', file: 'a.xml', status: 'failed', step: 'build', error: '<boom>' },
      { target: 'cj', locale: 'ca/en_us', file: 'b.xml', status: 'uploaded', itemCount: 5 },
    ]);
    expect(subject).toBe('[stage] Feed push failed: cj us/en_us');
    expect(html).toContain('&lt;boom&gt;');
    expect(html).toContain('b.xml');
  });
});

describe('main', () => {
  test('parses manual-run params', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const prev = process.env.__OW_NAMESPACE;
    process.env.__OW_NAMESPACE = STAGE_NS;
    try {
      const res = await main({ LOG_LEVEL: 'error', dryRun: 'true', locale: 'US/EN_US' });
      expect(res.dryRun).toBe(true);
      expect(res.results.map((r) => [r.locale, r.status])).toEqual([['us/en_us', 'validated']]);
    } finally {
      if (prev === undefined) delete process.env.__OW_NAMESPACE; else process.env.__OW_NAMESPACE = prev;
    }
  });
});
