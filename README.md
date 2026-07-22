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

### `recipe-notify/recipe-notify` (web action + scheduled)

Emails a daily digest of **newly published recipes** to a configured list. Runs
on a daily cron and is also available as an HTTP endpoint for status checks and
manual triggers.

**Production only.** Stage deploys the same manifest, so the scheduled run is
gated by `RECIPE_NOTIFY_ENABLED` — it is set to `"true"` only in the prod deploy
env and the action no-ops immediately otherwise. This prevents duplicate emails
to the shared recipient list (state is per-namespace, but the DA template and its
recipients are shared).

**Scheduled mode** (daily): Polls the CalcMenu `GetUpdatedRecipes` journal since
a persisted timestamp cursor. The API input is date-granular but responses carry
full-precision `DateUpdated` timestamps and a `Status` (`New`/`Updated`/
`Deleted`), so the action keeps recipes whose `DateUpdated` is strictly newer
than the cursor (millisecond compare — dedupes the re-fetched boundary day),
filters to `Status="New"`, resolves each recipe's deep link from the published
`query-index.json` (by `Number`), and sends the digest. The cursor advances to
the batch's max `DateUpdated` only on a successful run. The first run cold-starts
(seeds the cursor without emailing) to avoid blasting the back-catalogue.

**Recipients + copy**: authored in a DA document at
`/config/recipes/digest-template` (same format as `email-template.html`, with a
`{{digest}}` placeholder where the recipe table is injected). No recipient env
var.

### `feeds/feeds` (web action)

Serves product-catalog feeds for downstream service providers over HTTP, from a
single endpoint. The source is the (enriched) Google Merchant Center feed
published per locale; each provider gets it in the format it expects. This is a
**pull model** — providers fetch the URL on their own schedule.

Supported providers:

- **`meta`** — Facebook/Instagram (Advantage+/DPA). Non-namespaced `<rss>` feed
  (`availability` in the spaced spec form, `in stock`).
- **`pinterest`** — Pinterest catalogs. Same non-namespaced `<rss>` feed as Meta;
  includes `product_type` and `google_product_category` from the source feed.
- **`cj`** — Commission Junction. Bare `<feed>` root, non-namespaced, Google-spec
  `availability` (`in_stock`); replaces the current SFTP drop.
- **`bazaarvoice`** — Bazaarvoice `ProductFeed.xml`. Loads the category taxonomy
  from a published DA sheet (`BV_CATEGORY_SHEET_URL`) and maps GMC identifiers
  (`gtin`→`UPC`) and variant grouping (`item_group_id`→`BV_FE_FAMILY`).

Not served here: **Google Ads** — no separate feed; it serves from the linked
Merchant Center account (i.e. the source GMC feed itself).

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

### Recipe Notify Status

```
GET /recipe-notify/recipe-notify
Authorization: Bearer <RECIPE_NOTIFY_TOKEN>
```

Returns JSON: `since`, `lastRun`, `status`, `processedCount`, `lastError`.

### Recipe Notify Manual Trigger

```
POST /recipe-notify/recipe-notify
Authorization: Bearer <RECIPE_NOTIFY_TOKEN>
Content-Type: application/json

{
  "since": "<ISO 8601>",   // optional cursor override (backfill)
  "dryRun": true            // optional — compute new recipes + links, do not send
}
```

`dryRun` bypasses the prod gate and never sends or advances the cursor, so stage
can be exercised on demand. It returns the computed new-recipe set with resolved
deep links.

### Provider Feeds

```
GET /feeds/feeds?provider=<meta|pinterest|cj|bazaarvoice>&locale=<cc/ll_cc>
```

Returns the catalog in the provider's format (`application/xml`). `locale`
defaults to `us/en_us` and must match `cc/ll_cc` (e.g. `ca/en_us`). When
`FEEDS_TOKEN` is set, requests must authenticate with `Authorization: Bearer
<token>` or `?token=<token>` (the query form is for providers that only accept a
plain URL). Responses are cacheable (`max-age=3600`).

Deployed web-action base: `https://<namespace>.adobeioruntime.net/api/v1/web/feeds/feeds`
(`<namespace>` per environment — e.g. `60038-161ivoryjackal-stage` on stage).
The per-provider feed URLs to hand to each platform (locale `us/en_us` shown;
swap `locale` for other markets, e.g. `ca/en_us`, `ca/fr_ca`, `mx/es_mx`):

| Provider | Feed URL |
|---|---|
| Meta | `…/api/v1/web/feeds/feeds?provider=meta&locale=us/en_us` |
| Pinterest | `…/api/v1/web/feeds/feeds?provider=pinterest&locale=us/en_us` |
| Commission Junction | `…/api/v1/web/feeds/feeds?provider=cj&locale=us/en_us` |
| Bazaarvoice | `…/api/v1/web/feeds/feeds?provider=bazaarvoice&locale=us/en_us` |

Google Ads has no URL here — it serves from the linked Google Merchant Center
account (the source feed at `{FEED_SITE_BASE}/<locale>/products/merchant-center-feed.xml`).

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

### recipe-notify package

All `RECIPE_*` value vars have in-code defaults (see `sync.js`); override only if they change.

| Variable | Description | Default |
|---|---|---|
| `ORG` / `SITE` | Org/site slug | `aemsites` / `vitamix` |
| `LOG_LEVEL` | Logging level | `info` |
| `EMAIL_TOKEN` | Productbus email service token (reused from forms) | — |
| `AIO_CLIENTID` / `AIO_CLIENTSECRET` / `AIO_SCOPES` | S2S creds to mint the IMS token for reading the DA template (reused from forms) | — |
| `RECIPE_API_URL` | CalcMenu `GetUpdatedRecipes` base URL | `https://vitamix.calcmenuweb.com/ws/service.asmx/GetUpdatedRecipes` |
| `RECIPE_API_ID` | CalcMenu API user id | `API` |
| `RECIPE_API_PSWD` | CalcMenu API password | `Vitamix!` |
| `RECIPE_SITE_BASE` | Deep-link site base | `https://www.vitamix.com` |
| `RECIPE_LINK_LOCALE` | Deep-link locale path | `us/en_us` |
| `RECIPE_DIGEST_TEMPLATE` | DA path of the digest template | `/config/recipes/digest-template` |
| `RECIPE_NOTIFY_TOKEN` | Bearer token for the status/trigger HTTP APIs (HTTP access denied if unset) | — |
| `RECIPE_NOTIFY_ENABLED` | Prod-only gate — scheduled run sends only when `"true"`. Set in prod deploy env only. | unset (no-op) |

### feeds package

| Variable | Description | Default |
|---|---|---|
| `ORG` / `SITE` | Org/site slug | `aemsites` / `vitamix` |
| `LOG_LEVEL` | Logging level | `info` |
| `FEED_SITE_BASE` | Base host serving the Merchant Center feed per locale | `https://main--vitamix--aemsites.aem.network` |
| `FEEDS_TOKEN` | Optional bearer/token gate for the feed URLs. When unset, feeds are public. | unset (public) |

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
