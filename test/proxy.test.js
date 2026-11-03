import {
  describe, test, expect, afterEach,
} from '@jest/globals';
import { proxyFetch } from '../src/proxy.js';

const ctx = {
  env: { ORG: 'org', SITE: 'site', PROXY_TOKEN: 't' },
  log: { error() {} },
};

afterEach(() => { delete global.fetch; });

describe('proxyFetch', () => {
  test('passes the signal to fetch and keeps it out of the envelope', async () => {
    let init;
    global.fetch = async (_url, i) => { init = i; return { ok: true }; };
    const signal = AbortSignal.timeout(60_000);

    await proxyFetch(ctx, 'https://example.com/x', { method: 'POST', body: '<xml/>', signal });

    expect(init.signal).toBe(signal);
    expect(JSON.parse(init.body)).toEqual({ url: 'https://example.com/x', method: 'POST', body: '<xml/>' });
  });

  test('no signal → no signal on the request', async () => {
    let init;
    global.fetch = async (_url, i) => { init = i; return { ok: true }; };
    await proxyFetch(ctx, 'https://example.com/x', { method: 'GET' });
    expect('signal' in init).toBe(false);
  });
});
