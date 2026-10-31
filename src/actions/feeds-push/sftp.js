/**
 * SFTP upload for feeds-push.
 *
 * One connection per (host, port, credentials), reused for every locale that
 * shares it. Connection errors are retried; an upload that has started is not.
 */

import SftpClient from 'ssh2-sftp-client';
import { SFTP_READY_TIMEOUT_MS, SFTP_CONNECT_RETRIES } from './config.js';

/**
 * @typedef {{
 *   host: string,
 *   port: number,
 *   username: string,
 *   password: string,
 *   algorithms?: Record<string, unknown>,
 *   hostFingerprints?: string[],
 * }} SftpOptions
 */

/**
 * OpenSSH-style fingerprint of a host key hash.
 * @param {string} hashHex sha256 of the host key, hex (as ssh2 passes it)
 * @returns {string} e.g. "SHA256:gRHI…"
 */
export function fingerprint(hashHex) {
  return `SHA256:${Buffer.from(hashHex, 'hex').toString('base64').replace(/=+$/, '')}`;
}

/**
 * Open an SFTP connection, retrying connection failures.
 * @param {SftpOptions} options
 * @param {{ log: any, createClient?: () => SftpClient, retries?: number }} deps
 * @returns {Promise<SftpClient>}
 */
export async function connect(options, { log, createClient = () => new SftpClient(), retries = SFTP_CONNECT_RETRIES }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const client = createClient();
    /** @type {string | null} host key seen when it didn't match the pin */
    let rejectedKey = null;
    const pins = options.hostFingerprints;
    try {
      await client.connect({
        host: options.host,
        port: options.port,
        username: options.username,
        password: options.password,
        algorithms: options.algorithms,
        readyTimeout: SFTP_READY_TIMEOUT_MS,
        // Pin the server's host key so an impersonating host can't collect the
        // (account-wide) password.
        ...(pins?.length ? {
          hostHash: 'sha256',
          hostVerifier: (/** @type {string} */ hash) => {
            const seen = fingerprint(hash);
            if (pins.includes(seen)) return true;
            rejectedKey = seen;
            return false;
          },
        } : {}),
      });
      return client;
    } catch (err) {
      lastErr = rejectedKey
        ? new Error(`host key mismatch for ${options.host}: got ${rejectedKey}, expected one of ${pins.join(', ')}`)
        : err;
      log.warn(`sftp connect to ${options.host}:${options.port} failed (attempt ${attempt + 1}/${retries + 1}): ${lastErr.message}`);
      try { await client.end(); } catch { /* not connected */ }
    }
  }
  throw lastErr;
}

/** Suffix for the temporary upload name; never matches a registered file. */
export const TEMP_SUFFIX = '.part';

/** @param {unknown} err */
const isUnsupported = (err) => /does not support/i.test(String(err?.message || err));

/**
 * Move `from` to `to`, replacing `to` if it exists.
 * Prefers the atomic posix-rename@openssh.com extension; when the server
 * doesn't offer it, deletes `to` and does a plain SFTPv3 rename (which won't
 * overwrite). The provider just keeps its previous state if that gap is hit.
 * @param {SftpClient} client
 * @param {string} from
 * @param {string} to
 * @returns {Promise<'posix-rename' | 'delete+rename'>}
 */
export async function replace(client, from, to) {
  try {
    await client.posixRename(from, to);
    return 'posix-rename';
  } catch (err) {
    if (!isUnsupported(err)) throw err;
  }
  await client.delete(to, true); // notFoundOK
  await client.rename(from, to);
  return 'delete+rename';
}

/**
 * Upload a string body to `remotePath`, overwriting any existing file.
 *
 * With `atomic`, the body is written to `<remotePath>.part`, its size is
 * verified, and only then renamed to `remotePath`, so the provider never sees
 * a partially written file under the registered name. On failure the temp
 * file is removed (best effort) and the error is rethrown.
 *
 * @param {SftpClient} client
 * @param {string} body
 * @param {string} remotePath
 * @param {{ atomic?: boolean }} [opts]
 * @returns {Promise<{ bytes: number, rename?: 'posix-rename' | 'delete+rename' }>}
 */
export async function upload(client, body, remotePath, { atomic = false } = {}) {
  const buffer = Buffer.from(body, 'utf-8');
  if (!atomic) {
    await client.put(buffer, remotePath);
    return { bytes: buffer.length };
  }

  const tempPath = `${remotePath}${TEMP_SUFFIX}`;
  try {
    await client.put(buffer, tempPath);
    const { size } = await client.stat(tempPath);
    if (size !== buffer.length) {
      throw new Error(`size mismatch after upload: ${tempPath} is ${size} bytes, expected ${buffer.length}`);
    }
    const rename = await replace(client, tempPath, remotePath);
    return { bytes: buffer.length, rename };
  } catch (err) {
    try { await client.delete(tempPath, true); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Close a connection, ignoring errors.
 * @param {SftpClient} client
 */
export async function close(client) {
  try { await client.end(); } catch { /* ignore */ }
}

/**
 * Join a remote directory and file name (POSIX).
 * @param {string} dir e.g. "/" or "/feeds"
 * @param {string} file
 * @returns {string}
 */
export function remotePath(dir, file) {
  return `${dir.replace(/\/+$/, '')}/${file}`;
}
