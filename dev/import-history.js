import 'dotenv/config';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { updateSheet } from '../src/da.js';

const { DA_TOKEN, ORG, SITE, DA_LANG = 'en_us', FORMS, YEAR, MONTH } = process.env;
const LANG = DA_LANG;
const missing = ['DA_TOKEN', 'ORG', 'SITE'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const filterForms = FORMS ? new Set(FORMS.split(',').map((s) => s.trim())) : null;
const filterYear = YEAR ?? null;
const filterMonth = MONTH ? MONTH.padStart(2, '0') : null;

const ctx = {
  env: { ORG, SITE },
  events: { token: DA_TOKEN },
  log: {
    info: (...args) => console.log('[INFO]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    debug: () => { },
  },
};

// @ts-ignore
const OUTPUT_DIR = new URL('../output', import.meta.url).pathname;

function parseTsv(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split('\t');
    return headers.reduce((obj, header, i) => {
      obj[header] = (values[i] ?? '').trim();
      return obj;
    }, {});
  });
}

/**
 * Scan all CSVs under a form directory and return a sorted, deduplicated header list.
 * timestamp and IP are always first and second; remaining keys are alphabetical.
 * @param {string} formDir
 * @returns {string[]}
 */
function collectFormHeaders(formDir) {
  const keys = new Set();
  for (const store of listDirs(formDir)) {
    for (const year of listDirs(join(formDir, store))) {
      const yearDir = join(formDir, store, year);
      for (const file of readdirSync(yearDir).filter((f) => f.endsWith('.csv'))) {
        const lines = readFileSync(join(yearDir, file), 'utf-8')
          .replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        if (lines.length > 0) {
          lines[0].split('\t').forEach((h) => { if (h.trim()) keys.add(h.trim()); });
        }
      }
    }
  }
  const pinned = ['timestamp', 'IP'].filter((k) => keys.has(k));
  const rest = [...keys].filter((k) => k !== 'timestamp' && k !== 'IP').sort((a, b) => a.localeCompare(b));
  return [...pinned, ...rest];
}

/**
 * Reorder a record's keys to match the canonical header order.
 * Keys absent from the record are set to empty string.
 * @param {Record<string, string>} record
 * @param {string[]} headers
 * @returns {Record<string, string>}
 */
function sortRecord(record, headers) {
  return headers.reduce((obj, key) => {
    obj[key] = record[key] ?? '';
    return obj;
  }, {});
}

function buildSheet(records) {
  return {
    ':private': {
      'private-data': {
        total: records.length,
        limit: records.length,
        offset: 0,
        data: records,
      },
    },
  };
}

function listDirs(dir) {
  return readdirSync(dir).filter(
    (name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory()
  );
}

async function main() {
  const formNames = listDirs(OUTPUT_DIR).filter((name) => !filterForms || filterForms.has(name));

  for (const formName of formNames) {
    const formDir = join(OUTPUT_DIR, formName);
    const headers = collectFormHeaders(formDir);
    console.log(`[INFO] ${formName} columns (${headers.length}): ${headers.join(', ')}`);
    const stores = listDirs(formDir);

    for (const store of stores) {
      const storeDir = join(formDir, store);
      const years = listDirs(storeDir).filter((y) => !filterYear || y === filterYear);

      for (const year of years) {
        const yearDir = join(storeDir, year);
        const csvFiles = readdirSync(yearDir).filter(
          (name) => name.endsWith('.csv') && (!filterMonth || basename(name, '.csv') === filterMonth)
        );

        for (const csvFile of csvFiles) {
          const month = basename(csvFile, '.csv');
          const content = readFileSync(join(yearDir, csvFile), 'utf-8');
          const records = parseTsv(content).map((r) => sortRecord(r, headers));

          if (records.length === 0) {
            console.log(`[SKIP] empty: ${formName}/${store}/${year}/${csvFile}`);
            continue;
          }

          const sheet = buildSheet(records);
          const daPath = `/incoming/${store}/${LANG}/${formName}/${year}/${month}.json`;
          console.log(`[INFO] importing ${records.length} records → ${daPath}`);
          await updateSheet(ctx, daPath, sheet);
        }
      }
    }
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
