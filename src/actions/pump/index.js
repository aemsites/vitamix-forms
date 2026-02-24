import stateLib from '@adobe/aio-lib-state';
import { errorResponse } from '../../utils.js';
import { publishEvent } from '../../events.js';
import { drainJournal } from '../../journal.js';
import makeContext from '../../context.js';

const STATE_KEY = 'journal_position';

/**
 * Scheduled action (every 10 minutes): reads journal events,
 * groups by formId, and publishes `form.grouped` events.
 * @param {Object} params
 */
export async function main(params) {
  try {
    const ctx = await makeContext(params);
    const { log } = ctx;

    const state = await stateLib.init();

    const posEntry = await state.get(STATE_KEY);
    const since = posEntry?.value || undefined;
    log.info(`reading journal from position: ${since || 'beginning'}`);

    const { events, lastPosition } = await drainJournal(ctx, { since });
    if (!events.length) {
      log.info('no new journal events');
      return { statusCode: 200, body: { message: 'no new events' } };
    }

    log.info(`read ${events.length} events from journal`);

    /** @type {Record<string, unknown[]>} */
    const groups = {};
    for (const { event } of events) {
      const { formId, data } = /** @type {any} */ (event.data ?? event);
      if (!formId) continue;
      if (!groups[formId]) groups[formId] = [];
      groups[formId].push(data);
    }

    for (const [formId, submissions] of Object.entries(groups)) {
      log.info(`publishing form:grouped for formId=${formId}, count=${submissions.length}`);
      await publishEvent(ctx, 'form.grouped', { formId, submissions });
    }

    if (lastPosition) {
      await state.put(STATE_KEY, lastPosition, { ttl: -1 });
    }

    return {
      statusCode: 200,
      body: {
        eventsRead: events.length,
        groupsPublished: Object.keys(groups).length,
      },
    };
  } catch (error) {
    if (error.response) return error.response;
    console.error('fatal error: ', error);
    return errorResponse(500, 'server error');
  }
}
