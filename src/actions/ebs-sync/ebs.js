/**
 * EBS SOAP client for the EBS sync job.
 *
 * Builds a CreateRequest SOAP envelope from a commerce API order and its journal
 * entries, then POSTs it to the configured EBS endpoint.
 *
 * All payment data is sourced from the payment_completed journal entry plus the
 * fraud_evaluated entry (for Chase SafeTech/Forter state determination).
 * order.custom is never read for field data — only the syncedToEbs flag set by
 * sync.js is stored there.
 *
 * ── Address field names (OrderAddress interface) ─────────────────────────────
 *   address1, address2, state, zip  (NOT street/region/postalCode)
 *
 * ── Payment data sources ─────────────────────────────────────────────────────
 *   Chase (provider='chase')   payment_completed:
 *     transactionId, approvalCode, cardType (brand), cardNumber (masked mPAN),
 *     cardExpiry (MMYY), avsMatch, cvvMatch, amount, currency
 *     providerData.safetechResponse  (pipe-delimited, optional)
 *   fraud_evaluated: decision ('approve'|'decline'|'not_reviewed'|'pending')
 *
 *   PayPal (provider='paypal') payment_completed:
 *     transactionId, paypalOrderId, payerEmail, payerId, sellerProtection,
 *     paypalFee (optional), amount, currency
 *
 *   Affirm (provider='affirm') payment_completed:
 *     transactionId, amount, currency
 *
 *   All providers: amount, currency
 *   When estimates were locked in: taxAmount (number), shippingCost (number),
 *     subtotal (number) — these may be absent; falls back to order.estimates
 *
 * ── Fields MISSING from the commerce API schema (must be added) ──────────────
 *   orderType                    Order/@Type                hardcoded 'Household'
 *   taxHolidayInEffect           Order/@TaxHolidayInEffect  hardcoded 'false'
 *   ctsCode / referrerCode       Order/@ReferrerCode        hardcoded ''
 *   giftMessage                  ns2:Message                always empty
 *   affiliateCoupon              ns2:SalesPersonId          always empty
 *   salesPersonId override       ns2:SalesPersonId          always empty
 *   paymentTerms override        OrderPayment/@PaymentTerms always 'Immediate'
 *   couponCode                   ns2:PromotionCode          never emitted
 *   promotionDescription         ns2:PromotionCode prefix   never emitted
 *   shippingDiscount (PayPal)    PaymentDetails/ShippingDiscount  hardcoded '0.00'
 *   item.taxAmount               LineItem/Tax/@Amount       hardcoded '0.00'
 *   item.unitOfMeasure           LineItem/@UnitOfMeasure    defaulted 'Each'
 *   item.serialNumber            ns2:SerialNumber           never emitted
 *   item.promotionCode           ns2:PromotionCode (item)   never emitted
 *   Chase cardId                 CreditCard/@CardId         hardcoded ''
 *   Chase storedCredentials      CreditCard/@StoredCredentials  hardcoded 'N'
 *   Chase mitMsgType             CreditCard/@MITMsgType     hardcoded 'CGEN'
 *   Chase nameOnCard             NameOnCard                 derived from customer name
 *   PayPal paymentStatus         PayPalExpressCheckout/@PaymentStatus  hardcoded ''
 *   PayPal pendingReason         PayPalExpressCheckout/@PendingReason  hardcoded ''
 *   PayPal protectionEligibilityType  hardcoded ''
 *   PayPal payerStatus           PayerInfo/PayerStatus      hardcoded ''
 *   PayPal isFinancing flag      PayPalCredit vs PayPalExpressCheckout  hardcoded false
 *   PayPal financing fields      FinancingFeeAmount etc.    hardcoded '0.00'
 *   PayPal billingAddressStatus  BillingAddress/AddressStatus  hardcoded ''
 *   PayPal shippingAddressStatus ShipToAddress/AddressStatus   hardcoded ''
 *   Affirm payment plan          PaymentTerms (3/5)         hardcoded 'Immediate'
 */

const EBS_TIMEOUT_MS = 120_000; // 2 minutes per order

/**
 * Sync a single order to EBS.
 * Derives all payment data from the order journal entries.
 * Throws on any non-success response so the caller can apply retry logic.
 *
 * @param {object}   params       - Action params (needs EBS_BASE_URL)
 * @param {object}   order        - Full StoredOrder from the commerce API
 * @param {object[]} orderJournal - All journal entries for this order
 */
async function syncOrderToEbs(params, order, orderJournal) {
  const paymentSnapshot = buildPaymentSnapshot(order, orderJournal);
  if (!paymentSnapshot) {
    throw new Error(
      `Order ${order.id}: cannot build payment snapshot — no recognisable payment_completed entry`,
    );
  }

  const xml = buildCreateOrderXml(order, paymentSnapshot);

  const res = await fetch(`${params.EBS_BASE_URL}/VITOTCCreateWebOrder`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: 'POST',
      Accept: 'text/xml',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    body: xml,
    signal: AbortSignal.timeout(EBS_TIMEOUT_MS),
  });

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error(`EBS HTTP ${res.status}: ${responseText.slice(0, 500)}`);
  }

  if (!parseEbsSuccess(responseText)) {
    throw new Error(`EBS rejected order: ${extractEbsErrorMessage(responseText)}`);
  }
}

/** Returns true when the EBS response indicates success. */
function parseEbsSuccess(xml) {
  return /<Response[^>]+Succeeded="true"/.test(xml);
}

/** Extracts the human-readable error from a failed EBS response. */
function extractEbsErrorMessage(xml) {
  const m =
    xml.match(/<Details[^>]+Message="([^"]*)"/) ||
    xml.match(/<Details[^>]+Message='([^']*)'/) ;
  return m ? m[1] : `Unknown EBS error (first 300 chars): ${xml.slice(0, 300)}`;
}

// ---------------------------------------------------------------------------
// Payment snapshot — derive all payment data from journal entries
// ---------------------------------------------------------------------------

/**
 * Build a normalised payment snapshot from the order's journal entries.
 *
 * The snapshot is the single source of truth for all payment fields in the
 * generated EBS XML. Fields are sourced from:
 *   - The payment_completed journal entry (provider-specific fields + totals)
 *   - The fraud_evaluated journal entry (fraud decision for Chase order state)
 *   - order.estimates (fallback for taxAmount/shippingCost/subtotal when
 *     the payment_completed entry was logged without locked-in estimates)
 *
 * Returns null when no payment_completed entry is present in the journal.
 *
 * @param {object}   order
 * @param {object[]} orderJournal
 * @returns {object | null}
 */
function buildPaymentSnapshot(order, orderJournal) {
  const completed = orderJournal.find((e) => e.event === 'payment_completed');
  if (!completed) return null;

  const { provider } = completed;
  const method = resolveEbsMethod(provider);
  if (!method) {
    console.warn(
      `[ebs-sync] Unrecognised payment provider "${provider}" — cannot build EBS XML`,
    );
    return null;
  }

  // Totals: prefer values spread into the journal entry by computeTotal().
  // Fall back to order.estimates when the entry was logged without locked-in estimates
  // (as observed in test data where taxAmount/shippingCost/subtotal are absent).
  const amount = String(completed.amount ?? '0.00');
  const taxAmount = String(
    Number(
      completed.taxAmount ??
      order.estimates?.taxAmount ??
      0,
    ).toFixed(2),
  );
  const shippingCost = String(
    Number(
      completed.shippingCost ??
      order.estimates?.shippingMethod?.rate ??
      0,
    ).toFixed(2),
  );
  const subtotal = String(
    Number(
      completed.subtotal ??
      order.estimates?.subtotal ??
      0,
    ).toFixed(2),
  );

  const base = {
    method,
    provider,
    amount,
    taxAmount,
    shippingCost,
    subtotal,
    timestamp: completed.timestamp,
  };

  if (provider === 'chase') {
    const safetech = parseSafetech(completed.providerData?.safetechResponse);

    // Fraud decision: prefer SafeTech FraudStatusCode; also check fraud_evaluated
    // event (emitted by Forter or other post-auth fraud provider).
    const fraudEval = orderJournal.find((e) => e.event === 'fraud_evaluated');
    const fraudDecision = fraudEval?.decision || null;

    return {
      ...base,
      transactionId: completed.transactionId || '',
      approvalCode: completed.approvalCode || '',
      // cardType from Chase queryTransaction is the card brand (e.g. "Visa")
      cardBrand: completed.cardType || '',
      // cardNumber is the masked mPAN (e.g. "401288XXXXXX1881") — last 4 for EBS
      last4: (completed.cardNumber || '').slice(-4),
      // cardExpiry from Chase in MMYY format (e.g. "0127" = January 2027)
      expiration: cardExpiryToDate(completed.cardExpiry || ''),
      approvalDate: completed.timestamp,
      // MISSING: cardId not logged in Chase journal entry — hardcoded ''
      cardId: '',
      // SafeTech parsed fields (present only when safetechMerchantId is configured)
      fraudScore: safetech.RiskScore || '',
      fraudStatusCode: safetech.FraudStatusCode || '',
      fraudRiskInquiryTransactionId: safetech.RiskInquiryTransactionID || '',
      fraudAutoDecisionResponse: safetech.AutoDecisionResponse || '',
      // Forter / fraud provider decision from fraud_evaluated entry
      fraudDecision,
      // MISSING: storedCredentials (payment plan indicator not in journal) — 'N'
      storedCredentials: 'N',
      // MISSING: mitMsgType (not in journal) — 'CGEN' (standard one-time payment)
      mitMsgType: 'CGEN',
    };
  }

  if (provider === 'paypal') {
    return {
      ...base,
      transactionId: completed.transactionId || '',
      // PayPal journal uses payerEmail (not paypalEmail)
      paypalEmail: completed.payerEmail || '',
      payerId: completed.payerId || '',
      // paypalOrderId is the closest equivalent to the legacy PayPal token
      token: completed.paypalOrderId || '',
      approvalDate: completed.timestamp,
      // sellerProtection is the closest available field to protectionEligibility
      protectionEligibility: completed.sellerProtection || '',
      // MISSING: paymentStatus (not in journal) — ''
      paymentStatus: '',
      // MISSING: pendingReason (not in journal) — ''
      pendingReason: '',
      // MISSING: protectionEligibilityType (not in journal) — ''
      protectionEligibilityType: '',
      // MISSING: payerStatus (not in journal) — ''
      payerStatus: '',
      // MISSING: isFinancing flag (not in journal) — false (always PayPalExpressCheckout)
      isFinancing: false,
      // MISSING: PayPal Credit financing fields (not in journal)
      financingFeeAmount: '0.00',
      financingTerm: '',
      financingMonthlyPayment: '0.00',
      financingTotalCost: '0.00',
      // MISSING: address status fields (not in journal) — ''
      shippingAddressStatus: '',
      billingAddressStatus: '',
    };
  }

  if (provider === 'affirm') {
    return {
      ...base,
      transactionId: completed.transactionId || '',
      transactionDate: completed.timestamp,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// XML builders
// ---------------------------------------------------------------------------

function buildCreateOrderXml(order, paymentSnapshot) {
  const country = resolveCountry(order);
  const source = countryToSource(country);
  const priceList = countryToPriceList(country);

  // MISSING: orderType (not in order or journal) — hardcoded 'Household'
  const orderType = 'Household';

  // Shipping method derived from locked-in estimates (type field, e.g. 'standard')
  const shippingMethod = resolveShippingMethod(order);

  // MISSING: taxHolidayInEffect (not in order or journal) — hardcoded 'false'
  const taxHolidayInEffect = 'false';

  // MISSING: ctsCode / referrerCode (not in order or journal) — hardcoded ''
  const referrerCode = '';

  const orderKey = order.friendlyId || order.id;
  const created = formatEbsDate(order.createdAt || new Date().toISOString());

  // Tax and shipping totals from the payment snapshot (with order.estimates fallback)
  const taxAmount = paymentSnapshot.taxAmount;
  const shippingAmount = paymentSnapshot.shippingCost;

  // MISSING: giftMessage (not in order or journal) — always empty
  const giftMessage = '<ns2:Message></ns2:Message>';

  // MISSING: salesPersonId and affiliateCoupon (not in order or journal) — always ''.
  // Required by EBS when affiliate coupons are used or payment is Affirm.
  // Both fields must be added to the commerce API.
  const salesPersonId = '';

  return `<?xml version="1.0" encoding="UTF-8" ?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:ord="http://xmlns.vitamix.com/Erp/Orders"
    xmlns:ent="http://xmlns.vitamix.com/Enterprise"
    xmlns:pay="http://xmlns.vitamix.com/Erp/PaymentMethods/PaymentTransactionLogger"
    xmlns:ship="http://xmlns.vitamix.com/Erp/Shipments">
  <soapenv:Header/>
  <soapenv:Body>
    <ns2:CreateRequest
        xmlns="http://xmlns.vitamix.com/Enterprise"
        xmlns:ns2="http://xmlns.vitamix.com/Erp/Orders"
        xmlns:ns3="http://xmlns.vitamix.com/Erp/PaymentMethods/PaymentTransactionLogger"
        xmlns:ns4="http://xmlns.vitamix.com/Erp/Shipments"
        xmlns:ns5="http://xmlns.oracle.com/pcbpel/adapter/db/sp/DbCallXXOTC_CREATE_SALES_ORDER_PKG"
        Id="${escapeXml(order.id)}">
      <ns2:Order
          Shipping="${shippingMethod}"
          PriceList="${priceList}"
          Source="${source}"
          Type="${orderType}"
          State="${determineOrderState(order, paymentSnapshot)}"
          TaxHolidayInEffect="${taxHolidayInEffect}"
          ReferrerCode="${escapeXml(referrerCode)}"
          Key="${escapeXml(orderKey)}"
          Created="${created}">
        ${buildCustomerXml(order)}
        ${buildPaymentXml(paymentSnapshot, order)}
        <ns2:Tax Amount="${taxAmount}" Provisional="true" />
        ${giftMessage}
        ${salesPersonId}
        ${buildPromotionsXml()}
        <ns2:Charge Type="Shipping" Value="${shippingAmount}" />
        ${buildLineItemsXml(order)}
      </ns2:Order>
    </ns2:CreateRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildCustomerXml(order) {
  const email = escapeXml(order.customer?.email || '');
  const firstName = escapeXml(sanitizeName(order.customer?.firstName || ''));
  const lastName = escapeXml(sanitizeName(order.customer?.lastName || ''));
  const phone = sanitizePhone(
    order.customer?.phone || order.billing?.phone || order.shipping?.phone || '',
  );

  // billing falls back to shipping when absent
  const billing = order.billing || order.shipping || {};
  const shipping = order.shipping || {};

  return `<ns2:Customer
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:type="Person"
          Key="${email}"
          Action="U">
          ${buildAddressXml('BillTo', billing, email)}
          ${buildAddressXml('ShipTo', shipping, email)}
          <Mobile>${phone}</Mobile>
          <Email>${email}</Email>
          <First>${firstName}</First>
          <Last>${lastName}</Last>
        </ns2:Customer>`;
}

/**
 * Build a BillTo or ShipTo address block.
 * Uses OrderAddress field names: address1, address2, state, zip.
 */
function buildAddressXml(tag, address, emailKey) {
  const key = `${emailKey}-${address.id || '0'}`;
  const street1 = escapeXml(sanitizeAddress(address.address1 || ''));
  // Always emit Address2 — empty string when absent (PHP parity).
  const street2 = `<Address2>${address.address2 ? escapeXml(sanitizeAddress(address.address2)) : ''}</Address2>`;
  const city = escapeXml(sanitizeAddress(address.city || ''));
  const state = escapeXml(address.state || '');
  const zip = escapeXml(address.zip || '');
  const country = escapeXml((address.country || '').toUpperCase());
  // Default IsValidated to 'true' (PHP behaviour for non-Chase methods).
  const isValidated = address.isValidated === false ? 'false' : 'true';

  return `<${tag} IsValidated="${isValidated}" Key="${key}">
            <Address1>${street1}</Address1>
            ${street2}
            <City>${city}</City>
            <County xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true" />
            <Region>${state}</Region>
            <PostalCode>${zip}</PostalCode>
            <Country>${country}</Country>
          </${tag}>`;
}

/**
 * Build the OrderPayment block from a payment snapshot.
 *
 * PayPal omits PaymentTerms (PHP parity); all other methods include it.
 *
 * Supported methods: chasehpp, paypal, affirm.
 * applepay is included for future parity but has no current provider in the API.
 */
function buildPaymentXml(paymentSnapshot, order) {
  const { method } = paymentSnapshot;

  if (!method || method === 'free' || method === 'none') return '';

  const isPayPal = method === 'paypal';
  const paymentTermsAttr = isPayPal ? '' : ` PaymentTerms="${resolvePaymentTerms()}"`;

  let inner;
  let transactionLogger = '';

  if (method === 'chasehpp') {
    // MISSING: nameOnCard not logged — derived from customer name
    const nameOnCard = escapeXml(
      `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim(),
    );
    // MISSING: storedCredentials (payment plan indicator not in journal) — 'N'
    // MISSING: mitMsgType (not in journal) — 'CGEN'
    inner = `<ns2:CreditCard
              CardId="${escapeXml(paymentSnapshot.cardId)}"
              Expiration="${escapeXml(paymentSnapshot.expiration)}"
              Approval="${formatEbsDate(paymentSnapshot.approvalDate)}"
              FraudScore="${escapeXml(paymentSnapshot.fraudScore)}"
              AuthCode="${escapeXml(paymentSnapshot.approvalCode)}"
              CardBrand="${escapeXml(paymentSnapshot.cardBrand)}"
              FraudStatusCode="${escapeXml(paymentSnapshot.fraudStatusCode)}"
              FraudRiskInquiryTransactionID="${escapeXml(paymentSnapshot.fraudRiskInquiryTransactionId)}"
              FraudAutoDecisionResponse="${escapeXml(paymentSnapshot.fraudAutoDecisionResponse)}"
              CardLast4Digits="${escapeXml(paymentSnapshot.last4)}"
              MITMsgType="${escapeXml(paymentSnapshot.mitMsgType)}"
              StoredCredentials="${paymentSnapshot.storedCredentials}"
              TransactionId="${escapeXml(paymentSnapshot.transactionId)}"
              Amount="${paymentSnapshot.amount}">
              <NameOnCard>${nameOnCard}</NameOnCard>
            </ns2:CreditCard>`;
  } else if (method === 'applepay') {
    // Apple Pay has no current provider in the commerce API — included for future parity.
    const nameOnCard = escapeXml(
      `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim(),
    );
    inner = `<ns2:ApplePay
              TransactionId="${escapeXml(paymentSnapshot.transactionId || '')}"
              Amount="${paymentSnapshot.amount}"
              Approval="${formatEbsDate(paymentSnapshot.approvalDate || paymentSnapshot.timestamp)}"
              AuthCode="${escapeXml(paymentSnapshot.approvalCode || '')}"
              CardBrand="${escapeXml(paymentSnapshot.cardBrand || '')}"
              CardLast4Digits="${escapeXml(paymentSnapshot.last4 || '')}"
              MITMsgType="CGEN"
              StoredCredentials="N">
              <NameOnCard>${nameOnCard}</NameOnCard>
            </ns2:ApplePay>`;
  } else if (method === 'affirm') {
    inner = `<ns2:Affirm
              TransactionId="${escapeXml(paymentSnapshot.transactionId)}"
              Amount="${paymentSnapshot.amount}"
              TransactionDate="${formatEbsDate(paymentSnapshot.transactionDate)}"
              TransactionStatus="authorized" />`;
  } else if (isPayPal) {
    // MISSING: isFinancing (not in journal) — always PayPalExpressCheckout, never PayPalCredit
    inner = `<ns2:PayPalExpressCheckout
                PayPalEmailAddress="${escapeXml(paymentSnapshot.paypalEmail)}"
                Approval="${formatEbsDate(paymentSnapshot.approvalDate)}"
                PaymentStatus="${escapeXml(paymentSnapshot.paymentStatus)}"
                PendingReason="${escapeXml(paymentSnapshot.pendingReason)}"
                ProtectionEligibility="${escapeXml(paymentSnapshot.protectionEligibility)}"
                AuthCode="${escapeXml(paymentSnapshot.transactionId)}"
                PayerId="${escapeXml(paymentSnapshot.payerId)}"
                TransactionId="${escapeXml(paymentSnapshot.transactionId)}"
                Amount="${paymentSnapshot.amount}" />`;
    transactionLogger = buildPayPalTransactionLogger(paymentSnapshot, order);
  } else {
    console.warn(`[ebs-sync] Unknown payment method "${method}" — omitting OrderPayment block`);
    return '';
  }

  return `<ns2:OrderPayment${paymentTermsAttr}>
          ${inner}
        </ns2:OrderPayment>${transactionLogger}`;
}

/**
 * Build the ns2:PaymentTransactionLogger block for PayPal orders.
 * Carries additional PayPal API response data used by EBS for reconciliation.
 */
function buildPayPalTransactionLogger(paymentSnapshot, order) {
  const billing = order.billing || order.shipping || {};
  const shipping = order.shipping || {};
  const billingPhone = sanitizePhone(billing.phone || order.customer?.phone || '');
  const shippingPhone = sanitizePhone(shipping.phone || order.customer?.phone || '');
  const invoiceId = escapeXml(order.friendlyId || order.id || '');

  // MISSING: shippingDiscount (not in order or journal) — hardcoded '0.00'
  const shippingDiscount = '0.00';

  // MISSING: isFinancing (not in journal) — always non-financing PaymentInfo
  const paymentInfo = `<ns3:PaymentInfo>
              <ns3:IsFinancing>false</ns3:IsFinancing>
              <ns3:PaymentType>instant</ns3:PaymentType>
            </ns3:PaymentInfo>`;

  return `
        <ns2:PaymentTransactionLogger>
          <ns3:Token>${escapeXml(paymentSnapshot.token)}</ns3:Token>
          <ns3:PayerInfo>
            <ns3:Payer>${escapeXml(paymentSnapshot.paypalEmail)}</ns3:Payer>
            <ns3:PayerID>${escapeXml(paymentSnapshot.payerId)}</ns3:PayerID>
            <ns3:PayerStatus>${escapeXml(paymentSnapshot.payerStatus)}</ns3:PayerStatus>
            <ns3:PayerName>
              <ns3:FirstName>${escapeXml(sanitizeName(order.customer?.firstName || ''))}</ns3:FirstName>
              <ns3:LastName>${escapeXml(sanitizeName(order.customer?.lastName || ''))}</ns3:LastName>
            </ns3:PayerName>
            <ns3:PayerCountry>${escapeXml((billing.country || '').toUpperCase())}</ns3:PayerCountry>
          </ns3:PayerInfo>
          ${paymentInfo}
          <ns3:InvoiceID>${invoiceId}</ns3:InvoiceID>
          <ns3:ContactPhone>${billingPhone}</ns3:ContactPhone>
          <ns3:PaymentDetails>
            <ns3:OrderTotal>${paymentSnapshot.amount}</ns3:OrderTotal>
            <ns3:ItemTotal>${paymentSnapshot.subtotal}</ns3:ItemTotal>
            <ns3:AllowedPaymentMethodType>InstantFundingSource</ns3:AllowedPaymentMethodType>
            <ns3:ShippingDiscount>${shippingDiscount}</ns3:ShippingDiscount>
          </ns3:PaymentDetails>
          <ns3:ShipToAddress>
            <ns3:Street1>${escapeXml(sanitizeAddress(shipping.address1 || ''))}</ns3:Street1>
            <ns3:CityName>${escapeXml(sanitizeAddress(shipping.city || ''))}</ns3:CityName>
            <ns3:StateOrProvince>${escapeXml(shipping.state || '')}</ns3:StateOrProvince>
            <ns3:Country>${escapeXml((shipping.country || '').toUpperCase())}</ns3:Country>
            <ns3:Phone>${shippingPhone}</ns3:Phone>
            <ns3:PostalCode>${escapeXml(shipping.zip || '')}</ns3:PostalCode>
            <ns3:AddressStatus>${escapeXml(
              (paymentSnapshot.shippingAddressStatus || '').toUpperCase(),
            )}</ns3:AddressStatus>
          </ns3:ShipToAddress>
          <ns3:BillingAddress>
            <ns3:Street1>${escapeXml(sanitizeAddress(billing.address1 || ''))}</ns3:Street1>
            <ns3:CityName>${escapeXml(sanitizeAddress(billing.city || ''))}</ns3:CityName>
            <ns3:StateOrProvince>${escapeXml(billing.state || '')}</ns3:StateOrProvince>
            <ns3:PostalCode>${escapeXml(billing.zip || '')}</ns3:PostalCode>
            <ns3:Country>${escapeXml((billing.country || '').toUpperCase())}</ns3:Country>
            <ns3:Phone>${billingPhone}</ns3:Phone>
            <ns3:AddressStatus>${escapeXml(
              (paymentSnapshot.billingAddressStatus || '').toUpperCase(),
            )}</ns3:AddressStatus>
          </ns3:BillingAddress>
          <ns3:TransactionID>${escapeXml(paymentSnapshot.transactionId)}</ns3:TransactionID>
          <ns3:Amount>${paymentSnapshot.amount}</ns3:Amount>
          <ns3:MsgSubId></ns3:MsgSubId>
          <ns3:AuthorizationInfo>
            <ns3:PendingReason>${escapeXml(paymentSnapshot.pendingReason)}</ns3:PendingReason>
            <ns3:ProtectionEligibility>${escapeXml(
              paymentSnapshot.protectionEligibility,
            )}</ns3:ProtectionEligibility>
            <ns3:ProtectionEligibilityType>${escapeXml(
              paymentSnapshot.protectionEligibilityType,
            )}</ns3:ProtectionEligibilityType>
          </ns3:AuthorizationInfo>
        </ns2:PaymentTransactionLogger>`;
}

function buildLineItemsXml(order) {
  return (order.items || [])
    .map((item) => {
      const sku = escapeXml(item.sku || '');
      const qty = item.quantity ?? 1;
      const price = item.price?.final || item.price?.regular || '0.00';
      // MISSING: item-level tax (not in OrderItem schema) — hardcoded '0.00'
      const itemTax = '0.00';
      // MISSING: unitOfMeasure (not in OrderItem schema) — defaulted 'Each'
      // Warranty items should use 'Years'; add unitOfMeasure to OrderItem to fix.
      const unitOfMeasure = item.unitOfMeasure || 'Each';
      // MISSING: item serialNumber and promotionCode (not in OrderItem schema) — omitted

      return `<ns2:LineItem
            Sku="${sku}"
            Quantity="${qty}"
            UnitSellingPrice="${price}"
            UnitOfMeasure="${unitOfMeasure}">
            <ns2:Tax Amount="${itemTax}" Provisional="true" />
          </ns2:LineItem>`;
    })
    .join('\n        ');
}

/**
 * Promotions block — omitted pending API additions.
 * MISSING: couponCode and promotionDescription are not in the order or journal schema.
 * Add both fields to the Order type in the commerce API to enable this block.
 */
function buildPromotionsXml() {
  return '';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine EBS Order State.
 *
 * Booked:  PayPal (amount > 0), Chase with SafeTech FraudStatusCode starting 'A'
 *          OR with fraud_evaluated decision 'approve', free/zero-amount orders.
 * Entered: Affirm, Apple Pay, or Chase without fraud approval confirmation.
 *
 * PHP parity: PayPal → Booked, chasehpp + fraudStatusCode starts 'A' → Booked, total=0 → Booked
 */
function determineOrderState(order, paymentSnapshot) {
  const amount = Number(paymentSnapshot?.amount ?? order.total ?? 0);
  if (amount === 0) return 'Booked';

  const { method, fraudStatusCode, fraudDecision } = paymentSnapshot;

  if (method === 'paypal') return 'Booked';

  if (method === 'chasehpp') {
    // SafeTech FraudStatusCode starting with 'A' = approved by SafeTech
    if (fraudStatusCode && String(fraudStatusCode).charAt(0) === 'A') return 'Booked';
    // Post-auth fraud provider (e.g. Forter) approved the order
    if (fraudDecision === 'approve') return 'Booked';
    return 'Entered';
  }

  // Affirm, Apple Pay, unknown — conservative default
  return 'Entered';
}

/**
 * Resolve PaymentTerms for non-PayPal methods.
 * MISSING: payment plan indicator not in journal — always 'Immediate'.
 * Add payment plan data to the commerce API to support '3-PaymentPlan' and '5-PayPlan'.
 */
function resolvePaymentTerms() {
  // MISSING: paymentPlan (not in journal) — hardcoded 'Immediate'
  return 'Immediate';
}

/**
 * Resolve the EBS shipping method string from the locked-in estimates.
 * ShippingRate.type 'standard' (case-insensitive) → 'Standard', else → 'Expedited'.
 */
function resolveShippingMethod(order) {
  const type = order.estimates?.shippingMethod?.type || '';
  return /standard/i.test(type) ? 'Standard' : 'Expedited';
}

/**
 * Map a payment provider name to the EBS payment method string.
 *
 * @param {string} provider - Journal entry provider value ('chase'|'paypal'|'affirm')
 * @returns {string}
 */
function resolveEbsMethod(provider) {
  switch (provider) {
    case 'chase': return 'chasehpp';
    case 'paypal': return 'paypal';
    case 'affirm': return 'affirm';
    default: return '';
  }
}

/**
 * Parse a Chase SafeTech pipe-delimited response string into a key→value map.
 *
 * Format: "Key1:Value1|Key2:Value2|..."
 * Known keys: FraudScoreIndicator, FraudStatusCode, RiskInquiryTransactionID,
 *             AutoDecisionResponse, RiskScore
 *
 * @param {string | undefined} response
 * @returns {Record<string, string>}
 */
function parseSafetech(response) {
  if (!response) return {};
  const result = {};
  for (const pair of String(response).split('|')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    result[pair.slice(0, colonIdx).trim()] = pair.slice(colonIdx + 1).trim();
  }
  return result;
}

/**
 * Convert a Chase card expiry in MMYY format to EBS date format.
 * EBS expects YYYY-MM-DDTHH:mm — we use the 28th as the nominal expiry day.
 *
 * @param {string} mmyy - e.g. "0127" = January 2027
 * @returns {string} e.g. "2027-01-28T00:00"
 */
function cardExpiryToDate(mmyy) {
  const s = String(mmyy);
  if (s.length < 4) return '';
  const mm = s.slice(0, 2);
  const yy = s.slice(2, 4);
  return `20${yy}-${mm}-28T00:00`;
}

/** Resolve the 2-char ISO country code from the order. */
function resolveCountry(order) {
  return (
    order.country ||
    order.billing?.country ||
    order.shipping?.country ||
    'US'
  ).toUpperCase();
}

const SOURCE_MAP = { US: 'US', CA: 'CA', UK: 'UK', GB: 'UK', IE: 'IE' };
function countryToSource(country) {
  return SOURCE_MAP[country] || 'US';
}

const PRICE_LIST_MAP = {
  US: 'US HH END CUSTOMER',
  CA: 'CAN HH END CUSTOMER',
  UK: 'EUR UK HH END CUSTOMER EX VAT',
  GB: 'EUR UK HH END CUSTOMER EX VAT',
  IE: 'EUR IRELAND HH END CUSTOMER EX VAT',
};
function countryToPriceList(country) {
  return PRICE_LIST_MAP[country] || 'US HH END CUSTOMER';
}

/** Format an ISO 8601 timestamp to EBS's YYYY-MM-DDTHH:mm format. */
function formatEbsDate(iso) {
  return String(iso).slice(0, 16).replace(' ', 'T');
}

/** Strip all non-digit characters from a phone number. */
function sanitizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

/** Strip characters outside [a-zA-Z0-9 ] from address fields. */
function sanitizeAddress(value) {
  return String(value || '').replace(/[^a-zA-Z0-9 ]/g, '');
}

/** Strip &, ", ', <, > from name fields. */
function sanitizeName(value) {
  return String(value || '').replace(/[&"'<>]/g, '');
}

/** Escape XML special characters. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export { syncOrderToEbs, buildPaymentSnapshot };
