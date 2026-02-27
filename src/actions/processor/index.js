import { listFolder, fetchSheet, updateSheet } from '../../da.js';
import { errorResponse } from '../../utils.js';
import makeContext from '../../context.js';
import { resolveEmailTemplate, sendEmail } from '../../emails.js';

/**
 * @returns {SingleSheet} 
 */
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
 * Order record keys by header row keys
 * The order of the header row keys in the header row is the order of the keys in the record
 * But timestamp and IP are always first and second
 * 
 * If any keys don't exist in the header row, they are added to the end of the record
 * If headerRow is undefined, the record provided is used as the header row
 * If headerRow is provided, it is mutated in place
 * 
 * @param {Context} ctx
 * @param {Record<string, string>} record 
 * @param {Record<string, string>} [headerRow] 
 * @returns {Record<string, string>}
 */
function orderRecord(ctx, record, headerRow) {
  const { log } = ctx;
  const orderedKeys = Array.from(
    new Set([...Object.keys(headerRow ?? {}), ...Object.keys(record)])
  ).filter((key) => key !== 'timestamp' && key !== 'IP');

  const orderedRecord = {
    timestamp: record.timestamp ?? '',
    IP: record.IP ?? '',
    ...orderedKeys.reduce((acc, key) => {
      acc[key] = record[key] ?? ''; // take the place of missing keys with empty string
      return acc;
    }, {}),
  };

  // add any new keys to the header row
  if (headerRow) {
    orderedKeys.forEach((key) => {
      if (headerRow[key] === undefined) {
        log.info(`adding key to header row: ${key}`);
        headerRow[key] = '';
      }
    });
  }

  return orderedRecord;
}

/**
 * Appends record to sheet
 * 
 * @param {Context} ctx 
 * @param {Sheet} sheet 
 * @param {SheetRecord} record 
 * @param {string} [sheetName = 'private-data']
 * @returns {number} new total count of records in sheet
 */
function appendToSheet(ctx, sheet, record, sheetName = 'private-data') {
  /** @type {{ data: any[]; total?: number; limit?: number; }} */
  let dest;
  if (sheetName.startsWith('private-')) {
    dest = sheet[':private'][sheetName];
  } else if (sheet[':type'] === 'multi-sheet') {
    if (!sheet[sheetName]) {
      sheet[sheetName] = {
        "total": 0,
        "limit": 0,
        "offset": 0,
        "data": []
      }
    }
    // @ts-ignore
    dest = sheet[sheetName];
  } else {
    if (!sheet.data) {
      sheet.data = [];
    }
    // @ts-ignore
    dest = sheet;
  }

  // push the record, update total and limit
  const orderedRecord = orderRecord(ctx, record, dest.data[0]);
  // if all properties of the first record are empty, it's a new sheet with no data
  // use the ordered record as the header row to avoid an empty row between the header and data
  // otherwise, append the ordered record to the data array
  if (Object.values(dest.data[0]).every((value) => value === '')) {
    dest.data[0] = orderedRecord;
  } else {
    dest.data.push(orderedRecord);
  }
  dest.total = dest.data.length;
  dest.limit = (dest.limit ?? 0) + 1;

  return dest.total;
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
      log.debug('sheet exists, fetching existing');
      sheet = await fetchSheet(ctx, sheetPath);
    } else {
      log.debug('sheet does not exist, creating new');
      sheet = INITIAL_SHEET();
    }
    const newCount = appendToSheet(ctx, sheet, data);
    await updateSheet(ctx, sheetPath, sheet);
    log.info(sheetExists ? `appended 1 record to sheet: ${sheetPath} (total=${newCount})` : `created new sheet: ${sheetPath} (total=${newCount})`);

    // notify if email is configured
    // get the email template for this form, which exists at the root of the folder
    const hasEmailTemplate = entries.find((entry) => entry.path === `/${ctx.env.ORG}/${ctx.env.SITE}${folderPath}/email-template.html`);
    if (hasEmailTemplate) {
      const email = await resolveEmailTemplate(ctx, `${folderPath}/email-template.html`, data);
      if (email) {
        await sendEmail(ctx, email.toEmail, email.subject, email.html, email.cc, email.bcc);
      }
    }

    return { statusCode: 200 };
  } catch (error) {
    if (error.response) return error.response;
    console.error('fatal error: ', error);
    return errorResponse(500, 'server error');
  }
}
