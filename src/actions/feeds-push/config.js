/**
 * feeds-push configuration — everything that isn't a secret lives here, per
 * environment. Changing a target, file name, locale or on/off switch is a code
 * change + deploy. Secrets (SFTP credentials, alert recipients) come from env
 * vars set by the deploy workflows; targets reference them by `credentials` key.
 *
 * Emergency stop without a deploy: `aio rt rule disable feeds-push-rule` in the
 * affected namespace (re-created as enabled on the next deploy).
 */

/** Runtime namespace → environment. Any other namespace does nothing. */
export const NAMESPACES = {
  '60038-161ivoryjackal-stage': 'stage',
  '60038-161ivoryjackal': 'prod',
};

/**
 * Schedule: push at 1:00 AM America/New_York, all year.
 *
 * I/O Runtime's alarm feed ignores `timezone` and evaluates cron in UTC, so the
 * trigger fires at both 05:00 and 06:00 UTC (1 AM EDT / 1 AM EST), and a
 * scheduled run only proceeds when it's the first hour that reads
 * SCHEDULE_HOUR on the local clock (see isScheduledHour in ./run.js).
 */
export const SCHEDULE_TIMEZONE = 'America/New_York';
export const SCHEDULE_HOUR = 1;

/**
 * Default minimum items a feed must contain to be uploaded. Targets/locales
 * should set a realistic `minItems` floor: the shrink guard has no baseline on
 * a first run, after the state TTL, or when state can't be read.
 */
export const MIN_ITEMS = 1;

/**
 * Shrink guard: skip the upload when the item count drops below this fraction
 * of the last successful push for the same target + locale. Providers like CJ
 * replace the whole catalog with each file, so a partial-but-valid build would
 * otherwise delist products. Bypass with a manual `force: true` run.
 */
export const MAX_SHRINK = 0.5;

/** SFTP connection timeout (ms) and retries (connection errors only). */
export const SFTP_READY_TIMEOUT_MS = 30000;
export const SFTP_CONNECT_RETRIES = 1;

/**
 * @typedef {{
 *   file: string,
 *   enabled?: boolean,
 *   credentials?: string,
 *   minItems?: number,
 * }} LocaleConfig
 *
 * @typedef {{
 *   provider: string,
 *   enabled?: boolean,
 *   host: string,
 *   port: number,
 *   remoteDir: string,
 *   credentials: string,
 *   algorithms?: Record<string, unknown>,
 *   hostFingerprints?: string[],
 *   idPattern?: RegExp,
 *   minItems?: number,
 *   locales: Record<string, LocaleConfig>,
 * }} TargetConfig
 *
 * @typedef {{
 *   enabled: boolean,
 *   scheduled: boolean,
 *   targets: Record<string, TargetConfig>,
 * }} EnvConfig
 *
 * `enabled` gates every real push in the environment. `scheduled` controls
 * whether the nightly alarm pushes; when false, only manual runs push.
 */

/**
 * Commission Junction "POST to CJ SFTP" — shared by every environment.
 * - Files must go in the root directory; CJ ignores subdirectories.
 * - The file name must exactly match the CJ feed registration.
 * - CJ's server (Apache SSHD) only offers the legacy `ssh-dss` host key, which
 *   ssh2 doesn't enable by default. The key is pinned: all three A records for
 *   datatransfer.cj.com served this fingerprint (2026-10-28). If CJ rotates it,
 *   connections fail and alert; add the new fingerprint after verifying it.
 * - CJ item-level commissioning needs ids of letters, digits, `-` and `_` only.
 *   Other ids don't fail the import, so they warn instead of blocking.
 */
const CJ_SFTP = {
  provider: 'cj',
  host: 'datatransfer.cj.com',
  port: 22,
  remoteDir: '/',
  algorithms: { serverHostKey: { append: ['ssh-dss'] } },
  hostFingerprints: ['SHA256:gRHIccwhOI+eXWmHZS/AacDj24Pc6zizcue39ILRsVE'],
  idPattern: /^[A-Za-z0-9_-]+$/,
};

/** @type {Record<string, EnvConfig>} */
export const CONFIG = {
  stage: {
    enabled: true,
    // Stage pushes on demand only (aio rt action invoke … -p now true). The
    // alarm still fires here (app.config.yaml is shared) but the run no-ops.
    scheduled: false,
    targets: {
      cj: {
        ...CJ_SFTP,
        credentials: 'CJ', // CJ_SFTP_USERNAME / CJ_SFTP_PASSWORD
        locales: {
          // CJ test feed "Vitamix_US_Edge_Test" (feed 323567, ad 17374154), test mode
          // Floors are ~60% of the current item count (2026-10: US 160, CA 141),
          // so a partial catalog is blocked even without a shrink-guard baseline.
          'us/en_us': { file: 'vitamix_us_edge.xml', minItems: 100 },
          // CJ test feed "Vitamix_CA_Edge_Test" (feed 323619, ad 17374929), test
          // mode. Same CJ account and SFTP credentials as US.
          'ca/en_us': { file: 'vitamix_ca_edge.xml', minItems: 85 },
        },
      },
    },
  },
  prod: {
    // Off until the live CJ registrations + credentials exist.
    enabled: false,
    scheduled: true, // nightly at 1 AM America/New_York once enabled
    targets: {},
  },
};

/**
 * @param {string | undefined} [namespace] defaults to the runtime's namespace
 * @returns {string | null} environment name, or null for unknown namespaces
 */
export function resolveEnvironment(namespace = process.env.__OW_NAMESPACE) {
  return (namespace && NAMESPACES[namespace]) || null;
}

/**
 * Read SFTP credentials for a credentials key from the action params.
 * `CJ` → CJ_SFTP_USERNAME / CJ_SFTP_PASSWORD.
 * @param {Record<string, unknown>} params
 * @param {string} ref
 * @returns {{ username: string, password: string } | null} null if either is missing
 */
export function resolveCredentials(params, ref) {
  const userKey = `${ref}_SFTP_USERNAME`;
  const passKey = `${ref}_SFTP_PASSWORD`;
  // An unset secret can arrive as an empty string or as the unsubstituted
  // "$VAR" literal left by the deploy.
  const usable = (v, key) => typeof v === 'string' && v !== '' && v !== `$${key}`;
  const username = params[userKey];
  const password = params[passKey];
  if (!usable(username, userKey) || !usable(password, passKey)) return null;
  return { username: String(username), password: String(password) };
}
