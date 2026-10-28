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
 * }} SftpOptions
 */

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
    try {
      await client.connect({
        host: options.host,
        port: options.port,
        username: options.username,
        password: options.password,
        algorithms: options.algorithms,
        readyTimeout: SFTP_READY_TIMEOUT_MS,
      });
      return client;
    } catch (err) {
      lastErr = err;
      log.warn(`sftp connect to ${options.host}:${options.port} failed (attempt ${attempt + 1}/${retries + 1}): ${err.message}`);
      try { await client.end(); } catch { /* not connected */ }
    }
  }
  throw lastErr;
}

/**
 * Upload a string body to `remotePath`, overwriting any existing file.
 * @param {SftpClient} client
 * @param {string} body
 * @param {string} remotePath
 * @returns {Promise<number>} bytes uploaded
 */
export async function upload(client, body, remotePath) {
  const buffer = Buffer.from(body, 'utf-8');
  await client.put(buffer, remotePath);
  return buffer.length;
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
