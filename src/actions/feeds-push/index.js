/**
 * Adobe I/O Runtime action — feeds-push (non-web).
 *
 * Builds provider feeds and uploads them to each provider's SFTP endpoint.
 * Runs nightly at 1:00 AM America/New_York: the feeds-push-schedule alarm
 * fires at 05:00 and 06:00 UTC (Runtime's alarm feed ignores `timezone`), and
 * only the run that falls at 1 AM New York time pushes.
 * What runs where is configured in code (./config.js), per environment; only
 * secrets (SFTP credentials, ALERT_FEED_FAIL_EMAILS) come from env vars.
 *
 * Manual runs (namespace credentials required — there's no web URL):
 *
 *   aio rt action invoke feeds/feeds-push --result
 *     -p now true             run now (a bare invoke is treated as the
 *                             schedule and skips outside 1 AM ET)
 *     -p dryRun true          build + validate only, no SFTP (works even when
 *                             the environment is disabled)
 *     -p target cj            limit to one target
 *     -p locale us/en_us      limit to one locale
 *     -p force true           bypass the shrink guard
 *
 * Any of now/dryRun/force/target/locale marks a manual run, which skips the
 * 1 AM check. The run summary is the activation result.
 */

import { run } from './run.js';

/** @param {unknown} value */
const isTrue = (value) => value === true || /^(true|1|yes)$/i.test(String(value ?? '').trim());

/** @param {unknown} value */
const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Params that only a person sets; their presence means a manual run. */
const MANUAL_PARAMS = ['now', 'dryRun', 'force', 'target', 'locale'];

export async function main(params) {
  const manual = MANUAL_PARAMS.some((key) => params[key] !== undefined);
  return run(params, {
    scheduled: !manual,
    dryRun: isTrue(params.dryRun),
    force: isTrue(params.force),
    target: optionalString(params.target)?.toLowerCase(),
    locale: optionalString(params.locale)?.toLowerCase(),
  });
}
