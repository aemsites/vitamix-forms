import { XMLParser } from 'fast-xml-parser';
import { proxyFetch } from './proxy.js';

const PATHS = {
  queryOrder: '/soa-infra/services/OTC/VITOTCQueryOrder/vitotcqueryorderbpel_client_ep',
  validateSerialNumber: '/soa-infra/services/OTC/VITOTCValidateSerialNum/vitotcvalidateserialnumbpel_client_ep',
  createRegistration: '/soa-infra/services/OTC/VITOTCProdRegistration/vitotcproductregbpel_client_ep',
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

/**
 * Escape XML special characters to prevent injection
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @param {string} xml
 * @returns {object}
 */
function parseResponse(xml) {
  const parsed = parser.parse(xml);
  return parsed?.Envelope?.Body ?? parsed;
}

/**
 * @param {Context} ctx
 * @param {string} baseUrl
 * @param {string} path
 * @param {string} xml
 * @returns {Promise<{ status: number, body: object, raw: string }>}
 */
async function soapFetch(ctx, baseUrl, path, xml) {
  const url = `${baseUrl}${path}`;
  const resp = await proxyFetch(ctx, url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: xml,
  });
  const raw = await resp.text();
  const body = parseResponse(raw);
  return { status: resp.status, body, raw };
}

/**
 * Query an order by key via VITOTCQueryOrder SOAP API
 * @param {Context} ctx
 * @param {string} baseUrl - EBS SOAP base URL
 * @param {string} orderKey - order key (e.g. "omstg1000031076")
 * @returns {Promise<{ status: number, body: object, raw: string }>}
 */
export async function queryOrder(ctx, baseUrl, orderKey) {
  const requestId = crypto.randomUUID();
  const xml = [
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:ord="http://xmlns.vitamix.com/Erp/Orders"',
    '  xmlns:ent="http://xmlns.vitamix.com/Enterprise">',
    '  <soapenv:Header/>',
    '  <soapenv:Body>',
    '    <ns2:SearchRequest Id="', requestId, '"',
    '      xmlns="http://xmlns.vitamix.com/Enterprise"',
    '      xmlns:ns2="http://xmlns.vitamix.com/Erp/Orders"',
    '      xmlns:ns3="http://xmlns.vitamix.com/Erp/PaymentMethods/PaymentTransactionLogger"',
    '      xmlns:ns4="http://xmlns.vitamix.com/Erp/Shipments">',
    '      <ns2:Order Key="', escapeXml(orderKey), '"/>',
    '    </ns2:SearchRequest>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
  console.log('querying order:', xml);
  return soapFetch(ctx, baseUrl, PATHS.queryOrder, xml);
}

/**
 * Validate a product serial number via VITOTCValidateSerialNum SOAP API
 * @param {Context} ctx
 * @param {string} baseUrl - EBS SOAP base URL
 * @param {string} serialNumber - serial number (e.g. "067881201029626223")
 * @returns {Promise<{ status: number, body: object, raw: string }>}
 */
export async function validateSerialNumber(ctx, baseUrl, serialNumber) {
  const requestId = crypto.randomUUID();
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:ser="http://xmlns.vitamix.com/Erp/Products/SerialNumbers"',
    '  xmlns:ent="http://xmlns.vitamix.com/Enterprise">',
    '  <soapenv:Header/>',
    '  <soapenv:Body>',
    '    <ser:Request Id="', requestId, '">',
    '      <ser:SerialNumber SystemOfRecordKey="', escapeXml(serialNumber), '"/>',
    '    </ser:Request>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
  return soapFetch(ctx, baseUrl, PATHS.validateSerialNumber, xml);
}

/**
 * @typedef {object} RegistrationData
 * @property {string} formCode
 * @property {string} purchaseLocation
 * @property {string} purchaseDate - ISO date string (e.g. "2026-02-22T00:00:00")
 * @property {string} [prefix]
 * @property {string} [suffix]
 * @property {string} address1
 * @property {string} city
 * @property {string} region - state/province code (e.g. "OH")
 * @property {string} postalCode
 * @property {string} geoCode
 * @property {string} country - country code (e.g. "US")
 * @property {string} mobile
 * @property {string} email
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} [middleName]
 * @property {string} serialNumber
 */

/**
 * Create a product registration via VITOTCProdRegistration SOAP API
 * @param {Context} ctx
 * @param {string} baseUrl - EBS SOAP base URL
 * @param {RegistrationData} data
 * @returns {Promise<{ status: number, body: object, raw: string }>}
 */
export async function createProductRegistration(ctx, baseUrl, data) {
  const requestId = crypto.randomUUID();
  const e = escapeXml;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:vit="http://www.Vitamix.com/launchPad/VITOTCProdRegistration/VITOTCProdRegistrationBPEL"',
    '  xmlns:ent="http://xmlns.vitamix.com/Enterprise"',
    '  xmlns:prod="http://xmlns.vitamix.com/Erp/Products">',
    '  <soapenv:Header/>',
    '  <soapenv:Body>',
    `    <prod:CreateRegistration Id="${requestId}">`,
    `      <prod:Registration FormCode="${e(data.formCode)}" PurchaseLocation="${e(data.purchaseLocation)}" PurchaseDate="${e(data.purchaseDate)}">`,
    `        <prod:Person Prefix="${e(data.prefix ?? '')}" Suffix="${e(data.suffix ?? '')}">`,
    '          <ent:BillTo>',
    `            <ent:Address1>${e(data.address1)}</ent:Address1>`,
    `            <ent:City>${e(data.city)}</ent:City>`,
    `            <ent:Region>${e(data.region)}</ent:Region>`,
    `            <ent:PostalCode>${e(data.postalCode)}</ent:PostalCode>`,
    `            <ent:GeoCode>${e(data.geoCode)}</ent:GeoCode>`,
    `            <ent:Country>${e(data.country)}</ent:Country>`,
    '          </ent:BillTo>',
    `          <ent:Mobile>${e(data.mobile)}</ent:Mobile>`,
    `          <ent:Email>${e(data.email)}</ent:Email>`,
    `          <ent:First>${e(data.firstName)}</ent:First>`,
    `          <ent:Last>${e(data.lastName)}</ent:Last>`,
    `          <ent:Middle>${e(data.middleName ?? '')}</ent:Middle>`,
    '        </prod:Person>',
    `        <prod:SerialNumber SystemOfRecordKey="${e(data.serialNumber)}"/>`,
    '      </prod:Registration>',
    '    </prod:CreateRegistration>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
  return soapFetch(ctx, baseUrl, PATHS.createRegistration, xml);
}
