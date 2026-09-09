## What it does

- Polls the commerce journal for purchase events from the last 24 hours via `getJournalEntries`
- Filters journal entries to `payment_completed` events only, then deduplicates by `orderId` before processing
- Claims each order with a distributed state lock to prevent double-processing across concurrent cron runs
- Fetches full order details via `getOrder` and constructs a Meta CAPI `Purchase` event payload
- Hashes PII fields (email, phone, first name, last name) with SHA-256 before sending
- Sends the payload to the Meta Graph API using the configured pixel and access token
- Marks orders as `PROCESSED` on success or `FAILED` on error in Adobe I/O State

## Required params / environment

| Param | Required | Description |
|---|---|---|
| `EDGE_COMMERCE_API_BASE` | Yes | Commerce API base URL for journal and order lookups |
| `EDGE_COMMERCE_API_ORDERS_TOKEN` | Yes | Auth token for commerce API |
| `META_ACCESS_TOKEN` | Yes | Meta Graph API access token |
| `META_PIXEL_ID` | Yes (prod) | Pixel ID for production |
| `META_PIXEL_ID_STAGE` | Yes (stage) | Pixel ID for stage |
| `META_PIXEL_ID_UAT` | Yes (uat/dev) | Pixel ID for UAT and local dev |
| `META_BASE_URL` | No | Defaults to `https://graph.facebook.com` |
| `META_API_VERSION` | No | Defaults to `v22.0` |
| `LOG_LEVEL` | No | Log level passed as action param. Defaults to `debug` in code |
| `AIO_LOG_LEVEL` | No | **Must be set in `.env`** to enable `log.info`/`log.debug` output. Without this, `Core.Logger` defaults to `warn` and suppresses info logs. Set to `debug` for local development |

## Environment-based pixel selection

The pixel ID is chosen at runtime based on the Adobe I/O Runtime namespace or workspace name:

| Condition | Pixel param used |
|---|---|
| namespace contains `prod` or workspace is `production` | `META_PIXEL_ID` |
| namespace contains `stage` or workspace is `stage` | `META_PIXEL_ID_STAGE` |
| namespace contains `uat` or workspace is `uat` | `META_PIXEL_ID_UAT` |
| anything else (local dev, unknown) | `META_PIXEL_ID_UAT` (safe default) |

## State and locking

The action uses Adobe I/O State (`@adobe/aio-lib-state`) to prevent the same order from being sent to Meta more than once. The state key uses the **full `orderId`** (e.g. `meta-capi:VITAMIX-US-1001`) to avoid collision between orders from different store prefixes that may share the same numeric suffix.

| Function | State key | Status written | TTL |
|---|---|---|---|
| `claimOrder` | `meta-capi:{orderId}` | `PROCESSING` (with 10-min lock) | 600 s |
| `completeOrder` | `meta-capi:{orderId}` | `PROCESSED` | forever (`-1`) |
| `failOrder` | `meta-capi:{orderId}` | `FAILED` | forever (`-1`) |

**Skip conditions in `claimOrder`:**
- Status is `PROCESSED` → skip permanently (already sent to Meta)
- Status is `PROCESSING` and `lockedUntil` has not expired → skip (another worker is processing it)

## event_id and Meta deduplication

The `event_id` field in the CAPI payload is derived from the `orderId` using `lastIndexOf('-')`:

```js
const lastDashIndex = orderValue.lastIndexOf('-');
const orderId = orderValue.substring(lastDashIndex + 1);
```

For example, `VITAMIX-US-1001` → `event_id = "1001"`.

**This value must exactly match the `eventID` sent by the client-side Meta Pixel for the same purchase.** Meta uses `event_id` to match browser Pixel events with server-side CAPI events and deduplicate them. If there is a mismatch (e.g. client sends `"VITAMIX-US-1001"` but server sends `"1001"`), Meta treats them as two separate events and counts the purchase twice in Ads reporting — defeating the purpose of server-side CAPI integration.

Verify that your storefront Pixel `Purchase` event sends only the numeric order number (without any store prefix) as the `eventID`, or update both sides to use the same full order ID format.

## event_time extraction

`event_time` is extracted from the `orderId` value passed by the journal entry. The format expected is `<ISO-timestamp>-<numericOrderId>` (e.g. `2026-08-01T12:00:00.000Z-1001`):

```js
const lastDashIndex = orderValue.lastIndexOf('-');
const actualTimestamp = orderValue.substring(0, lastDashIndex);  // ISO date part
const orderId = orderValue.substring(lastDashIndex + 1);         // numeric order ID

const event_time = actualTimestamp && !isNaN(Date.parse(actualTimestamp))
  ? Math.floor(new Date(actualTimestamp).getTime() / 1000)       // use order timestamp
  : Math.floor(Date.now() / 1000);                               // fallback to now
```

If the timestamp portion cannot be parsed, it falls back to the current time.

## Payload structure

```json
{
  "data": [
    {
      "event_name": "Purchase",
      "event_time": 1234567890,
      "event_id": "1001",
      "action_source": "website",
      "user_data": {
        "em": ["<sha256-hashed email>"],
        "ph": ["<sha256-hashed phone — only included if phone is present>"],
        "fn": ["<sha256-hashed first name>"],
        "ln": ["<sha256-hashed last name>"]
      },
      "custom_data": {
        "currency": "USD",
        "value": 99.99,
        "content_type": "product",
        "contents": [
          { "id": "SKU-123", "quantity": 1, "price": 99.99 }
        ]
      }
    }
  ]
}
```

## Errors and logging

- All logging uses `Core.Logger('meta-capi')`. **`AIO_LOG_LEVEL=debug` must be set in `.env`** for `log.info` output to appear — without it, the SDK defaults to `warn` level and all info logs are silently suppressed.
- The `LOG_LEVEL` action param (set in `app.config.yaml`) controls the label passed to the logger constructor. `AIO_LOG_LEVEL` env var controls the actual transport filter.
- `sendToMeta` has two layers of error handling:
  - **Network errors** (DNS failure, timeout, TLS error) — caught, logged with URL and error message, re-thrown as `Meta API network error: ...`
  - **Non-2xx or `parsedBody.error` responses** — Meta can return HTTP 200 with an error body (e.g. auth failures with code 190); both cases are detected and thrown so the order is not silently marked `PROCESSED`
- Per-order errors are caught in `main()`, the order is marked `FAILED` in state, and the loop continues to the next order
- A top-level uncaught error (e.g. journal fetch failure) returns HTTP 500 with `{ "error": "meta_capi_failed", "detail": "..." }`
- Successful response from `sendToMeta` returns `{ status: <HTTP status>, body: { eventsReceived: <count>, metaResponse: <full body> } }`

## Local development

```bash
# Terminal 1 — rebuild dist/ on every src/ change
npm run build:watch

# Terminal 2 — serve the action locally
aio app dev
```

`aio app dev` serves from `dist/` (as configured in `app.config.yaml`). Source changes in `src/` are not picked up until after a build. The `build:watch` script rebuilds automatically on save.

To invoke the action manually:
```bash
aio rt action invoke forms/meta-capi --result
```

The action has no public HTTP endpoint (`web: 'no'` in `app.config.yaml`). HTTP invocation via `curl` is not available.

## Notes

- The action is designed to be triggered as a scheduled cron job (every 3 hours per `app.config.yaml`). Each run processes up to 24 hours of journal entries.
- The state lock TTL is 600 seconds (10 minutes). If the action crashes mid-processing, the lock expires automatically and the order will be retried on the next cron run.
- `FAILED` orders are stored in state forever (`ttl: -1`) and will not be retried automatically. Manual intervention or a separate retry mechanism is required.
