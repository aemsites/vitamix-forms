import SftpClient from 'ssh2-sftp-client';

/** @param {Record<string, any>} params @param {string} name */
const required = (params, name) => {
  const value = String(params[name] || '').trim();
  if (!value) throw new Error(`Missing required SFTP setting: ${name}`);
  return value;
};

/**
 * Validate SFTP runtime settings and build the remote target path.
 * Private key material is supplied base64-encoded to support multiline keys.
 * @param {Record<string, any>} params
 */
export function getSftpConfig(params) {
  const host = required(params, 'OPENAI_SFTP_HOST');
  const username = required(params, 'OPENAI_SFTP_USERNAME');
  const directory = required(params, 'OPENAI_SFTP_DIRECTORY').replace(/\\/g, '/');
  const filename = String(params.OPENAI_SFTP_FILENAME || 'vitamix-products-feed-gpt.csv.gz').trim();
  if (!filename || filename.includes('/') || filename.includes('\\')) {
    throw new Error('OPENAI_SFTP_FILENAME must be a filename, not a path');
  }

  const password = String(params.OPENAI_SFTP_PASSWORD || '');
  if (!password) {
    throw new Error('Configure OPENAI_SFTP_PASSWORD');
  }

  const directoryPath = directory === '/' ? '' : directory.replace(/\/+$/, '');
  const remotePath = `${directoryPath}/${filename}`;
  const port = Number(params.OPENAI_SFTP_PORT || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('OPENAI_SFTP_PORT must be a valid TCP port');
  }

  /** @type {Record<string, any>} */
  const connection = {
    host,
    port,
    username,
    readyTimeout: 30000,
  };
  connection.password = password;
  return { connection, remotePath, filename };
}

/**
 * Validate upload inputs before opening a network connection.
 * @param {Record<string, any>} connection
 * @param {string} remotePath
 * @param {Buffer} contents
 */
function validateUpload(connection, remotePath, contents) {
  if (!connection || typeof connection !== 'object') {
    throw new TypeError('SFTP connection settings must be an object');
  }
  if (!String(connection.host || '').trim()) throw new Error('SFTP host is required');
  if (!String(connection.username || '').trim()) throw new Error('SFTP username is required');
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) {
    throw new Error('SFTP port must be a valid TCP port');
  }
  if (!connection.password) {
    throw new Error('SFTP password is required');
  }
  if (!remotePath.startsWith('/') || remotePath.includes('\0')
    || remotePath.split('/').includes('..')) {
    throw new Error('SFTP remote path must be an absolute path without traversal segments');
  }
  if (!Buffer.isBuffer(contents) || contents.length === 0) {
    throw new Error('SFTP upload contents must be a non-empty Buffer');
  }
}

/**
 * Wrap transport errors without losing their SSH error code or original cause.
 * @param {string} operation
 * @param {any} cause
 * @returns {Error & { code?: string }}
 */
function sftpOperationError(operation, cause) {
  const message = String(cause?.message || cause || 'unknown error');
  const error = /** @type {Error & { code?: string, cause?: any }} */ (
    new Error(`SFTP ${operation} failed: ${message}`)
  );
  error.cause = cause;
  if (cause?.code) error.code = cause.code;
  return error;
}

/**
 * Upload a complete snapshot to the stable OpenAI SFTP path.
 * @param {Record<string, any>} connection
 * @param {string} remotePath
 * @param {Buffer} contents
 * @param {{ createClient?: () => any }} [dependencies] test seam
 */
export async function uploadSftpSnapshot(
  connection,
  remotePath,
  contents,
  { createClient = () => new SftpClient() } = {},
) {
  /** @type {any} */
  let client;
  /** @type {Error & { code?: string } | undefined} */
  let operationError;
  try {
    validateUpload(connection, remotePath, contents);
    client = createClient();
    if (!client || typeof client.connect !== 'function'
      || typeof client.put !== 'function' || typeof client.end !== 'function') {
      throw new TypeError('SFTP client must provide connect(), put(), and end() methods');
    }
    try {
      await client.connect(connection);
    } catch (err) {
      throw sftpOperationError('connection', err);
    }
    try {
      await client.put(contents, remotePath);
    } catch (err) {
      throw sftpOperationError('upload', err);
    }
  } catch (err) {
    operationError = err instanceof Error ? err : sftpOperationError('operation', err);
  }

  if (client && typeof client.end === 'function') {
    try {
      await client.end();
    } catch (err) {
      // A cleanup error must not hide a more useful connection/upload error.
      if (!operationError) operationError = sftpOperationError('disconnect', err);
    }
  }

  if (operationError) throw operationError;
}
