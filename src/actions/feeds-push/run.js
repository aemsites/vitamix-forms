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
  CONFIG, MIN_ITEMS, SCHEDULE_TIMEZONE, SCHEDULE_HOUR, resolveEnvironment, resolveCredentials,
} from './config.js';
import { validateFeed } from './validate.js';
import * as sftp from './sftp.js';
import {
  loadCounts, saveCounts, countKey, loadAlertedWarnings, saveAlertedWarnings,
} from './state.js';
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
 *   warnings?: string[],
 * }} PushResult
 *
 * @typedef {{
 *   dryRun?: boolean,
 *   force?: boolean,
 *   scheduled?: boolean,
 *   now?: Date,
 *   target?: string,
 *   locale?: string,
 *   namespace?: string,
 *   config?: Record<string, import('./config.js').EnvConfig>,
 *   sftpDeps?: { createClient?: () => any, retries?: number },
 * }} RunOptions
 */

const DEFAULTS = { ORG: 'aemsites', SITE: 'vitamix', LOG_LEVEL: 'info' };

/**
 * Hour (0–23) on the wall clock of `timeZone` at `date`.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {number}
 */
export function localHour(date, timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(date));
}

/**
 * True when `date` is in the first hour the local clock reads `hour`.
 * The alarm fires at both 05:00 and 06:00 UTC; exactly one of them is 1 AM in
 * New York on a normal day. On the night DST ends both are 1 AM, and only the
 * first counts (an hour earlier wasn't already 1 AM).
 * @param {Date} date
 * @param {string} [timeZone]
 * @param {number} [hour]
 * @returns {boolean}
 */
export function isScheduledHour(date, timeZone = SCHEDULE_TIMEZONE, hour = SCHEDULE_HOUR) {
  const hourEarlier = new Date(date.getTime() - 3600 * 1000);
  return localHour(date, timeZone) === hour && localHour(hourEarlier, timeZone) !== hour;
}

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
        minItems: localeConfig.minItems ?? target.minItems ?? MIN_ITEMS,
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

  if (options.scheduled && envConfig.scheduled === false) {
    log.info(`skipping: ${environment} pushes on demand only (scheduled: false)`);
    return {
      skipped: true,
      reason: 'schedule-disabled',
      environment,
      hint: 'for a manual run, pass -p now true (or dryRun/target/locale/force)',
    };
  }
  if (options.scheduled) {
    const now = options.now || new Date();
    if (!isScheduledHour(now)) {
      const local = new Intl.DateTimeFormat('en-US', {
        timeZone: SCHEDULE_TIMEZONE, dateStyle: 'short', timeStyle: 'short',
      }).format(now);
      log.info(`skipping: not the scheduled ${SCHEDULE_HOUR}:00 ${SCHEDULE_TIMEZONE} run (now ${local})`);
      return {
        skipped: true,
        reason: 'outside-schedule',
        environment,
        localTime: `${local} ${SCHEDULE_TIMEZONE}`,
        hint: 'for a manual run, pass -p now true (or dryRun/target/locale/force)',
      };
    }
  }

  const jobs = listJobs(envConfig, options);
  if (!jobs.length && (options.target || options.locale)) {
    // A filtered manual run that matches nothing is almost always a typo;
    // don't let it look like a successful no-op.
    const known = listJobs(envConfig).map((j) => `${j.targetKey}:${j.locale}`);
    const error = `no feed matches target=${JSON.stringify(options.target ?? '*')} `
      + `locale=${JSON.stringify(options.locale ?? '*')}; known: ${known.join(', ') || 'none'}`;
    log.error(error);
    return {
      ok: false, environment, dryRun, error, results: [],
    };
  }
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
  if (!dryRun) {
    alert = await alertIfNeeded(ctx, environment, results, warnings);
  }

  for (const r of results) {
    const line = `${r.target} ${r.locale} → ${r.file}: ${r.status}`
      + `${r.itemCount !== undefined ? ` (${r.itemCount} items)` : ''}${r.error ? ` — ${r.step}: ${r.error}` : ''}`
      + `${r.warnings?.length ? ` [warnings: ${r.warnings.join('; ')}]` : ''}`;
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

/** @param {PushResult} r */
const warningSignature = (r) => [...(r.warnings || [])].sort().join('\n');

/**
 * Decide whether to alert, and send it.
 * - Any failure → alert, every run.
 * - Run-level warnings (e.g. shrink guard skipped on a state outage) → alert,
 *   every run. They're transient, and with state down we can't dedupe anyway.
 * - Per-feed warnings (e.g. ids CJ can't commission) → alert only when a feed's
 *   warnings differ from the ones last alerted on, so a persistent data issue
 *   emails once instead of nightly. Cleared warnings reset, so a recurrence
 *   alerts again.
 * @returns {Promise<string | undefined>} alert outcome, or undefined if none was due
 */
async function alertIfNeeded(ctx, environment, results, runWarnings) {
  const hasFailures = results.some((r) => r.status === 'failed');
  const signatures = Object.fromEntries(results.map((r) => [countKey(r.target, r.locale), warningSignature(r)]));

  /** @type {Record<string, string> | null} null when state can't be read */
  let alerted = null;
  try {
    alerted = await loadAlertedWarnings();
  } catch (err) {
    ctx.log.warn(`could not load alerted warnings, not deduplicating: ${err.message}`);
  }
  const newWarnings = Object.entries(signatures)
    .some(([key, sig]) => sig && (!alerted || alerted[key] !== sig));

  let outcome;
  if (hasFailures || runWarnings.length || newWarnings) {
    outcome = await sendFailureAlert(ctx, environment, results, runWarnings);
  } else if (Object.values(signatures).some(Boolean)) {
    outcome = 'suppressed-repeat';
    ctx.log.info('feed warnings unchanged since the last alert; not alerting again');
  }

  // Record what this run's feeds look like now: alerted warnings, or '' for
  // feeds whose warnings cleared. Only when the alert actually went out (or
  // there was nothing new), so a failed send is retried next run.
  if (outcome !== 'send-failed' && outcome !== 'no-recipients') {
    try {
      await saveAlertedWarnings(signatures);
    } catch (err) {
      ctx.log.warn(`could not save alerted warnings: ${err.message}`);
    }
  }
  return outcome;
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
  const { problems, warnings } = validateFeed(built, {
    idPattern: target.idPattern, previousCount: previous, force, minItems: job.minItems,
  });
  if (warnings.length) result.warnings = warnings;
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
      hostFingerprints: target.hostFingerprints,
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
