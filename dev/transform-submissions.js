import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

// fixed columns that always appear first, in this order
const BASE_HEADERS = ['timestamp', 'IP', 'email', 'firstName', 'lastName', 'pageUrl', 'reasonForCommunication', 'typeOfRequest'];

const STORE_LOCALE = { 2: 'us', 3: 'ca', 8: 'mx' };

// maps CSV column name → forms_response key (for renamed fields)
const FIELD_MAP = {
  email: 'text-email',
  firstName: 'text-firstname',
  lastName: 'text-lastname',
  reasonForCommunication: 'select-reasonforcontact',
  typeOfRequest: 'radio-group-typeofrequest',
};

// reverse lookup: forms_response key → CSV column name
const REVERSE_FIELD_MAP = Object.fromEntries(
  Object.entries(FIELD_MAP).map(([csv, form]) => [form, csv]),
);

function escapeField(value) {
  if (!value) return '';
  const str = String(value);
  if (str.includes('\t') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseFormData(entry) {
  try {
    return JSON.parse(entry.forms_response || '{}');
  } catch {
    return null;
  }
}

function transformSubmission(entry, formData) {
  const record = {
    timestamp: entry.created_at || '',
    IP: entry.user_ip || '',
    pageUrl: '',
  };

  for (const [formKey, field] of Object.entries(formData)) {
    const csvKey = REVERSE_FIELD_MAP[formKey] || formKey;
    record[csvKey] = field?.value ?? '';
  }

  return record;
}

function run() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node dev/transform-submissions.js <input.json> [output-dir]');
    process.exit(1);
  }

  const outputDir = resolve(process.argv[3] || 'output');
  const raw = readFileSync(resolve(inputPath), 'utf-8');
  const submissions = JSON.parse(raw);

  if (!Array.isArray(submissions)) {
    console.error('Error: input JSON must be an array of submission objects');
    process.exit(1);
  }

  console.log(`Processing ${submissions.length} submissions...`);

  // pass 1: discover all columns and parse form data
  const extraKeys = new Set();
  const parsed = [];
  let skipped = 0;

  for (const entry of submissions) {
    const formData = parseFormData(entry);
    if (!formData) {
      console.warn(`  skipping entity_id=${entry.entity_id}: malformed forms_response`);
      skipped++;
      continue;
    }

    for (const formKey of Object.keys(formData)) {
      const csvKey = REVERSE_FIELD_MAP[formKey] || formKey;
      if (!BASE_HEADERS.includes(csvKey)) {
        extraKeys.add(csvKey);
      }
    }

    parsed.push({ entry, formData });
  }

  const HEADERS = [...BASE_HEADERS, ...[...extraKeys].sort()];
  console.log(`Columns: ${HEADERS.join(', ')}`);

  // pass 2: transform and group by locale/year/month
  const grouped = new Map();

  for (const { entry, formData } of parsed) {
    const record = transformSubmission(entry, formData);

    const locale = STORE_LOCALE[entry.store_id] || `store-${entry.store_id}`;
    const date = new Date(entry.created_at);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const key = `${locale}/${year}/${month}`;

    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }

  // write CSVs (tab-separated), all with the same columns
  const headerLine = HEADERS.join('\t');

  for (const [key, records] of [...grouped.entries()].sort()) {
    const parts = key.split('/');
    const dir = join(outputDir, parts[0], parts[1]);
    mkdirSync(dir, { recursive: true });

    const filePath = join(outputDir, `${key}.csv`);
    const lines = [headerLine];
    for (const rec of records) {
      lines.push(HEADERS.map((h) => escapeField(rec[h])).join('\t'));
    }

    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    console.log(`  wrote ${records.length} rows → ${filePath}`);
  }

  console.log(`Done. ${submissions.length - skipped} written, ${skipped} skipped.`);
}

run();
