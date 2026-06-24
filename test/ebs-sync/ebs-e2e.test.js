/**
 * End-to-end tests for the EBS sync pipeline.
 *
 * For each journal fixture (NDJSON from real test orders), verifies:
 *   - buildPaymentSnapshot extracts the correct payment data
 *   - syncOrderToEbs produces the expected SOAP XML (compared to golden fixtures)
 *   - Declined orders correctly yield no payment snapshot
 *
 * Golden XML fixtures are stored alongside the journal NDJSON files in test/fixtures/.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { syncOrderToEbs, buildPaymentSnapshot } from '../../src/actions/ebs-sync/ebs.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures');

function loadJournal(filename) {
  return readFileSync(join(FIXTURES, filename), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function loadFixture(filename) {
  return readFileSync(join(FIXTURES, filename), 'utf-8');
}

// ---------------------------------------------------------------------------
// Mock order objects — realistic Canadian orders matching the journal fixtures
// ---------------------------------------------------------------------------

/** Order matching journal-cc-approved.ndjson (Chase Visa, Forter approved). */
const CC_APPROVED_ORDER = {
  id: '2026-05-04T19-47-57.113Z-M4Z6Y6PC',
  friendlyId: 'M4Z6Y6PC',
  createdAt: '2026-05-04T19:47:57.113Z',
  state: 'payment_completed',
  country: 'ca',
  customer: {
    firstName: 'Test',
    lastName: 'Buyer',
    email: 'approve@forter.com',
    phone: '4165551234',
  },
  billing: {
    name: 'Test Buyer',
    address1: '123 Main St',
    city: 'Toronto',
    state: 'ON',
    zip: 'M5V2T6',
    country: 'ca',
    phone: '4165551234',
    email: 'approve@forter.com',
  },
  shipping: {
    name: 'Test Buyer',
    address1: '123 Main St',
    city: 'Toronto',
    state: 'ON',
    zip: 'M5V2T6',
    country: 'ca',
    phone: '4165551234',
    email: 'approve@forter.com',
  },
  items: [
    {
      sku: '068051-04',
      quantity: 1,
      price: { final: '449.95', currency: 'CAD' },
    },
  ],
  estimates: {
    shippingMethod: {
      id: 265,
      label: 'Standard Shipping: 8-10 Business Days',
      type: 'standard',
      rate: 31.71,
    },
    tax: { country: 'CA', state: 'ON', rate: 13, id: 'CA-ON-*-Rate1' },
  },
  payment: {
    method: 'card',
    transactionId: '69F8F8131B061CE600000FFA0000796C41565367',
    cardLastFour: '1881',
    amount: '540.15',
    currency: 'CAD',
  },
};

/** Order matching journal-cc-decline.ndjson (Chase, Forter declined → cancelled). */
const CC_DECLINE_ORDER = {
  id: '2026-05-04T19-59-52.869Z-8d5Em9AI',
  friendlyId: '8d5Em9AI',
  createdAt: '2026-05-04T19:59:52.869Z',
  state: 'payment_cancelled',
  country: 'ca',
  customer: {
    firstName: 'Test',
    lastName: 'Decline',
    email: 'decline@forter.com',
    phone: '4165559999',
  },
  shipping: {
    name: 'Test Decline',
    address1: '456 King St W',
    city: 'Toronto',
    state: 'ON',
    zip: 'M5V3K1',
    country: 'ca',
    phone: '4165559999',
    email: 'decline@forter.com',
  },
  items: [
    {
      sku: '068051-04',
      quantity: 1,
      price: { final: '449.95', currency: 'CAD' },
    },
  ],
  estimates: {
    shippingMethod: {
      id: 265,
      label: 'Standard Shipping: 8-10 Business Days',
      type: 'standard',
      rate: 31.71,
    },
    tax: { country: 'CA', state: 'ON', rate: 13, id: 'CA-ON-*-Rate1' },
  },
};

/** Order matching journal-pp-approved.ndjson (PayPal, Forter approved). */
const PP_APPROVED_ORDER = {
  id: '2026-05-04T20-11-14.494Z-rpzhksxV',
  friendlyId: 'rpzhksxV',
  createdAt: '2026-05-04T20:11:14.494Z',
  state: 'payment_completed',
  country: 'ca',
  customer: {
    firstName: 'Test',
    lastName: 'Shopper',
    email: 'fake@adobe.com',
    phone: '5555555555',
  },
  billing: {
    name: 'Test Shopper',
    address1: '46 Fake St',
    city: 'Aurora',
    state: 'ON',
    zip: 'L1K1K1',
    country: 'ca',
    phone: '5555555555',
    email: 'fake@adobe.com',
  },
  shipping: {
    name: 'Test Shopper',
    address1: '46 Fake St',
    city: 'Aurora',
    state: 'ON',
    zip: 'L1K1K1',
    country: 'ca',
    phone: '5555555555',
    email: 'fake@adobe.com',
  },
  items: [
    {
      sku: '068051-04',
      quantity: 1,
      price: { final: '449.95', currency: 'CAD' },
    },
  ],
  estimates: {
    shippingMethod: {
      id: 265,
      label: 'Standard Shipping: 8-10 Business Days',
      type: 'standard',
      rate: 31.71,
    },
    tax: { country: 'CA', state: 'ON', rate: 13, id: 'CA-ON-*-Rate1' },
  },
};

/** Order matching journal-ap-approved.ndjson (Apple Pay via Chase, Forter not_reviewed). */
const AP_APPROVED_ORDER = {
  id: '2026-05-13T23-32-22.021Z-N2J1OM4S',
  friendlyId: 'N2J1OM4S',
  createdAt: '2026-05-13T23:32:22.021Z',
  state: 'payment_completed',
  country: 'ca',
  customer: {
    firstName: 'Dylan',
    lastName: 'Davis',
    email: 'dyland@adobe.com',
    phone: '5555551234',
  },
  billing: {
    name: 'Dylan Davis',
    address1: '789 Queen St E',
    city: 'Toronto',
    state: 'ON',
    zip: 'M4M1H3',
    country: 'ca',
    phone: '5555551234',
    email: 'dyland@adobe.com',
  },
  shipping: {
    name: 'Dylan Davis',
    address1: '789 Queen St E',
    city: 'Toronto',
    state: 'ON',
    zip: 'M4M1H3',
    country: 'ca',
    phone: '5555551234',
    email: 'dyland@adobe.com',
  },
  items: [
    {
      sku: '062048-04',
      quantity: 1,
      price: { final: '999.95', currency: 'CAD' },
    },
  ],
  estimates: {
    shippingMethod: {
      id: 300,
      label: 'Free Shipping',
      type: 'standard',
      rate: 0,
    },
    tax: { country: 'CA', state: 'ON', rate: 13, id: 'CA-ON-*-Rate1' },
  },
};

/** Order matching journal-affirm-approved.ndjson (Affirm BNPL, no Forter). */
const AFFIRM_APPROVED_ORDER = {
  id: '2026-05-14T00-36-15.515Z-EZY1S855',
  friendlyId: 'EZY1S855',
  createdAt: '2026-05-14T00:36:15.515Z',
  state: 'payment_completed',
  country: 'ca',
  customer: {
    firstName: 'Dylan',
    lastName: 'Depass',
    email: 'dylandepass@gmail.com',
    phone: '5555550000',
  },
  billing: {
    name: 'Dylan Depass',
    address1: '100 Test Ave',
    city: 'Toronto',
    state: 'ON',
    zip: 'M5V1A1',
    country: 'ca',
    phone: '5555550000',
    email: 'dylandepass@gmail.com',
  },
  shipping: {
    name: 'Dylan Depass',
    address1: '100 Test Ave',
    city: 'Toronto',
    state: 'ON',
    zip: 'M5V1A1',
    country: 'ca',
    phone: '5555550000',
    email: 'dylandepass@gmail.com',
  },
  items: [
    {
      sku: '068051-04',
      quantity: 1,
      price: { final: '729.95', currency: 'CAD' },
    },
  ],
  estimates: {
    shippingMethod: {
      id: 300,
      label: 'Free Shipping',
      type: 'standard',
      rate: 0,
    },
    tax: { country: 'CA', state: 'ON', rate: 13, id: 'CA-ON-*-Rate1' },
  },
};

/** Order matching journal-pp-bundle-warranty.ndjson (PayPal, bundle + extended warranty, free shipping). */
const PP_BUNDLE_WARRANTY_ORDER = {
  id: '2026-05-25T21-00-22.943Z-omuat5711040325',
  friendlyId: 'omuat5711040325',
  createdAt: '2026-05-25T21:00:22.943Z',
  state: 'payment_completed',
  country: 'ca',
  customer: {
    firstName: 'Dylan',
    lastName: 'Depass',
    email: 'dylandepass@gmail.com',
    phone: '(647) 972-8542',
  },
  billing: {
    name: 'Dylan Depass',
    address1: '46 Mosley Street',
    city: 'Aurora',
    state: 'ON',
    zip: 'L4G 1G9',
    country: 'ca',
    phone: '6479728542',
    email: 'dylandepass@gmail.com',
  },
  shipping: {
    name: 'Dylan Depass',
    address1: '46 Mosley Street',
    city: 'Aurora',
    state: 'ON',
    zip: 'L4G 1G9',
    country: 'ca',
    phone: '6479728542',
    email: 'dylandepass@gmail.com',
  },
  items: [
    {
      sku: '001372-1093-VB',
      quantity: 1,
      name: '5200 Standard - Getting Started',
      price: { final: '899.95', currency: 'CAD' },
      bundleItems: [
        {
          sku: '061724-04-VB',
          name: 'Personal Cup Adapter',
          quantity: 1,
          price: { final: '200.96', currency: 'CAD' },
          taxAmount: '26.13',
        },
        {
          sku: '069834-VB',
          name: 'Silicone Blender Spatula',
          quantity: 1,
          price: { final: '17.43', currency: 'CAD' },
          taxAmount: '2.26',
        },
        {
          sku: '060488-VB',
          name: 'Classic Series Tamper Holder',
          quantity: 1,
          price: { final: '43.65', currency: 'CAD' },
          taxAmount: '5.67',
        },
        {
          sku: '001372-1093-VB',
          name: '5200 Standard - Getting Started',
          quantity: 1,
          price: { final: '637.91', currency: 'CAD' },
          taxAmount: '82.94',
        },
      ],
    },
    {
      sku: '001314',
      quantity: 1,
      name: 'Extended Warranty, add 3 yrs',
      price: { final: '117.00', currency: 'CAD' },
      custom: { linkedTo: '001372-1093-VB', coverageYears: 3 },
      taxAmount: '15.20',
    },
  ],
  estimates: {
    shippingMethod: {
      id: '265',
      label: 'Standard Shipping: 8-10 Business Days',
      type: 'standard',
      rate: '31.71',
    },
    tax: {
      provider: 'avalara',
      totalTax: '132.20',
      amount: '132.20',
    },
    discounts: [
      {
        id: 'free-ship-ca',
        name: 'free-ship-ca',
        type: 'free_shipping',
        amount: 0,
        freeShipping: true,
        source: 'pricing_rule',
      },
    ],
  },
};

const MOCK_PARAMS = {
  EBS_BASE_URL: 'https://ebs.test.example.com',
  EBS_API_KEY: 'test-api-key',
};
const MOCK_CTX = {
  env: { ORG: 'test-org', SITE: 'test-site', PROXY_TOKEN: 'test-token' },
  log: { error: () => {} },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ebs-sync e2e', () => {
  let capturedXml;
  const origFetch = global.fetch;

  beforeAll(() => {
    // proxyFetch wraps the destination request inside a JSON envelope:
    //   POST <proxy>  body: { url, method, headers, body: <SOAP XML> }
    // Tests assert against the inner SOAP XML.
    global.fetch = async (_url, opts) => {
      const wrapped = JSON.parse(opts.body);
      capturedXml = wrapped.body;
      return { ok: true, status: 200, text: async () => '<Response Succeeded="true" />' };
    };
  });

  afterAll(() => {
    global.fetch = origFetch;
  });

  beforeEach(() => {
    capturedXml = null;
  });

  /**
   * Assert that the captured XML matches the golden fixture file.
   * On first run (fixture missing), writes the file so it can be reviewed and committed.
   */
  function assertXmlFixture(fixtureName, xml) {
    const fixturePath = join(FIXTURES, fixtureName);
    if (!existsSync(fixturePath)) {
      writeFileSync(fixturePath, xml, 'utf-8');
      console.log(`[fixture] Wrote ${fixtureName} — review and commit.`);
    }
    expect(xml).toBe(loadFixture(fixtureName));
  }

  const clone = (value) => JSON.parse(JSON.stringify(value));

  const withCompletedPayment = (journal, fields) => journal.map((entry) => (
    entry.event === 'payment_completed' ? { ...entry, ...fields } : entry
  ));

  const addressValidation = (xml, tag) => xml.match(new RegExp(`<${tag} IsValidated="([^"]+)"`))?.[1];

  async function buildXml(order, journal) {
    await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
    expect(capturedXml).toBeTruthy();
    return capturedXml;
  }

  // ── Chase credit card — approved by Forter ──────────────────────────────

  describe('CC approved (journal-cc-approved)', () => {
    const journal = loadJournal('journal-cc-approved.ndjson');

    test('buildPaymentSnapshot extracts Chase payment fields', () => {
      const snap = buildPaymentSnapshot(CC_APPROVED_ORDER, journal);
      expect(snap).not.toBeNull();
      expect(snap.method).toBe('chasehpp');
      expect(snap.provider).toBe('chase');
      expect(snap.amount).toBe('540.15');
      expect(snap.taxAmount).toBe('58.49');
      expect(snap.shippingCost).toBe('31.71');
      expect(snap.subtotal).toBe('449.95');
      expect(snap.transactionId).toBe('69F8F8131B061CE600000FFA0000796C41565367');
      expect(snap.approvalCode).toBe('tst401');
      expect(snap.cardBrand).toBe('Visa');
      expect(snap.last4).toBe('1881');
      expect(snap.expiration).toBe('2028-01-28-12:00');
      expect(snap.fraudDecision).toBe('approve');
      expect(snap.avsMatch).toBe('2 ');
      // No SafeTech data in this journal (Forter-only environment)
      expect(snap.fraudScore).toBe('');
      expect(snap.fraudStatusCode).toBe('');
    });

    test('syncOrderToEbs produces expected SOAP XML', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, CC_APPROVED_ORDER, journal);
      expect(capturedXml).toBeTruthy();
      assertXmlFixture('expected-cc-approved.xml', capturedXml);
    });

    test('CreditCard CardLast4Digits falls back to order payment cardLastFour', async () => {
      const journalWithoutCardLast4 = withCompletedPayment(journal, { cardLast4: undefined });

      const xml = await buildXml(CC_APPROVED_ORDER, journalWithoutCardLast4);

      expect(xml).toContain('CardLast4Digits="1881"');
    });
  });

  // ── Chase credit card — declined by Forter ──────────────────────────────

  describe('CC decline (journal-cc-decline)', () => {
    const journal = loadJournal('journal-cc-decline.ndjson');

    test('buildPaymentSnapshot returns null (no payment_completed)', () => {
      const snap = buildPaymentSnapshot(CC_DECLINE_ORDER, journal);
      expect(snap).toBeNull();
    });

    test('syncOrderToEbs throws for declined order', async () => {
      await expect(syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, CC_DECLINE_ORDER, journal))
        .rejects.toThrow('cannot build payment snapshot');
    });
  });

  // ── PayPal — approved by Forter ─────────────────────────────────────────

  describe('PP approved (journal-pp-approved)', () => {
    const journal = loadJournal('journal-pp-approved.ndjson');

    test('buildPaymentSnapshot extracts PayPal payment fields', () => {
      const snap = buildPaymentSnapshot(PP_APPROVED_ORDER, journal);
      expect(snap).not.toBeNull();
      expect(snap.method).toBe('paypal');
      expect(snap.provider).toBe('paypal');
      expect(snap.amount).toBe('540.15');
      expect(snap.taxAmount).toBe('58.49');
      expect(snap.shippingCost).toBe('31.71');
      expect(snap.subtotal).toBe('449.95');
      expect(snap.transactionId).toBe('9AR333349R915513J');
      expect(snap.paypalEmail).toBe('sb-bruwa26923093@personal.example.com');
      expect(snap.payerId).toBe('RV6HF5GVYA4D8');
      expect(snap.token).toBe('6B3711486D865245E');
      expect(snap.protectionEligibility).toBe('ELIGIBLE');
      expect(snap.paymentStatus).toBe('CREATED');
      expect(snap.payerStatus).toBe('VERIFIED');
    });

    test('syncOrderToEbs produces expected SOAP XML', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, PP_APPROVED_ORDER, journal);
      expect(capturedXml).toBeTruthy();
      assertXmlFixture('expected-pp-approved.xml', capturedXml);
    });
  });

  // ── Apple Pay (chase-wallet) — Forter not_reviewed ─────────────────────

  describe('AP approved (journal-ap-approved)', () => {
    const journal = loadJournal('journal-ap-approved.ndjson');

    test('buildPaymentSnapshot extracts Apple Pay payment fields', () => {
      const snap = buildPaymentSnapshot(AP_APPROVED_ORDER, journal);
      expect(snap).not.toBeNull();
      expect(snap.method).toBe('applepay');
      expect(snap.provider).toBe('chase-wallet');
      expect(snap.amount).toBe('1129.94');
      expect(snap.taxAmount).toBe('129.99');
      expect(snap.shippingCost).toBe('0.00');
      expect(snap.subtotal).toBe('999.95');
      expect(snap.transactionId).toBe('6A050A09034A95F000000FFB00003F9E41565325');
      expect(snap.approvalCode).toBe('tst310');
      expect(snap.fraudDecision).toBe('not_reviewed');
      // No card info or nameOnCard in chase-wallet journal entries yet
      expect(snap.cardBrand).toBe('');
      expect(snap.last4).toBe('');
      expect(snap.nameOnCard).toBe('');
    });

    test('syncOrderToEbs produces expected SOAP XML', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, AP_APPROVED_ORDER, journal);
      expect(capturedXml).toBeTruthy();
      assertXmlFixture('expected-ap-approved.xml', capturedXml);
    });
  });

  // ── Affirm BNPL — no Forter ───────────────────────────────────────────

  describe('Affirm approved (journal-affirm-approved)', () => {
    const journal = loadJournal('journal-affirm-approved.ndjson');

    test('buildPaymentSnapshot extracts Affirm payment fields', () => {
      const snap = buildPaymentSnapshot(AFFIRM_APPROVED_ORDER, journal);
      expect(snap).not.toBeNull();
      expect(snap.method).toBe('affirm');
      expect(snap.provider).toBe('affirm');
      expect(snap.amount).toBe('824.84');
      expect(snap.taxAmount).toBe('94.89');
      expect(snap.shippingCost).toBe('0.00');
      expect(snap.subtotal).toBe('729.95');
      expect(snap.transactionId).toBe('MTUW-BDJZ');
      expect(snap.transactionDate).toBe('2026-05-14T00:36:47.223Z');
    });

    test('syncOrderToEbs produces expected SOAP XML', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, AFFIRM_APPROVED_ORDER, journal);
      expect(capturedXml).toBeTruthy();
      assertXmlFixture('expected-affirm-approved.xml', capturedXml);
    });
  });

  // ── Address validation state ───────────────────────────────────────────

  describe('address validation state', () => {
    test('ShipTo IsValidated follows shipping.isValidated false', async () => {
      const order = clone(PP_APPROVED_ORDER);
      order.shipping.isValidated = false;
      order.billing.isValidated = true;

      const xml = await buildXml(order, loadJournal('journal-pp-approved.ndjson'));

      expect(addressValidation(xml, 'ShipTo')).toBe('false');
      expect(addressValidation(xml, 'BillTo')).toBe('true');
    });

    test.each([undefined, true])('ShipTo IsValidated defaults to true for %s', async (isValidated) => {
      const order = clone(PP_APPROVED_ORDER);
      if (isValidated !== undefined) order.shipping.isValidated = isValidated;

      const xml = await buildXml(order, loadJournal('journal-pp-approved.ndjson'));

      expect(addressValidation(xml, 'ShipTo')).toBe('true');
    });

    test.each([
      ['paypal', PP_APPROVED_ORDER, 'journal-pp-approved.ndjson'],
      ['affirm', AFFIRM_APPROVED_ORDER, 'journal-affirm-approved.ndjson'],
      ['applepay', AP_APPROVED_ORDER, 'journal-ap-approved.ndjson'],
    ])('BillTo IsValidated stays true for non-Chase method %s', async (_method, baseOrder, fixture) => {
      const order = clone(baseOrder);
      order.billing.isValidated = false;

      const xml = await buildXml(order, loadJournal(fixture));

      expect(addressValidation(xml, 'BillTo')).toBe('true');
    });

    test.each(['1', '2 ', 'G', 'M1', 'UK'])('BillTo IsValidated is false for Chase AVS %s', async (avsMatch) => {
      const xml = await buildXml(
        clone(CC_APPROVED_ORDER),
        withCompletedPayment(loadJournal('journal-cc-approved.ndjson'), { avsMatch }),
      );

      expect(addressValidation(xml, 'BillTo')).toBe('false');
    });

    test.each(['', 'Y', '  ', undefined])('BillTo IsValidated is true for Chase AVS %s', async (avsMatch) => {
      const xml = await buildXml(
        clone(CC_APPROVED_ORDER),
        withCompletedPayment(loadJournal('journal-cc-approved.ndjson'), { avsMatch }),
      );

      expect(addressValidation(xml, 'BillTo')).toBe('true');
    });

    test('BillTo IsValidated is true for zero-total Chase orders regardless of AVS', async () => {
      const xml = await buildXml(
        clone(CC_APPROVED_ORDER),
        withCompletedPayment(loadJournal('journal-cc-approved.ndjson'), { amount: '0.00', avsMatch: '2' }),
      );

      expect(addressValidation(xml, 'BillTo')).toBe('true');
    });
  });

  // ── PayPal — bundle + extended warranty + free shipping ─────────────────

  describe('PP bundle + warranty (journal-pp-bundle-warranty)', () => {
    const journal = loadJournal('journal-pp-bundle-warranty.ndjson');

    test('buildPaymentSnapshot extracts PayPal payment fields', () => {
      const snap = buildPaymentSnapshot(PP_BUNDLE_WARRANTY_ORDER, journal);
      expect(snap).not.toBeNull();
      expect(snap.method).toBe('paypal');
      expect(snap.provider).toBe('paypal');
      expect(snap.amount).toBe('1149.15');
      expect(snap.taxAmount).toBe('132.20');
      expect(snap.shippingCost).toBe('0.00');
      expect(snap.subtotal).toBe('1016.95');
      expect(snap.transactionId).toBe('5D558546MN799870T');
      expect(snap.paypalEmail).toBe('sb-buyer@personal.example.com');
      expect(snap.payerId).toBe('TESTPAYERID567');
      expect(snap.token).toBe('7PP987654321ABCDE');
      expect(snap.protectionEligibility).toBe('ELIGIBLE');
      expect(snap.paymentStatus).toBe('CREATED');
      expect(snap.payerStatus).toBe('VERIFIED');
    });

    test('syncOrderToEbs produces expected SOAP XML', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, PP_BUNDLE_WARRANTY_ORDER, journal);
      expect(capturedXml).toBeTruthy();
      assertXmlFixture('expected-pp-bundle-warranty.xml', capturedXml);
    });

    test('bundle children are emitted as line items, wrapper is dropped', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, PP_BUNDLE_WARRANTY_ORDER, journal);
      // Bundle wrapper price (899.95) must NOT appear as a line item
      expect(capturedXml).not.toMatch(/UnitSellingPrice="899\.95"/);
      // Each bundle child must appear with its own price (with '-VB' suffix stripped)
      expect(capturedXml).toMatch(/Sku="061724-04"[\s\S]*?UnitSellingPrice="200\.96"/);
      expect(capturedXml).toMatch(/Sku="069834"[\s\S]*?UnitSellingPrice="17\.43"/);
      expect(capturedXml).toMatch(/Sku="060488"[\s\S]*?UnitSellingPrice="43\.65"/);
      expect(capturedXml).toMatch(/Sku="001372-1093"[\s\S]*?UnitSellingPrice="637\.91"/);
    });

    test("bundle items have their '-VB' suffix stripped to the original SKU", async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, PP_BUNDLE_WARRANTY_ORDER, journal);
      // No bundle SKU should reach EBS with the virtual-bundle '-VB' suffix
      expect(capturedXml).not.toMatch(/Sku="[^"]*-VB"/);
      // The original (stripped) SKUs are present
      expect(capturedXml).toMatch(/Sku="061724-04"/);
      expect(capturedXml).toMatch(/Sku="069834"/);
      expect(capturedXml).toMatch(/Sku="060488"/);
      expect(capturedXml).toMatch(/Sku="001372-1093"/);
    });

    test("the '-VB' suffix is stripped only for bundle items, not simple products", async () => {
      // A simple (non-bundle) product whose SKU happens to end in '-VB' must be
      // left untouched — stripping applies to bundle children only.
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items.push({
        sku: '099999-VB',
        quantity: 1,
        name: 'Standalone item with VB-like SKU',
        price: { final: '10.00', currency: 'CAD' },
        taxAmount: '0.00',
      });
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      // Simple product keeps its SKU verbatim
      expect(capturedXml).toMatch(/Sku="099999-VB"/);
    });

    test('warranty uses UnitOfMeasure="Years" and shares serial with its product', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, PP_BUNDLE_WARRANTY_ORDER, journal);
      // Warranty line item
      expect(capturedXml).toMatch(/Sku="001314"[\s\S]*?UnitOfMeasure="Years"/);
      // Serial number links warranty to its product — same serial on both
      const serials = [...capturedXml.matchAll(/<ns2:SerialNumber>([^<]+)<\/ns2:SerialNumber>/g)];
      expect(serials).toHaveLength(2);
      expect(serials[0][1]).toBe(serials[1][1]);
    });

    test('warranty quantity is coverageYears and price is the per-year unit price', async () => {
      // Order carries price.final=117.00 as the total for the full 3-year term.
      // EBS expects Quantity=coverageYears (3) and a per-year unit price (117/3=39.00).
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, PP_BUNDLE_WARRANTY_ORDER, journal);
      const line = capturedXml.match(/<ns2:LineItem\s+Sku="001314"[\s\S]*?<\/ns2:LineItem>/)[0];
      expect(line).toMatch(/Quantity="3"/);
      expect(line).toMatch(/UnitSellingPrice="39\.00"/);
      expect(line).toMatch(/UnitOfMeasure="Years"/);
      // The total (price.final) must not leak through as the unit price
      expect(line).not.toMatch(/UnitSellingPrice="117\.00"/);
    });

    test('item-level tax amounts are emitted from taxAmount fields', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, PP_BUNDLE_WARRANTY_ORDER, journal);
      // Each bundle child carries its own tax
      const taxes = [...capturedXml.matchAll(/<ns2:Tax Amount="([^"]+)" Provisional="true" \/>/g)]
        .map((m) => m[1])
        .filter((t) => t !== '132.20'); // exclude order-level tax
      expect(taxes).toEqual(['26.13', '2.26', '5.67', '82.94', '15.20']);
    });
  });

  // ── Warranty VitamixProductId lookup ────────────────────────────────────

  describe('warranty vitamixProductId mapping', () => {
    const journal = loadJournal('journal-pp-bundle-warranty.ndjson');

    test('warranty SKU 001314 maps to VitamixProductId 001314', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, PP_BUNDLE_WARRANTY_ORDER, journal);
      expect(capturedXml).toMatch(/Sku="001314"[\s\S]*?UnitOfMeasure="Years"/);
    });

    test('warranty SKU 070791 maps to VitamixProductId 70791', async () => {
      // Clone the order with the second warranty SKU
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items[1].sku = '070791';
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      // Emitted SKU should be the transformed VitamixProductId, not the catalog SKU
      expect(capturedXml).toMatch(/Sku="70791"[\s\S]*?UnitOfMeasure="Years"/);
      expect(capturedXml).not.toMatch(/Sku="070791"/);
    });
  });

  // ── Warranty per-year pricing math ──────────────────────────────────────

  describe('warranty per-year pricing', () => {
    const journal = loadJournal('journal-pp-bundle-warranty.ndjson');

    /** Run the sync with a warranty whose total price.final and coverageYears are overridden. */
    async function syncWarranty({ final, coverageYears }) {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items[1].price.final = final;
      if (coverageYears === undefined) {
        delete order.items[1].custom.coverageYears;
      } else {
        order.items[1].custom.coverageYears = coverageYears;
      }
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      return capturedXml.match(/<ns2:LineItem\s+Sku="001314"[\s\S]*?<\/ns2:LineItem>/)[0];
    }

    test('splits the term total evenly: 117.00 over 3 years => 39.00 × 3', async () => {
      const line = await syncWarranty({ final: '117.00', coverageYears: 3 });
      expect(line).toMatch(/Quantity="3"/);
      expect(line).toMatch(/UnitSellingPrice="39\.00"/);
    });

    test('5-year term: 250.00 over 5 years => 50.00 × 5', async () => {
      const line = await syncWarranty({ final: '250.00', coverageYears: 5 });
      expect(line).toMatch(/Quantity="5"/);
      expect(line).toMatch(/UnitSellingPrice="50\.00"/);
    });

    test('non-even division rounds the unit price to 2 decimals: 100.00 over 3 years', async () => {
      const line = await syncWarranty({ final: '100.00', coverageYears: 3 });
      expect(line).toMatch(/Quantity="3"/);
      expect(line).toMatch(/UnitSellingPrice="33\.33"/);
    });

    test('1-year term: unit price equals the full total', async () => {
      const line = await syncWarranty({ final: '49.00', coverageYears: 1 });
      expect(line).toMatch(/Quantity="1"/);
      expect(line).toMatch(/UnitSellingPrice="49\.00"/);
    });

    test('missing coverageYears falls back to a single year at full price', async () => {
      const line = await syncWarranty({ final: '99.00', coverageYears: undefined });
      expect(line).toMatch(/Quantity="1"/);
      expect(line).toMatch(/UnitSellingPrice="99\.00"/);
    });
  });

  // ── Commercial vs Household order type ─────────────────────────────────

  describe('order type (Commercial / Household)', () => {
    const journal = loadJournal('journal-pp-bundle-warranty.ndjson');

    test('order without commercial items produces Type="Household"', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, PP_BUNDLE_WARRANTY_ORDER, journal);
      expect(capturedXml).toMatch(/Type="Household"/);
    });

    test('order with a commercial item produces Type="Commercial"', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items[0].custom = { isCommercial: true };
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      expect(capturedXml).toMatch(/Type="Commercial"/);
    });

    test('commercial flag on a simple (non-bundle) item produces Type="Commercial"', async () => {
      // Use the simple CC order with isCommercial on the single item
      const order = structuredClone(CC_APPROVED_ORDER);
      order.items[0].custom = { isCommercial: true };
      const ccJournal = loadJournal('journal-cc-approved.ndjson');
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, ccJournal);
      expect(capturedXml).toMatch(/Type="Commercial"/);
    });
  });

  // ── Gift message ──────────────────────────────────────────────────────

  describe('gift message', () => {
    const journal = loadJournal('journal-cc-approved.ndjson');

    test('order without giftMessage emits empty ns2:Message', async () => {
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, CC_APPROVED_ORDER, journal);
      expect(capturedXml).toMatch(/<ns2:Message><\/ns2:Message>/);
    });

    test('order with giftMessage emits sanitised CDATA message', async () => {
      const order = structuredClone(CC_APPROVED_ORDER);
      order.giftMessage = 'Happy Birthday! Enjoy your new blender :)';
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      // Special chars stripped, wrapped in CDATA
      expect(capturedXml).toMatch(
        /<ns2:Message><!\[CDATA\[Happy Birthday Enjoy your new blender \]\]><\/ns2:Message>/,
      );
    });
  });
});
