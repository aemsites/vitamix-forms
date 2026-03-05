const NAMESPACE = process.env.AIO_RUNTIME_NAMESPACE;
const BASE_URL = `https://${NAMESPACE}.adobeioruntime.net/api/v1/web/forms`;

describe('Post-Deploy Tests', () => {
  it('returns the deployed version', async () => {
    const resp = await fetch(`${BASE_URL}/version`);
    expect(resp.ok).toBe(true);

    const body = await resp.json();
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});
