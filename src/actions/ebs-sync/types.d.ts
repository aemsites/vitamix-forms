/**
 * Types for the EBS sync action.
 *
 * JournalPaymentData   — payment fields extracted from order journal entries
 * JournalOrderData     — combined type: stored order + journal-derived payment data
 */

// ── Payment data extracted from journal entries ──────────────────────────────

/**
 * Normalised payment data derived from the order's journal entries.
 * All fields are sourced from:
 *   - payment_completed entry (provider-specific transaction data + totals)
 *   - fraud_evaluated entry (Chase: fraud decision for EBS order state)
 *   - order.estimates (fallback for tax/shipping/subtotal when absent from journal)
 *
 * Fields documented as MISSING are not currently logged to the journal and
 * are hardcoded to safe defaults in buildPaymentSnapshot(). They must be
 * added to the commerce API to be populated correctly.
 */
export interface JournalPaymentData {
  /** EBS-facing method identifier */
  method: 'chasehpp' | 'paypal' | 'affirm' | 'applepay';
  /** Raw provider name from the payment_completed journal entry */
  provider: 'chase' | 'paypal' | 'affirm';
  /** Charged total as a decimal string (e.g. "913.05") */
  amount: string;
  /** Tax amount as a decimal string — from journal or order.estimates fallback */
  taxAmount: string;
  /** Shipping cost as a decimal string — from journal or order.estimates fallback */
  shippingCost: string;
  /** Item subtotal as a decimal string — from journal or order.estimates fallback */
  subtotal: string;
  /** ISO 8601 timestamp of the payment_completed entry */
  timestamp: string;

  // ── Chase-specific ──────────────────────────────────────────────────────────
  /** Chase TxnGUID from queryTransaction (all providers) */
  transactionId?: string;
  /** Chase ApprovalCode from queryTransaction */
  approvalCode?: string;
  /** Card brand from Chase cardType field (e.g. "Visa", "Mastercard") */
  cardBrand?: string;
  /** Last 4 digits sliced from the masked mPAN (e.g. "1881" from "401288XXXXXX1881") */
  last4?: string;
  /** Card expiry converted from Chase MMYY format to EBS date (e.g. "2027-01-28T00:00") */
  expiration?: string;
  /** MISSING: Chase CardId — not logged in the journal; always '' */
  cardId?: string;
  /** SafeTech RiskScore (from providerData.safetechResponse pipe-delimited string) */
  fraudScore?: string;
  /** SafeTech FraudStatusCode — starts with 'A' when approved */
  fraudStatusCode?: string;
  /** SafeTech RiskInquiryTransactionID */
  fraudRiskInquiryTransactionId?: string;
  /** SafeTech AutoDecisionResponse */
  fraudAutoDecisionResponse?: string;
  /** Decision from fraud_evaluated journal entry (e.g. 'approve', 'decline', 'not_reviewed') */
  fraudDecision?: string | null;
  /** MISSING: StoredCredentials flag — not logged; always 'N' */
  storedCredentials?: string;
  /** MISSING: MIT message type — not logged; always 'CGEN' */
  mitMsgType?: string;

  // ── PayPal-specific ─────────────────────────────────────────────────────────
  /** PayPal payer email address (from payerEmail field in journal) */
  paypalEmail?: string;
  /** PayPal PayerID */
  payerId?: string;
  /** PayPal order ID (paypalOrderId) — closest equivalent to legacy token */
  token?: string;
  /** Seller protection status (from sellerProtection field in journal) */
  protectionEligibility?: string;
  /** MISSING: payment status — not logged; always '' */
  paymentStatus?: string;
  /** MISSING: pending reason — not logged; always '' */
  pendingReason?: string;
  /** MISSING: protection eligibility type — not logged; always '' */
  protectionEligibilityType?: string;
  /** MISSING: payer status — not logged; always '' */
  payerStatus?: string;
  /** MISSING: PayPal Credit financing flag — not logged; always false */
  isFinancing?: boolean;
  /** MISSING: financing fee amount — not logged; always '0.00' */
  financingFeeAmount?: string;
  /** MISSING: financing term — not logged; always '' */
  financingTerm?: string;
  /** MISSING: financing monthly payment — not logged; always '0.00' */
  financingMonthlyPayment?: string;
  /** MISSING: financing total cost — not logged; always '0.00' */
  financingTotalCost?: string;
  /** MISSING: shipping address status from PayPal — not logged; always '' */
  shippingAddressStatus?: string;
  /** MISSING: billing address status from PayPal — not logged; always '' */
  billingAddressStatus?: string;

  // ── Affirm-specific ─────────────────────────────────────────────────────────
  /** Affirm transaction ID (shared field name with Chase) */
  // transactionId covered above
  /** payment_completed timestamp used as Affirm TransactionDate in EBS XML */
  transactionDate?: string;
}

// ── Combined order data ──────────────────────────────────────────────────────

/**
 * Address in the StoredOrder format (OrderAddress interface from helix-product-shared).
 * Note field names: address1/address2/state/zip — NOT street/region/postalCode.
 */
export interface StoredOrderAddress {
  name?: string;
  email?: string;
  address1: string;
  address2?: string;
  city: string;
  /** State/province code (e.g. "CA", "OH") */
  state: string;
  /** Postal/ZIP code */
  zip: string;
  country: string;
  company?: string;
  phone?: string;
  isDefault?: boolean;
  /** When false, EBS IsValidated attribute is set to 'false' */
  isValidated?: boolean;
}

export interface StoredOrderCustomer {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}

export interface StoredOrderItem {
  sku: string;
  quantity: number;
  price: { final: string; currency: string; regular?: string };
  name?: string;
  imageUrl?: string;
  productUrl?: string;
  /** MISSING from schema: warranty items should use 'Years'; defaults to 'Each' */
  unitOfMeasure?: string;
  custom?: Record<string, unknown>;
}

export interface StoredOrderEstimates {
  subtotal?: string;
  taxAmount?: string;
  total?: string;
  shippingMethod?: {
    id: string;
    /** Customer-facing label (e.g. "Standard Shipping: 8-10 Business Days") */
    label: string;
    /** Type identifier (e.g. "standard") — maps to EBS 'Standard'|'Expedited' */
    type: string;
    /** Shipping cost as a decimal number */
    rate: number;
  };
}

/**
 * The complete data set required to build an EBS CreateOrder XML payload.
 * Combines the stored order document (from getOrder()) with payment data
 * extracted from the order's journal entries (from buildPaymentSnapshot()).
 *
 * order   — returned by getOrder() from the commerce API
 * payment — returned by buildPaymentSnapshot() from the journal entries
 */
export interface JournalOrderData {
  // ── From the stored order document ────────────────────────────────────────
  id: string;
  friendlyId?: string;
  createdAt?: string;
  state: string;
  /** ISO 3166-1 alpha-2 country code — falls back to shipping.country */
  country?: string;
  customer: StoredOrderCustomer;
  /** Billing address — falls back to shipping when absent */
  billing?: StoredOrderAddress;
  shipping: StoredOrderAddress;
  items: StoredOrderItem[];
  /** Locked-in estimate snapshot — present when estimateToken was provided at order creation */
  estimates?: StoredOrderEstimates;
  /** Service-managed key/value pairs; only syncedToEbs is written by this action */
  custom?: Record<string, string>;

  // ── Derived from journal entries ──────────────────────────────────────────
  payment: JournalPaymentData;
}
