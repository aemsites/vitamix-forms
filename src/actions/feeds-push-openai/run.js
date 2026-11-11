import { gzipSync } from 'node:zlib';
import { Core } from '@adobe/aio-sdk';
import { errorInfo } from '../../utils.js';
import { fetchGmcFeed } from '../feeds/source.js';
import { prepareFeed } from '../feeds/prepare.js';
import { PROVIDERS } from '../feeds/providers/index.js';
import { getSftpConfig, uploadSftpSnapshot } from './sftp.js';

const DEFAULT_FEED_SITE_BASE = 'https://www.vitamix.com';
const OPENAI_LOCALE = 'us/en_us';

/** Convert an SFTP failure into an actionable, non-secret-bearing log message. */
/** @param {any} err */
export function sftpErrorMessage(err) {
  const code = err?.code;
  const message = String(err?.message || err);

  if (code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return 'Network Layer Error: Cannot reach OpenAI SFTP server. Check your firewall rules or network configuration.';
  }
  if (message.includes('Authentication failed')) {
    return 'Network Layer Error: SSH/SFTP authentication failed. Validate your password or private keys.';
  }
  if (code === 'ERR_BAD_PATH' || message.includes('No such file')) {
    return 'Network Layer Error: Directory structure unexpected. Ensure you target the root path correctly.';
  }
  return `Network Layer Error: ${message}`;
}

/**
 * Build and push a complete OpenAI product-feed snapshot.
 *
 * @param {Record<string, any>} params Adobe I/O Runtime action inputs
 * @param {{ upload?: (connection: Record<string, any>, remotePath: string, contents: Buffer) => Promise<void> }} [dependencies] test seam
 * @returns {Promise<{ body: object }>}
 */
export async function run(params, { upload = uploadSftpSnapshot } = {}) {
  const log = Core.Logger('openai-feed-push', { level: params.LOG_LEVEL || 'info' });
  const startedAt = new Date().toISOString();
  let phase = 'feed generation';
    log.info('[openai-feed-push] test begins');
    
  try {
    if (params.OPENAI_FEED_PUSH_ENABLED !== 'true') {
      log.info('[openai-feed-push] Skipping: OPENAI_FEED_PUSH_ENABLED is not "true"');
      return { body: { skipped: true, reason: 'disabled' } };
    }

    // Validate credentials before fetching/building the catalog.
    const { connection, remotePath, filename } = getSftpConfig(params);
    const provider = PROVIDERS.openai;
    const ctx = /** @type {any} */ ({
      env: {
        FEED_SITE_BASE: params.FEED_SITE_BASE || DEFAULT_FEED_SITE_BASE,
        FEED_CONTENT_BASE: params.FEED_CONTENT_BASE,
      },
      log: /** @type {any} */ (log),
    });

    const source = await fetchGmcFeed(ctx, provider.locale || OPENAI_LOCALE);
    const feed = await prepareFeed(ctx, source, provider.locale || OPENAI_LOCALE);
    if (!feed.items.length) {
      throw new Error('Refusing to upload an empty OpenAI product feed');
    }
    const csv = await provider.build(ctx, feed);
    // The provider adds a BOM for spreadsheet compatibility; strip it from the
    // machine-ingested snapshot so the first CSV header remains exactly item_id.
    const csvWithoutBom = csv.replace(/^\uFEFF/, '');
    const compressed = gzipSync(Buffer.from(csvWithoutBom, 'utf8'));
    phase = 'SFTP upload';
    await upload(connection, remotePath, compressed);

    const result = {
      uploaded: true,
      filename,
      itemCount: feed.items.length,
      compressedBytes: compressed.length,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    log.info(`[openai-feed-push] Uploaded ${feed.items.length} products to ${filename} (${compressed.length} bytes)`);
    return { body: result };
  } catch (err) {
    if (phase === 'SFTP upload') {
      log.error(sftpErrorMessage(err), errorInfo(err));
    } else {
      log.error('[openai-feed-push] Feed generation failed', errorInfo(err));
    }
    throw err;
  }
}
