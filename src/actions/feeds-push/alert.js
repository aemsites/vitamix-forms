/**
 * Failure alert email for feeds-push. One email per run, only when something
 * failed, to the comma-separated ALERT_FEED_FAIL_EMAILS secret. When that's
 * unset, failures are only logged.
 *
 * The HTML is built inline (no DA template) so alerts don't depend on DA.
 */

import { sendEmail } from '../../emails.js';

/**
 * @param {unknown} value ALERT_FEED_FAIL_EMAILS
 * @returns {string[]}
 */
export function parseRecipients(value) {
  if (typeof value !== 'string' || value === '$ALERT_FEED_FAIL_EMAILS') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** @param {unknown} s */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

/**
 * @param {string} environment
 * @param {import('./run.js').PushResult[]} results
 * @returns {{ subject: string, html: string }}
 */
export function buildAlert(environment, results) {
  const failed = results.filter((r) => r.status === 'failed');
  const what = failed.map((r) => `${r.target} ${r.locale}`).join(', ');
  const subject = `[${environment}] Feed push failed: ${what}`;

  const rows = results.map((r) => `<tr>
  <td>${esc(r.target)}</td><td>${esc(r.locale)}</td><td>${esc(r.file)}</td>
  <td>${esc(r.status)}${r.step ? ` (${esc(r.step)})` : ''}</td>
  <td>${esc(r.itemCount ?? '')}</td><td>${esc(r.error ?? '')}</td>
</tr>`).join('\n');

  const html = `<p>The scheduled product feed push in <b>${esc(environment)}</b> had failures.
The provider keeps its previous file for each failed feed.</p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>Target</th><th>Locale</th><th>File</th><th>Status</th><th>Items</th><th>Error</th></tr>
${rows}
</table>
<p>Re-run manually: <code>aio rt action invoke feeds/feeds-push --result</code>
(add <code>-p force true</code> to bypass the shrink guard).</p>`;

  return { subject, html };
}

/**
 * Send the alert if recipients are configured. Never throws.
 * @param {{ env: Record<string, any>, log: any }} ctx
 * @param {string} environment
 * @param {import('./run.js').PushResult[]} results
 * @returns {Promise<'sent' | 'no-recipients' | 'send-failed'>}
 */
export async function sendFailureAlert(ctx, environment, results) {
  const recipients = parseRecipients(ctx.env.ALERT_FEED_FAIL_EMAILS);
  if (!recipients.length) {
    ctx.log.warn('ALERT_FEED_FAIL_EMAILS not set; failure logged only');
    return 'no-recipients';
  }
  const { subject, html } = buildAlert(environment, results);
  try {
    await sendEmail(ctx, recipients, subject, html);
    return 'sent';
  } catch (err) {
    ctx.log.error(`failed to send feed push alert: ${err.message}`);
    return 'send-failed';
  }
}
