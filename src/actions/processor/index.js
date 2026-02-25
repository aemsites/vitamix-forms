import { listFolder, fetchSheet, updateSheet } from '../../sheets.js';
import { errorResponse } from '../../utils.js';
import makeContext from '../../context.js';

/** @returns {SingleSheet} */
const INITIAL_SHEET = () => {
  return {
    ":private": {
      "private-data": {
        "total": 0,
        "limit": 0,
        "offset": 0,
        "data": []
      }
    }
  }
}

/**
 * Appends record to sheet
 * 
 * @param {Sheet} sheet 
 * @param {SheetRecord} record 
 * @param {string} [sheetName = 'private-data']
 * @returns {number} new total count of records in sheet
 */
function appendToSheet(sheet, record, sheetName = 'private-data') {
  let newCount = 0;
  if (sheetName.startsWith('private-')) {
    sheet[':private'][sheetName].data.push(record);
    newCount = sheet[':private'][sheetName].total + 1;
  } else if (sheet[':type'] === 'multi-sheet') {
    if (!sheet[sheetName]) {
      sheet[sheetName] = {
        "total": 0,
        "limit": 0,
        "offset": 0,
        "data": []
      }
    }
    sheet[sheetName].data.push(record);
    newCount = sheet[sheetName].total + 1;
  } else {
    if (!sheet.data) {
      sheet.data = [];
    }
    sheet.data.push(record);
    newCount = sheet.total + 1;
  }
  return newCount;
}

/**
 * Event-triggered action: receives a `form.submitted` event,
 * reads the destination sheet, appends the submission, and writes it back.
 * @param {Object} params
 */
export async function main(params) {
  try {
    const ctx = await makeContext(params);
    const { log } = ctx;

    const { formId, data } = /** @type {any} */ (ctx.data.data ?? ctx.data);
    if (!formId || !data || typeof data !== 'object') {
      return errorResponse(400, 'invalid event payload');
    }

    // check if folder exists for formId
    let folderPath = `/incoming/${formId}`;
    const entries = await listFolder(ctx, folderPath); // list API should return empty array if folder doesn't exist
    if (entries.length === 0) {
      // if no entries exist, assume the form is invalid, write to deadletter
      folderPath = `/incoming/deadletter/${formId}`;
    }

    // sheets are named by year
    const year = new Date().getFullYear();
    const sheetPath = `${folderPath}/${year}.json`;
    log.info(`processing submission for formId=${formId} to sheet=${sheetPath}`);

    // if entries contains the destination sheet, append to it, otherwise create a new sheet
    const sheetExists = !!entries.find((entry) => entry.path === `/${ctx.env.ORG}/${ctx.env.SITE}${sheetPath}`);

    /** @type {Sheet} */
    let sheet;
    if (sheetExists) {
      sheet = await fetchSheet(ctx, sheetPath);
    } else {
      sheet = INITIAL_SHEET();
    }
    const record = {
      timestamp: new Date().toISOString(),
      ...data,
    };
    const newCount = appendToSheet(sheet, record);
    await updateSheet(ctx, sheetPath, sheet);
    log.info(sheetExists ? `appended 1 record to sheet: ${sheetPath} (total=${newCount})` : `created new sheet: ${sheetPath} (total=${newCount})`);

    return { statusCode: 200 };
  } catch (error) {
    if (error.response) return error.response;
    console.error('fatal error: ', error);
    return errorResponse(500, 'server error');
  }
}
