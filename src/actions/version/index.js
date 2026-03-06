const VERSION = process.env.VERSION;

/**
 * Returns the currently deployed version.
 */
export async function main() {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: { version: VERSION },
  };
}
