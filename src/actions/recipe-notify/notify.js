/**
 * Digest rendering and delivery.
 *
 * Renders the new recipes as an HTML table, injects it into the DA digest
 * template's `{{digest}}` placeholder, and sends via the shared email service.
 * Recipients and subject come from the template (`/config/recipes/digest-template`).
 */

import { resolveDigestTemplate, sendEmail } from '../../emails.js';
import { resolveLinks } from './links.js';

/** Raised when the digest template document is missing, so the run can skip the send without advancing the cursor. */
export class TemplateMissingError extends Error {
  constructor(path) {
    super(`digest template not found at ${path}`);
    this.name = 'TemplateMissingError';
    this.templatePath = path;
  }
}

/**
 * Escape a string for safe inclusion in HTML.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format an API date (`2026-07-17T04:10:00`) as `YYYY-MM-DD`, or '' if
 * unparseable. Uses the literal date portion to avoid timezone drift (the API
 * timestamps carry no zone, so a UTC conversion could shift the displayed day).
 * @param {string | null} value
 * @returns {string}
 */
function formatDate(value) {
  if (!value) return '';
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(value);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}

// Inline styles — email clients don't reliably support <style>/CSS classes.
const TABLE_STYLE = 'border-collapse:separate;border-spacing:0;width:100%;max-width:720px;'
  + 'font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;';
const TH_STYLE = 'text-align:left;padding:10px 18px;border-bottom:2px solid #e0e0e0;'
  + 'font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#777;';
const TD_STYLE = 'padding:14px 18px;border-bottom:1px solid #eee;vertical-align:top;';
const THUMB_STYLE = 'display:block;width:96px;height:96px;object-fit:cover;border-radius:8px;background:#f4f4f4;';
const NAME_STYLE = 'color:#0a5c36;text-decoration:none;font-weight:bold;font-size:15px;';
const MUTED_STYLE = 'color:#888;';

/**
 * Render the new recipes as a styled HTML table (one row each), including a
 * thumbnail image. `Name` is linked when a deep link was resolved.
 * @param {(import('./recipes.js').Recipe & { url?: string | null, image?: string | null })[]} recipes
 * @returns {string}
 */
export function renderDigestTable(recipes) {
  const rows = recipes.map((r) => {
    const thumb = r.image
      ? `<img src="${escapeHtml(r.image)}" alt="${escapeHtml(r.name)}" width="96" height="96" style="${THUMB_STYLE}">`
      : `<div style="${THUMB_STYLE}"></div>`;
    const name = r.url
      ? `<a href="${escapeHtml(r.url)}" style="${NAME_STYLE}">${escapeHtml(r.name)}</a>`
      : `<span style="${NAME_STYLE}">${escapeHtml(r.name)}</span>`;
    const meta = `<div style="margin-top:4px;${MUTED_STYLE}">${escapeHtml(r.number)} &middot; #${escapeHtml(r.code)}</div>`;
    return '<tr>'
      + `<td style="${TD_STYLE}width:96px;">${thumb}</td>`
      + `<td style="${TD_STYLE}">${name}${meta}</td>`
      + `<td style="${TD_STYLE}white-space:nowrap;">${formatDate(r.dateCreated)}</td>`
      + `<td style="${TD_STYLE}">${escapeHtml(r.brands.join(', '))}</td>`
      + '</tr>';
  });
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="${TABLE_STYLE}">`
    + `<thead><tr>`
    + `<th style="${TH_STYLE}"></th>`
    + `<th style="${TH_STYLE}">Recipe</th>`
    + `<th style="${TH_STYLE}">Created</th>`
    + `<th style="${TH_STYLE}">Brands</th>`
    + `</tr></thead>`
    + `<tbody>${rows.join('')}</tbody>`
    + '</table>';
}

/**
 * Resolve deep links + render the digest table for a set of new recipes.
 * @param {Context} ctx
 * @param {import('./recipes.js').Recipe[]} recipes
 * @returns {Promise<{ recipes: (import('./recipes.js').Recipe & { url: string | null })[], html: string }>}
 */
export async function buildDigest(ctx, recipes) {
  const withLinks = await resolveLinks(ctx, recipes);
  return { recipes: withLinks, html: renderDigestTable(withLinks) };
}

/**
 * Build and send the digest email.
 * @param {Context} ctx
 * @param {import('./recipes.js').Recipe[]} recipes - new recipes (non-empty)
 * @param {string} digestHtml - pre-rendered table from buildDigest
 * @returns {Promise<{ toEmail: string | string[], subject: string }>}
 */
export async function sendDigest(ctx, recipes, digestHtml) {
  const templatePath = ctx.env.RECIPE_DIGEST_TEMPLATE;
  const today = new Date().toISOString().slice(0, 10);

  const email = await resolveDigestTemplate(ctx, templatePath, digestHtml, {
    count: String(recipes.length),
    date: today,
  });
  if (!email) {
    throw new TemplateMissingError(templatePath);
  }

  const subject = email.subject || `New Vitamix recipes — ${today} (${recipes.length} new)`;
  await sendEmail(ctx, email.toEmail, subject, email.html, email.cc, email.bcc);
  return { toEmail: email.toEmail, subject };
}
