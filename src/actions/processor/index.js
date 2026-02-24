import { fetchSheet, updateSheet } from '../../sheets.js';
import { errorResponse } from '../../utils.js';
import makeContext from '../../context.js';

/**
 * Event-triggered action: receives a `form.grouped` event,
 * reads the destination sheet, appends submissions, and writes it back.
 * @param {Object} params
 */
export async function main(params) {
  try {
    const ctx = await makeContext(params);
    const { log } = ctx;

    const { formId, submissions } = /** @type {any} */ (ctx.data.data ?? ctx.data);
    if (!formId || !Array.isArray(submissions)) {
      return errorResponse(400, 'invalid event payload');
    }

    const sheetPath = ctx.env.SHEET;
    log.info(`processing ${submissions.length} submissions for formId=${formId}`);

    const sheet = await fetchSheet(ctx, sheetPath);
    const now = new Date().toISOString();
    const records = submissions.map((s) => ({
      ...s,
      formId,
      timestamp: s.timestamp || now,
    }));

    sheet.data.push(...records);
    await updateSheet(ctx, sheetPath, sheet);
    log.info(`appended ${records.length} records to sheet: ${sheetPath}`);

    return { statusCode: 200 };
  } catch (error) {
    if (error.response) return error.response;
    console.error('fatal error: ', error);
    return errorResponse(500, 'server error');
  }
}
