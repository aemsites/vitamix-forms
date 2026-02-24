import { v4 as uuid } from 'uuid';

const EVENTS_INGRESS_URL = 'https://eventsingress.adobe.io';

/**
 * Publish a CloudEvent to Adobe I/O Events
 * @param {Context} ctx
 * @param {string} eventType - event type code (e.g. 'form:submitted')
 * @param {*} data - event payload
 * @returns {Promise<Response>}
 */
export async function publishEvent(ctx, eventType, data) {
  const { apiKey, token, providerId } = ctx.events;
  const resp = await fetch(EVENTS_INGRESS_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/cloudevents+json',
    },
    body: JSON.stringify({
      datacontenttype: 'application/json',
      specversion: '1.0',
      source: `urn:uuid:${providerId}`,
      type: eventType,
      id: uuid(),
      data,
    }),
  });
  if (!resp.ok && resp.status !== 204) {
    const text = await resp.text();
    throw new Error(`Failed to publish event: ${resp.status} ${text}`);
  }
  return resp;
}
