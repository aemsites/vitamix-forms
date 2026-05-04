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

const MOCK_PARAMS = { EBS_BASE_URL: 'https://ebs.test.example.com' };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ebs-sync e2e', () => {
  let capturedXml;
  const origFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = async (_url, opts) => {
      capturedXml = opts.body;
      return { ok: true, text: async () => '<Response Succeeded="true" />' };
    };
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
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
      expect(snap.expiration).toBe('2028-01-28T00:00');
      expect(snap.fraudDecision).toBe('approve');
      // No SafeTech data in this journal (Forter-only environment)
      expect(snap.fraudScore).toBe('');
      expect(snap.fraudStatusCode).toBe('');
    });

    test('syncOrderToEbs produces expected SOAP XML', async () => {
      await syncOrderToEbs(MOCK_PARAMS, CC_APPROVED_ORDER, journal);
      expect(capturedXml).toBeTruthy();
      assertXmlFixture('expected-cc-approved.xml', capturedXml);
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
      await expect(syncOrderToEbs(MOCK_PARAMS, CC_DECLINE_ORDER, journal))
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
    });

    test('syncOrderToEbs produces expected SOAP XML', async () => {
      await syncOrderToEbs(MOCK_PARAMS, PP_APPROVED_ORDER, journal);
      expect(capturedXml).toBeTruthy();
      assertXmlFixture('expected-pp-approved.xml', capturedXml);
    });
  });
});
