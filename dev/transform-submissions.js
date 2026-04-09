import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve, basename } from 'path';

// fixed columns that always appear first, in this order
const BASE_HEADERS = ['timestamp', 'IP', 'email', 'firstName', 'lastName', 'pageUrl', 'reasonForCommunication', 'typeOfRequest'];

// header orders
// media-contact: timestamp	IP	additionalComments	businessLine	email	firstName	lastName	pageUrl	phone	publicationCompany	reasonForContact
// consult-expert: timestamp	IP	businessAddressLine1	businessAddressLine2	businessName	city	country	emailAddress	firstName	howMayWeHelp	lastName	numberOfLocations	pageUrl	phoneNumber	state	typeOfBusiness	zipCode
// wellness-program: timestamp	IP	companyName	emailAddress	firstName	jobTitle	lastName	otherRemarks	pageUrl	phoneNumber

const STORE_LOCALE = { 2: 'us', 3: 'ca', 8: 'mx' };

const CONSULT_EXPERT_HEADERS = ['timestamp', 'IP', 'businessAddressLine1', 'businessAddressLine2', 'businessName', 'city', 'country', 'emailAddress', 'firstName', 'howMayWeHelp', 'lastName', 'numberOfLocations', 'pageUrl', 'phoneNumber', 'state', 'typeOfBusiness', 'zipCode'];

// Per-form config: known column order and field key → CSV column name mapping.
// Any keys found in the data that aren't listed in headers are appended (sorted) after.
const FORM_CONFIGS = {
  'contact-us': {
    headers: BASE_HEADERS,
    fieldMap: {
      email: 'text-email',
      firstName: 'text-firstname',
      lastName: 'text-lastname',
      reasonForCommunication: 'select-reasonforcontact',
      typeOfRequest: 'radio-group-typeofrequest',
    },
  },
  'consult-expert-us': {
    headers: CONSULT_EXPERT_HEADERS,
    fieldMap: {
      firstName: 'text-1638171875497',
      lastName: 'text-1638171875677',
      businessName: 'text-1638171879750',
      businessAddressLine1: 'text-1638171881559',
      businessAddressLine2: 'text-1638171882630',
      city: 'text-1638172311652',
      state: 'select-state',
      zipCode: 'text-zip-code',
      emailAddress: 'text-email',
      phoneNumber: 'text-phone',
      typeOfBusiness: 'select-typeofbusiness',
      numberOfLocations: 'select-number-of-locations',
      howMayWeHelp: 'textarea-comment',
    },
  },
  'consult-expert-ca': {
    headers: CONSULT_EXPERT_HEADERS,
    fieldMap: {
      firstName: 'text-first-name',
      lastName: 'text-last-name',
      businessName: 'text-businessname-optional',
      businessAddressLine1: 'text-business-address-line1',
      businessAddressLine2: 'text-business-address-line2-optional',
      city: 'text-city',
      state: 'select-proviance',
      zipCode: 'text-postal-code',
      emailAddress: 'text-email',
      phoneNumber: 'text-phone',
      typeOfBusiness: 'select-typeofbusiness',
      numberOfLocations: 'select-number-of-locations',
      howMayWeHelp: 'textarea-howmanyhelp',
    },
  },
  'consult-expert-mx': {
    headers: CONSULT_EXPERT_HEADERS,
    fieldMap: {
      firstName: 'text-first-name',
      lastName: 'text-last-name',
      businessName: 'text-businessname-optional',
      businessAddressLine1: 'text-business-address-line1',
      businessAddressLine2: 'text-business-address-line2-optional',
      city: 'text-city',
      state: 'text-state',
      zipCode: 'text-zip-code',
      emailAddress: 'text-email',
      phoneNumber: 'text-phone',
      typeOfBusiness: 'select-typeofbusiness',
      numberOfLocations: 'select-number-of-locations',
      howMayWeHelp: 'textarea-howmanyhelp',
    },
  },
  'media-contact': {
    headers: ['timestamp', 'IP', 'additionalComments', 'businessLine', 'email', 'firstName', 'lastName', 'pageUrl', 'phone', 'publicationCompany', 'reasonForContact'],
    fieldMap: {
      businessLine: 'select-1622109900940',
      publicationCompany: 'text-company',
      firstName: 'text-firstname',
      lastName: 'text-lastname',
      email: 'text-email',
      phone: 'text-phone',
      reasonForContact: 'select-1622110183558',
      additionalComments: 'textarea-1622110334714',
    },
  },
  'wellness-program': {
    headers: ['timestamp', 'IP', 'companyName', 'emailAddress', 'firstName', 'jobTitle', 'lastName', 'otherRemarks', 'pageUrl', 'phoneNumber'],
    fieldMap: {
      firstName: 'text-firstname',
      lastName: 'text-lastname',
      companyName: 'text-businessname',
      jobTitle: 'text-title',
      phoneNumber: 'text-phone',
      emailAddress: 'text-email',
      otherRemarks: 'textarea-comments',
    },
  },
};

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

function transformSubmission(entry, formData, reverseFieldMap) {
  const record = {
    timestamp: entry.created_at || '',
    IP: entry.user_ip || '',
    pageUrl: '',
  };

  for (const [formKey, field] of Object.entries(formData)) {
    const csvKey = reverseFieldMap[formKey] || formKey;
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
  const inputName = basename(resolve(inputPath), '.json');

  // For consult-expert the store is encoded in the filename (e.g. consult-expert-us.json)
  // and all records belong to that store. For other forms, store_id drives the locale.
  const isConsultExpert = inputName.startsWith('consult-expert-');
  const fixedStore = isConsultExpert ? inputName.slice('consult-expert-'.length) : null;

  const config = FORM_CONFIGS[inputName];
  if (!config) {
    console.error(`Unknown form type: "${inputName}". Supported: ${Object.keys(FORM_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  const reverseFieldMap = Object.fromEntries(
    Object.entries(config.fieldMap).map(([csv, form]) => [form, csv]),
  );

  const raw = readFileSync(resolve(inputPath), 'utf-8');
  const submissions = JSON.parse(raw);

  if (!Array.isArray(submissions)) {
    console.error('Error: input JSON must be an array of submission objects');
    process.exit(1);
  }

  console.log(`Processing ${submissions.length} submissions (${inputName})...`);

  // pass 1: discover all columns and parse form data
  const knownHeaders = new Set(config.headers);
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
      const csvKey = reverseFieldMap[formKey] || formKey;
      if (!knownHeaders.has(csvKey)) {
        extraKeys.add(csvKey);
      }
    }

    parsed.push({ entry, formData });
  }

  const HEADERS = [...config.headers, ...[...extraKeys].sort()];
  console.log(`Columns: ${HEADERS.join(', ')}`);

  // pass 2: transform and group by locale/year/month
  const grouped = new Map();

  for (const { entry, formData } of parsed) {
    const record = transformSubmission(entry, formData, reverseFieldMap);

    const locale = fixedStore ?? STORE_LOCALE[entry.store_id] ?? `store-${entry.store_id}`;
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
