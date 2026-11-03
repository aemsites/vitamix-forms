import {
  describe, test, expect, afterEach,
} from '@jest/globals';
import { proxyFetch } from '../src/proxy.js';

const ctx = {
  env: { ORG: 'org', SITE: 'site', PROXY_TOKEN: 't' },
  log: { error() {} },
};

const nodeFetch = global.fetch;
afterEach(() => { global.fetch = nodeFetch; });

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

describe('proxyFetch abort (real fetch, local server)', () => {
  // Real timers and a real socket: the request is redirected to a local server
  // that stalls, to check the signal really ends the request.
  async function withServer(handler, fn) {
    const http = await import('node:http');
    const server = http.createServer(handler);
    await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
    const { port } = server.address();
    global.fetch = (_url, init) => nodeFetch(`http://127.0.0.1:${port}/`, init);
    try {
      await fn();
    } finally {
      global.fetch = nodeFetch;
      server.closeAllConnections();
      await new Promise((r) => { server.close(r); });
    }
  }

  test('stalled response headers are aborted', async () => {
    await withServer(() => {}, async () => {
      const err = await proxyFetch(ctx, 'https://example.com/x', { method: 'POST', signal: AbortSignal.timeout(100) })
        .catch((e) => e);
      expect(err.name).toBe('TimeoutError');
    });
  });

  test('a stalled response body is aborted', async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.write('<partial');
    }, async () => {
      const res = await proxyFetch(ctx, 'https://example.com/x', { method: 'POST', signal: AbortSignal.timeout(150) });
      const err = await res.text().catch((e) => e);
      expect(err.name).toBe('TimeoutError');
    });
  });
});
