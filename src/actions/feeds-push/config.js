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

/** Minimum items a feed must contain to be uploaded. */
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
 *   idPattern?: RegExp,
 *   locales: Record<string, LocaleConfig>,
 * }} TargetConfig
 *
 * @typedef {{ enabled: boolean, targets: Record<string, TargetConfig> }} EnvConfig
 */

/**
 * Commission Junction "POST to CJ SFTP" — shared by every environment.
 * - Files must go in the root directory; CJ ignores subdirectories.
 * - The file name must exactly match the CJ feed registration.
 * - CJ's server (Apache SSHD) only offers the legacy `ssh-dss` host key, which
 *   ssh2 doesn't enable by default.
 * - CJ item-level commissioning needs ids of letters, digits, `-` and `_` only.
 */
const CJ_SFTP = {
  provider: 'cj',
  host: 'datatransfer.cj.com',
  port: 22,
  remoteDir: '/',
  algorithms: { serverHostKey: { append: ['ssh-dss'] } },
  idPattern: /^[A-Za-z0-9_-]+$/,
};

/** @type {Record<string, EnvConfig>} */
export const CONFIG = {
  stage: {
    enabled: true,
    targets: {
      cj: {
        ...CJ_SFTP,
        credentials: 'CJ', // CJ_SFTP_USERNAME / CJ_SFTP_PASSWORD
        locales: {
          // CJ test feed "Vitamix_US_Edge_Test" (feed 323567, ad 17374154), test mode
          'us/en_us': { file: 'vitamix_us_edge.xml' },
          // Once a CA test feed is registered (add credentials: 'CJ_CA' if it's
          // a separate CJ account):
          // 'ca/en_us': { file: '<registered file name>.xml' },
        },
      },
    },
  },
  prod: {
    // Off until the live CJ registrations + credentials exist.
    enabled: false,
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
