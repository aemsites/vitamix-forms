/**
 * Unit tests for buildPaymentSnapshot — verifies that payment data is correctly
 * extracted from order journal entries to populate JournalPaymentData.
 *
 * Test data is taken directly from real journal logs observed in the system.
 * Each test case includes the full journal entry sequence for an order.
 */

import { describe, test, expect } from '@jest/globals';
import { buildPaymentSnapshot } from '../../src/actions/ebs-sync/ebs.js';

// ---------------------------------------------------------------------------
// Fixtures — real journal entries from the system
// ---------------------------------------------------------------------------

/**
 * Chase + Forter success order (2026-04-08).
 * Forter approved; no SafeTech configured (providerData absent).
 * taxAmount/shippingCost/subtotal absent from payment_completed (no locked estimates).
 */
const CHASE_FORTER_ENTRIES = [
  {
    id: 'b652fe29-dee2-498e-a182-fdf75a4332c9',
    timestamp: '2026-04-08T16:36:54.949Z',
    journal: 'orders',
    event: 'create',
    orderId: '2026-04-08T16-36-53.686Z-68035653',
    state: 'pending',
  },
  {
    id: '1d6b5992-67bd-4609-bcf3-b69f5d2f1005',
    timestamp: '2026-04-08T16:36:56.084Z',
    journal: 'orders',
    event: 'http_request',
    service: 'chase-init',
    orderId: '2026-04-08T16-36-53.686Z-68035653',
    ok: true,
    statusCode: 200,
  },
  {
    id: 'd5cec05f-1465-4f7f-92c4-a06e80f05f84',
    timestamp: '2026-04-08T16:36:56.932Z',
    journal: 'orders',
    event: 'payment_initiated',
    orderId: '2026-04-08T16-36-53.686Z-68035653',
    provider: 'chase',
    method: 'card',
    attemptId: '7ba51f8e-5b56-49a9-ad00-d8902b808ae0',
    amount: '21210.80',
    currency: 'CAD',
  },
  {
    id: '96c63fc1-3867-42df-b312-17b41b310d5d',
    timestamp: '2026-04-08T16:37:35.218Z',
    journal: 'orders',
    event: 'http_request',
    service: 'chase-query',
    orderId: '2026-04-08T16-36-53.686Z-68035653',
    ok: true,
    statusCode: 200,
  },
  {
    id: 'ce9cd2f1-1735-4f2e-b9c0-5fc357cbf593',
    timestamp: '2026-04-08T16:37:36.475Z',
    journal: 'orders',
    event: 'http_request',
    service: 'forter',
    orderId: '2026-04-08T16-36-53.686Z-68035653',
    ok: true,
    statusCode: 200,
  },
  {
    id: '0e87b645-4797-42b2-a179-e746eab95481',
    timestamp: '2026-04-08T16:37:36.475Z',
    journal: 'orders',
    event: 'fraud_evaluated',
    orderId: '2026-04-08T16-36-53.686Z-68035653',
    attemptId: '7ba51f8e-5b56-49a9-ad00-d8902b808ae0',
    provider: 'forter',
    decision: 'approve',
    reasonCodes: ['Test'],
  },
  {
    id: '8d4cee8d-dd48-4687-bd1b-4b3ec0d5af79',
    timestamp: '2026-04-08T16:37:37.017Z',
    journal: 'orders',
    event: 'payment_completed',
    orderId: '2026-04-08T16-36-53.686Z-68035653',
    attemptId: '7ba51f8e-5b56-49a9-ad00-d8902b808ae0',
    provider: 'chase',
    transactionId: '69D6844E106ACBB3000004420000559C4156542B',
    approvalCode: 'tst387',
    cardType: 'Visa',
    cardNumber: '401288XXXXXX1881',
    cardBin: '401288',
    cardExpiry: '0127',
    avsMatch: '2 ',
    cvvMatch: 'M',
    amount: '21210.80',
    currency: 'CAD',
    // taxAmount / shippingCost / subtotal absent — estimates not locked in this test order
  },
];

/**
 * Affirm success order (2026-04-15).
 * Includes taxAmount, shippingCost, subtotal in payment_completed.
 */
const AFFIRM_SUCCESS_ENTRIES = [
  {
    id: '24c45d45-09c8-4b68-9e6d-feb8b0fb1e42',
    timestamp: '2026-04-15T15:57:22.346Z',
    journal: 'orders',
    event: 'create',
    orderId: '2026-04-15T15-57-20.960Z-LhC561cP',
    state: 'pending',
  },
  {
    id: 'f29e6571-1052-47be-ab74-83f0fc9d8a4b',
    timestamp: '2026-04-15T15:57:23.807Z',
    journal: 'orders',
    event: 'payment_initiated',
    orderId: '2026-04-15T15-57-20.960Z-LhC561cP',
    provider: 'affirm',
    method: 'bnpl',
    attemptId: '1b3978fc-3c91-441f-93e9-90ea8d1311ad',
    amount: '913.05',
    currency: 'CAD',
    subtotal: 779.95,
    taxAmount: 101.3935,
    shippingCost: 31.71,
  },
  {
    id: 'de309f0d-a657-4659-8694-bd9e803ad526',
    timestamp: '2026-04-15T15:57:47.526Z',
    journal: 'orders',
    event: 'http_request',
    service: 'affirm-authorize',
    orderId: '2026-04-15T15-57-20.960Z-LhC561cP',
    ok: true,
    statusCode: 200,
  },
  {
    id: 'd064a8bb-52cd-44d1-981c-fb1ecc742739',
    timestamp: '2026-04-15T15:57:48.394Z',
    journal: 'orders',
    event: 'payment_completed',
    orderId: '2026-04-15T15-57-20.960Z-LhC561cP',
    attemptId: '1b3978fc-3c91-441f-93e9-90ea8d1311ad',
    provider: 'affirm',
    transactionId: 'LSKG-IBXR',
    amount: '913.05',
    currency: 'CAD',
    subtotal: 779.95,
    taxAmount: 101.3935,
    shippingCost: 31.71,
  },
];

/**
 * Affirm cancelled order (2026-04-15).
 * Affirm authorize returned HTTP 400 → payment_cancelled.
 */
const AFFIRM_CANCELLED_ENTRIES = [
  {
    id: '8f048275-a0b4-409b-9ba4-c5e21c2063bd',
    timestamp: '2026-04-15T14:26:18.326Z',
    journal: 'orders',
    event: 'create',
    orderId: '2026-04-15T14-26-17.037Z-RYdghJ9K',
    state: 'pending',
  },
  {
    id: '79f2bd96-2055-48e4-b5c8-35f9d334efc9',
    timestamp: '2026-04-15T14:26:19.549Z',
    journal: 'orders',
    event: 'payment_initiated',
    orderId: '2026-04-15T14-26-17.037Z-RYdghJ9K',
    provider: 'affirm',
    method: 'bnpl',
    attemptId: '985c4ccc-d6b2-4bfc-a36d-bf6a5f623b68',
    amount: '913.05',
    currency: 'CAD',
    subtotal: 779.95,
    taxAmount: 101.3935,
    shippingCost: 31.71,
  },
  {
    id: '6fd3683e-c692-4699-8a5f-2511feeb1410',
    timestamp: '2026-04-15T14:27:33.580Z',
    journal: 'orders',
    event: 'http_request',
    service: 'affirm-authorize',
    orderId: '2026-04-15T14-26-17.037Z-RYdghJ9K',
    ok: false,
    statusCode: 400,
    response: {
      headers: { 'content-type': 'application/json' },
      body: '{"status_code": 400, "type": "invalid_request", "path": "shipping.address.street2"}',
    },
  },
  {
    id: 'd0d489bf-d54d-4cc3-aa7e-d9f82a33ac44',
    timestamp: '2026-04-15T14:27:34.116Z',
    journal: 'orders',
    event: 'payment_cancelled',
    orderId: '2026-04-15T14-26-17.037Z-RYdghJ9K',
    attemptId: '985c4ccc-d6b2-4bfc-a36d-bf6a5f623b68',
    provider: 'affirm',
    reason: 'verification_failed',
    detail: 'Affirm authorize returned HTTP 400',
  },
];

/**
 * Incomplete order — only create + payment_initiated, no terminal event.
 * Represents an order still in-flight during the journal window.
 */
const IN_FLIGHT_ENTRIES = [
  {
    id: '2e9c1f28-d6db-4985-adaf-3c583e0f479f',
    timestamp: '2026-04-15T14:26:04.781Z',
    journal: 'orders',
    event: 'create',
    orderId: '2026-04-15T14-26-02.937Z-h7B61PsK',
    state: 'pending',
  },
  {
    id: '4efe2914-eab3-4b5e-881b-5d5a2c5b71ed',
    timestamp: '2026-04-15T14:26:05.988Z',
    journal: 'orders',
    event: 'payment_initiated',
    orderId: '2026-04-15T14-26-02.937Z-h7B61PsK',
    provider: 'affirm',
    method: 'bnpl',
    attemptId: '06afc9ba-83d1-4f56-ab3d-42b5669867b7',
    amount: '913.05',
    currency: 'CAD',
    subtotal: 779.95,
    taxAmount: 101.3935,
    shippingCost: 31.71,
  },
];

// ---------------------------------------------------------------------------
// Helper — minimal mock order (only fields read by buildPaymentSnapshot)
// ---------------------------------------------------------------------------

function mockOrder(overrides = {}) {
  return {
    id: 'test-order-id',
    state: 'payment_completed',
    estimates: null,
    custom: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildPaymentSnapshot', () => {
  // ── Affirm success ─────────────────────────────────────────────────────────

  describe('Affirm — payment_completed', () => {
    test('returns a non-null snapshot', () => {
      const snapshot = buildPaymentSnapshot(mockOrder(), AFFIRM_SUCCESS_ENTRIES);
      expect(snapshot).not.toBeNull();
    });

    test('maps provider to EBS method', () => {
      const { method, provider } = buildPaymentSnapshot(mockOrder(), AFFIRM_SUCCESS_ENTRIES);
      expect(method).toBe('affirm');
      expect(provider).toBe('affirm');
    });

    test('extracts amount and currency from payment_completed', () => {
      const { amount } = buildPaymentSnapshot(mockOrder(), AFFIRM_SUCCESS_ENTRIES);
      expect(amount).toBe('913.05');
    });

    test('extracts taxAmount as a 2-decimal string', () => {
      const { taxAmount } = buildPaymentSnapshot(mockOrder(), AFFIRM_SUCCESS_ENTRIES);
      // 101.3935 → rounded to 2 decimals → '101.39'
      expect(taxAmount).toBe('101.39');
    });

    test('extracts shippingCost as a 2-decimal string', () => {
      const { shippingCost } = buildPaymentSnapshot(mockOrder(), AFFIRM_SUCCESS_ENTRIES);
      expect(shippingCost).toBe('31.71');
    });

    test('extracts subtotal as a 2-decimal string', () => {
      const { subtotal } = buildPaymentSnapshot(mockOrder(), AFFIRM_SUCCESS_ENTRIES);
      expect(subtotal).toBe('779.95');
    });

    test('extracts Affirm transactionId', () => {
      const { transactionId } = buildPaymentSnapshot(mockOrder(), AFFIRM_SUCCESS_ENTRIES);
      expect(transactionId).toBe('LSKG-IBXR');
    });

    test('sets transactionDate to the payment_completed timestamp', () => {
      const { transactionDate, timestamp } = buildPaymentSnapshot(mockOrder(), AFFIRM_SUCCESS_ENTRIES);
      expect(transactionDate).toBe('2026-04-15T15:57:48.394Z');
      expect(timestamp).toBe('2026-04-15T15:57:48.394Z');
    });

    test('ignores payment_initiated and http_request entries', () => {
      // http_request and payment_initiated entries must not affect the snapshot
      const snapshot = buildPaymentSnapshot(mockOrder(), AFFIRM_SUCCESS_ENTRIES);
      // transactionId comes from payment_completed, not http_request
      expect(snapshot.transactionId).toBe('LSKG-IBXR');
    });
  });

  // ── Affirm cancelled ───────────────────────────────────────────────────────

  describe('Affirm — payment_cancelled (no payment_completed)', () => {
    test('returns null', () => {
      const snapshot = buildPaymentSnapshot(mockOrder(), AFFIRM_CANCELLED_ENTRIES);
      expect(snapshot).toBeNull();
    });
  });

  // ── In-flight order (no terminal event) ───────────────────────────────────

  describe('in-flight order (create + payment_initiated only)', () => {
    test('returns null — no payment_completed in journal', () => {
      const snapshot = buildPaymentSnapshot(mockOrder(), IN_FLIGHT_ENTRIES);
      expect(snapshot).toBeNull();
    });
  });

  // ── Empty journal ──────────────────────────────────────────────────────────

  describe('empty journal', () => {
    test('returns null', () => {
      expect(buildPaymentSnapshot(mockOrder(), [])).toBeNull();
    });
  });

  // ── Chase + Forter ─────────────────────────────────────────────────────────

  describe('Chase — payment_completed with Forter fraud_evaluated', () => {
    test('returns a non-null snapshot', () => {
      const snapshot = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(snapshot).not.toBeNull();
    });

    test('maps provider to EBS method', () => {
      const { method, provider } = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(method).toBe('chasehpp');
      expect(provider).toBe('chase');
    });

    test('extracts Chase transactionId', () => {
      const { transactionId } = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(transactionId).toBe('69D6844E106ACBB3000004420000559C4156542B');
    });

    test('extracts approvalCode', () => {
      const { approvalCode } = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(approvalCode).toBe('tst387');
    });

    test('extracts card brand from cardType field', () => {
      const { cardBrand } = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(cardBrand).toBe('Visa');
    });

    test('derives last4 from masked mPAN', () => {
      // cardNumber "401288XXXXXX1881" → last 4 → "1881"
      const { last4 } = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(last4).toBe('1881');
    });

    test('converts cardExpiry from MMYY to EBS date format', () => {
      // cardExpiry "0127" (January 2027) → "2027-01-28T00:00"
      const { expiration } = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(expiration).toBe('2027-01-28T00:00');
    });

    test('captures fraudDecision from fraud_evaluated entry', () => {
      const { fraudDecision } = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(fraudDecision).toBe('approve');
    });

    test('defaults SafeTech fields to empty string when providerData absent', () => {
      // This order has no providerData.safetechResponse
      const snapshot = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(snapshot.fraudStatusCode).toBe('');
      expect(snapshot.fraudScore).toBe('');
      expect(snapshot.fraudRiskInquiryTransactionId).toBe('');
      expect(snapshot.fraudAutoDecisionResponse).toBe('');
    });

    test('defaults missing MISSING fields to safe constants', () => {
      const snapshot = buildPaymentSnapshot(mockOrder(), CHASE_FORTER_ENTRIES);
      expect(snapshot.cardId).toBe('');
      expect(snapshot.storedCredentials).toBe('N');
      expect(snapshot.mitMsgType).toBe('CGEN');
    });

    test('falls back to order.estimates for totals when absent from journal', () => {
      // payment_completed for this Chase order has no taxAmount/shippingCost/subtotal
      // → should fall back to order.estimates (null in this test) → '0.00'
      const snapshot = buildPaymentSnapshot(mockOrder({ estimates: null }), CHASE_FORTER_ENTRIES);
      expect(snapshot.taxAmount).toBe('0.00');
      expect(snapshot.shippingCost).toBe('0.00');
      expect(snapshot.subtotal).toBe('0.00');
    });

    test('uses order.estimates for totals when present and journal values absent', () => {
      const estimates = {
        taxAmount: '150.00',
        subtotal: '500.00',
        shippingMethod: { id: 'std', label: 'Standard', type: 'standard', rate: 25.00 },
      };
      const snapshot = buildPaymentSnapshot(mockOrder({ estimates }), CHASE_FORTER_ENTRIES);
      expect(snapshot.taxAmount).toBe('150.00');
      expect(snapshot.subtotal).toBe('500.00');
      expect(snapshot.shippingCost).toBe('25.00');
    });
  });

  // ── Chase with SafeTech ────────────────────────────────────────────────────

  describe('Chase — payment_completed with SafeTech providerData', () => {
    const safetechEntries = [
      ...CHASE_FORTER_ENTRIES.filter((e) => e.event !== 'payment_completed'),
      {
        ...CHASE_FORTER_ENTRIES.find((e) => e.event === 'payment_completed'),
        providerData: {
          safetechResponse:
            'FraudStatusCode:A100|RiskScore:42|RiskInquiryTransactionID:TXN-99|'
            + 'AutoDecisionResponse:APPROVE|FraudScoreIndicator:LOW',
        },
      },
    ];

    test('parses FraudStatusCode from SafeTech response', () => {
      const { fraudStatusCode } = buildPaymentSnapshot(mockOrder(), safetechEntries);
      expect(fraudStatusCode).toBe('A100');
    });

    test('parses RiskScore from SafeTech response', () => {
      const { fraudScore } = buildPaymentSnapshot(mockOrder(), safetechEntries);
      expect(fraudScore).toBe('42');
    });

    test('parses RiskInquiryTransactionID', () => {
      const { fraudRiskInquiryTransactionId } = buildPaymentSnapshot(mockOrder(), safetechEntries);
      expect(fraudRiskInquiryTransactionId).toBe('TXN-99');
    });

    test('parses AutoDecisionResponse', () => {
      const { fraudAutoDecisionResponse } = buildPaymentSnapshot(mockOrder(), safetechEntries);
      expect(fraudAutoDecisionResponse).toBe('APPROVE');
    });
  });

  // ── cardExpiryToDate edge cases ────────────────────────────────────────────

  describe('Chase — cardExpiry conversion edge cases', () => {
    function snapshotWithExpiry(cardExpiry) {
      const entries = [
        ...CHASE_FORTER_ENTRIES.filter((e) => e.event !== 'payment_completed'),
        { ...CHASE_FORTER_ENTRIES.find((e) => e.event === 'payment_completed'), cardExpiry },
      ];
      return buildPaymentSnapshot(mockOrder(), entries);
    }

    test('"1228" (December 2028) → "2028-12-28T00:00"', () => {
      expect(snapshotWithExpiry('1228').expiration).toBe('2028-12-28T00:00');
    });

    test('"0130" (January 2030) → "2030-01-28T00:00"', () => {
      expect(snapshotWithExpiry('0130').expiration).toBe('2030-01-28T00:00');
    });

    test('empty string → empty string', () => {
      expect(snapshotWithExpiry('').expiration).toBe('');
    });

    test('undefined → empty string', () => {
      expect(snapshotWithExpiry(undefined).expiration).toBe('');
    });
  });

  // ── Unrecognised provider ──────────────────────────────────────────────────

  describe('unrecognised provider', () => {
    test('returns null', () => {
      const entries = [
        {
          event: 'payment_completed',
          provider: 'stripe',
          transactionId: 'pi_xxx',
          amount: '100.00',
          currency: 'USD',
        },
      ];
      const snapshot = buildPaymentSnapshot(mockOrder(), entries);
      expect(snapshot).toBeNull();
    });
  });
});
