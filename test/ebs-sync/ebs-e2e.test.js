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
import {
  syncOrderToEbs, buildPaymentSnapshot, resolveGwpPromotions, shortenCouponName,
  COUPON_NAME_MAX_LENGTH,
} from '../../src/actions/ebs-sync/ebs.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
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
      path: '/ca/en_ca/products/5200-legacy-bundle',
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
    // The proxy URL-decodes text/xml bodies before forwarding them; decode the
    // same way so tests assert against the XML the target receives.
    global.fetch = async (_url, opts) => {
      const wrapped = JSON.parse(opts.body);
      capturedXml = decodeURIComponent(wrapped.body);
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

    test.each(['1', '2 ', 'G', 'M1', 'UK', 'Unknown'])('BillTo IsValidated is false for Chase AVS %s', async (avsMatch) => {
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

  // ── Persisted Commerce API line discount allocations ───────────────────

  describe('persisted line discount allocations', () => {
    const ccJournal = loadJournal('journal-cc-approved.ndjson');
    const bundleJournal = loadJournal('journal-pp-bundle-warranty.ndjson');

    test('consumes the persisted Commerce API bundle and warranty contract fixture', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items = JSON.parse(loadFixture('commerce-api-persisted-line-discounts.json')).items;

      const xml = await buildXml(order, bundleJournal);
      expect(xml).toMatch(/Sku="061724-04"[\s\S]*?UnitSellingPrice="192\.96"/);
      expect(xml).toMatch(/Sku="069834"[\s\S]*?UnitSellingPrice="5\.43"/);
      expect(xml).toMatch(/Sku="060488"[\s\S]*?UnitSellingPrice="43\.65"/);
      expect(xml).toMatch(/Sku="001372-1093"[\s\S]*?UnitSellingPrice="637\.91"/);
      expect(xml).toMatch(/Sku="001314"[\s\S]*?UnitSellingPrice="33\.00"/);
    });

    test('uses a simple line’s persisted coupon and override allocations with cents rounding', async () => {
      const order = structuredClone(CC_APPROVED_ORDER);
      order.items[0] = {
        ...order.items[0],
        price: { final: '799.95', currency: 'CAD' },
        discounts: [
          { id: 'coupon:SAVE100', amount: '100.00' },
          { id: 'promo:override', amount: '99.99' },
        ],
      };
      order.items.push({
        sku: 'unaffected-sku',
        quantity: 1,
        price: { final: '50.00', currency: 'CAD' },
      });

      const xml = await buildXml(order, ccJournal);
      expect(xml).toMatch(/Sku="068051-04"[\s\S]*?UnitSellingPrice="599\.96"/);
      expect(xml).toMatch(/Sku="unaffected-sku"[\s\S]*?UnitSellingPrice="50\.00"/);
    });

    test('uses the discounted total across a multi-quantity simple line', async () => {
      const order = structuredClone(CC_APPROVED_ORDER);
      order.items[0] = {
        ...order.items[0],
        quantity: 2,
        price: { final: '100.00', currency: 'CAD' },
        discounts: [
          { id: 'coupon:SAVE8', amount: '8.00' },
          { id: 'promo:targeted', amount: '12.00' },
        ],
      };

      const xml = await buildXml(order, ccJournal);
      expect(xml).toMatch(/Quantity="2"[\s\S]*?UnitSellingPrice="90\.00"/);
    });

    test('rounds a persisted half-cent split to two decimal places', async () => {
      const order = structuredClone(CC_APPROVED_ORDER);
      order.items[0] = {
        ...order.items[0],
        quantity: 2,
        price: { final: '100.00', currency: 'CAD' },
        discounts: [{ id: 'coupon:ONE-CENT', amount: '0.01' }],
      };

      const xml = await buildXml(order, ccJournal);
      // (100.00 × 2 − 0.01) ÷ 2 = 99.995, which Magento rounds to 100.00.
      expect(xml).toMatch(/Quantity="2"[\s\S]*?UnitSellingPrice="100\.00"/);
    });

    test('does not infer merchandise prices from aggregate or free-shipping estimates', async () => {
      const order = structuredClone(CC_APPROVED_ORDER);
      order.estimates.discounts = [
        { id: 'coupon:UNSCOPED', amount: 200, source: 'coupon' },
        { id: 'free-shipping', amount: 0, freeShipping: true, source: 'pricing_rule' },
      ];

      const xml = await buildXml(order, ccJournal);
      expect(xml).toMatch(/Sku="068051-04"[\s\S]*?UnitSellingPrice="449\.95"/);
    });

    test('uses only component allocations when emitting bundle children', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items[0].discounts = [{ id: 'coupon:BUNDLE', amount: '20.00' }];
      order.items[0].bundleItems[0].discounts = [{ id: 'coupon:BUNDLE', amount: '8.00' }];
      order.items[0].bundleItems[1].discounts = [{ id: 'coupon:BUNDLE', amount: '12.00' }];

      const xml = await buildXml(order, bundleJournal);
      expect(xml).toMatch(/Sku="061724-04"[\s\S]*?UnitSellingPrice="192\.96"/);
      expect(xml).toMatch(/Sku="069834"[\s\S]*?UnitSellingPrice="5\.43"/);
      expect(xml).toMatch(/Sku="060488"[\s\S]*?UnitSellingPrice="43\.65"/);
      expect(xml).toMatch(/Sku="001372-1093"[\s\S]*?UnitSellingPrice="637\.91"/);
      expect(xml).toMatch(/Sku="001314"[\s\S]*?UnitSellingPrice="39\.00"/);
    });

    test('allocates a discounted warranty across every purchased coverage year', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items[1].quantity = 2;
      order.items[1].discounts = [
        { id: 'coupon:WARRANTY', amount: '12.00' },
        { id: 'promo:WARRANTY', amount: '6.00' },
      ];

      const xml = await buildXml(order, bundleJournal);
      const line = xml.match(/<ns2:LineItem\s+Sku="001314"[\s\S]*?<\/ns2:LineItem>/)[0];
      expect(line).toMatch(/Quantity="6"/);
      expect(line).toMatch(/UnitSellingPrice="36\.00"/);
      expect(line).toMatch(/UnitOfMeasure="Years"/);
    });
  });

  // ── Coupon promotions & salesperson attribution ─────────────────────────

  describe('coupon promotions and salesperson attribution', () => {
    const journal = loadJournal('journal-cc-approved.ndjson');

    // Base order with no coupon fields and no estimate discounts, so each test
    // controls the coupon shape it exercises.
    const orderWith = (overrides) => {
      const order = structuredClone(CC_APPROVED_ORDER);
      delete order.estimates.discounts;
      return { ...order, ...overrides };
    };

    // Order-level elements sit between SalesPersonId/Message and the first LineItem.
    const orderLevel = (xml) => xml.slice(0, xml.indexOf('<ns2:LineItem'));
    const lineItems = (xml) => xml.match(/<ns2:LineItem\b[\s\S]*?<\/ns2:LineItem>/g);
    const promotionCodes = (fragment) => [
      ...fragment.matchAll(/<ns2:PromotionCode>([^<]*)<\/ns2:PromotionCode>/g),
    ].map((m) => m[1]);

    test('emits one order-level PromotionCode per applied coupon code', async () => {
      const xml = await buildXml(orderWith({ couponCodes: ['SAVE10', 'IDME20'] }), journal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['(SAVE10)', '(IDME20)']);
    });

    test('stamps every applied coupon code on every line item', async () => {
      const order = orderWith({ couponCodes: ['SAVE10', 'IDME20'] });
      order.items.push({ sku: 'other-sku', quantity: 1, price: { final: '50.00', currency: 'CAD' } });
      const lines = lineItems(await buildXml(order, journal));
      expect(lines).toHaveLength(2);
      lines.forEach((line) => expect(promotionCodes(line)).toEqual(['(SAVE10)', '(IDME20)']));
    });

    test('stamps coupon codes on lines whether or not the coupon discounted them', async () => {
      const order = orderWith({ couponCodes: ['SAVE10'] });
      order.items[0].discounts = [{ id: 'coupon:SAVE10', amount: '10.00' }];
      order.items.push({ sku: 'other-sku', quantity: 1, price: { final: '50.00', currency: 'CAD' } });
      const lines = lineItems(await buildXml(order, journal));
      lines.forEach((line) => expect(promotionCodes(line)).toEqual(['(SAVE10)']));
    });

    test('stamps coupon codes after the VBND code on bundle children and on warranty lines', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      delete order.estimates?.discounts;
      order.couponCodes = ['WELCOME1'];
      const bundleJournal = loadJournal('journal-pp-bundle-warranty.ndjson');
      const lines = lineItems(await buildXml(order, bundleJournal));
      const warranty = lines.filter((line) => /UnitOfMeasure="Years"/.test(line));
      const children = lines.filter((line) => /UnitOfMeasure="Each"/.test(line));
      expect(warranty.length).toBeGreaterThan(0);
      expect(children.length).toBeGreaterThan(0);
      warranty.forEach((line) => expect(promotionCodes(line)).toEqual(['(WELCOME1)']));
      children.forEach((line) => expect(promotionCodes(line)).toEqual(['VBND10', '(WELCOME1)']));
    });

    // ── VBND Discount Reason Code at the order header ───────────────────────
    // Magento stamped the same promotion list on the order header and on every
    // line, so the VBND code of a virtual bundle must appear at both levels.

    const bundleJournal = loadJournal('journal-pp-bundle-warranty.ndjson');
    const bundleOrder = (overrides = {}) => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      delete order.estimates?.discounts;
      return { ...order, ...overrides };
    };
    // A second virtual bundle (VX3 + 24-ounce Tumbler, black) for multi-bundle carts.
    const vx3Bundle = (sku = '075886-04-VB') => ({
      sku,
      path: '/us/en_us/products/vx3-plus-24-ounce-tumbler',
      quantity: 1,
      name: 'VX3 + 24-ounce Tumbler',
      price: { final: '519.95', currency: 'USD' },
      bundleItems: [
        {
          sku, name: 'VX3', quantity: 1, price: { final: '490.56', currency: 'USD' }, taxAmount: '36.54',
        },
        {
          sku: '069836-VB', name: '24-ounce Tumbler', quantity: 1, price: { final: '29.39', currency: 'USD' }, taxAmount: '2.19',
        },
      ],
    });

    test('stamps the bundle VBND code on the order header when there are no coupons', async () => {
      const xml = await buildXml(bundleOrder(), bundleJournal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['VBND10']);
    });

    test('stamps the bundle VBND code on the header ahead of coupon codes', async () => {
      const xml = await buildXml(bundleOrder({ couponCodes: ['WELCOME1', 'SAVE10'] }), bundleJournal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['VBND10', '(WELCOME1)', '(SAVE10)']);
    });

    test('emits each bundle VBND code once on the header when a bundle line repeats', async () => {
      const order = bundleOrder();
      order.items.splice(1, 0, structuredClone(order.items[0]));
      const xml = await buildXml(order, bundleJournal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['VBND10']);
    });

    test('lists a VBND code per distinct bundle on the header, in line order', async () => {
      const order = bundleOrder();
      order.items.splice(1, 0, vx3Bundle());
      const xml = await buildXml(order, bundleJournal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['VBND10', 'VBND19']);
    });

    test('omits the header VBND code for a bundle with no mapped code', async () => {
      const order = bundleOrder({ couponCodes: ['WELCOME1'] });
      order.items[0].path = '/ca/en_ca/products/some-unmapped-bundle';
      const xml = await buildXml(order, bundleJournal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['(WELCOME1)']);
    });

    test('does not stamp a header VBND code for simple products', async () => {
      const xml = await buildXml(orderWith({}), journal);
      expect(promotionCodes(orderLevel(xml))).toEqual([]);
    });

    test.each([
      ['black', '075886-04-VB', 'VBND19'],
      ['white', '075924-04-VB', 'VBND19.1'],
    ])('stamps the VX3 + 24-ounce Tumbler %s VBND code on the header and both bundle lines', async (_color, sku, code) => {
      const order = bundleOrder();
      order.items = [vx3Bundle(sku)];
      const xml = await buildXml(order, bundleJournal);
      expect(promotionCodes(orderLevel(xml))).toEqual([code]);
      const lines = lineItems(xml);
      expect(lines).toHaveLength(2);
      lines.forEach((line) => expect(promotionCodes(line)).toEqual([code]));
    });

    // Propel 750 + Stainless Steel Container (VBND17*) and 2-Speed Immersion
    // Blender 4-Piece Bundle (VBND18): the code goes on the header and on every
    // bundle child line, in the US and Canada.
    test.each([
      ['Propel 750 + SS Container, Black', 'propel-750-plus-stainless-steel-container', '071395-VB', ['067891-VB', '071395-VB'], 'VBND17'],
      ['Propel 750 + SS Container, Red', 'propel-750-plus-stainless-steel-container', '073294-VB', ['067891-VB', '073294-VB'], 'VBND17.1'],
      ['Propel 750 + SS Container, White', 'propel-750-plus-stainless-steel-container', '073295-VB', ['067891-VB', '073295-VB'], 'VBND17.2'],
      ['Propel 750 + SS Container, Slate', 'propel-750-plus-stainless-steel-container', '073296-VB', ['067891-VB', '073296-VB'], 'VBND17.3'],
      ['2-Speed IB 4-Piece Bundle', '2-speed-immersion-blender-4-piece-bundle', '073511-VB', ['069812-VB', '069814-VB', '073511-VB'], 'VBND18'],
    ])('stamps the %s VBND code on the header and every bundle line', async (_label, urlKey, sku, childSkus, code) => {
      const order = bundleOrder();
      order.items = ['us/en_us', 'ca/en_us'].map((locale) => ({
        sku,
        path: `/${locale}/products/${urlKey}`,
        quantity: 1,
        name: urlKey,
        price: { final: '100.00', currency: 'USD' },
        bundleItems: childSkus.map((childSku) => ({
          sku: childSku, name: childSku, quantity: 1, price: { final: '10.00', currency: 'USD' }, taxAmount: '1.00',
        })),
      }));
      const xml = await buildXml(order, bundleJournal);
      // two bundle lines in the same cart share the code: one header entry
      expect(promotionCodes(orderLevel(xml))).toEqual([code]);
      const lines = lineItems(xml);
      expect(lines).toHaveLength(childSkus.length * 2);
      lines.forEach((line) => expect(promotionCodes(line)).toEqual([code]));
    });

    test('emits no line-level PromotionCode when the order has no coupons', async () => {
      const lines = lineItems(await buildXml(orderWith({}), journal));
      lines.forEach((line) => expect(line).not.toContain('<ns2:PromotionCode>'));
    });

    test('accepts a single coupon code string', async () => {
      const xml = await buildXml(orderWith({ couponCode: 'SAVE10' }), journal);
      expect(xml).toContain('<ns2:PromotionCode>(SAVE10)</ns2:PromotionCode>');
    });

    test('emits no PromotionCode or SalesPersonId when there are no coupons', async () => {
      const xml = await buildXml(orderWith({}), journal);
      expect(xml).not.toContain('<ns2:PromotionCode>');
      expect(xml).not.toContain('<ns2:SalesPersonId>');
    });

    test('sets SalesPersonId to the first CJ-prefixed code among several', async () => {
      const xml = await buildXml(orderWith({ couponCodes: ['SAVE10', '06-AFF1', '06-AFF2'] }), journal);
      expect(xml).toContain('<ns2:SalesPersonId>06-AFF1</ns2:SalesPersonId>');
      // every applied code is still recorded as a promotion
      expect(promotionCodes(orderLevel(xml))).toEqual(['(SAVE10)', '(06-AFF1)', '(06-AFF2)']);
    });

    test('omits SalesPersonId when no code matches the CJ prefix', async () => {
      const xml = await buildXml(orderWith({ couponCodes: ['SAVE10', 'IDME20'] }), journal);
      expect(xml).not.toContain('<ns2:SalesPersonId>');
    });

    test('falls back to estimates.discounts for orders without the coupon fields', async () => {
      const order = structuredClone(CC_APPROVED_ORDER);
      order.estimates.discounts = [
        { id: 'coupon:06-LEGACY', amount: 25, source: 'coupon' },
        { id: 'free-shipping', amount: 0, freeShipping: true, source: 'pricing_rule' },
      ];
      const xml = await buildXml(order, journal);
      expect(xml).toContain('<ns2:PromotionCode>(06-LEGACY)</ns2:PromotionCode>');
      expect(xml).toContain('<ns2:SalesPersonId>06-LEGACY</ns2:SalesPersonId>');
    });

    test('falls back to custom.affiliateCode when no applied coupon has the CJ prefix', async () => {
      const xml = await buildXml(orderWith({
        couponCodes: ['SAVE10'],
        custom: { affiliateCode: '06-AFF1' },
      }), journal);
      expect(xml).toContain('<ns2:SalesPersonId>06-AFF1</ns2:SalesPersonId>');
      // the affiliate code is not reported as an applied promotion
      expect(promotionCodes(xml)).toEqual(['(SAVE10)', '(SAVE10)']);
    });

    test('uses custom.affiliateCode when the order has no coupons', async () => {
      const xml = await buildXml(orderWith({ custom: { affiliateCode: '06-AFF1' } }), journal);
      expect(xml).toContain('<ns2:SalesPersonId>06-AFF1</ns2:SalesPersonId>');
      expect(xml).not.toContain('<ns2:PromotionCode>');
    });

    test('prefers an applied CJ-prefixed coupon over custom.affiliateCode', async () => {
      const xml = await buildXml(orderWith({
        couponCodes: ['06-APPLIED'],
        custom: { affiliateCode: '06-OTHER' },
      }), journal);
      expect(xml).toContain('<ns2:SalesPersonId>06-APPLIED</ns2:SalesPersonId>');
    });

    test('ignores custom.affiliateCode without the CJ prefix', async () => {
      const xml = await buildXml(orderWith({ custom: { affiliateCode: 'SAVE10' } }), journal);
      expect(xml).not.toContain('<ns2:SalesPersonId>');
    });

    test('XML-escapes coupon codes', async () => {
      const xml = await buildXml(orderWith({ couponCodes: ['A&B'] }), journal);
      expect(xml).toContain('<ns2:PromotionCode>(A&amp;B)</ns2:PromotionCode>');
    });

    // ── "{name} ({code})" coupon format ──────────────────────────────────────
    // Each coupon goes out as its coupon type name, shortened to the discount it
    // describes, followed by the code in parentheses, on the header and every
    // line. The name is the one stored on the order's coupon discount entry.

    const couponDiscount = (code, name) => ({
      id: `coupon:${code}`, name, amount: 25, source: 'coupon',
    });

    test('sends "{short name} ({code})" on the header and every line', async () => {
      const name = '#974 US 2026 MAIN Email Offer - $25 off orders over $200 - WELCOME, TEXT (SMS)';
      const expected = '$25 off orders over $200 (WELCOME431705)';
      const order = orderWith({
        couponCodes: ['WELCOME431705'],
        estimates: {
          ...CC_APPROVED_ORDER.estimates,
          discounts: [couponDiscount('WELCOME431705', name)],
        },
      });
      order.items.push({ sku: 'other-sku', quantity: 1, price: { final: '50.00', currency: 'CAD' } });
      const xml = await buildXml(order, journal);
      expect(promotionCodes(orderLevel(xml))).toEqual([expected]);
      const lines = lineItems(xml);
      expect(lines).toHaveLength(2);
      lines.forEach((line) => expect(promotionCodes(line)).toEqual([expected]));
    });

    describe('shortenCouponName', () => {
      test.each([
        ['#974 US 2026 MAIN Email Offer - $25 off orders over $200 - WELCOME, TEXT (SMS)', '$25 off orders over $200'],
        ['#971 CA 2026 MAIN Email Offer - $20 off orders over $300 - WEL (Welcome)', '$20 off orders over $300'],
        ['#821 Anniversary Discount - $150 off order', '$150 off order'],
        ['Staff Codes - 40% off New/Recons + Accessories', '40% off New/Recons + Accessories'],
        ['#888 Spotlight Offer - US/CA $150 off VX1 PARTNER$', '$150 off VX1 PARTNER$'],
        ['#955 Partners - Standard 15% off PARTNER@CODE$1', '15% off PARTNER@CODE$1'],
        ['#1127 $25 off Cup/Bowl Starter Kit', '$25 off Cup/Bowl Starter Kit'],
        ['#12 Big Sale - $1,000.50 Off a Blender', '$1,000.50 Off a Blender'],
        ['#7 Promo - 12.5 % off everything', '12.5 % off everything'],
        ['$25 Off $200', '$25 Off $200'],
        ['#40 Rewards - Free Tumbler - RWD1 - US', 'Free Tumbler'],
        ['#41 Spring - FREE shipping on blenders', 'FREE shipping on blenders'],
        ['#42 Spring - Free Tumbler - $10 off a blender', '$10 off a blender'],
      ])('keeps the discount part of %j', (name, expected) => {
        expect(shortenCouponName(name)).toBe(expected);
      });

      test.each([
        [
          'at a word boundary',
          '#43 Get a Tumbler for $5 when you buy a Blender and a Container',
          'Get a Tumbler for $5 when you buy a Blender and a',
        ],
        [
          'without a trailing separator',
          '#44 Partner Accounts - Regional Portal Program -- Extra Words',
          'Partner Accounts - Regional Portal Program',
        ],
        [
          'mid-word when no space falls in the second half',
          'Supercalifragilisticexpialidociously-long-single-word-coupon-name',
          'Supercalifragilisticexpialidociously-long-single-w',
        ],
        [
          'a long discount part',
          '#45 Promo - $25 off any blender, container, accessory or cookbook in the store',
          '$25 off any blender, container, accessory or',
        ],
      ])('caps a long name %s', (_label, name, expected) => {
        const short = shortenCouponName(name);
        expect(short).toBe(expected);
        expect(short.length).toBeLessThanOrEqual(COUPON_NAME_MAX_LENGTH);
      });

      test('keeps a name of exactly the maximum length', () => {
        const name = `Partner ${'x'.repeat(COUPON_NAME_MAX_LENGTH - 8)}`;
        expect(shortenCouponName(name)).toBe(name);
      });

      test.each([
        ['#253 Partner Accounts - US Portal PARTNERCODE', 'Partner Accounts - US Portal PARTNERCODE'],
        ['#322 Partner $70 CODE3 abc123', 'Partner $70 CODE3 abc123'],
        ['#669 Friends and Family', 'Friends and Family'],
        ['#1124 Giveaway - VX3 (White)', 'Giveaway - VX3 (White)'],
        ['Affiliates Deal Group', 'Affiliates Deal Group'],
        ['IDME', 'IDME'],
        ['#12', '#12'],
        ['Offer - takeoff kit', 'Offer - takeoff kit'],
        ['', ''],
      ])('keeps %j without its id when no part names a discount', (name, expected) => {
        expect(shortenCouponName(name)).toBe(expected);
      });
    });

    test('names each of several coupons, in the order applied', async () => {
      const order = orderWith({
        couponCodes: ['SAVE10', 'IDME20'],
        estimates: {
          ...CC_APPROVED_ORDER.estimates,
          discounts: [couponDiscount('IDME20', 'ID.me 20%'), couponDiscount('SAVE10', '$10 Off')],
        },
      });
      const xml = await buildXml(order, journal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['$10 Off (SAVE10)', 'ID.me 20% (IDME20)']);
    });

    test('sends "%" in coupon names through the proxy unchanged', async () => {
      // A raw '%' (not followed by two hex digits) made the proxy's URL-decode
      // throw; a valid escape like %25 or %20 would be silently decoded.
      const name = '40% off New/Recons + Accessories %25 %20 100%';
      const order = orderWith({
        couponCodes: ['PCT40'],
        estimates: { ...CC_APPROVED_ORDER.estimates, discounts: [couponDiscount('PCT40', name)] },
      });
      const xml = await buildXml(order, journal);
      expect(promotionCodes(orderLevel(xml))).toEqual([`${name} (PCT40)`]);
    });

    test('names a coupon derived from estimates.discounts alone', async () => {
      const order = structuredClone(CC_APPROVED_ORDER);
      order.estimates.discounts = [
        couponDiscount('06-LEGACY', 'Affiliate 10%'),
        { id: 'free-shipping', name: 'Free Shipping', amount: 0, freeShipping: true, source: 'pricing_rule' },
      ];
      const xml = await buildXml(order, journal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['Affiliate 10% (06-LEGACY)']);
      // SalesPersonId keeps the bare code
      expect(xml).toContain('<ns2:SalesPersonId>06-LEGACY</ns2:SalesPersonId>');
    });

    test('falls back to "({code})" when the coupon has no or a blank name', async () => {
      const order = orderWith({
        couponCodes: ['SAVE10', 'IDME20'],
        estimates: {
          ...CC_APPROVED_ORDER.estimates,
          discounts: [couponDiscount('SAVE10', '   '), { id: 'coupon:IDME20', amount: 5, source: 'coupon' }],
        },
      });
      const xml = await buildXml(order, journal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['(SAVE10)', '(IDME20)']);
    });

    test('trims the coupon name and XML-escapes it', async () => {
      const order = orderWith({
        couponCodes: ['BOGO'],
        estimates: {
          ...CC_APPROVED_ORDER.estimates,
          discounts: [couponDiscount('BOGO', '  Buy 1 & Get <1>  ')],
        },
      });
      const xml = await buildXml(order, journal);
      expect(xml).toContain('<ns2:PromotionCode>Buy 1 &amp; Get &lt;1&gt; (BOGO)</ns2:PromotionCode>');
    });

    test('names the coupon after the VBND code on bundle children and on warranty lines', async () => {
      const order = bundleOrder({
        couponCodes: ['WELCOME1'],
        estimates: {
          ...PP_BUNDLE_WARRANTY_ORDER.estimates,
          discounts: [couponDiscount('WELCOME1', '$25 Off $200')],
        },
      });
      const xml = await buildXml(order, bundleJournal);
      expect(promotionCodes(orderLevel(xml))).toEqual(['VBND10', '$25 Off $200 (WELCOME1)']);
      const lines = lineItems(xml);
      const warranty = lines.filter((line) => /UnitOfMeasure="Years"/.test(line));
      const children = lines.filter((line) => /UnitOfMeasure="Each"/.test(line));
      expect(warranty.length).toBeGreaterThan(0);
      expect(children.length).toBeGreaterThan(0);
      warranty.forEach((line) => expect(promotionCodes(line)).toEqual(['$25 Off $200 (WELCOME1)']));
      children.forEach((line) => expect(promotionCodes(line)).toEqual(['VBND10', '$25 Off $200 (WELCOME1)']));
    });

    // ── Gift-with-purchase (GWP) promotions ──────────────────────────────────
    // Magento treated a free-gift rule like any other applied cart rule, so its
    // name appeared as a PromotionCode on the header and on every line, ahead of
    // the VBND code and the coupons. Edge records the gifts a cart qualified for
    // in estimates.freeItems; only promotions whose gift is actually in the
    // order (a $0 line at the granted path) are sent. The name comes from the
    // gift line's custom.promotionName, falling back to the grant's ruleId.

    describe('gift-with-purchase promotions', () => {
      const GWP_PATH = '/us/en_us/products/cookbook';
      const GWP_NAME = '(US) Pre-Holiday 2026 GWP';
      const GWP_RULE_ID = 'us-pre-holiday-2026-gwp';

      const freeItem = (overrides = {}) => ({
        path: GWP_PATH, ruleId: GWP_RULE_ID, quantity: 1, ...overrides,
      });
      const giftCustom = (overrides = {}) => ({
        giftWithPurchase: true, promotionId: GWP_RULE_ID, promotionName: GWP_NAME, ...overrides,
      });
      const giftLine = (overrides = {}) => ({
        sku: 'gift-sku',
        path: GWP_PATH,
        quantity: 1,
        name: 'Cookbook',
        price: { final: '0', currency: 'CAD' },
        custom: giftCustom(),
        ...overrides,
      });
      const lineSku = (line) => line.match(/Sku="([^"]*)"/)[1];

      /** CC order plus $0 gift lines, with the given estimates.freeItems. */
      const gwpOrder = (freeItems, { gifts = [giftLine()], ...overrides } = {}) => {
        const order = orderWith(overrides);
        order.estimates = { ...order.estimates, freeItems };
        order.items = [...order.items, ...gifts];
        return order;
      };
      const withGiftCustom = (custom) => gwpOrder([freeItem()], { gifts: [giftLine({ custom })] });
      const headerCodes = async (order) => promotionCodes(orderLevel(await buildXml(order, journal)));

      test('sends the promotion name on the header and on every line, including the gift line', async () => {
        const xml = await buildXml(gwpOrder([freeItem()]), journal);
        expect(promotionCodes(orderLevel(xml))).toEqual([GWP_NAME]);
        const lines = lineItems(xml);
        expect(lines.map(lineSku)).toEqual(['068051-04', 'gift-sku']);
        lines.forEach((line) => expect(promotionCodes(line)).toEqual([GWP_NAME]));
      });

      test('sends the name without parentheses, since it is not a coupon', async () => {
        const xml = await buildXml(withGiftCustom(giftCustom({ promotionName: 'Free Cookbooks' })), journal);
        expect(xml).toContain('<ns2:PromotionCode>Free Cookbooks</ns2:PromotionCode>');
        expect(xml).not.toContain('Free Cookbooks(');
        expect(xml).not.toContain('(Free Cookbooks)');
      });

      test('trims the promotion name', async () => {
        expect(await headerCodes(withGiftCustom(giftCustom({ promotionName: '  Free Cookbooks  ' }))))
          .toEqual(['Free Cookbooks']);
      });

      describe('spending threshold', () => {
        test('sends "GWP {threshold}" from the grant, rounded down, instead of the name', async () => {
          const xml = await buildXml(gwpOrder([freeItem({ minimumSubtotal: 299.95 })]), journal);
          expect(promotionCodes(orderLevel(xml))).toEqual(['GWP 299']);
          lineItems(xml).forEach((line) => expect(promotionCodes(line)).toEqual(['GWP 299']));
        });

        test('sends a whole-dollar threshold as is', async () => {
          expect(await headerCodes(gwpOrder([freeItem({ minimumSubtotal: 400 })]))).toEqual(['GWP 400']);
        });

        test('does not need or check the client promotion name', async () => {
          const order = gwpOrder([freeItem({ minimumSubtotal: 399.95 })], {
            gifts: [giftLine({ custom: giftCustom({ promotionName: 'Free\nGift' }) })],
          });
          expect(resolveGwpPromotions(order)).toEqual({ codes: ['GWP 399'], issues: [], missing: [] });
        });

        test.each([
          ['zero', 0],
          ['below one dollar', 0.5],
          ['negative', -5],
          ['a string', '299.95'],
          ['not finite', Infinity],
          ['null', null],
        ])('falls back to the promotion name when the threshold is %s', async (_label, minimumSubtotal) => {
          expect(await headerCodes(gwpOrder([freeItem({ minimumSubtotal })]))).toEqual([GWP_NAME]);
        });

        test('sends one value for two promotions with the same name and no threshold', async () => {
          const otherPath = '/us/en_us/products/tumbler';
          const order = gwpOrder([freeItem(), freeItem({ path: otherPath, ruleId: 'second-gwp' })], {
            gifts: [
              giftLine(),
              giftLine({ sku: 'tumbler-sku', path: otherPath, custom: giftCustom({ promotionId: 'second-gwp' }) }),
            ],
          });
          expect(await headerCodes(order)).toEqual([GWP_NAME]);
        });

        test('sends one value for two promotions at the same threshold', async () => {
          const otherPath = '/us/en_us/products/tumbler';
          const order = gwpOrder([
            freeItem({ minimumSubtotal: 299.95 }),
            freeItem({ path: otherPath, ruleId: 'second-gwp', minimumSubtotal: 299 }),
          ], {
            gifts: [
              giftLine(),
              giftLine({ sku: 'tumbler-sku', path: otherPath, custom: giftCustom({ promotionId: 'second-gwp' }) }),
            ],
          });
          expect(await headerCodes(order)).toEqual(['GWP 299']);
        });

        test('sends each tier, in freeItems order, ahead of the coupon', async () => {
          const otherPath = '/us/en_us/products/tumbler';
          const order = gwpOrder([
            freeItem({ path: otherPath, ruleId: 'second-gwp', minimumSubtotal: 399.95 }),
            freeItem({ minimumSubtotal: 299.95 }),
          ], {
            gifts: [
              giftLine(),
              giftLine({ sku: 'tumbler-sku', path: otherPath, custom: giftCustom({ promotionId: 'second-gwp' }) }),
            ],
            couponCodes: ['WELCOMEW84'],
          });
          order.estimates.discounts = [couponDiscount(
            'WELCOMEW84',
            '#974 US 2026 MAIN Email Offer - $25 off orders over $200 - WELCOME, TEXT (SMS)',
          )];
          expect(await headerCodes(order))
            .toEqual(['GWP 399', 'GWP 299', '$25 off orders over $200 (WELCOMEW84)']);
        });
      });

      test('ignores a name on the grant itself', async () => {
        expect(await headerCodes(gwpOrder([freeItem({ name: 'Server Name' })]))).toEqual([GWP_NAME]);
      });

      describe('missing or invalid custom data falls back to the ruleId', () => {
        test.each([
          ['no promotionName (orders placed before it was recorded)', giftCustom({ promotionName: undefined })],
          ['a null promotionName', giftCustom({ promotionName: null })],
          ['no custom data at all', undefined],
          ['custom data that is not an object', 'gift'],
          ['a blank promotionName', giftCustom({ promotionName: '   ' })],
          ['an empty promotionName', giftCustom({ promotionName: '' })],
          ['a numeric promotionName', giftCustom({ promotionName: 42 })],
          ['an object promotionName', giftCustom({ promotionName: { en: GWP_NAME } })],
          ['an array promotionName', giftCustom({ promotionName: [GWP_NAME] })],
          ['a promotionName with a newline', giftCustom({ promotionName: 'Free\nGift' })],
          ['a promotionName with a NUL character', giftCustom({ promotionName: 'Free\u0000Gift' })],
          ['a promotionName over 240 characters', giftCustom({ promotionName: 'x'.repeat(241) })],
          ['a promotionName with U+FFFF', giftCustom({ promotionName: 'Free Gift\uFFFF' })],
          ['a promotionName with U+FFFE', giftCustom({ promotionName: '\uFFFEFree Gift' })],
          ['a promotionName of only XML-invalid characters', giftCustom({ promotionName: '\uFFFF\uFFFF' })],
          ['a promotionName with an unpaired surrogate', giftCustom({ promotionName: 'Free \uD800Gift' })],
          ['no promotionId', giftCustom({ promotionId: undefined })],
        ])('with %s', async (_label, custom) => {
          const xml = await buildXml(withGiftCustom(custom), journal);
          expect(promotionCodes(orderLevel(xml))).toEqual([GWP_RULE_ID]);
          lineItems(xml).forEach((line) => expect(promotionCodes(line)).toEqual([GWP_RULE_ID]));
        });
      });

      test('accepts a promotionName of exactly 240 characters', async () => {
        const name = 'x'.repeat(240);
        expect(await headerCodes(withGiftCustom(giftCustom({ promotionName: name })))).toEqual([name]);
      });

      test('ignores the client gift flag: a granted $0 line is a gift without it', async () => {
        expect(await headerCodes(withGiftCustom(giftCustom({ giftWithPurchase: undefined }))))
          .toEqual([GWP_NAME]);
      });

      test('skips a grant without a ruleId', async () => {
        const xml = await buildXml(gwpOrder([freeItem({ ruleId: '  ' })]), journal);
        expect(xml).not.toContain('<ns2:PromotionCode>');
      });

      test('does not send a qualified promotion whose gift is not in the order', async () => {
        const xml = await buildXml(gwpOrder([freeItem()], { gifts: [] }), journal);
        expect(xml).not.toContain('<ns2:PromotionCode>');
      });

      test('does not send a promotion whose gift path is only present as a paid line', async () => {
        const paidLine = giftLine({ price: { final: '19.95', currency: 'CAD' } });
        const xml = await buildXml(gwpOrder([freeItem()], { gifts: [paidLine] }), journal);
        expect(xml).not.toContain('<ns2:PromotionCode>');
      });

      test('does not send a promotion whose grant path differs from the $0 line', async () => {
        const xml = await buildXml(
          gwpOrder([freeItem({ path: '/us/en_us/products/other-gift' })]),
          journal,
        );
        expect(xml).not.toContain('<ns2:PromotionCode>');
      });

      test('ignores a $0 line that the client flags as a gift but no grant covers', async () => {
        const order = orderWith({});
        order.items.push(giftLine());
        const xml = await buildXml(order, journal);
        expect(xml).not.toContain('<ns2:PromotionCode>');
      });

      test('ignores a $0 line when the order has no freeItems at all', async () => {
        const xml = await buildXml(gwpOrder(undefined), journal);
        expect(xml).not.toContain('<ns2:PromotionCode>');
      });

      test('sends only the promotions whose gift is in the order, in freeItems order', async () => {
        const otherPath = '/us/en_us/products/tumbler';
        const missingPath = '/us/en_us/products/spatula';
        const order = gwpOrder([
          freeItem({ path: missingPath, ruleId: 'missing-gwp' }),
          freeItem({ path: otherPath, ruleId: 'second-gwp' }),
          freeItem(),
        ], {
          // gift lines appear in the opposite order to the grants
          gifts: [
            giftLine(),
            giftLine({
              sku: 'tumbler-sku',
              path: otherPath,
              custom: giftCustom({ promotionId: 'second-gwp', promotionName: 'Free Tumbler' }),
            }),
          ],
        });
        expect(await headerCodes(order)).toEqual(['Free Tumbler', GWP_NAME]);
      });

      test('matches each promotion to its own line when two grant the same product', async () => {
        const order = gwpOrder([freeItem({ ruleId: 'first-gwp' }), freeItem()], {
          gifts: [
            giftLine(),
            giftLine({ custom: giftCustom({ promotionId: 'first-gwp', promotionName: 'First' }) }),
          ],
        });
        expect(await headerCodes(order)).toEqual(['First', GWP_NAME]);
      });

      test('emits one value per promotion when it grants several gift lines', async () => {
        const secondPath = '/us/en_us/products/cookbook-2';
        const order = gwpOrder([freeItem(), freeItem({ path: secondPath })], {
          gifts: [giftLine(), giftLine({ sku: 'gift-sku-2', path: secondPath })],
        });
        const xml = await buildXml(order, journal);
        expect(promotionCodes(orderLevel(xml))).toEqual([GWP_NAME]);
        const lines = lineItems(xml);
        expect(lines).toHaveLength(3);
        lines.forEach((line) => expect(promotionCodes(line)).toEqual([GWP_NAME]));
      });

      test('emits one value when the same grant is repeated', async () => {
        expect(await headerCodes(gwpOrder([freeItem(), freeItem()]))).toEqual([GWP_NAME]);
      });

      test('matches a grant path that carries a .json suffix', async () => {
        expect(await headerCodes(gwpOrder([freeItem({ path: `${GWP_PATH}.json` })]))).toEqual([GWP_NAME]);
      });

      test('matches a gift line path that carries a .json suffix', async () => {
        const order = gwpOrder([freeItem()], { gifts: [giftLine({ path: `${GWP_PATH}.json` })] });
        expect(await headerCodes(order)).toEqual([GWP_NAME]);
      });

      test.each([
        ['numeric 0', 0],
        ['"0.00"', '0.00'],
      ])('treats a %s final price as a gift', async (_label, final) => {
        const order = gwpOrder([freeItem()], {
          gifts: [giftLine({ price: { final, currency: 'CAD' } })],
        });
        expect(await headerCodes(order)).toEqual([GWP_NAME]);
      });

      test('does not treat a line with no price as a gift', async () => {
        const order = gwpOrder([freeItem()], { gifts: [giftLine({ price: undefined })] });
        const xml = await buildXml(order, journal);
        expect(xml).not.toContain('<ns2:PromotionCode>');
      });

      test.each([
        ['a string', 'nope'],
        ['an object', { path: GWP_PATH }],
        ['non-object entries', [null, 'x', 7, {}]],
      ])('tolerates freeItems that is %s', async (_label, freeItems) => {
        const xml = await buildXml(gwpOrder(freeItems), journal);
        expect(xml).not.toContain('<ns2:PromotionCode>');
      });

      test('tolerates null order lines', async () => {
        const order = gwpOrder([freeItem()]);
        order.items.push(null);
        expect(resolveGwpPromotions(order).codes).toEqual([GWP_NAME]);
      });

      test('XML-escapes the promotion name', async () => {
        const xml = await buildXml(
          withGiftCustom(giftCustom({ promotionName: 'Buy 1 & Get <1> "Free"' })),
          journal,
        );
        expect(xml).toContain(
          '<ns2:PromotionCode>Buy 1 &amp; Get &lt;1&gt; &quot;Free&quot;</ns2:PromotionCode>',
        );
      });

      test('puts the GWP before the coupon on the header and on simple lines', async () => {
        const order = gwpOrder([freeItem()], {
          gifts: [giftLine({ custom: giftCustom({ promotionName: 'Free Cookbooks' }) })],
          couponCodes: ['WELCOMEW84'],
        });
        order.estimates.discounts = [couponDiscount('WELCOMEW84', '$25 Off $200')];
        const xml = await buildXml(order, journal);
        const expected = ['Free Cookbooks', '$25 Off $200 (WELCOMEW84)'];
        expect(promotionCodes(orderLevel(xml))).toEqual(expected);
        const lines = lineItems(xml);
        expect(lines.map(lineSku)).toEqual(['068051-04', 'gift-sku']);
        lines.forEach((line) => expect(promotionCodes(line)).toEqual(expected));
      });

      test('orders GWP, then VBND, then coupon across header, bundle, warranty, simple and gift lines', async () => {
        const order = bundleOrder({
          couponCodes: ['WELCOME1'],
          estimates: {
            ...PP_BUNDLE_WARRANTY_ORDER.estimates,
            discounts: [couponDiscount('WELCOME1', '$25 Off $200')],
          },
        });
        order.estimates.freeItems = [freeItem()];
        order.items.push(
          { sku: 'simple-sku', quantity: 1, price: { final: '50.00', currency: 'CAD' } },
          giftLine(),
        );
        const xml = await buildXml(order, bundleJournal);
        const coupon = '$25 Off $200 (WELCOME1)';

        expect(promotionCodes(orderLevel(xml))).toEqual([GWP_NAME, 'VBND10', coupon]);

        const lines = lineItems(xml);
        const byUnit = (unit) => lines.filter((line) => line.includes(`UnitOfMeasure="${unit}"`));
        const warranty = byUnit('Years');
        const eachLines = byUnit('Each');
        const bundleChildren = eachLines.filter((line) => /Sku="(061724-04|069834|060488|001372-1093)"/.test(line));
        const simple = eachLines.filter((line) => lineSku(line) === 'simple-sku');
        const gift = eachLines.filter((line) => lineSku(line) === 'gift-sku');

        expect(bundleChildren).toHaveLength(4);
        expect(warranty).toHaveLength(1);
        expect(simple).toHaveLength(1);
        expect(gift).toHaveLength(1);
        bundleChildren.forEach((line) => expect(promotionCodes(line)).toEqual([GWP_NAME, 'VBND10', coupon]));
        warranty.forEach((line) => expect(promotionCodes(line)).toEqual([GWP_NAME, coupon]));
        simple.forEach((line) => expect(promotionCodes(line)).toEqual([GWP_NAME, coupon]));
        gift.forEach((line) => expect(promotionCodes(line)).toEqual([GWP_NAME, coupon]));
      });

      test('puts the GWP ahead of the VBND code when there is no coupon', async () => {
        const order = bundleOrder();
        order.estimates = { ...order.estimates, freeItems: [freeItem()] };
        order.items.push(giftLine());
        const xml = await buildXml(order, bundleJournal);
        expect(promotionCodes(orderLevel(xml))).toEqual([GWP_NAME, 'VBND10']);
        const lines = lineItems(xml);
        lines.filter((line) => line.includes('UnitOfMeasure="Years"'))
          .forEach((line) => expect(promotionCodes(line)).toEqual([GWP_NAME]));
        lines.filter((line) => /Sku="061724-04"/.test(line))
          .forEach((line) => expect(promotionCodes(line)).toEqual([GWP_NAME, 'VBND10']));
      });

      test('keeps the gift line priced at zero and leaves SalesPersonId untouched', async () => {
        const order = gwpOrder([freeItem()], { couponCodes: ['06-AFF1'] });
        const xml = await buildXml(order, journal);
        const gift = lineItems(xml).find((line) => lineSku(line) === 'gift-sku');
        expect(gift).toMatch(/UnitSellingPrice="0\.00"/);
        expect(xml).toContain('<ns2:SalesPersonId>06-AFF1</ns2:SalesPersonId>');
      });

      describe('pairing grants with gift lines', () => {
        test('accepts a name with characters outside the BMP', () => {
          const name = 'Free Gift \u{1F381}';
          expect(resolveGwpPromotions(withGiftCustom(giftCustom({ promotionName: name }))).codes)
            .toEqual([name]);
        });

        test.each([
          ['another promotion', 'other-gwp'],
          ['a very long promotion id', 'y'.repeat(500)],
        ])('skips a grant whose only line names %s, without alerting', async (_label, promotionId) => {
          const order = withGiftCustom(giftCustom({ promotionId }));
          expect(resolveGwpPromotions(order)).toEqual({ codes: [], issues: [], missing: [] });
          const xml = await buildXml(order, journal);
          expect(xml).not.toContain('<ns2:PromotionCode>');
        });

        test('reports only the promotion whose gift is in the order when two share a product', () => {
          // A's gift is in the order; B (listed second) qualified but its gift was not kept.
          const order = gwpOrder([freeItem(), freeItem({ ruleId: 'b-gwp' })]);
          expect(resolveGwpPromotions(order)).toEqual({ codes: [GWP_NAME], issues: [], missing: [] });
        });

        test('skips a grant whose shared gift line belongs to another promotion', async () => {
          // B is listed first but only A's gift is in the order.
          const order = gwpOrder([freeItem({ ruleId: 'b-gwp' }), freeItem()]);
          const result = resolveGwpPromotions(order);
          expect(result).toEqual({ codes: [GWP_NAME], issues: [], missing: [] });
        });

        test('uses one unlabelled gift line for only one of two grants', () => {
          const order = gwpOrder([freeItem({ ruleId: 'a-gwp' }), freeItem({ ruleId: 'b-gwp' })], {
            gifts: [giftLine({ custom: undefined })],
          });
          expect(resolveGwpPromotions(order).codes).toEqual(['a-gwp']);
        });

        test('gives each of two lines to a different grant', () => {
          const order = gwpOrder([freeItem({ ruleId: 'a-gwp' }), freeItem({ ruleId: 'b-gwp' })], {
            gifts: [
              giftLine({ custom: giftCustom({ promotionId: 'b-gwp', promotionName: 'B' }) }),
              giftLine({ custom: undefined }),
            ],
          });
          expect(resolveGwpPromotions(order).codes).toEqual(['a-gwp', 'B']);
        });
      });

      describe('reporting', () => {
        test('syncOrderToEbs returns no problems for a valid gift line', async () => {
          const result = await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, gwpOrder([freeItem()]), journal);
          expect(result.gwp).toEqual({ issues: [], missing: [] });
        });

        test('reports a missing name separately from invalid data', () => {
          const result = resolveGwpPromotions(withGiftCustom(giftCustom({ promotionName: undefined })));
          expect(result).toEqual({ codes: [GWP_RULE_ID], issues: [], missing: [GWP_RULE_ID] });
        });

        test.each([
          ['blank', giftCustom({ promotionName: ' ' }), 'custom.promotionName is blank'],
          ['not a string', giftCustom({ promotionName: 42 }), 'custom.promotionName is a number, not a string'],
          ['control characters', giftCustom({ promotionName: 'a\tb' }), 'custom.promotionName contains control characters'],
          ['too long', giftCustom({ promotionName: 'x'.repeat(300) }), 'custom.promotionName is 300 characters (max 240)'],
          ['U+FFFF', giftCustom({ promotionName: 'Gift\uFFFF' }), 'custom.promotionName contains characters XML does not allow'],
          ['only XML-invalid characters', giftCustom({ promotionName: '\uFFFF\uFFFF' }), 'custom.promotionName contains characters XML does not allow'],
          ['no promotion id', giftCustom({ promotionId: undefined }), 'custom.promotionId null does not match the granting promotion'],
        ])('reports invalid data (%s) with the line and the fallback', (_label, custom, reason) => {
          const result = resolveGwpPromotions(withGiftCustom(custom));
          expect(result.codes).toEqual([GWP_RULE_ID]);
          expect(result.missing).toEqual([]);
          expect(result.issues).toEqual([
            `gift-with-purchase ${GWP_RULE_ID} (gift-sku): ${reason}; sent the promotion id instead`,
          ]);
        });

        test('syncOrderToEbs returns the problems with the sent order', async () => {
          const order = withGiftCustom(giftCustom({ promotionName: '' }));
          const result = await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
          expect(result.gwp.issues).toHaveLength(1);
          expect(promotionCodes(orderLevel(result.xml))).toEqual([GWP_RULE_ID]);
        });
      });
    });
  });

  // ── Warranty VitamixProductId lookup ────────────────────────────────────

  // ── Client-supplied values ──────────────────────────────────────────────
  // Custom data and most order fields come from the browser. Whatever they
  // hold, the request must stay well-formed and carry them as text only.

  describe('client-supplied values', () => {
    const journal = loadJournal('journal-cc-approved.ndjson');
    const INJECT = `x"'</ns2:PromotionCode><evil a="1"/>]]><![CDATA[&amp;&#x3c;`;
    // Ends with a low then a high surrogate: both unpaired.
    const INVALID_CHARS = '\u0000\u0001\u0008\u000B\u001F\uFFFE\uFFFF\uDFFF\uD800';

    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    /** Every element name in a parsed document. */
    const elementNames = (node, out = new Set()) => {
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (!key.startsWith('@_') && key !== '#text') out.add(key);
          (Array.isArray(value) ? value : [value]).forEach((v) => elementNames(v, out));
        }
      }
      return out;
    };

    /** CC order with every client-reachable string set to `value`. */
    const hostileOrder = (value) => {
      const order = structuredClone(CC_APPROVED_ORDER);
      const address = (base) => ({
        ...base,
        id: value,
        name: value,
        address1: value,
        address2: value,
        city: value,
        state: value,
        zip: value,
        phone: value,
      });
      order.customer = { ...order.customer, firstName: value, lastName: value, email: value, phone: value };
      order.shipping = address(order.shipping);
      order.billing = address(order.billing ?? order.shipping);
      order.giftMessage = value;
      order.couponCodes = [`06-${value}`];
      order.custom = { affiliateCode: `06-${value}`, note: value };
      order.estimates = {
        ...order.estimates,
        discounts: [{ id: `coupon:06-${value}`, name: value, amount: 1, source: 'coupon' }],
        freeItems: [{ path: '/us/en_us/products/gift', ruleId: 'gwp-1', quantity: 1 }],
      };
      order.items = [
        ...order.items.map((item) => ({
          ...item,
          custom: { ...item.custom, categories: [value, { name: value }], isCommercial: value },
        })),
        {
          sku: '001314',
          path: '/us/en_us/products/warranty',
          quantity: 1,
          price: { final: '10.00', currency: 'USD' },
          custom: { linkedTo: order.items[0].sku, coverageYears: value },
        },
        {
          sku: 'gift-sku',
          path: '/us/en_us/products/gift',
          quantity: 1,
          price: { final: '0', currency: 'USD' },
          custom: { giftWithPurchase: true, promotionId: 'gwp-1', promotionName: value },
        },
      ];
      return order;
    };

    test.each([
      ['markup and entity text', INJECT],
      ['characters XML does not allow', `a${INVALID_CHARS}b`],
      ['both', `${INJECT}${INVALID_CHARS}`],
    ])('keeps the request well-formed with %s in every client field', async (_label, value) => {
      const xml = await buildXml(hostileOrder(value), journal);
      expect(XMLValidator.validate(xml)).toBe(true);
      const names = elementNames(parser.parse(xml));
      expect(names.has('evil')).toBe(false);
      expect(xml).not.toMatch(/<evil\b/);
      // eslint-disable-next-line no-control-regex
      expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/);
      expect(xml).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });

    test('carries custom values as escaped text', async () => {
      const xml = await buildXml(hostileOrder(INJECT), journal);
      const doc = new XMLParser({ removeNSPrefix: true, processEntities: true, htmlEntities: false })
        .parse(xml);
      const order = doc.Envelope.Body.CreateRequest.Order;
      // Parsed back, the value is exactly what the client sent.
      expect(order.SalesPersonId).toBe(`06-${INJECT}`);
      expect(xml).toContain(
        '<ns2:PromotionCode>x&quot;&apos;&lt;/ns2:PromotionCode&gt;&lt;evil a=&quot;1&quot;/&gt;]]&gt;&lt;![CDATA[&amp;amp;&amp;#x3c;</ns2:PromotionCode>',
      );
    });

    test('drops characters XML does not allow from custom values', async () => {
      const xml = await buildXml(hostileOrder(`A${INVALID_CHARS}B`), journal);
      expect(xml).toContain('<ns2:SalesPersonId>06-AB</ns2:SalesPersonId>');
    });

    test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
      'does not resolve %s through Object.prototype',
      async (key) => {
        const order = hostileOrder('v');
        order.shipping.country = key;
        order.billing.country = key;
        order.country = key;
        const warranty = order.items.find((i) => i.custom?.linkedTo);
        warranty.sku = key;
        const xml = await buildXml(order, journal);
        expect(XMLValidator.validate(xml)).toBe(true);
        expect(xml).not.toContain('[native code]');
      },
    );
  });

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

    test('string "Commercial" category produces Type="Commercial"', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items[0].custom = { categories: ['Kitchen', 'Commercial'] };
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      expect(capturedXml).toMatch(/Type="Commercial"/);
    });

    test('object "Commercial" category (name/url_key) produces Type="Commercial"', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items[0].custom = {
        categories: [
          { name: 'Kitchen', url_key: 'kitchen' },
          { name: 'Commercial', url_key: 'commercial' },
        ],
      };
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      expect(capturedXml).toMatch(/Type="Commercial"/);
    });

    test('"Commercial" category match is case-insensitive', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items[0].custom = { categories: ['commercial'] };
      order.items[1].custom = { categories: [{ name: 'COMMERCIAL', url_key: 'commercial' }] };
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      expect(capturedXml).toMatch(/Type="Commercial"/);
    });

    test('non-commercial categories leave Type="Household"', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      order.items[0].custom = {
        categories: ['Kitchen', { name: 'Household', url_key: 'household' }],
      };
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      expect(capturedXml).toMatch(/Type="Household"/);
    });

    test('malformed categories are ignored and leave Type="Household"', async () => {
      const order = structuredClone(PP_BUNDLE_WARRANTY_ORDER);
      // categories not an array, plus null/non-object/missing-name entries
      order.items[0].custom = { categories: 'Commercial' };
      order.items[1].custom = {
        categories: [null, 42, { url_key: 'commercial' }, {}],
      };
      await syncOrderToEbs(MOCK_CTX, MOCK_PARAMS, order, journal);
      expect(capturedXml).toMatch(/Type="Household"/);
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
