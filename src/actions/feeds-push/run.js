/**
 * feeds-push orchestration.
 *
 *   0. Resolve the environment from the runtime namespace. Unknown namespace or
 *      a disabled environment → skip (a dryRun ignores the environment switch).
 *   1. Expand the environment's targets × locales into jobs, honoring the
 *      per-target / per-locale `enabled` flags and the optional target/locale
 *      filters of a manual run.
 *   2. Per job: build the feed in-process (shared with the feeds web action),
 *      validate it (incl. the shrink guard against the last successful count),
 *      and upload it over SFTP. A failure in one job never stops the others.
 *   3. Record item counts of successful uploads; alert by email if anything
 *      failed.
 */

import { Core } from '@adobe/aio-sdk';
import { buildProviderFeed, resolveFeedEnv } from '../feeds/build.js';
import {
  CONFIG, resolveEnvironment, resolveCredentials,
} from './config.js';
import { validateFeed } from './validate.js';
import * as sftp from './sftp.js';
import { loadCounts, saveCounts, countKey } from './state.js';
import { sendFailureAlert } from './alert.js';

/**
 * @typedef {{
 *   target: string,
 *   locale: string,
 *   file: string,
 *   status: 'uploaded' | 'validated' | 'failed',
 *   step?: 'config' | 'build' | 'validate' | 'connect' | 'upload',
 *   itemCount?: number,
 *   bytes?: number,
 *   remotePath?: string,
 *   error?: string,
 * }} PushResult
 *
 * @typedef {{
 *   dryRun?: boolean,
 *   force?: boolean,
 *   target?: string,
 *   locale?: string,
 *   namespace?: string,
 *   config?: Record<string, import('./config.js').EnvConfig>,
 *   sftpDeps?: { createClient?: () => any, retries?: number },
 * }} RunOptions
 */

const DEFAULTS = { ORG: 'aemsites', SITE: 'vitamix', LOG_LEVEL: 'info' };

/**
 * @param {import('./config.js').EnvConfig} envConfig
 * @param {{ target?: string, locale?: string }} filters
 */
export function listJobs(envConfig, { target: onlyTarget, locale: onlyLocale } = {}) {
  const jobs = [];
  for (const [targetKey, target] of Object.entries(envConfig.targets || {})) {
    if (target.enabled === false) continue;
    if (onlyTarget && onlyTarget !== targetKey) continue;
    for (const [locale, localeConfig] of Object.entries(target.locales || {})) {
      if (localeConfig.enabled === false) continue;
      if (onlyLocale && onlyLocale !== locale) continue;
      jobs.push({
        targetKey,
        target,
        locale,
        file: localeConfig.file,
        credentials: localeConfig.credentials || target.credentials,
      });
    }
  }
  return jobs;
}

/**
 * Run the push job.
 * @param {Record<string, any>} params action params (secrets arrive here)
 * @param {RunOptions} [options]
 */
export async function run(params, options = {}) {
  const env = { ...DEFAULTS, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')) };
  const log = Core.Logger('feeds-push', { level: env.LOG_LEVEL });
  const {
    dryRun = false, force = false, config = CONFIG, sftpDeps = {},
  } = options;

  const environment = resolveEnvironment(options.namespace);
  if (!environment || !config[environment]) {
    log.info(`skipping: unknown namespace "${options.namespace ?? process.env.__OW_NAMESPACE}"`);
    return { skipped: true, reason: 'unknown-namespace' };
  }
  const envConfig = config[environment];
  if (!envConfig.enabled && !dryRun) {
    log.info(`skipping: feed push is disabled for ${environment}`);
    return { skipped: true, reason: 'disabled', environment };
  }

  const jobs = listJobs(envConfig, options);
  if (!jobs.length) {
    log.info(`no feeds to push in ${environment}`);
    return {
      ok: true, environment, dryRun, results: [],
    };
  }

  const ctx = { env: { ...env, ...resolveFeedEnv(params) }, log };
  /** @type {string[]} */
  const warnings = [];

  /** @type {import('./state.js').Counts} */
  let previousCounts = {};
  try {
    previousCounts = await loadCounts();
  } catch (err) {
    // Fail open: a state outage shouldn't stop the nightly push.
    warnings.push(`could not load previous item counts, shrink guard skipped: ${err.message}`);
    log.warn(warnings[warnings.length - 1]);
  }

  /** @type {Map<string, Promise<any>>} open connections by host/port/credentials */
  const connections = new Map();
  /** @type {PushResult[]} */
  const results = [];
  /** @type {import('./state.js').Counts} */
  const newCounts = {};

  try {
    for (const job of jobs) {
      const result = await pushOne(ctx, job, {
        dryRun, force, previousCounts, connections, sftpDeps, params,
      });
      results.push(result);
      if (result.status === 'uploaded') {
        newCounts[countKey(job.targetKey, job.locale)] = {
          count: result.itemCount, at: new Date().toISOString(),
        };
      }
    }
  } finally {
    for (const pending of connections.values()) {
      // eslint-disable-next-line no-await-in-loop
      const client = await pending.catch(() => null);
      // eslint-disable-next-line no-await-in-loop
      if (client) await sftp.close(client);
    }
  }

  if (Object.keys(newCounts).length) {
    try {
      await saveCounts(newCounts);
    } catch (err) {
      warnings.push(`could not save item counts: ${err.message}`);
      log.warn(warnings[warnings.length - 1]);
    }
  }

  const failed = results.filter((r) => r.status === 'failed');
  let alert;
  if (failed.length && !dryRun) {
    alert = await sendFailureAlert(ctx, environment, results);
  }

  for (const r of results) {
    const line = `${r.target} ${r.locale} → ${r.file}: ${r.status}`
      + `${r.itemCount !== undefined ? ` (${r.itemCount} items)` : ''}${r.error ? ` — ${r.step}: ${r.error}` : ''}`;
    if (r.status === 'failed') log.error(line); else log.info(line);
  }

  return {
    ok: failed.length === 0,
    environment,
    dryRun,
    force,
    results,
    ...(warnings.length ? { warnings } : {}),
    ...(alert ? { alert } : {}),
  };
}

/**
 * Build, validate and upload one target + locale.
 * @returns {Promise<PushResult>}
 */
async function pushOne(ctx, job, {
  dryRun, force, previousCounts, connections, sftpDeps, params,
}) {
  const { targetKey, target, locale, file } = job;
  /** @type {PushResult} */
  const result = { target: targetKey, locale, file, status: 'failed' };
  const fail = (step, err) => ({ ...result, step, error: err instanceof Error ? err.message : String(err) });

  // Credentials are checked up front so a missing secret fails fast — but a
  // dryRun never connects, so it doesn't need them.
  const creds = resolveCredentials(params, job.credentials);
  if (!creds && !dryRun) {
    return fail('config', `missing ${job.credentials}_SFTP_USERNAME / ${job.credentials}_SFTP_PASSWORD`);
  }

  let built;
  try {
    built = await buildProviderFeed(ctx, target.provider, locale);
  } catch (err) {
    return fail('build', err);
  }
  result.itemCount = built.itemCount;

  const previous = previousCounts[countKey(targetKey, locale)]?.count ?? null;
  const problems = validateFeed(built, { idPattern: target.idPattern, previousCount: previous, force });
  if (problems.length) {
    return fail('validate', problems.join('; '));
  }

  const path = sftp.remotePath(target.remoteDir, file);
  result.remotePath = path;
  if (dryRun) {
    return { ...result, status: 'validated', bytes: Buffer.byteLength(built.body, 'utf-8') };
  }

  const connKey = `${target.host}:${target.port}:${job.credentials}`;
  if (!connections.has(connKey)) {
    connections.set(connKey, sftp.connect({
      host: target.host,
      port: target.port,
      algorithms: target.algorithms,
      ...creds,
    }, { log: ctx.log, ...sftpDeps }));
  }
  let client;
  try {
    client = await connections.get(connKey);
  } catch (err) {
    return fail('connect', err);
  }

  try {
    const bytes = await sftp.upload(client, built.body, path);
    return { ...result, status: 'uploaded', bytes };
  } catch (err) {
    return fail('upload', err);
  }
}
