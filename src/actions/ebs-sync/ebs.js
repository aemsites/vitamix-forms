/**
 * EBS SOAP client for the EBS sync job.
 *
 * Builds a CreateRequest SOAP envelope from a commerce API order object and
 * POSTs it to the configured EBS endpoint.
 *
 * Field mapping — commerce API order → EBS XML:
 *   order.id / order.friendlyId            → CreateRequest/@Id, Order/@Key
 *   order.createdAt                        → Order/@Created
 *   order.country (billing/shipping)       → Order/@Source, Order/@PriceList
 *   order.customer.*                       → ns2:Customer block
 *   order.billing / order.shipping         → BillTo / ShipTo
 *   order.items                            → ns2:LineItem elements
 *   order.payment.*                        → ns2:OrderPayment + ns2:PaymentTransactionLogger
 *
 * Expected order.custom fields (all optional with fallback defaults):
 *   ctsCode                 → Order/@ReferrerCode
 *   taxAmount               → ns2:Tax/@Amount
 *   shippingAmount          → ns2:Charge/@Value
 *   shippingDiscount        → ns2:PaymentTransactionLogger/PaymentDetails/ShippingDiscount
 *   shippingMethod          → Order/@Shipping ("Standard"|"Expedited")
 *   orderType               → Order/@Type ("Household"|"Commercial")
 *   couponCode              → ns2:PromotionCode
 *   promotionDescription    → prefix in ns2:PromotionCode
 *   giftMessage             → ns2:Message
 *   affiliateCoupon         → ns2:SalesPersonId (primary source)
 *   salesPersonId           → ns2:SalesPersonId (override when not 'default')
 *   taxHolidayInEffect      → Order/@TaxHolidayInEffect
 *   paymentMethod           → fallback if order.payment.method is absent
 *
 * Payment fields (read from order.payment):
 *   method              → which payment XML element to use
 *   paymentPlan         → PaymentTerms: 3 → "3-PaymentPlan", 5 → "5-PayPlan"
 *   installmentAmount   → CreditCard/@Amount when paymentPlan > 1 (first installment)
 *   See buildPaymentXml() for per-method field details.
 */

const EBS_TIMEOUT_MS = 120_000; // 2 minutes per order

/**
 * Sync a single order to EBS.
 * Throws on any non-success response so the caller can apply retry logic.
 *
 * @param {object} params - Action params (needs EBS_BASE_URL)
 * @param {object} order  - Full order object from the commerce API
 */
async function syncOrderToEbs(params, order) {
  const xml = buildCreateOrderXml(order);

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
  const m = xml.match(/<Details[^>]+Message="([^"]*)"/)
    || xml.match(/<Details[^>]+Message='([^']*)'/);
  return m ? m[1] : `Unknown EBS error (first 300 chars): ${xml.slice(0, 300)}`;
}

// ---------------------------------------------------------------------------
// XML builders
// ---------------------------------------------------------------------------

function buildCreateOrderXml(order) {
  const country = resolveCountry(order);
  const source = countryToSource(country);
  const priceList = countryToPriceList(country);
  const orderType = order.custom?.orderType || 'Household';
  const shippingMethod = order.custom?.shippingMethod || 'Standard';
  const taxHolidayInEffect = order.custom?.taxHolidayInEffect || 'false';
  const referrerCode = order.custom?.ctsCode || '';
  const orderKey = order.friendlyId || order.id;
  const created = formatEbsDate(order.createdAt || new Date().toISOString());
  const taxAmount = order.custom?.taxAmount || '0.00';
  const shippingAmount = order.custom?.shippingAmount || '0.00';

  // Always emit <ns2:Message> — empty string when no gift message (PHP parity).
  const giftMessage = order.custom?.giftMessage
    ? `<ns2:Message><![CDATA[${order.custom.giftMessage}]]></ns2:Message>`
    : `<ns2:Message></ns2:Message>`;

  // SalesPersonId priority (mirrors PHP):
  //   1. order.custom.salesPersonId if set and not the sentinel 'default'
  //   2. order.custom.affiliateCoupon as fallback
  // Required by EBS when an affiliate coupon is applied or when payment is Affirm.
  const rawSalesPersonId = (order.custom?.salesPersonId && order.custom.salesPersonId !== 'default')
    ? order.custom.salesPersonId
    : (order.custom?.affiliateCoupon || '');
  const salesPersonId = rawSalesPersonId
    ? `<ns2:SalesPersonId>${escapeXml(rawSalesPersonId)}</ns2:SalesPersonId>`
    : '';

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
          State="${determineOrderState(order)}"
          TaxHolidayInEffect="${taxHolidayInEffect}"
          ReferrerCode="${escapeXml(referrerCode)}"
          Key="${escapeXml(orderKey)}"
          Created="${created}">
        ${buildCustomerXml(order)}
        ${buildPaymentXml(order)}
        <ns2:Tax Amount="${taxAmount}" Provisional="true" />
        ${giftMessage}
        ${salesPersonId}
        ${buildPromotionsXml(order)}
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

  // Fall back billing to shipping if absent
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

function buildAddressXml(tag, address, emailKey) {
  const key = `${emailKey}-${address.id || '0'}`;
  const street1 = escapeXml(sanitizeAddress(address.street || ''));
  // Always emit Address2 — empty string when absent (PHP parity).
  const street2 = `<Address2>${address.street2 ? escapeXml(sanitizeAddress(address.street2)) : ''}</Address2>`;
  const city = escapeXml(sanitizeAddress(address.city || ''));
  const region = escapeXml(address.region || '');
  const postalCode = escapeXml(address.postalCode || '');
  const country = escapeXml((address.country || '').toUpperCase());
  // Default IsValidated to 'true' (PHP behavior for non-Chase methods).
  // Explicitly set to 'false' only when the commerce API signals failed validation.
  const isValidated = address.isValidated === false ? 'false' : 'true';

  return `<${tag} IsValidated="${isValidated}" Key="${key}">
            <Address1>${street1}</Address1>
            ${street2}
            <City>${city}</City>
            <County xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true" />
            <Region>${region}</Region>
            <PostalCode>${postalCode}</PostalCode>
            <Country>${country}</Country>
          </${tag}>`;
}

/**
 * Build the OrderPayment block.
 *
 * Reads from order.payment (set by the payment provider integration) with
 * order.custom.paymentMethod as a fallback. Supported methods:
 *
 *   chasehpp / creditcard  → ns2:CreditCard
 *     payment.cardId, .expiration, .approvalDate, .fraudScore, .authCode,
 *     .cardBrand, .fraudStatusCode, .fraudRiskInquiryTransactionId,
 *     .fraudAutoDecisionResponse, .last4, .mitMsgType, .storedCredentials,
 *     .transactionId, .amount, .installmentAmount (used when paymentPlan > 1),
 *     .nameOnCard, .paymentPlan
 *
 *   paypal / paypal_express → ns2:PayPalExpressCheckout or ns2:PayPalCredit
 *                           + ns2:PaymentTransactionLogger
 *     payment.isFinancing, .paypalEmail, .approvalDate, .paymentStatus,
 *     .pendingReason, .protectionEligibility, .protectionEligibilityType,
 *     .transactionId, .payerId, .payerStatus, .token, .amount,
 *     .financingFeeAmount, .financingTerm, .financingMonthlyPayment,
 *     .financingTotalCost, .shippingAddressStatus, .billingAddressStatus
 *
 *   applepay → ns2:ApplePay (StoredCredentials always "N")
 *     payment.transactionId, .amount, .approvalDate, .authCode, .cardBrand,
 *     .last4, .mitMsgType, .nameOnCard
 *
 *   affirm / affirm_gateway → ns2:Affirm
 *     payment.transactionId, .amount, .transactionDate
 *
 *   free / none → (no OrderPayment block; OrderState is Booked when total is 0)
 */
function buildPaymentXml(order) {
  const payment = order.payment || {};
  const method = payment.method || order.custom?.paymentMethod || '';

  if (!method || method === 'free' || method === 'none') {
    return '';
  }

  const isPayPal = method === 'paypal' || method === 'paypal_express';
  // PayPal omits PaymentTerms (PHP parity); all other methods include it.
  const paymentTermsAttr = isPayPal ? '' : ` PaymentTerms="${resolvePaymentTerms(order)}"`;

  let inner;
  let transactionLogger = '';

  if (method === 'chasehpp' || method === 'creditcard') {
    // Payment plans: storedCredentials forced Y, amount is the first installment.
    const paymentPlan = Number(payment.paymentPlan || 0);
    const storedCredentials = paymentPlan > 1 ? 'Y' : (payment.storedCredentials ? 'Y' : 'N');
    const amount = paymentPlan > 1
      ? (payment.installmentAmount || payment.amount || '0.00')
      : (payment.amount || '0.00');
    const nameOnCard = escapeXml(
      payment.nameOnCard
      || `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim(),
    );
    inner = `<ns2:CreditCard
              CardId="${escapeXml(payment.cardId || '')}"
              Expiration="${formatEbsDate(payment.expiration || new Date().toISOString())}"
              Approval="${formatEbsDate(payment.approvalDate || new Date().toISOString())}"
              FraudScore="${escapeXml(String(payment.fraudScore || ''))}"
              AuthCode="${escapeXml(payment.authCode || payment.approvalCode || '')}"
              CardBrand="${escapeXml(payment.cardBrand || '')}"
              FraudStatusCode="${escapeXml(payment.fraudStatusCode || '')}"
              FraudRiskInquiryTransactionID="${escapeXml(payment.fraudRiskInquiryTransactionId || '')}"
              FraudAutoDecisionResponse="${escapeXml(payment.fraudAutoDecisionResponse || '')}"
              CardLast4Digits="${escapeXml(payment.last4 || '')}"
              MITMsgType="${escapeXml(payment.mitMsgType || 'CGEN')}"
              StoredCredentials="${storedCredentials}"
              TransactionId="${escapeXml(payment.transactionId || '')}"
              Amount="${amount}">
              <NameOnCard>${nameOnCard}</NameOnCard>
            </ns2:CreditCard>`;
  } else if (method === 'applepay') {
    const nameOnCard = escapeXml(
      payment.nameOnCard
      || `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim(),
    );
    // StoredCredentials is always N for ApplePay (PHP parity).
    inner = `<ns2:ApplePay
              TransactionId="${escapeXml(payment.transactionId || '')}"
              Amount="${payment.amount || '0.00'}"
              Approval="${formatEbsDate(payment.approvalDate || new Date().toISOString())}"
              AuthCode="${escapeXml(payment.authCode || '')}"
              CardBrand="${escapeXml(payment.cardBrand || '')}"
              CardLast4Digits="${escapeXml(payment.last4 || '')}"
              MITMsgType="${escapeXml(payment.mitMsgType || 'CGEN')}"
              StoredCredentials="N">
              <NameOnCard>${nameOnCard}</NameOnCard>
            </ns2:ApplePay>`;
  } else if (method === 'affirm' || method === 'affirm_gateway') {
    inner = `<ns2:Affirm
              TransactionId="${escapeXml(payment.transactionId || '')}"
              Amount="${payment.amount || '0.00'}"
              TransactionDate="${formatEbsDate(payment.transactionDate || new Date().toISOString())}"
              TransactionStatus="authorized" />`;
  } else if (isPayPal) {
    if (payment.isFinancing) {
      inner = `<ns2:PayPalCredit
                FinancingFeeAmount="${payment.financingFeeAmount || '0.00'}"
                FinancingTerm="${escapeXml(String(payment.financingTerm || ''))}"
                PayPalEmailAddress="${escapeXml(payment.paypalEmail || '')}"
                Approval="${formatEbsDate(payment.approvalDate || new Date().toISOString())}"
                PaymentStatus="${escapeXml(payment.paymentStatus || '')}"
                PendingReason="${escapeXml(payment.pendingReason || '')}"
                ProtectionEligibility="${escapeXml(payment.protectionEligibility || '')}"
                AuthCode="${escapeXml(payment.transactionId || '')}"
                PayerId="${escapeXml(payment.payerId || '')}"
                TransactionId="${escapeXml(payment.transactionId || '')}"
                Amount="${payment.amount || '0.00'}" />`;
    } else {
      inner = `<ns2:PayPalExpressCheckout
                PayPalEmailAddress="${escapeXml(payment.paypalEmail || '')}"
                Approval="${formatEbsDate(payment.approvalDate || new Date().toISOString())}"
                PaymentStatus="${escapeXml(payment.paymentStatus || '')}"
                PendingReason="${escapeXml(payment.pendingReason || '')}"
                ProtectionEligibility="${escapeXml(payment.protectionEligibility || '')}"
                AuthCode="${escapeXml(payment.transactionId || '')}"
                PayerId="${escapeXml(payment.payerId || '')}"
                TransactionId="${escapeXml(payment.transactionId || '')}"
                Amount="${payment.amount || '0.00'}" />`;
    }
    transactionLogger = buildPayPalTransactionLogger(order);
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
 * Carries additional PayPal API response data that EBS uses for reconciliation.
 */
function buildPayPalTransactionLogger(order) {
  const payment = order.payment || {};
  const billing = order.billing || order.shipping || {};
  const shipping = order.shipping || {};
  const billingPhone = sanitizePhone(billing.phone || order.customer?.phone || '');
  const shippingPhone = sanitizePhone(shipping.phone || order.customer?.phone || '');
  const invoiceId = escapeXml(order.friendlyId || order.id || '');
  const grandTotal = order.total || order.grandTotal || '0.00';
  const subtotal = order.subtotal || '0.00';
  const shippingDiscount = order.custom?.shippingDiscount || '0.00';

  const paymentInfo = payment.isFinancing
    ? `<ns3:PaymentInfo>
              <ns3:IsFinancing>true</ns3:IsFinancing>
              <ns3:FinancingFeeAmount>${payment.financingFeeAmount || '0.00'}</ns3:FinancingFeeAmount>
              <ns3:FinancingTerm>${escapeXml(String(payment.financingTerm || ''))}</ns3:FinancingTerm>
              <ns3:FinancingMonthlyPayment>${payment.financingMonthlyPayment || '0.00'}</ns3:FinancingMonthlyPayment>
              <ns3:FinancingTotalCost>${payment.financingTotalCost || '0.00'}</ns3:FinancingTotalCost>
              <ns3:PaymentType>instant</ns3:PaymentType>
            </ns3:PaymentInfo>`
    : `<ns3:PaymentInfo>
              <ns3:IsFinancing>false</ns3:IsFinancing>
              <ns3:PaymentType>instant</ns3:PaymentType>
            </ns3:PaymentInfo>`;

  return `
        <ns2:PaymentTransactionLogger>
          <ns3:Token>${escapeXml(payment.token || '')}</ns3:Token>
          <ns3:PayerInfo>
            <ns3:Payer>${escapeXml(payment.paypalEmail || '')}</ns3:Payer>
            <ns3:PayerID>${escapeXml(payment.payerId || '')}</ns3:PayerID>
            <ns3:PayerStatus>${escapeXml(payment.payerStatus || '')}</ns3:PayerStatus>
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
            <ns3:OrderTotal>${grandTotal}</ns3:OrderTotal>
            <ns3:ItemTotal>${subtotal}</ns3:ItemTotal>
            <ns3:AllowedPaymentMethodType>InstantFundingSource</ns3:AllowedPaymentMethodType>
            <ns3:ShippingDiscount>${shippingDiscount}</ns3:ShippingDiscount>
          </ns3:PaymentDetails>
          <ns3:ShipToAddress>
            <ns3:Street1>${escapeXml(sanitizeAddress(shipping.street || ''))}</ns3:Street1>
            <ns3:CityName>${escapeXml(sanitizeAddress(shipping.city || ''))}</ns3:CityName>
            <ns3:StateOrProvince>${escapeXml(shipping.region || '')}</ns3:StateOrProvince>
            <ns3:Country>${escapeXml((shipping.country || '').toUpperCase())}</ns3:Country>
            <ns3:Phone>${shippingPhone}</ns3:Phone>
            <ns3:PostalCode>${escapeXml(shipping.postalCode || '')}</ns3:PostalCode>
            <ns3:AddressStatus>${escapeXml((payment.shippingAddressStatus || '').toUpperCase())}</ns3:AddressStatus>
          </ns3:ShipToAddress>
          <ns3:BillingAddress>
            <ns3:Street1>${escapeXml(sanitizeAddress(billing.street || ''))}</ns3:Street1>
            <ns3:CityName>${escapeXml(sanitizeAddress(billing.city || ''))}</ns3:CityName>
            <ns3:StateOrProvince>${escapeXml(billing.region || '')}</ns3:StateOrProvince>
            <ns3:PostalCode>${escapeXml(billing.postalCode || '')}</ns3:PostalCode>
            <ns3:Country>${escapeXml((billing.country || '').toUpperCase())}</ns3:Country>
            <ns3:Phone>${billingPhone}</ns3:Phone>
            <ns3:AddressStatus>${escapeXml((payment.billingAddressStatus || '').toUpperCase())}</ns3:AddressStatus>
          </ns3:BillingAddress>
          <ns3:TransactionID>${escapeXml(payment.transactionId || '')}</ns3:TransactionID>
          <ns3:Amount>${payment.amount || '0.00'}</ns3:Amount>
          <ns3:MsgSubId></ns3:MsgSubId>
          <ns3:AuthorizationInfo>
            <ns3:PendingReason>${escapeXml(payment.pendingReason || '')}</ns3:PendingReason>
            <ns3:ProtectionEligibility>${escapeXml(payment.protectionEligibility || '')}</ns3:ProtectionEligibility>
            <ns3:ProtectionEligibilityType>${escapeXml(payment.protectionEligibilityType || '')}</ns3:ProtectionEligibilityType>
          </ns3:AuthorizationInfo>
        </ns2:PaymentTransactionLogger>`;
}

function buildLineItemsXml(order) {
  return (order.items || []).map((item) => {
    const sku = escapeXml(item.sku || '');
    const qty = item.quantity ?? 1;
    const price = item.price?.final || item.price?.regular || '0.00';
    const itemTax = item.custom?.taxAmount || '0.00';
    // Use unitOfMeasure from commerce API — warranty items use 'Years', normal items 'Each'.
    const unitOfMeasure = item.unitOfMeasure || 'Each';
    const serialNumber = item.custom?.serialNumber
      ? `<ns2:SerialNumber>${escapeXml(item.custom.serialNumber)}</ns2:SerialNumber>`
      : '';
    const itemPromo = item.custom?.promotionCode
      ? `<ns2:PromotionCode>${escapeXml(item.custom.promotionCode)}</ns2:PromotionCode>`
      : '';

    return `<ns2:LineItem
            Sku="${sku}"
            Quantity="${qty}"
            UnitSellingPrice="${price}"
            UnitOfMeasure="${unitOfMeasure}">
            <ns2:Tax Amount="${itemTax}" Provisional="true" />
            ${serialNumber}${itemPromo}
          </ns2:LineItem>`;
  }).join('\n        ');
}

function buildPromotionsXml(order) {
  if (!order.custom?.couponCode) return '';
  const desc = order.custom.promotionDescription || '';
  const text = desc
    ? `${desc}(${order.custom.couponCode})`
    : order.custom.couponCode;
  return `<ns2:PromotionCode>${escapeXml(text)}</ns2:PromotionCode>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the EBS Order State attribute.
 *
 * Booked:  PayPal (any amount), Chase/creditcard (post-Forter approval),
 *          Apple Pay, Affirm, free orders with zero total.
 * Entered: everything else (pending fulfilment confirmation).
 */
function determineOrderState(order) {
  const method = order.payment?.method || order.custom?.paymentMethod || '';
  if (['paypal', 'paypal_express', 'chasehpp', 'creditcard'].includes(method)) {
    return 'Booked';
  }
  // Free / zero-dollar orders are fulfilled immediately.
  const grandTotal = Number(order.total ?? order.grandTotal ?? 0);
  if ((method === 'free' || method === 'none' || !method) && grandTotal === 0) {
    return 'Booked';
  }
  return 'Entered';
}

/**
 * Resolve the PaymentTerms string for non-PayPal methods.
 * PHP maps payment_plan numeric → EBS term string; falls back to custom.paymentTerms.
 */
function resolvePaymentTerms(order) {
  const plan = Number(order.payment?.paymentPlan || 0);
  if (plan === 3) return '3-PaymentPlan';
  if (plan === 5) return '5-PayPlan';
  return order.custom?.paymentTerms || 'Immediate';
}

/** Resolve the 2-char ISO country code from wherever it lives on the order. */
function resolveCountry(order) {
  return (
    order.country
    || order.billing?.country
    || order.shipping?.country
    || 'US'
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

/** Escape XML special characters in attribute values and text content. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export { syncOrderToEbs };
