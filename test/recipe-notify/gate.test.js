import { describe, test, expect, jest } from '@jest/globals';

// Mock aio-lib-state so importing sync.js → state.js never touches the platform.
jest.unstable_mockModule('@adobe/aio-lib-state', () => ({
  init: async () => ({ get: async () => null, put: async () => {}, delete: async () => {} }),
}));

const { run, withDefaults } = await import('../../src/actions/recipe-notify/sync.js');

describe('prod gate', () => {
  test('scheduled run no-ops when RECIPE_NOTIFY_ENABLED is not "true"', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const res = await run({ LOG_LEVEL: 'error' }); // enabled unset
    expect(res.body).toEqual({ skipped: true, reason: 'disabled' });
    expect(fetchSpy).not.toHaveBeenCalled(); // no API/template/email work
    fetchSpy.mockRestore();
  });

  test('dryRun bypasses the gate', async () => {
    // dryRun proceeds past the gate; stub fetch to return an empty journal so it
    // completes without network. Cold start → seeds without emailing.
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '<ws_GetUpdatedRecipes></ws_GetUpdatedRecipes>',
    });
    const res = await run({ LOG_LEVEL: 'error' }, { dryRun: true });
    expect(res.body.skipped).toBeUndefined();
    expect(res.body.dryRun).toBe(true);
    jest.restoreAllMocks();
  });
});

describe('withDefaults', () => {
  test('fills undefined/empty env vars with defaults, preserves overrides', () => {
    const env = withDefaults({ RECIPE_API_ID: 'CUSTOM', RECIPE_API_PSWD: '' });
    expect(env.RECIPE_API_ID).toBe('CUSTOM');
    expect(env.RECIPE_API_PSWD).toBe('Vitamix!'); // '' → default
    expect(env.RECIPE_API_URL).toBe('https://vitamix.calcmenuweb.com/ws/service.asmx/GetUpdatedRecipes');
    expect(env.RECIPE_SITE_BASE).toBe('https://www.vitamix.com');
    expect(env.RECIPE_LINK_LOCALE).toBe('us/en_us');
    expect(env.RECIPE_DIGEST_TEMPLATE).toBe('/config/recipes/digest-template');
    expect(env.ORG).toBe('aemsites');
    expect(env.SITE).toBe('vitamix');
  });
});
