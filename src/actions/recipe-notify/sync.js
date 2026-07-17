/**
 * Core recipe-notify orchestration.
 *
 * Each scheduled invocation:
 *   0. Prod gate — bail immediately unless RECIPE_NOTIFY_ENABLED === "true"
 *      (skipped for dryRun manual triggers).
 *   1. Acquire a best-effort lock (bails if held).
 *   2. Load the timestamp cursor (`since`).
 *   3. Query the journal since the date portion of the cursor.
 *   4. Keep recipes with dateUpdated strictly > cursor, then Status === "New".
 *   5. Cold start (no cursor): seed the cursor to the batch max WITHOUT emailing,
 *      so we never blast the back-catalogue.
 *   6. If there are new recipes: build the digest (with deep links) and email it.
 *   7. Advance the cursor to the batch max on success (digest sent, or nothing
 *      new). On any failure, leave the cursor unchanged so the window is
 *      re-queried next run.
 */

import { Core } from '@adobe/aio-sdk';
import { getAccessToken } from '../../auth.js';
import { loadState, saveState, acquireLock, releaseLock } from './state.js';
import { fetchRecipes } from './recipes.js';
import { detectNewRecipes } from './detect.js';
import { buildDigest, sendDigest } from './notify.js';

const DEFAULTS = {
  ORG: 'aemsites',
  SITE: 'vitamix',
  LOG_LEVEL: 'info',
  RECIPE_API_URL: 'https://vitamix.calcmenuweb.com/ws/service.asmx/GetUpdatedRecipes',
  RECIPE_API_ID: 'API',
  RECIPE_API_PSWD: 'Vitamix!',
  RECIPE_SITE_BASE: 'https://www.vitamix.com',
  RECIPE_LINK_LOCALE: 'us/en_us',
  RECIPE_DIGEST_TEMPLATE: '/config/recipes/digest-template',
};

/**
 * Merge params with reasonable defaults for any undefined env var.
 * @param {object} params
 * @returns {object}
 */
export function withDefaults(params) {
  const env = { ...params };
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (env[key] === undefined || env[key] === null || env[key] === '') {
      env[key] = value;
    }
  }
  return env;
}

/** Date portion (`YYYY-MM-DD`) of an ISO-ish timestamp, or today if absent. */
function queryDate(since) {
  if (since && since.length >= 10) return since.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/**
 * Run the recipe-notify job.
 * @param {object} params - action params (env vars injected by the Runtime)
 * @param {{ dryRun?: boolean, sinceOverride?: string }} [options]
 * @returns {Promise<{ body: object }>}
 */
export async function run(params, options = {}) {
  const env = withDefaults(params);
  const log = Core.Logger('recipe-notify', { level: env.LOG_LEVEL });
  const { dryRun = false, sinceOverride } = options;

  // ── 0. Prod gate ────────────────────────────────────────────────────
  if (!dryRun && env.RECIPE_NOTIFY_ENABLED !== 'true') {
    log.info('[recipe-notify] Skipping: RECIPE_NOTIFY_ENABLED is not "true" (non-prod).');
    return { body: { skipped: true, reason: 'disabled' } };
  }

  const ctx = { env, log, events: {} };

  const locked = await acquireLock();
  if (!locked) {
    log.info('[recipe-notify] Skipping: another invocation is holding the lock.');
    return { body: { skipped: true, reason: 'locked' } };
  }

  const summary = {
    since: null,
    coldStart: false,
    dryRun,
    changedCount: 0,
    newCount: 0,
    sent: false,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
  };
  const startTime = Date.now();

  try {
    const state = await loadState();
    const since = sinceOverride ?? state.since;
    const coldStart = !since;
    summary.since = since;
    summary.coldStart = coldStart;

    // ── 3. Fetch journal ──────────────────────────────────────────────
    const recipes = await fetchRecipes(ctx, queryDate(since));

    // ── 4. Detect ─────────────────────────────────────────────────────
    const { changed, newRecipes, maxUpdated } = detectNewRecipes(recipes, since);
    summary.changedCount = changed.length;
    summary.newCount = newRecipes.length;
    log.info(`[recipe-notify] ${changed.length} changed since cursor, ${newRecipes.length} new`);

    // ── 5. Cold start — seed cursor, do not email ─────────────────────
    if (coldStart) {
      log.info(`[recipe-notify] Cold start — seeding cursor to ${maxUpdated ?? '(unchanged)'} without emailing.`);
      if (!dryRun) {
        await saveState({ since: maxUpdated, lastRun: new Date().toISOString(), status: 'idle', lastError: null });
      }
      summary.newCursor = maxUpdated;
      return { body: summary };
    }

    // ── 6. Notify ─────────────────────────────────────────────────────
    if (newRecipes.length > 0) {
      const { recipes: linked, html } = await buildDigest(ctx, newRecipes);
      summary.newRecipes = linked.map((r) => ({
        code: r.code, number: r.number, name: r.name, dateUpdated: r.dateUpdated, url: r.url,
      }));

      if (dryRun) {
        log.info('[recipe-notify] dryRun — not sending, not advancing cursor.');
        return { body: summary };
      }

      // Mint the IMS token only when we actually need DA (to read the template).
      ctx.events.token = await getAccessToken(env.AIO_CLIENTID, env.AIO_CLIENTSECRET, env.AIO_SCOPES);
      const { toEmail, subject } = await sendDigest(ctx, newRecipes, html);
      summary.sent = true;
      summary.toEmail = toEmail;
      summary.subject = subject;
      log.info(`[recipe-notify] Sent digest for ${newRecipes.length} new recipes to ${JSON.stringify(toEmail)}`);
    } else {
      log.info('[recipe-notify] No new recipes — no email (no heartbeat).');
      if (dryRun) return { body: summary };
    }

    // ── 7. Advance cursor (success path) ──────────────────────────────
    await saveState({
      since: maxUpdated,
      lastRun: new Date().toISOString(),
      processedCount: (state.processedCount || 0) + newRecipes.length,
      status: 'idle',
      lastError: null,
    });
    summary.newCursor = maxUpdated;
  } catch (err) {
    const message = err?.stack || String(err);
    log.error(`[recipe-notify] Run failed — cursor not advanced.\n${message}`);
    summary.error = err.message;
    if (!dryRun) {
      await saveState({ status: 'error', lastError: message, lastRun: new Date().toISOString() }).catch(() => {});
    }
  } finally {
    await releaseLock();
    summary.elapsedMs = Date.now() - startTime;
  }

  return { body: summary };
}
