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

const {
  run, listJobs, isScheduledHour, localHour,
} = await import('../../src/actions/feeds-push/run.js');
const { main } = await import('../../src/actions/feeds-push/index.js');
const {
  CONFIG, NAMESPACES, resolveEnvironment, resolveCredentials, isScheduleEnabled,
} = await import('../../src/actions/feeds-push/config.js');
const { validateFeed, checkBazaarvoice } = await import('../../src/actions/feeds-push/validate.js');
const sftpModule = await import('../../src/actions/feeds-push/sftp.js');
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

/** Bazaarvoice category sheet: every test product is a blender. */
const BV_SHEET = {
  categories: { data: [{ externalId: '91', name: 'Blenders', path: '/shop/blenders' }] },
  products: { data: [{ sku: 'SKU0', categoryExternalId: '91' }] },
};

/**
 * Route fetch: merchant-center feed per locale, the Bazaarvoice category sheet
 * and product index, email API. Commercial sub-indexes are missing (404).
 */
function mockFetch({ feeds = {}, emailOk = true } = {}) {
  const emails = [];
  const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('bv-categories')) {
      return { ok: true, status: 200, json: async () => BV_SHEET };
    }
    if (/\/products\/index\.json/.test(u)) {
      return { ok: true, status: 200, json: async () => ({ total: 1, data: [{ sku: 'SKU0', reviewsId: 'r0' }] }) };
    }
    if (u.includes('/emails')) {
      emails.push(JSON.parse(init.body));
      return { ok: emailOk, status: emailOk ? 200 : 500, headers: { get: () => null } };
    }
    const m = u.match(/vitamix\.com\/([a-z]{2}\/[a-z]{2}_[a-z]{2})\/products\/merchant-center-feed\.xml/);
    const feed = m && feeds[m[1]];
    if (feed == null) return { ok: false, status: 404, text: async () => '' };
    if (feed instanceof Error) throw feed;
    return { ok: true, status: 200, text: async () => feed };
  });
  return { spy, emails };
}

/**
 * Fake SFTP client backed by an in-memory filesystem (shared across clients).
 * `uploads` lists files as they land under their final (non-.part) name, in
 * order; `ops` records every call; `files` is the final remote state.
 */
function mockSftp({
  connectError, putError, renameError, posixRename = true, shortWrite = false, files = new Map(),
} = {}) {
  const uploads = [];
  const connects = [];
  const ops = [];
  let ended = 0;
  const land = (path, body) => {
    files.set(path, body);
    if (!path.endsWith('.part')) uploads.push({ path, body });
  };
  const createClient = () => ({
    connect: jest.fn(async (opts) => {
      connects.push(opts);
      if (connectError) throw connectError;
    }),
    put: jest.fn(async (buf, path) => {
      ops.push(['put', path]);
      if (putError) {
        files.set(path, '<partial');
        throw putError;
      }
      land(path, buf.toString('utf-8'));
    }),
    stat: jest.fn(async (path) => {
      ops.push(['stat', path]);
      const body = files.get(path);
      if (body === undefined) throw new Error(`No such file: ${path}`);
      return { size: Buffer.byteLength(body, 'utf-8') - (shortWrite ? 1 : 0) };
    }),
    posixRename: jest.fn(async (from, to) => {
      ops.push(['posixRename', from, to]);
      if (!posixRename) throw new Error('Server does not support this extended request');
      if (renameError) throw renameError;
      const body = files.get(from);
      files.delete(from);
      land(to, body);
    }),
    rename: jest.fn(async (from, to) => {
      ops.push(['rename', from, to]);
      if (renameError) throw renameError;
      if (files.has(to)) throw new Error('Failure: file exists');
      const body = files.get(from);
      files.delete(from);
      land(to, body);
    }),
    delete: jest.fn(async (path, notFoundOK) => {
      ops.push(['delete', path]);
      if (!files.has(path) && !notFoundOK) throw new Error(`No such file: ${path}`);
      files.delete(path);
    }),
    end: jest.fn(async () => { ended += 1; }),
  });
  return {
    createClient, uploads, connects, ops, files, ended: () => ended,
  };
}

const SECRETS = {
  LOG_LEVEL: 'error',
  CJ_SFTP_USERNAME: 'cj-user',
  CJ_SFTP_PASSWORD: 'cj-pass',
  BV_SFTP_USERNAME: 'bv-user',
  BV_SFTP_PASSWORD: 'bv-pass',
  ALERT_FEED_FAIL_EMAILS: 'a@example.com, b@example.com',
  EMAIL_TOKEN: 'email-token',
};

/**
 * The real stage config with small item floors, so tests can use tiny feeds.
 * (The real US floor is covered by its own test.)
 */
const smallConfig = () => ({
  ...CONFIG,
  stage: {
    enabled: true,
    targets: {
      cj: {
        ...CONFIG.stage.targets.cj,
        locales: { 'us/en_us': { ...CONFIG.stage.targets.cj.locales['us/en_us'], minItems: 1 } },
      },
    },
  },
});

/** The real stage Bazaarvoice target alone, with small item floors. */
const bvConfig = () => ({
  ...CONFIG,
  stage: {
    enabled: true,
    targets: {
      bazaarvoice: {
        ...CONFIG.stage.targets.bazaarvoice,
        locales: Object.fromEntries(Object.entries(CONFIG.stage.targets.bazaarvoice.locales)
          .map(([locale, l]) => [locale, { ...l, minItems: 1 }])),
      },
    },
  },
});

/** A config with CJ US + CA on stage, for multi-locale tests. */
const twoLocaleConfig = () => ({
  ...CONFIG,
  stage: {
    enabled: true,
    targets: {
      cj: {
        ...CONFIG.stage.targets.cj,
        locales: {
          'us/en_us': { file: 'vitamix_us_edge.xml', minItems: 1 },
          'ca/en_us': { file: 'vitamix_ca_edge.xml', minItems: 1 },
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

  test('stage pushes the CJ US and CA test feeds on demand only; prod has no CJ target', () => {
    expect(CONFIG.stage.enabled).toBe(true);
    expect(CONFIG.stage.scheduled).toBe(false);
    const { locales } = CONFIG.stage.targets.cj;
    expect(Object.keys(locales)).toEqual(['us/en_us', 'ca/en_us']);
    expect(locales['us/en_us']).toMatchObject({ file: 'vitamix_us_edge.xml', minItems: 100 });
    expect(locales['ca/en_us']).toMatchObject({ file: 'vitamix_ca_edge.xml', minItems: 85 });
    // same CJ account → shared credentials, no per-locale override
    expect(locales['ca/en_us'].credentials).toBeUndefined();
    expect(CONFIG.stage.targets.cj.remoteDir).toBe('/');
    expect(CONFIG.prod.scheduled).toBe(true);
    expect(CONFIG.prod.targets.cj).toBeUndefined();
  });

  test('Bazaarvoice: staging SFTP on stage, production SFTP on prod; only prod\'s schedule is switched', () => {
    const shared = {
      provider: 'bazaarvoice',
      port: 22,
      remoteDir: '/import-inbox',
      credentials: 'BV',
      // not confirmed that BV ignores temp files and imports a renamed file
      atomicUpload: false,
      locales: {
        'us/en_us': { file: 'productfeed-en_US.xml', minItems: 115 },
        'ca/en_us': { file: 'productfeed-en_CA.xml', minItems: 100 },
        'mx/es_mx': { file: 'productfeed-en_MX.xml', minItems: 6 },
      },
    };
    expect(CONFIG.stage.targets.bazaarvoice).toEqual({
      ...shared,
      host: 'sftp-stg.bazaarvoice.com',
      hostFingerprints: ['SHA256:t/uFhJvmc7afOctQfLpTWHCt9QqEePvWSIYkICMVxiI'],
    });
    expect(CONFIG.prod.targets.bazaarvoice).toEqual({
      ...shared,
      scheduleEnabledBy: 'BV_SCHEDULE_ENABLED',
      host: 'sftp.bazaarvoice.com',
      hostFingerprints: ['SHA256:yEGwcR7htSTYWCWtT5mLkC/vryF8B7jFtTIaX2xZLMM'],
    });
    expect(CONFIG.prod.enabled).toBe(true);
    // every prod target needs its schedule switched on explicitly
    for (const target of Object.values(CONFIG.prod.targets)) expect(target.scheduleEnabledBy).toBeTruthy();
  });

  test('isScheduleEnabled: only "true" turns a switched schedule on', () => {
    const t = { scheduleEnabledBy: 'X_ENABLED' };
    expect(isScheduleEnabled({}, {})).toBe(true);
    expect(isScheduleEnabled(t, { X_ENABLED: 'true' })).toBe(true);
    expect(isScheduleEnabled(t, { X_ENABLED: ' TRUE ' })).toBe(true);
    expect(isScheduleEnabled(t, { X_ENABLED: true })).toBe(true);
    for (const v of [undefined, '', 'false', '1', '$X_ENABLED']) {
      expect(isScheduleEnabled(t, { X_ENABLED: v })).toBe(false);
    }
  });

  test('resolveCredentials treats empty and unsubstituted vars as missing', () => {
    expect(resolveCredentials(SECRETS, 'CJ')).toEqual({ username: 'cj-user', password: 'cj-pass' });
    expect(resolveCredentials(SECRETS, 'BV')).toEqual({ username: 'bv-user', password: 'bv-pass' });
    expect(resolveCredentials({ BV_SFTP_USERNAME: '$BV_SFTP_USERNAME', BV_SFTP_PASSWORD: '$BV_SFTP_PASSWORD' }, 'BV'))
      .toBeNull();
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

  test('a disabled environment builds and uploads nothing', async () => {
    const { spy } = mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp();
    const config = smallConfig();
    config.stage.enabled = false;
    const res = await run(SECRETS, { namespace: STAGE_NS, config, sftpDeps: { createClient: sftp.createClient } });
    expect(res).toEqual({ skipped: true, reason: 'disabled', environment: 'stage' });
    expect(spy).not.toHaveBeenCalled();
    expect(sftp.connects).toHaveLength(0);
  });

  test('prod without BV_SCHEDULE_ENABLED: the 1 AM run builds and uploads nothing', async () => {
    const { spy } = mockFetch({ feeds: { 'us/en_us': sourceFeed(200) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, {
      namespace: PROD_NS, scheduled: true, now: new Date('2026-07-01T05:00:03Z'), sftpDeps: { createClient: sftp.createClient },
    });
    expect(res).toEqual({
      skipped: true,
      reason: 'target-schedule-disabled',
      environment: 'prod',
      scheduleOff: ['bazaarvoice (BV_SCHEDULE_ENABLED is not "true")'],
    });
    expect(spy).not.toHaveBeenCalled();
    expect(sftp.connects).toHaveLength(0);
  });

  test('prod with BV_SCHEDULE_ENABLED: the 1 AM run pushes Bazaarvoice to the production SFTP', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(120), 'ca/en_us': sourceFeed(100), 'mx/es_mx': sourceFeed(6) } });
    const sftp = mockSftp();
    const opts = { namespace: PROD_NS, scheduled: true, sftpDeps: { createClient: sftp.createClient } };
    const on = { ...SECRETS, BV_SCHEDULE_ENABLED: 'true' };
    // outside 1 AM ET: nothing
    expect(await run(on, { ...opts, now: new Date('2026-07-01T15:00:00Z') }))
      .toMatchObject({ skipped: true, reason: 'outside-schedule' });
    expect(sftp.connects).toHaveLength(0);

    const res = await run(on, { ...opts, now: new Date('2026-07-01T05:00:03Z') });
    expect(res.ok).toBe(true);
    expect(res.environment).toBe('prod');
    expect(res.scheduleOff).toBeUndefined();
    expect(sftp.connects.map((c) => c.host)).toEqual(['sftp.bazaarvoice.com']);
    expect(sftp.uploads.map((u) => u.path)).toEqual([
      '/import-inbox/productfeed-en_US.xml',
      '/import-inbox/productfeed-en_CA.xml',
      '/import-inbox/productfeed-en_MX.xml',
    ]);
  });

  test('a disabled environment with a dryRun builds and validates without SFTP', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp();
    const config = smallConfig();
    config.stage.enabled = false;
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
    const res = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });

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
      namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient },
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
    const res = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
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
    const res = await run(noAlerts, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
    expect(res.ok).toBe(false);
    expect(res.alert).toBe('no-recipients');
    expect(emails).toHaveLength(0);
  });

  test('alert send failure does not throw', async () => {
    mockFetch({ feeds: {}, emailOk: false });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
    expect(res.alert).toBe('send-failed');
    expect(res.results[0].status).toBe('failed');
  });

  test('connect failure is retried, then reported', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp({ connectError: new Error('auth failed') });
    const res = await run(SECRETS, {
      namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient, retries: 1 },
    });
    expect(sftp.connects).toHaveLength(2);
    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'connect', error: 'auth failed' });
  });

  test('upload failure is reported and not retried', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp({ putError: new Error('permission denied') });
    const res = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
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

  test('bad CJ ids upload anyway and send a warnings alert', async () => {
    const { emails } = mockFetch({ feeds: { 'us/en_us': sourceFeed(2, 'BAD.') } });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
    expect(res.ok).toBe(true);
    expect(res.results[0].status).toBe('uploaded');
    expect(res.results[0].warnings[0]).toMatch(/2 ids don't match/);
    expect(sftp.uploads).toHaveLength(1);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('[stage] Feed push warnings: cj us/en_us');
  });

  test('a filter that matches nothing is an error, not a silent no-op', async () => {
    const { spy } = mockFetch();
    const res = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), target: 'cjj' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no feed matches target="cjj" locale="*"; known: cj:us/en_us');
    expect(spy).not.toHaveBeenCalled();
  });

  test('passes the pinned host key to the SFTP connection', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp();
    await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
    expect(sftp.connects[0].hostHash).toBe('sha256');
    expect(typeof sftp.connects[0].hostVerifier).toBe('function');
  });

  test('dryRun never connects and never alerts', async () => {
    const { emails } = mockFetch({ feeds: {} });
    const sftp = mockSftp();
    const res = await run({ LOG_LEVEL: 'error', ALERT_FEED_FAIL_EMAILS: 'a@example.com' }, {
      namespace: STAGE_NS, config: smallConfig(), dryRun: true, sftpDeps: { createClient: sftp.createClient },
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

    const blocked = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
    expect(blocked.results[0]).toMatchObject({ status: 'failed', step: 'validate' });
    expect(blocked.results[0].error).toMatch(/dropped from 10 to 4/);
    expect(sftp.uploads).toHaveLength(0);

    const forced = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), force: true, sftpDeps: { createClient: sftp.createClient } });
    expect(forced.results[0].status).toBe('uploaded');
    // the forced count becomes the new baseline
    expect(JSON.parse(store.get('feeds-push.counts'))['cj|us/en_us'].count).toBe(4);
  });

  test('exactly 50% is allowed', async () => {
    store.set('feeds-push.counts', JSON.stringify({ 'cj|us/en_us': { count: 8 } }));
    mockFetch({ feeds: { 'us/en_us': sourceFeed(4) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
    expect(res.results[0].status).toBe('uploaded');
  });

  test('a state outage skips the guard with a warning (fail open)', async () => {
    stateMock.get.mockRejectedValueOnce(new Error('state down'));
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
    expect(res.results[0].status).toBe('uploaded');
    expect(res.warnings[0]).toMatch(/shrink guard skipped: state down/);
  });

  test('a state outage still alerts, so an unguarded upload is noticed', async () => {
    stateMock.get.mockRejectedValueOnce(new Error('state down'));
    const { emails } = mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });
    expect(res.ok).toBe(true);
    expect(res.alert).toBe('sent');
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('[stage] Feed push warnings: cj us/en_us');
    expect(emails[0].html).toContain('shrink guard skipped: state down');
  });

  test('the real US floor (minItems 100) blocks a small feed even without a baseline', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'validate', error: 'only 3 items (minimum 100)' });
    expect(sftp.connects).toHaveLength(0);
  });
});

describe('run — warning alert dedup', () => {
  const opts = (sftp) => ({ namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient } });

  test('a persistent warning alerts once, then is suppressed', async () => {
    const { emails } = mockFetch({ feeds: { 'us/en_us': sourceFeed(2, 'BAD.') } });
    const sftp = mockSftp();
    const first = await run(SECRETS, opts(sftp));
    const second = await run(SECRETS, opts(sftp));
    expect(first.alert).toBe('sent');
    expect(second.alert).toBe('suppressed-repeat');
    expect(second.results[0].status).toBe('uploaded');
    expect(emails).toHaveLength(1);
  });

  test('changed warnings alert again', async () => {
    const sftp = mockSftp();
    const { emails } = mockFetch({ feeds: { 'us/en_us': sourceFeed(2, 'BAD.') } });
    await run(SECRETS, opts(sftp));
    jest.restoreAllMocks();
    const second = mockFetch({ feeds: { 'us/en_us': sourceFeed(3, 'BAD.') } }); // 3 bad ids now
    const res = await run(SECRETS, opts(sftp));
    expect(emails).toHaveLength(1);
    expect(res.alert).toBe('sent');
    expect(second.emails).toHaveLength(1);
  });

  test('a warning that clears and comes back alerts again', async () => {
    const sftp = mockSftp();
    let m = mockFetch({ feeds: { 'us/en_us': sourceFeed(2, 'BAD.') } });
    await run(SECRETS, opts(sftp));
    expect(m.emails).toHaveLength(1);
    jest.restoreAllMocks();
    m = mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } }); // clean
    const clean = await run(SECRETS, opts(sftp));
    expect(clean.alert).toBeUndefined();
    jest.restoreAllMocks();
    m = mockFetch({ feeds: { 'us/en_us': sourceFeed(2, 'BAD.') } }); // back
    const back = await run(SECRETS, opts(sftp));
    expect(back.alert).toBe('sent');
    expect(m.emails).toHaveLength(1);
  });

  test('failures alert every run', async () => {
    const { emails } = mockFetch({ feeds: {} });
    const sftp = mockSftp();
    await run(SECRETS, opts(sftp));
    await run(SECRETS, opts(sftp));
    expect(emails).toHaveLength(2);
  });

  test('a failed send is retried on the next run', async () => {
    const sftp = mockSftp();
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2, 'BAD.') }, emailOk: false });
    const first = await run(SECRETS, opts(sftp));
    expect(first.alert).toBe('send-failed');
    jest.restoreAllMocks();
    const { emails } = mockFetch({ feeds: { 'us/en_us': sourceFeed(2, 'BAD.') } });
    const second = await run(SECRETS, opts(sftp));
    expect(second.alert).toBe('sent');
    expect(emails).toHaveLength(1);
  });

  test('a filtered run does not reset other feeds\' alerted warnings', async () => {
    const sftp = mockSftp();
    const twoOpts = { namespace: STAGE_NS, config: twoLocaleConfig(), sftpDeps: { createClient: sftp.createClient } };
    let m = mockFetch({ feeds: { 'us/en_us': sourceFeed(2, 'BAD.'), 'ca/en_us': sourceFeed(2) } });
    await run(SECRETS, twoOpts);
    expect(m.emails).toHaveLength(1);
    jest.restoreAllMocks();
    m = mockFetch({ feeds: { 'us/en_us': sourceFeed(2, 'BAD.'), 'ca/en_us': sourceFeed(2) } });
    await run(SECRETS, { ...twoOpts, locale: 'ca/en_us' });
    await run(SECRETS, twoOpts); // US warning unchanged → still suppressed
    expect(m.emails).toHaveLength(0);
  });
});

describe('validateFeed', () => {
  const xml = (ids) => `<?xml version="1.0"?><feed>${ids.map((id) => `<item><id>${id}</id></item>`).join('')}</feed>`;
  const built = (ids) => ({ body: xml(ids), contentType: 'application/xml', itemCount: ids.length });

  const ID = /^[A-Za-z0-9_-]+$/;

  test('passes a good feed', () => {
    expect(validateFeed(built(['a-1', 'B_2']), { idPattern: ID })).toEqual({ problems: [], warnings: [] });
  });

  test('rejects empty body, invalid XML and too few items', () => {
    expect(validateFeed({ body: '  ', contentType: 'application/xml', itemCount: 0 }).problems)
      .toEqual(['feed body is empty']);
    expect(validateFeed({ body: '<feed><item></feed>', contentType: 'application/xml', itemCount: 1 }).problems[0])
      .toMatch(/invalid XML/);
    expect(validateFeed(built([])).problems).toEqual(['only 0 items (minimum 1)']);
    expect(validateFeed(built(['a', 'b']), { minItems: 3 }).problems).toEqual(['only 2 items (minimum 3)']);
  });

  test('bad CJ ids warn but do not block', () => {
    const { problems, warnings } = validateFeed(built(['ok', 'bad id', 'bad.id']), { idPattern: ID });
    expect(problems).toEqual([]);
    expect(warnings[0]).toMatch(/2 ids don't match .*: bad id, bad\.id/);
  });

  test('checks CSV feeds for a header row', () => {
    expect(validateFeed({ body: '\uFEFFid,title\n1,x\n', contentType: 'text/csv', itemCount: 1 }).problems).toEqual([]);
    expect(validateFeed({ body: 'nothing', contentType: 'text/csv', itemCount: 1 }).problems)
      .toEqual(['CSV has no header row']);
  });
});

describe('run — Bazaarvoice', () => {
  const opts = (sftp, extra = {}) => ({
    namespace: STAGE_NS, config: bvConfig(), sftpDeps: { createClient: sftp.createClient }, ...extra,
  });

  test('uploads each locale directly to /import-inbox with the staging credentials', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3), 'ca/en_us': sourceFeed(2), 'mx/es_mx': sourceFeed(1) } });
    const sftp = mockSftp({ files: new Map([['/import-inbox/productfeed-en_US.xml', '<old/>']]) });
    const res = await run(SECRETS, opts(sftp));

    expect(res.ok).toBe(true);
    expect(res.results.map((r) => [r.locale, r.status, r.itemCount, r.remotePath])).toEqual([
      ['us/en_us', 'uploaded', 3, '/import-inbox/productfeed-en_US.xml'],
      ['ca/en_us', 'uploaded', 2, '/import-inbox/productfeed-en_CA.xml'],
      ['mx/es_mx', 'uploaded', 1, '/import-inbox/productfeed-en_MX.xml'],
    ]);
    expect(sftp.connects).toEqual([expect.objectContaining({
      host: 'sftp-stg.bazaarvoice.com', port: 22, username: 'bv-user', password: 'bv-pass', hostHash: 'sha256',
    })]);
    // no temp file + rename: written straight to the final names
    expect(sftp.ops).toEqual([
      ['put', '/import-inbox/productfeed-en_US.xml'],
      ['put', '/import-inbox/productfeed-en_CA.xml'],
      ['put', '/import-inbox/productfeed-en_MX.xml'],
    ]);
    const us = sftp.files.get('/import-inbox/productfeed-en_US.xml');
    expect(us).toMatch(/<Feed xmlns="http:\/\/www\.bazaarvoice\.com\/xs\/PRR\/ProductFeed\/14\.7"/);
    expect(us).toContain('<Name locale="en_US">');
    expect(sftp.files.get('/import-inbox/productfeed-en_MX.xml')).toContain('<Name locale="es_MX">');
    const counts = JSON.parse(store.get('feeds-push.counts'));
    expect(counts['bazaarvoice|mx/es_mx'].count).toBe(1);
  });

  test('missing BV credentials fail every Bazaarvoice locale without connecting', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp();
    const noBv = { ...SECRETS, BV_SFTP_USERNAME: '', BV_SFTP_PASSWORD: '' };
    const res = await run(noBv, opts(sftp, { locale: 'us/en_us' }));
    expect(res.results[0]).toMatchObject({
      status: 'failed', step: 'config', error: 'missing BV_SFTP_USERNAME / BV_SFTP_PASSWORD',
    });
    expect(sftp.connects).toHaveLength(0);
  });

  test('a product without an image blocks that locale\'s upload', async () => {
    const noImage = sourceFeed(2).replace('<g:image_link>https://www.vitamix.com/img/1.jpg</g:image_link>', '');
    mockFetch({ feeds: { 'us/en_us': noImage } });
    const sftp = mockSftp();
    const res = await run(SECRETS, opts(sftp, { locale: 'us/en_us' }));
    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'validate' });
    expect(res.results[0].error).toMatch(/1 products missing ImageUrl: SKU1/);
    expect(sftp.connects).toHaveLength(0);
  });

  test('the real floors block small feeds even without a baseline', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(114), 'ca/en_us': sourceFeed(100), 'mx/es_mx': sourceFeed(5) } });
    const res = await run(SECRETS, { namespace: STAGE_NS, target: 'bazaarvoice', dryRun: true });
    expect(res.results.map((r) => [r.locale, r.status, r.error])).toEqual([
      ['us/en_us', 'failed', 'only 114 items (minimum 115)'],
      ['ca/en_us', 'validated', undefined],
      ['mx/es_mx', 'failed', 'only 5 items (minimum 6)'],
    ]);
  });
});

describe('run — Bazaarvoice schedule switch', () => {
  test('prod manual runs push without BV_SCHEDULE_ENABLED', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(120) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, {
      namespace: PROD_NS, target: 'bazaarvoice', locale: 'us/en_us', sftpDeps: { createClient: sftp.createClient },
    });
    expect(res.ok).toBe(true);
    expect(res.scheduleOff).toBeUndefined();
    expect(sftp.uploads.map((u) => u.path)).toEqual(['/import-inbox/productfeed-en_US.xml']);
    expect(sftp.connects.map((c) => c.host)).toEqual(['sftp.bazaarvoice.com']);
  });

  test('switch off: the nightly run still pushes other targets and lists the skipped one', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(3) } });
    const sftp = mockSftp();
    const config = smallConfig();
    config.stage.scheduled = true;
    config.stage.targets.bazaarvoice = { ...bvConfig().stage.targets.bazaarvoice, scheduleEnabledBy: 'BV_SCHEDULE_ENABLED' };
    const res = await run(SECRETS, {
      namespace: STAGE_NS, config, scheduled: true, now: new Date('2026-07-01T05:00:03Z'), sftpDeps: { createClient: sftp.createClient },
    });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.target)).toEqual(['cj']);
    expect(res.scheduleOff).toEqual(['bazaarvoice (BV_SCHEDULE_ENABLED is not "true")']);
  });

  test('stage never pushes on the schedule, even with the switch on', async () => {
    const { spy } = mockFetch({ feeds: { 'us/en_us': sourceFeed(200) } });
    const res = await run({ ...SECRETS, BV_SCHEDULE_ENABLED: 'true' }, {
      namespace: STAGE_NS, scheduled: true, now: new Date('2026-07-01T05:00:03Z'),
    });
    expect(res).toMatchObject({ skipped: true, reason: 'schedule-disabled', environment: 'stage' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Bazaarvoice validation', () => {
  const NS = 'http://www.bazaarvoice.com/xs/PRR/ProductFeed/14.7';
  const product = (id, fields = {}) => {
    const f = {
      Name: `Product ${id}`,
      ProductPageUrl: `https://www.example.com/p/${id}`,
      ImageUrl: `https://www.example.com/i/${id}.jpg`,
      CategoryExternalId: '91',
      ...fields,
    };
    return `<Product><ExternalId>${id}</ExternalId>${Object.entries(f)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`).join('')}</Product>`;
  };
  const feed = (products, {
    ns = NS, incremental = 'false', categories = '<Category><ExternalId>55</ExternalId><Name>Shop</Name></Category>'
      + '<Category><ExternalId>91</ExternalId><ParentExternalId>55</ParentExternalId><Name>Blenders</Name></Category>',
  } = {}) => `<?xml version="1.0" encoding="UTF-8"?><Feed xmlns="${ns}" name="x" incremental="${incremental}">`
    + `<Categories>${categories}</Categories><Products>${products.join('')}</Products></Feed>`;
  const built = (body, itemCount) => ({ body, contentType: 'application/xml', itemCount });
  const check = (body, itemCount) => validateFeed(built(body, itemCount), { provider: 'bazaarvoice' }).problems;

  test('passes a good feed, including a single product and no categories', () => {
    expect(check(feed([product('A'), product('B')]), 2)).toEqual([]);
    expect(check(feed([product('A', { CategoryExternalId: undefined })], { categories: '' }), 1)).toEqual([]);
  });

  test('requires the BV root, namespace and a full feed', () => {
    expect(check('<?xml version="1.0"?><feed><item/></feed>', 1)).toEqual(['missing <Feed> root element']);
    expect(check(feed([product('A')], { ns: 'urn:other' }), 1)[0]).toMatch(/namespace is "urn:other"/);
    expect(check(feed([product('A')], { incremental: 'true' }), 1))
      .toEqual(['<Feed> must be a full feed (incremental="false")']);
  });

  test('the product count must match the built item count', () => {
    expect(check(feed([product('A')]), 2)).toEqual(['1 <Product> elements, expected 2']);
  });

  test('requires ExternalId, Name, ProductPageUrl and ImageUrl', () => {
    const problems = check(feed([
      product('A', { Name: '' }),
      product('B', { ImageUrl: undefined, ProductPageUrl: ' ' }),
      '<Product><Name>x</Name><ProductPageUrl>https://e.com/x</ProductPageUrl><ImageUrl>https://e.com/x.jpg</ImageUrl></Product>',
    ]), 3);
    expect(problems).toEqual([
      '1 products missing Name: A',
      '1 products missing ProductPageUrl: B',
      '1 products missing ImageUrl: B',
      '1 products missing ExternalId: #3',
    ]);
  });

  test('rejects bad ids, URLs and dangling category references', () => {
    expect(check(feed([product('A'), product('A')]), 2)).toEqual(['duplicate product ExternalIds: A']);
    expect(check(feed([product('A/1')]), 1)).toEqual(['product ExternalIds containing "/": A/1']);
    expect(check(feed([product('A', { ImageUrl: '/i/a.jpg' })]), 1)).toEqual(['invalid product URLs: A ImageUrl']);
    expect(check(feed([product('A', { CategoryExternalId: '99' })]), 1))
      .toEqual(['products referencing an undefined category: A→99']);
    expect(check(feed([product('A')], {
      categories: '<Category><ExternalId>91</ExternalId><ParentExternalId>7</ParentExternalId><Name>B</Name></Category>'
        + '<Category><ExternalId>91</ExternalId><Name>B</Name></Category>',
    }), 1)).toEqual(['duplicate category ExternalIds: 91', 'categories with an undefined parent: 91→7']);
  });

  test('lists at most five offending ids', () => {
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    expect(check(feed(ids.map((id) => product(id, { Name: '' }))), 6))
      .toEqual(['6 products missing Name: A, B, C, D, E, …']);
  });

  test('only runs for the bazaarvoice provider and on well-formed XML', () => {
    const notBv = '<?xml version="1.0"?><feed><item><id>a</id></item></feed>';
    expect(validateFeed(built(notBv, 1), { provider: 'cj' }).problems).toEqual([]);
    expect(validateFeed(built('<Feed><Products>', 1), { provider: 'bazaarvoice' }).problems)
      .toEqual([expect.stringMatching(/^invalid XML/)]);
    expect(checkBazaarvoice(feed([product('A')]), 1)).toEqual([]);
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
  test('parses manual-run params (real stage config)', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(120) } });
    const prev = process.env.__OW_NAMESPACE;
    process.env.__OW_NAMESPACE = STAGE_NS;
    try {
      const res = await main({
        LOG_LEVEL: 'error', dryRun: 'true', target: 'CJ', locale: 'US/EN_US',
      });
      expect(res.dryRun).toBe(true);
      expect(res.results.map((r) => [r.locale, r.status])).toEqual([['us/en_us', 'validated']]);
    } finally {
      if (prev === undefined) delete process.env.__OW_NAMESPACE; else process.env.__OW_NAMESPACE = prev;
    }
  });
});

describe('sftp host key pinning', () => {
  const CJ_FP = CONFIG.stage.targets.cj.hostFingerprints[0];
  // sha256 hex whose base64 is the pinned CJ fingerprint
  const cjHashHex = Buffer.from(CJ_FP.replace(/^SHA256:/, ''), 'base64').toString('hex');
  const log = { warn() {} };

  /** client whose connect() runs the hostVerifier with the given key hash */
  const clientSeeing = (hashHex) => () => ({
    connect: async (opts) => {
      if (opts.hostVerifier && !opts.hostVerifier(hashHex)) {
        throw new Error('Host denied (verification failed)');
      }
    },
    end: async () => {},
  });

  test('fingerprint() formats like OpenSSH', () => {
    expect(sftpModule.fingerprint(cjHashHex)).toBe(CJ_FP);
  });

  test('accepts the pinned key', async () => {
    await expect(sftpModule.connect(
      { host: 'h', port: 22, hostFingerprints: [CJ_FP] },
      { log, createClient: clientSeeing(cjHashHex), retries: 0 },
    )).resolves.toBeDefined();
  });

  test('rejects any other key with a clear error', async () => {
    const other = 'ab'.repeat(32);
    await expect(sftpModule.connect(
      { host: 'datatransfer.cj.com', port: 22, hostFingerprints: [CJ_FP] },
      { log, createClient: clientSeeing(other), retries: 0 },
    )).rejects.toThrow(`host key mismatch for datatransfer.cj.com: got ${sftpModule.fingerprint(other)}, expected one of ${CJ_FP}`);
  });

  test('accepts the pinned Bazaarvoice staging key', async () => {
    const [bvFp] = CONFIG.stage.targets.bazaarvoice.hostFingerprints;
    const bvHashHex = Buffer.from(bvFp.replace(/^SHA256:/, ''), 'base64').toString('hex');
    await expect(sftpModule.connect(
      { host: 'sftp-stg.bazaarvoice.com', port: 22, hostFingerprints: [bvFp] },
      { log, createClient: clientSeeing(bvHashHex), retries: 0 },
    )).resolves.toBeDefined();
    await expect(sftpModule.connect(
      { host: 'sftp-stg.bazaarvoice.com', port: 22, hostFingerprints: [bvFp] },
      { log, createClient: clientSeeing(cjHashHex), retries: 0 },
    )).rejects.toThrow(/host key mismatch for sftp-stg\.bazaarvoice\.com/);
  });

  test('does not verify when no fingerprints are configured', async () => {
    await expect(sftpModule.connect(
      { host: 'h', port: 22 },
      { log, createClient: clientSeeing('00'), retries: 0 },
    )).resolves.toBeDefined();
  });
});

describe('schedule (1:00 AM America/New_York from a 05:00 + 06:00 UTC cron)', () => {
  const at = (iso) => new Date(iso);

  test('localHour uses the wall clock', () => {
    expect(localHour(at('2026-07-01T05:00:03Z'), 'America/New_York')).toBe(1); // EDT
    expect(localHour(at('2026-12-01T05:00:03Z'), 'America/New_York')).toBe(0); // EST
  });

  test.each([
    // summer (EDT, UTC-4): 05:00Z is 1 AM
    ['2026-07-01T05:00:03Z', true],
    ['2026-07-01T06:00:03Z', false],
    // winter (EST, UTC-5): 06:00Z is 1 AM
    ['2026-12-01T05:00:03Z', false],
    ['2026-12-01T06:00:03Z', true],
    // DST ends Sun 2026-11-01: both fires read 1 AM; only the first runs
    ['2026-11-01T05:00:03Z', true],
    ['2026-11-01T06:00:03Z', false],
    // DST starts Sun 2027-03-14 at 2 AM EST (07:00Z): 06:00Z is 1 AM EST
    ['2027-03-14T05:00:03Z', false],
    ['2027-03-14T06:00:03Z', true],
    // the alarm that fired at 9 PM ET on 2026-10-28 (01:00Z, old cron)
    ['2026-10-29T01:00:03Z', false],
  ])('%s → push=%s', (iso, expected) => {
    expect(isScheduledHour(at(iso))).toBe(expected);
  });

  test('exactly one push per local day across a year of 05:00/06:00Z fires', () => {
    const perDay = new Map();
    const start = Date.UTC(2026, 0, 1);
    for (let d = 0; d < 366 * 2; d += 1) {
      for (const h of [5, 6]) {
        const date = new Date(start + d * 86400000 + h * 3600000);
        if (isScheduledHour(date)) {
          const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);
          perDay.set(day, (perDay.get(day) || 0) + 1);
        }
      }
    }
    expect(perDay.size).toBeGreaterThanOrEqual(730);
    expect([...perDay.values()].every((n) => n === 1)).toBe(true);
  });

  test('a scheduled run outside 1 AM ET skips without building', async () => {
    const { spy } = mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const res = await run(SECRETS, {
      namespace: STAGE_NS, config: smallConfig(), scheduled: true, now: at('2026-07-01T06:00:03Z'),
    });
    expect(res).toMatchObject({ skipped: true, reason: 'outside-schedule', environment: 'stage' });
    expect(res.localTime).toMatch(/2:00 AM America\/New_York/);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a scheduled run at 1 AM ET pushes', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp();
    const res = await run(SECRETS, {
      namespace: STAGE_NS,
      config: smallConfig(),
      scheduled: true,
      now: at('2026-07-01T05:00:03Z'),
      sftpDeps: { createClient: sftp.createClient },
    });
    expect(res.ok).toBe(true);
    expect(sftp.uploads).toHaveLength(1);
  });

  test('stage (scheduled: false): the alarm no-ops even at 1 AM ET; manual runs still push', async () => {
    const { spy } = mockFetch({
      feeds: { 'us/en_us': sourceFeed(120), 'ca/en_us': sourceFeed(100), 'mx/es_mx': sourceFeed(8) },
    });
    const sftp = mockSftp();
    const scheduled = await run(SECRETS, {
      namespace: STAGE_NS, scheduled: true, now: at('2026-07-01T05:00:03Z'), sftpDeps: { createClient: sftp.createClient },
    });
    expect(scheduled).toMatchObject({ skipped: true, reason: 'schedule-disabled', environment: 'stage' });
    expect(spy).not.toHaveBeenCalled();

    const manual = await run(SECRETS, { namespace: STAGE_NS, sftpDeps: { createClient: sftp.createClient } });
    expect(manual.ok).toBe(true);
    expect(sftp.uploads.map((u) => u.path)).toEqual([
      '/vitamix_us_edge.xml',
      '/vitamix_ca_edge.xml',
      '/import-inbox/productfeed-en_US.xml',
      '/import-inbox/productfeed-en_CA.xml',
      '/import-inbox/productfeed-en_MX.xml',
    ]);
    // one shared connection per target
    expect(sftp.connects.map((c) => [c.host, c.username]))
      .toEqual([['datatransfer.cj.com', 'cj-user'], ['sftp-stg.bazaarvoice.com', 'bv-user']]);
  });

  test('main: a bare invoke is treated as scheduled; manual params bypass the check', async () => {
    const prev = process.env.__OW_NAMESPACE;
    process.env.__OW_NAMESPACE = STAGE_NS;
    jest.useFakeTimers({ now: at('2026-07-01T15:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      mockFetch({ feeds: { 'us/en_us': sourceFeed(120) } });
      // real stage config: scheduled runs are off
      expect(await main({ LOG_LEVEL: 'error' })).toMatchObject({ skipped: true, reason: 'schedule-disabled' });
      // trigger-provided params don't count as manual
      expect(await main({ LOG_LEVEL: 'error', cron: '0 5,6 * * *', timezone: 'UTC' }))
        .toMatchObject({ reason: 'schedule-disabled' });
      const dry = await main({ LOG_LEVEL: 'error', now: 'true', dryRun: 'true' });
      expect(dry.results[0].status).toBe('validated');
      const dryOnly = await main({ LOG_LEVEL: 'error', dryRun: 'true' });
      expect(dryOnly.results[0].status).toBe('validated');
    } finally {
      jest.useRealTimers();
      if (prev === undefined) delete process.env.__OW_NAMESPACE; else process.env.__OW_NAMESPACE = prev;
    }
  });
});

describe('atomic upload (temp name, verify size, rename into place)', () => {
  const OLD = '<old catalog/>';
  const pushUS = (sftp, extra = {}) => run(SECRETS, {
    namespace: STAGE_NS, config: smallConfig(), sftpDeps: { createClient: sftp.createClient }, ...extra,
  });

  test('CJ uploads to <file>.part, checks the size, then posix-renames over the live file', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp({ files: new Map([['/vitamix_us_edge.xml', OLD]]) });
    const res = await pushUS(sftp);

    expect(res.results[0]).toMatchObject({ status: 'uploaded', rename: 'posix-rename' });
    expect(sftp.ops).toEqual([
      ['put', '/vitamix_us_edge.xml.part'],
      ['stat', '/vitamix_us_edge.xml.part'],
      ['posixRename', '/vitamix_us_edge.xml.part', '/vitamix_us_edge.xml'],
    ]);
    expect([...sftp.files.keys()]).toEqual(['/vitamix_us_edge.xml']);
    expect(sftp.files.get('/vitamix_us_edge.xml')).toMatch(/<id>SKU0<\/id>/);
  });

  test('without posix-rename, deletes the live file then renames', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp({ posixRename: false, files: new Map([['/vitamix_us_edge.xml', OLD]]) });
    const res = await pushUS(sftp);

    expect(res.results[0]).toMatchObject({ status: 'uploaded', rename: 'delete+rename' });
    expect(sftp.ops.slice(2)).toEqual([
      ['posixRename', '/vitamix_us_edge.xml.part', '/vitamix_us_edge.xml'],
      ['delete', '/vitamix_us_edge.xml'],
      ['rename', '/vitamix_us_edge.xml.part', '/vitamix_us_edge.xml'],
    ]);
    expect([...sftp.files.keys()]).toEqual(['/vitamix_us_edge.xml']);
    expect(sftp.files.get('/vitamix_us_edge.xml')).not.toBe(OLD);
  });

  test('first push (no live file yet) works with the delete+rename fallback', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp({ posixRename: false });
    const res = await pushUS(sftp);
    expect(res.results[0]).toMatchObject({ status: 'uploaded', rename: 'delete+rename' });
    expect([...sftp.files.keys()]).toEqual(['/vitamix_us_edge.xml']);
  });

  test('a short write is never renamed into place; the live file and no temp remain', async () => {
    const { emails } = mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp({ shortWrite: true, files: new Map([['/vitamix_us_edge.xml', OLD]]) });
    const res = await pushUS(sftp);

    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'upload' });
    expect(res.results[0].error).toMatch(/size mismatch after upload/);
    expect(sftp.ops.map((o) => o[0])).not.toContain('posixRename');
    expect([...sftp.files.entries()]).toEqual([['/vitamix_us_edge.xml', OLD]]);
    expect(emails).toHaveLength(1);
  });

  test('an interrupted put leaves the live file untouched and cleans up the temp file', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp({ putError: new Error('connection reset'), files: new Map([['/vitamix_us_edge.xml', OLD]]) });
    const res = await pushUS(sftp);

    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'upload', error: 'connection reset' });
    expect([...sftp.files.entries()]).toEqual([['/vitamix_us_edge.xml', OLD]]);
    expect(store.has('feeds-push.counts')).toBe(false);
  });

  test('a rename failure keeps the live file and removes the temp file', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp({ renameError: new Error('permission denied'), files: new Map([['/vitamix_us_edge.xml', OLD]]) });
    const res = await pushUS(sftp);

    expect(res.results[0]).toMatchObject({ status: 'failed', step: 'upload', error: 'permission denied' });
    expect([...sftp.files.entries()]).toEqual([['/vitamix_us_edge.xml', OLD]]);
  });

  test('targets without atomicUpload write directly to the final name', async () => {
    mockFetch({ feeds: { 'us/en_us': sourceFeed(2) } });
    const sftp = mockSftp();
    const config = smallConfig();
    config.stage.targets.cj.atomicUpload = false;
    const res = await run(SECRETS, { namespace: STAGE_NS, config, sftpDeps: { createClient: sftp.createClient } });

    expect(res.results[0].status).toBe('uploaded');
    expect(res.results[0].rename).toBeUndefined();
    expect(sftp.ops).toEqual([['put', '/vitamix_us_edge.xml']]);
  });

  test('CJ is configured for atomic uploads', () => {
    expect(CONFIG.stage.targets.cj.atomicUpload).toBe(true);
  });
});
