/**
 * Adobe I/O Runtime action — feeds-push (non-web).
 *
 * Builds provider feeds and uploads them to each provider's SFTP endpoint.
 * Runs nightly at 1:00 AM America/New_York via the feeds-push-schedule alarm.
 * What runs where is configured in code (./config.js), per environment; only
 * secrets (SFTP credentials, ALERT_FEED_FAIL_EMAILS) come from env vars.
 *
 * Manual runs (namespace credentials required — there's no web URL):
 *
 *   aio rt action invoke feeds/feeds-push --result
 *     -p dryRun true          build + validate only, no SFTP (works even when
 *                             the environment is disabled)
 *     -p target cj            limit to one target
 *     -p locale us/en_us      limit to one locale
 *     -p force true           bypass the shrink guard
 *
 * The run summary is the activation result.
 */

import { run } from './run.js';

/** @param {unknown} value */
const isTrue = (value) => value === true || /^(true|1|yes)$/i.test(String(value ?? '').trim());

/** @param {unknown} value */
const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export async function main(params) {
  return run(params, {
    dryRun: isTrue(params.dryRun),
    force: isTrue(params.force),
    target: optionalString(params.target)?.toLowerCase(),
    locale: optionalString(params.locale)?.toLowerCase(),
  });
}
