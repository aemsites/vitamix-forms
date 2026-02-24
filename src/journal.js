/**
 * @param {string|null} header
 * @returns {Record<string, string>}
 */
function parseLinkHeader(header) {
  if (!header) return {};
  /** @type {Record<string, string>} */
  const links = {};
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

/**
 * Fetch a single batch of events from the Adobe I/O Events Journal
 * @param {Context} ctx
 * @param {JournalOptions} [options]
 * @returns {Promise<JournalResponse>}
 */
export async function fetchJournalEvents(ctx, options = {}) {
  const { apiKey, token, orgId, journalUrl } = ctx.events;

  const url = new URL(journalUrl);
  if (options.since) url.searchParams.set('since', options.since);
  if (options.latest) url.searchParams.set('latest', 'true');
  if (options.limit) url.searchParams.set('limit', String(options.limit));

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'Authorization': `Bearer ${token}`,
      'x-ims-org-id': orgId,
    },
  });

  if (resp.status === 204) {
    return {
      events: [],
      _page: { count: 0 },
      _links: parseLinkHeader(resp.headers.get('link')),
    };
  }

  if (resp.status === 410) {
    throw new Error('Journal events have expired at the given position');
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Journal API error: ${resp.status} ${text}`);
  }

  const body = await resp.json();
  body._links = parseLinkHeader(resp.headers.get('link'));
  return body;
}

/**
 * Drain all available events from the journal, following pagination
 * @param {Context} ctx
 * @param {{ since?: string }} [options]
 * @returns {Promise<{ events: JournalEvent[], lastPosition: string | null }>}
 */
export async function drainJournal(ctx, options = {}) {
  const allEvents = [];
  let since = options.since;
  let lastPosition = since || null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await fetchJournalEvents(ctx, { since });
    if (!result.events.length) break;

    allEvents.push(...result.events);
    lastPosition = result._page.last;
    since = lastPosition;
  }

  return { events: allEvents, lastPosition };
}
