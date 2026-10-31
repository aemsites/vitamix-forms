/**
 * Core inventory-sync orchestration (prod only).
 *
 * Each run:
 *   1. Bail unless INVENTORY_SYNC_ENABLED is "true" (dryRun bypasses this and writes nothing).
 *   2. Acquire the lock. Load cursor and head.
 *   3. Read outbox entries cursor+1..head and merge deltas by (sku, market).
 *      Missing entries are logged and skipped.
 *   4. Read the inventory sheet from the DA source (IMS token) with its ETag.
 *      If there are deltas: apply them to Qty/Availability and PUT the source
 *      with If-Match; on 412 re-read and re-apply (an author edited it).
 *   5. Advance the cursor to the last read seq, then delete applied entries.
 *      Preview is triggered only after this (best effort), so a slow or hung
 *      preview never sits inside the sheet-PUT → cursor crash window.
 *   6. Product check (every run): for managed rows with Qty <= 0 and
 *      OutOfStock, flip matching managed products to OutOfStock via
 *      index lookup + GET/If-Match PUT.
 *   7. Send ops-log events (404 = not supported yet, non-error).
 *   8. Save status, release the lock.
 */

import { Core } from '@adobe/aio-sdk';
import { getAccessToken } from '../../auth.js';
import { errorInfo } from '../../utils.js';
import {
  loadState, saveState, acquireLock, releaseLock,
  getCursor, setCursor, getHead, getOutboxEntry, deleteOutboxEntry,
} from './state.js';
import {
  SHEET_PATH, applyDeltas, mergeDeltas, soldOutRows, localesForMarket,
} from './sheet.js';
import { fetchIndex, findCandidates, updateProductAvailability } from './catalog.js';
import { sendOpsEvent } from './opslog.js';
import { triggerPreview } from './preview.js';
import { fetchSourceSheet, putSourceSheet } from './source.js';

/** Cap on outbox entries applied per run; the rest is picked up next run. */
export const MAX_ENTRIES_PER_RUN = 200;

/** Sheet read-apply-write attempts when the conditional PUT gets 412. */
export const MAX_SHEET_ATTEMPTS = 4;

const DEFAULTS = {
  ORG: 'aemsites',
  SITE: 'vitamix',
  LOG_LEVEL: 'info',
  EDGE_COMMERCE_API_BASE: 'https://api.adobecommerce.live',
};

/** @param {object} params */
export function withDefaults(params) {
  const env = { ...params };
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (env[key] === undefined || env[key] === null || env[key] === '') env[key] = value;
  }
  return env;
}

/** @param {object} params */
export function isEnabled(params) {
  return String(params?.INVENTORY_SYNC_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/**
 * Run the inventory sync.
 * @param {object} params - action params (env vars injected by the Runtime)
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<{ body: object }>}
 */
export async function run(params, { dryRun = false } = {}) {
  const env = withDefaults(params);
  const log = Core.Logger('inventory-sync', { level: env.LOG_LEVEL });

  // ── 1. Prod gate ──────────────────────────────────────────────────
  if (!dryRun && !isEnabled(env)) {
    log.info('[inventory-sync] Skipping: INVENTORY_SYNC_ENABLED is not "true" (non-prod).');
    return { body: { skipped: true, reason: 'disabled' } };
  }

  /** @type {{ env: object, log: object, events: { token?: string } }} */
  const ctx = { env, log, events: {} };
  const startTime = Date.now();

  // dryRun performs zero writes, including the lock.
  if (!dryRun) {
    const locked = await acquireLock();
    if (!locked) {
      log.info('[inventory-sync] Skipping: another invocation is holding the lock.');
      return { body: { skipped: true, reason: 'locked' } };
    }
  }

  const summary = {
    dryRun,
    cursor: 0,
    head: 0,
    appliedSeqs: [],
    missingSeqs: [],
    deltas: [],
    sheetChanges: [],
    sheetSkipped: [],
    sheetWritten: false,
    sheetAttempts: 0,
    previewed: false,
    products: [],
    events: [],
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
  };

  try {
    // ── 2. Cursor / head ────────────────────────────────────────────
    const cursor = await getCursor();
    const head = await getHead();
    summary.cursor = cursor;
    summary.head = head;
    const lastSeq = Math.min(head, cursor + MAX_ENTRIES_PER_RUN);

    // ── 3. Read outbox entries ──────────────────────────────────────
    const entries = [];
    for (let seq = cursor + 1; seq <= lastSeq; seq++) {
      const entry = await getOutboxEntry(seq);
      if (entry) {
        entries.push({ ...entry, seq });
      } else {
        summary.missingSeqs.push(seq);
        log.warn(`[inventory-sync] Outbox entry ${seq} missing \u2014 skipping.`);
      }
    }
    const deltas = mergeDeltas(entries);
    summary.deltas = deltas;
    if (lastSeq > cursor) {
      log.info(`[inventory-sync] Outbox ${cursor + 1}..${lastSeq} (head=${head}): ${entries.length} entries, ${deltas.length} merged deltas`);
    }

    // ── 4. Sheet (DA source, never aem.page) ────────────────────────
    ctx.events.token = await getAccessToken(env.AIO_CLIENTID, env.AIO_CLIENTSECRET, env.AIO_SCOPES);
    const sheet = await readApplyWrite(ctx, deltas, summary, { dryRun });
    const { oversold, outOfStock } = summary.sheetResult;
    delete summary.sheetResult;

    // ── 5. Advance cursor, delete applied entries ───────────────────
    // Done immediately after the sheet PUT to keep the accepted crash window
    // (PUT done, cursor not advanced → re-apply) as short as possible.
    if (lastSeq > cursor && !dryRun) {
      await setCursor(lastSeq);
      for (const entry of entries) {
        await deleteOutboxEntry(entry.seq).catch((err) => {
          log.warn(`[inventory-sync] Failed to delete outbox entry ${entry.seq}`, errorInfo(err));
        });
      }
    }
    summary.appliedSeqs = entries.map((e) => e.seq);

    // Best effort, after the cursor: authors work from the DA source anyway.
    if (summary.sheetWritten) summary.previewed = await triggerPreview(ctx, SHEET_PATH);

    // ── 6. Product check (every run) ────────────────────────────────
    summary.products = await productCheck(ctx, sheet, { dryRun });

    // ── 7. Ops-log events ───────────────────────────────────────────
    const flippedPaths = new Map(); // SKU → { paths, locales }
    for (const p of summary.products) {
      if (!['updated', 'planned'].includes(p.status)) continue;
      for (const r of p.results.filter((x) => x.status === 'flip')) {
        const key = r.sku.toUpperCase();
        if (!flippedPaths.has(key)) flippedPaths.set(key, []);
        flippedPaths.get(key).push(p.path);
      }
    }
    const events = [
      ...oversold,
      ...outOfStock.map((e) => ({
        ...e,
        locales: localesForMarket(e.market),
        paths: flippedPaths.get(e.sku.toUpperCase()) || [],
      })),
    ];
    for (const event of events) {
      const result = dryRun ? 'dryRun' : await sendOpsEvent(ctx, event);
      summary.events.push({ ...event, result });
    }

    // ── 8. Status ───────────────────────────────────────────────────
    if (!dryRun) {
      const prev = await loadState();
      await saveState({
        lastRun: new Date().toISOString(),
        status: 'idle',
        lastError: null,
        lastAppliedSeq: lastSeq > cursor ? lastSeq : prev.lastAppliedSeq,
        appliedEntries: prev.appliedEntries + entries.length,
        sheetUpdates: prev.sheetUpdates + (summary.sheetWritten ? 1 : 0),
        productsUpdated: prev.productsUpdated + summary.products.filter((p) => p.status === 'updated').length,
        oversoldEvents: prev.oversoldEvents + oversold.length,
        outOfStockEvents: prev.outOfStockEvents + outOfStock.length,
      });
    }
  } catch (err) {
    log.error('[inventory-sync] Run failed.', errorInfo(err));
    summary.error = err.message;
    if (!dryRun) {
      await saveState({
        status: 'error',
        lastError: err?.stack || String(err),
        lastRun: new Date().toISOString(),
      }).catch(() => {});
    }
  } finally {
    if (!dryRun) await releaseLock().catch(() => {});
    summary.elapsedMs = Date.now() - startTime;
  }

  return { body: summary };
}

/**
 * Read the sheet (with ETag), apply deltas, and write it back with If-Match.
 * On 412 (an author changed the sheet since our read) re-read and re-apply,
 * so their edit is kept and our decrement is applied on top of it.
 * Sets `summary.sheetChanges/sheetSkipped/sheetWritten/sheetAttempts` and
 * `summary.sheetResult` (events). Returns the sheet as written (or as planned
 * in dryRun), which drives the product check.
 */
async function readApplyWrite(ctx, deltas, summary, { dryRun }) {
  const { log } = ctx;
  for (let attempt = 1; attempt <= MAX_SHEET_ATTEMPTS; attempt++) {
    summary.sheetAttempts = attempt;
    const { sheet, etag } = await fetchSourceSheet(ctx, SHEET_PATH);
    if (!deltas.length) {
      summary.sheetResult = { oversold: [], outOfStock: [] };
      return sheet;
    }

    const result = applyDeltas(sheet, deltas);
    summary.sheetChanges = result.changes;
    summary.sheetSkipped = result.skipped;
    summary.sheetResult = { oversold: result.oversold, outOfStock: result.outOfStock };

    for (const c of result.changes) {
      log.info(`[inventory-sync] ${dryRun ? '[dryRun] ' : ''}sheet ${c.sku} market=${c.market || '(blank)'}: Qty ${c.before} \u2192 ${c.after} (sold ${c.sold})${c.availabilityChanged ? ', Availability \u2192 OutOfStock' : ''}; seqs=${c.seqs.join(',')} orders=${c.orderIds.join(',')}`);
    }
    for (const sk of result.skipped) {
      log.info(`[inventory-sync] sheet skip ${sk.sku} market=${sk.market || '(blank)'} units=${sk.units}: ${sk.reason}`);
    }

    if (!result.changes.length || dryRun) return sheet;
    if (!etag) throw new Error('DA source GET returned no ETag; refusing unconditional sheet write');

    if (await putSourceSheet(ctx, SHEET_PATH, sheet, etag) === 'ok') {
      summary.sheetWritten = true;
      return sheet;
    }
    log.info(`[inventory-sync] Sheet changed since read (412, attempt ${attempt}/${MAX_SHEET_ATTEMPTS}); re-reading`);
  }
  throw new Error(`inventory sheet kept changing (412 x${MAX_SHEET_ATTEMPTS}); will retry next run`);
}

/**
 * Flip matching managed products for every sold-out managed sheet row.
 * Each locale index is fetched at most once; each product at most once.
 * Per-product failures are logged and never fail the run.
 *
 * @param {{ env: object, log: object }} ctx
 * @param {object} sheet
 * @param {{ dryRun: boolean }} options
 */
async function productCheck(ctx, sheet, { dryRun }) {
  const { log } = ctx;
  const rows = soldOutRows(sheet);
  if (!rows.length) return [];

  /** @type {Map<string, Promise<object | null>>} */
  const indexes = new Map();
  const getIndex = (locale) => {
    if (!indexes.has(locale)) {
      indexes.set(locale, fetchIndex(ctx, locale).catch((err) => {
        log.warn(`[inventory-sync] Could not fetch product index for ${locale}`, errorInfo(err));
        return null;
      }));
    }
    return indexes.get(locale);
  };

  /** @type {Map<string, Set<string>>} path → SKUs */
  const targets = new Map();
  for (const row of rows) {
    for (const locale of row.locales) {
      const index = await getIndex(locale);
      if (!index) continue;
      const { matched, candidates } = findCandidates(index, row.sku, locale);
      if (!matched) {
        log.warn(`[inventory-sync] Managed sheet SKU ${row.sku} has no index row in ${locale}`);
      }
      for (const c of candidates) {
        if (!targets.has(c.path)) targets.set(c.path, new Set());
        targets.get(c.path).add(row.sku);
      }
    }
  }

  const results = [];
  for (const [path, skus] of targets) {
    try {
      const res = await updateProductAvailability(ctx, path, [...skus], { dryRun });
      results.push(res);
      for (const r of res.results) {
        if (r.status === 'flip') {
          log.info(`[inventory-sync] ${dryRun ? '[dryRun] would set' : 'set'} ${path} ${r.sku} availability \u2192 OutOfStock`);
        } else {
          log.info(`[inventory-sync] product ${path} ${r.sku} skipped: ${r.reason}`);
        }
      }
      if (res.status === 'conflict') {
        log.warn(`[inventory-sync] ${path}: gave up after repeated 412s; will retry next run`);
      } else if (res.status === 'not-found') {
        log.warn(`[inventory-sync] ${path}: catalog product not found`);
      }
    } catch (err) {
      log.warn(`[inventory-sync] Product update failed for ${path}`, errorInfo(err));
      results.push({
        path, status: 'error', error: err.message, results: [],
      });
    }
  }
  return results;
}
