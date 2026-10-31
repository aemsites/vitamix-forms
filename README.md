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

Before serializing, every provider gets the same catalog preparation
(`src/actions/feeds/prepare.js`), matching the legacy Magento feeds, so every
feed carries the same products. Add `raw=true` to a feed URL to skip it and get
the unprepared source feed in that provider's format (e.g. for side-by-side
review):

- **Products:** simple and bundle products only. Configurable parent rows (the
  PDP-level record whose variants are simples) are dropped — their simple
  variants are sent, grouped by `item_group_id`. `-VB` rows (duplicate simples
  Magento creates as bundle options) are dropped; the bundle itself is kept.
  Duplicate ids are collapsed.
- **Titles:** prefixed with "Vitamix" (unless present); variant titles are
  rebuilt as `<parent title> - <color>`; sanitized like the legacy feeds (ASCII
  letters, digits, space, `-`, `+`, plus `.`; accents transliterated).
- **Descriptions:** plain text without ®/™, ASCII punctuation. When missing (or
  just a copy of the title), fall back to the parent's description, then the
  first paragraph of the authored PDP content
  (`{FEED_CONTENT_BASE}<pdp path>.plain.html`), then "Description coming soon."
  ("Description à venir." for `fr_*` locales).

Supported providers:

- **`meta`** — Facebook/Instagram (Advantage+/DPA). Non-namespaced `<rss>` feed
  (`availability` in the spaced spec form, `in stock`).
- **`pinterest`** — Pinterest catalogs. Same non-namespaced `<rss>` feed as Meta;
  adds `product_type` from the store categories in the product index
  (`<locale>/products/index.json` `categoriesUrlKey`, i.e. `custom.categories`;
  variants use their parent's), falling back to the legacy `productType` while
  category data is completed — see `src/actions/feeds/product-type.js` — and
  always emits `google_product_category` (empty unless the source sets it),
  matching the legacy Magento feed.
- **`cj`** — Commission Junction. Bare `<feed>` root, non-namespaced, Google-spec
  `availability` (`in_stock`); replaces the current SFTP drop.
- **`bazaarvoice`** — Bazaarvoice `ProductFeed.xml`. Loads the category taxonomy
  from a published DA sheet (`BV_CATEGORY_SHEET_URL`) and maps GMC identifiers
  (`gtin`→`UPC`) and variant grouping (`item_group_id`→`BV_FE_FAMILY`). A
  variant missing from the category sheet inherits its parent's category (the
  sheet was lifted from the legacy feed, which listed configurable parents).
  `raw=true` serves the previous, unprepared Bazaarvoice feed.
- **`openai`** — OpenAI commerce "ads" feed (**CSV, US-only**, UTF-8 with BOM so
  spreadsheet tools detect the encoding). Columns match the sample
  (`docs/vitamix-openai-ads-feed-SAMPLE.csv`), mapped ~1:1 from GMC with a few
  static launch fields, `preorder`→`pre_order`, variant grouping (`group_id`,
  `listing_has_variations`, `variant_dict`) and the sale window split from
  `sale_price_effective_date`. Pinned to `us/en_us`.
- **`merchant-center`** — Google Merchant Center. Same `g:`-namespaced `<rss>`
  shape as the source feed, with every source attribute passed through
  (including repeated and structured values such as `shipping`), after the
  shared preparation. Point Merchant Center at this URL instead of the source.

Not served separately: **Google Ads** — it serves from the linked Merchant
Center account (i.e. the `merchant-center` feed).

### `feeds/feeds-push` (scheduled, non-web)

Pushes feeds to providers that take an SFTP upload, nightly at **1:00 AM
America/New_York**. Runtime's alarm feed ignores `timezone` and runs cron in
UTC, so `feeds-push-schedule` fires at 05:00 and 06:00 UTC, and only the run
that is the first 1 AM on the New York clock pushes. The other run returns
`{ skipped: true, reason: 'outside-schedule' }`. This holds across DST,
including the fall-back night, when both fires read 1 AM. It builds each feed in-process
with the same pipeline as `feeds/feeds` (`src/actions/feeds/build.js`), so the
uploaded file is exactly what the feed URL serves.

**Configuration is in code** (`src/actions/feeds-push/config.js`), per
environment: the on/off switch, targets (host, port, remote directory), and the
locale → file name map. The environment comes from the runtime namespace
(`60038-161ivoryjackal-stage` → stage, `60038-161ivoryjackal` → prod; any other
namespace does nothing). Only secrets are env vars (see below).

| Environment | Status | Schedule | Targets |
|---|---|---|---|
| stage | enabled | **on demand only** (`scheduled: false`) | CJ **test** feeds: `Vitamix_US_Edge_Test` (323567) `us/en_us` → `/vitamix_us_edge.xml`; `Vitamix_CA_Edge_Test` (323619) `ca/en_us` → `/vitamix_ca_edge.xml` |
| prod | **disabled** | nightly 1 AM ET (once enabled) | — |

The alarm is defined once in `app.config.yaml`, so it fires in every
environment. When an environment has `scheduled: false`, a scheduled run
returns `{ skipped: true, reason: 'schedule-disabled' }` and only manual runs
push.

Per run, for each target × locale: build → validate → upload. A failure in one
never stops the others. Validation blocks an upload when the feed is empty or
malformed, has fewer items than the feed's `minItems` floor (CJ US: 100), or
(the **shrink guard**) has fewer than 50% of the items of the last successful
push for that target + locale (counts kept in `aio-lib-state`). The provider
then keeps its previous file. CJ-incompatible ids only **warn** (they affect
item-level commissioning, not the import). If anything fails or warns (including
a shrink guard skipped because state was unavailable), one alert email goes to
`ALERT_FEED_FAIL_EMAILS` (log only when unset). Failures alert on every run; a
feed's warnings alert only when they change, so a persistent data issue emails
once rather than nightly. A manual run whose
`target`/`locale` filter matches nothing returns `ok: false` with the known
feeds.

CJ specifics ("POST to CJ SFTP", `datatransfer.cj.com:22`):
- Upload to the root `/` only; CJ ignores subdirectories.
- **Atomic upload** (`atomicUpload: true`): each file is written as
  `<file>.part`, its size checked against the bytes sent, then renamed to the
  registered name with `posix-rename` (atomic replace). If the server lacks
  `posix-rename`, the live file is deleted first and a plain `rename` is used.
  CJ never sees a partial file under the registered name, and any failure
  leaves the previous file in place and removes the temp file. CJ confirmed
  that renaming is supported; only the final name must match the registration.
  The result's `rename` field shows which method ran.
- The file name must exactly match the CJ feed registration. Each locale is a
  separate registration (country/currency/language are fixed per feed).
- CJ confirms receipt and processing **by email** to the registration's
  notification addresses.
- CJ's server only offers the legacy `ssh-dss` host key; the target enables it
  and **pins** its fingerprint (`hostFingerprints` in `config.js`). If CJ rotates
  the key, uploads fail with a `host key mismatch` alert; verify the new
  fingerprint with CJ before adding it.
- All CJ SFTP subscriptions on an account share one password — resetting it in
  CJ breaks every SFTP subscription on that account.

Manual runs (namespace credentials; there is no web URL):

Any of `now`, `dryRun`, `force`, `target` or `locale` marks a manual run and skips
the 1 AM check. A bare invoke is treated like the schedule.

```sh
aio rt action invoke feeds/feeds-push -p now true --result     # full run, now
aio rt action invoke feeds/feeds-push -p dryRun true --result  # build + validate only, no SFTP
aio rt action invoke feeds/feeds-push -p target cj -p locale us/en_us --result
aio rt action invoke feeds/feeds-push -p force true --result   # bypass the shrink guard
```

Emergency stop without a deploy: `aio rt rule disable feeds-push-rule` (the next
deploy re-enables it). To disable permanently, set `enabled: false` in
`config.js`.

Bundling note: ssh2 optionally loads native add-ons that webpack can't bundle;
`webpack-config.cjs` ignores them so ssh2 uses its pure-JS crypto.

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
GET /feeds/feeds?provider=<meta|pinterest|cj|bazaarvoice|openai|merchant-center>&locale=<cc/ll_cc>[&raw=true]
```

Returns the catalog in the provider's format (`application/xml`, or `text/csv`
for `openai`). `locale` defaults to `us/en_us` and must match `cc/ll_cc` (e.g.
`ca/en_us`); `openai` ignores it and always serves `us/en_us`. When
`FEEDS_TOKEN` is set, requests must authenticate with `Authorization: Bearer
<token>` or `?token=<token>` (the query form is for providers that only accept a
plain URL). Responses are cacheable (`max-age=3600`). `raw=true` skips the
shared catalog preparation (see above).

The per-provider feed URLs to hand to each platform (locale `us/en_us` shown;
swap `locale` for other markets, e.g. `ca/en_us`, `ca/fr_ca`, `mx/es_mx`).

**Stage** (`https://60038-161ivoryjackal-stage.adobeioruntime.net`):

| Provider | Feed URL |
|---|---|
| Meta | `https://60038-161ivoryjackal-stage.adobeioruntime.net/api/v1/web/feeds/feeds?provider=meta&locale=us/en_us` |
| Pinterest | `https://60038-161ivoryjackal-stage.adobeioruntime.net/api/v1/web/feeds/feeds?provider=pinterest&locale=us/en_us` |
| Commission Junction | `https://60038-161ivoryjackal-stage.adobeioruntime.net/api/v1/web/feeds/feeds?provider=cj&locale=us/en_us` |
| Bazaarvoice | `https://60038-161ivoryjackal-stage.adobeioruntime.net/api/v1/web/feeds/feeds?provider=bazaarvoice&locale=us/en_us` |
| OpenAI (CSV, US) | `https://60038-161ivoryjackal-stage.adobeioruntime.net/api/v1/web/feeds/feeds?provider=openai` |
| Merchant Center | `https://60038-161ivoryjackal-stage.adobeioruntime.net/api/v1/web/feeds/feeds?provider=merchant-center&locale=us/en_us` |

**Production** (`https://60038-161ivoryjackal.adobeioruntime.net`):

| Provider | Feed URL |
|---|---|
| Meta | `https://60038-161ivoryjackal.adobeioruntime.net/api/v1/web/feeds/feeds?provider=meta&locale=us/en_us` |
| Pinterest | `https://60038-161ivoryjackal.adobeioruntime.net/api/v1/web/feeds/feeds?provider=pinterest&locale=us/en_us` |
| Commission Junction | `https://60038-161ivoryjackal.adobeioruntime.net/api/v1/web/feeds/feeds?provider=cj&locale=us/en_us` |
| Bazaarvoice | `https://60038-161ivoryjackal.adobeioruntime.net/api/v1/web/feeds/feeds?provider=bazaarvoice&locale=us/en_us` |
| OpenAI (CSV, US) | `https://60038-161ivoryjackal.adobeioruntime.net/api/v1/web/feeds/feeds?provider=openai` |
| Merchant Center | `https://60038-161ivoryjackal.adobeioruntime.net/api/v1/web/feeds/feeds?provider=merchant-center&locale=us/en_us` |

Google Ads has no URL here — it serves from the linked Google Merchant Center
account (the `merchant-center` feed above; the unfiltered source is
`{FEED_SITE_BASE}/<locale>/products/merchant-center-feed.xml`).

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
| `FEED_SITE_BASE` | Base host serving the Merchant Center feed per locale | `https://www.vitamix.com` |
| `FEED_CONTENT_BASE` | Host serving authored PDP content (`.plain.html`), used for missing descriptions | `https://main--vitamix--aemsites.aem.live` |
| `FEEDS_TOKEN` | Optional bearer/token gate for the feed URLs. When unset, feeds are public. | unset (public) |

### feeds package — `feeds-push` action

Non-secret settings live in `src/actions/feeds-push/config.js`. Env vars are
secrets only:

| Variable | Description | Default |
|---|---|---|
| `CJ_SFTP_USERNAME` / `CJ_SFTP_PASSWORD` | CJ SFTP credentials for this environment (GitHub secrets `CJ_SFTP_*_STAGE` / `_PROD`) | unset — CJ uploads fail and alert |
| `ALERT_FEED_FAIL_EMAILS` | Comma-separated alert recipients for any failed feed push | unset (log only) |
| `EMAIL_TOKEN` | Productbus token used to send the alert | — |

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
