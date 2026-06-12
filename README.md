# vitamix-forms

Adobe I/O Runtime actions for the Vitamix storefront. Handles form submissions (product registration, newsletter signup, checkout-related EBS calls) and automated order synchronization to Oracle EBS.

## Actions

### `forms/submit` (web action)

Public HTTP endpoint that receives form submissions from the storefront. Validates the payload, publishes a `form.submitted` I/O Events CloudEvent for async processing, and for certain forms (e.g. product registration) calls EBS directly.

### `forms/processor`

Event-driven action triggered by `form.submitted` event (concurrency=1). Reads the destination sheet, appends the submission, and writes it back. Sends email notifications where configured.

### `forms/version` (web action)

Returns the currently deployed version (`{ "version": "..." }`). Used by post-deploy smoke tests.

### `ebs-sync/ebs-sync` (web action + scheduled)

Synchronizes completed commerce orders to Oracle EBS. Runs on a 5-minute cron schedule and is also available as an HTTP endpoint for status checks and manual triggers.

**Scheduled mode** (every 5 min): Reads the global orders journal since the last cursor, filters to terminal events (`payment_completed` / `payment_cancelled`), and for each completed order builds a SOAP XML payload and POSTs it to EBS via a static-IP proxy. Cancelled orders are skipped. A 15-minute overlap is applied to journal queries to catch late-arriving entries.

**Supported payment methods**: Credit card (Chase), PayPal, Apple Pay (Chase wallet), Affirm.

## APIs

### Form Submission

```
POST /forms/submit
Content-Type: application/json

{ "formId": "product-registration", "data": { ... } }
```

### EBS Sync Status

```
GET /ebs-sync/ebs-sync
Authorization: Bearer <SYNC_STATUS_TOKEN>
```

Returns JSON with current sync state: `since`, `lastProcessedOrderId`, `lastRun`, `status`, `processedCount`, `failedCount`, `lastError`.

### EBS Sync Manual Trigger

```
POST /ebs-sync/ebs-sync
Authorization: Bearer <SYNC_STATUS_TOKEN>
Content-Type: application/json

{
  "since": "<ISO 8601>",
  "until": "<ISO 8601>",   // optional upper bound
  "duration": <minutes>     // optional, alternative to "until"
}
```

Triggers a sync run starting from the given timestamp. `since` is required. Provide `until` or `duration` (not both) to cap the query window; omit both to scan up to the current time. The cursor advances normally after a successful run.

## Deployment

Deployed via GitHub Actions using `aio app deploy` and semantic-release.

| Environment | Trigger | Workflow |
|---|---|---|
| Stage | PR opened/updated against `main` | `.github/workflows/deploy_stage.yml` |
| Production | Push to `main` | `.github/workflows/deploy_prod.yml` |

Production deployments use semantic-release to version and tag releases automatically.

## Environment Variables

### forms package

| Variable | Description |
|---|---|
| `ORG` | Organization slug (hardcoded: `aemsites`) |
| `SITE` | Site slug (hardcoded: `vitamix`) |
| `LOG_LEVEL` | Logging level (default: `info`) |
| `AIO_CLIENTID` | Adobe I/O client ID |
| `AIO_CLIENTSECRET` | Adobe I/O client secret |
| `AIO_SCOPES` | Adobe I/O OAuth scopes |
| `AIO_IMSORGID` | Adobe IMS org ID |
| `AIO_EVENTS_PROVIDER_ID` | I/O Events provider ID |
| `EMAIL_TOKEN` | Token for sending notification emails |
| `PROXY_TOKEN` | Bearer token for the static-IP proxy (AWS API Gateway) |
| `EBS_BASE_URL` | Production EBS SOAP endpoint |
| `EBS_BASE_URL_STAGE` | Stage EBS SOAP endpoint |
| `EBS_API_KEY` | Production EBS API key |
| `EBS_API_KEY_STAGE` | Stage EBS API key |
| `NEWSLETTER_BASE_URL` | Production newsletter API base |
| `NEWSLETTER_BASE_URL_STAGE` | Stage newsletter API base |
| `NEWSLETTER_API_KEY` | Production newsletter API key |
| `NEWSLETTER_API_KEY_STAGE` | Stage newsletter API key |

### ebs-sync package

| Variable | Description |
|---|---|
| `ORG` | Organization slug (hardcoded: `aemsites`) |
| `SITE` | Site slug (hardcoded: `vitamix`) |
| `LOG_LEVEL` | Logging level |
| `SYNC_STATUS_TOKEN` | Bearer token for the status/trigger HTTP APIs |
| `EDGE_COMMERCE_API_BASE` | Edge Commerce API base URL |
| `EDGE_COMMERCE_API_ORDERS_TOKEN` | Bearer token for the orders/journal API |
| `EBS_BASE_URL` | Production EBS SOAP endpoint |
| `EBS_BASE_URL_STAGE` | Stage EBS SOAP endpoint |
| `EBS_API_KEY` | Production EBS API key |
| `EBS_API_KEY_STAGE` | Stage EBS API key |
| `PROXY_TOKEN` | Bearer token for the static-IP proxy |

## Setup (first-time per environment)

1. [Create App Builder project](https://experienceleague.adobe.com/en/docs/experience-manager-learn/cloud-service/asset-compute/set-up/app-builder)
2. Add service to project: `I/O Management API`
3. [Generate OAuth Server-to-Server credentials](https://developer.adobe.com/developer-console/docs/guides/credentials)
4. Set `.env` values using `example.env` template and values from Adobe Developer Console
5. Configure I/O Events:
   1. [Create Event Provider](./dev/create-event-provider.sh) — response `id` becomes `AIO_EVENTS_PROVIDER_ID`
   2. [Create Provider Metadata](./dev/create-event-meta-submitted.sh) for `form.submitted` event
   3. [Register action handler](./dev/create-action-registration.sh) for `forms/processor` on `form.submitted`

## Development

```bash
npm install
npm test
npm run build
npm run lint
```

Tests use Jest with ESM support (`--experimental-vm-modules`). The ebs-sync E2E tests compare generated SOAP XML against golden fixture files in `test/fixtures/`.

## References

- [Creating Runtime Actions](https://developer.adobe.com/app-builder/docs/guides/runtime_guides/creating-actions)
- [Events Registration API](https://developer.adobe.com/events/docs/guides/api/registration-api)
- [Events Publishing API](https://developer.adobe.com/events/docs/guides/api/eventsingress-api)
