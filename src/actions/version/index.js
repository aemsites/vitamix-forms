const VERSION = process.env.VERSION;

/**
 * Boolean-only config fingerprint for a base-url / api-key pair.
 *
 * This is a public, unauthenticated endpoint, so it must never return the
 * values themselves — only whether the deployment default equals the injected
 * _STAGE value. `targetsStage: true` means this deployment would talk to the
 * staging integration, which is a misconfiguration for prod.
 *
 * @param {string} [base]      deployment-default base URL
 * @param {string} [baseStage] injected stage base URL
 * @param {string} [key]       deployment-default API key
 * @param {string} [keyStage]  injected stage API key
 */
function stageCheck(base, baseStage, key, keyStage) {
  return {
    configured: Boolean(base && key),
    targetsStage: Boolean(base) && base === baseStage,
    apiKeyMatchesStage: Boolean(key) && key === keyStage,
  };
}

/**
 * Returns the currently deployed version plus a non-secret EBS / EBS-JSON
 * config health check (booleans only). Lets us confirm a prod deployment is
 * pointed at the prod integrations and not accidentally at staging.
 *
 * @param {object} [params] action params (env inputs injected by the Runtime)
 */
export async function main(params = {}) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      version: VERSION,
      config: {
        ebs: stageCheck(
          params.EBS_BASE_URL, params.EBS_BASE_URL_STAGE,
          params.EBS_API_KEY, params.EBS_API_KEY_STAGE,
        ),
        ebsJson: stageCheck(
          params.EBS_JSON_BASE_URL, params.EBS_JSON_BASE_URL_STAGE,
          params.EBS_JSON_API_KEY, params.EBS_JSON_API_KEY_STAGE,
        ),
      },
    },
  };
}
