## What it does

- Polls the commerce journal for purchase events from the last 24 hours via `getJournalEntries`
- Deduplicates journal entries by `orderId` before processing
- Claims each order with a distributed state lock to prevent double-processing across concurrent cron runs
- Fetches full order details via `getOrder` and constructs a Meta CAPI `Purchase` event payload
- Hashes PII fields (email, phone, first name, last name) with SHA-256 before sending
- Sends the payload to the Meta Graph API using the configured pixel and access token
- Marks orders as `PROCESSED` on success or `FAILED` on error

## Required params / environment

- Auth: `SYNC_STATUS_TOKEN` (required — Bearer token validated on every invocation)
- Runtime params (passed into the action): `EDGE_COMMERCE_API_BASE`, `EDGE_COMMERCE_API_ORDERS_TOKEN`, `ORG`, `SITE` (all required for commerce lookups)
- Meta config (env or params): `META_ACCESS_TOKEN` (required), `META_PIXEL_ID` / `META_PIXEL_ID_STAGE` / `META_PIXEL_ID_UAT` (one per environment), `META_BASE_URL` (optional, defaults to `https://graph.facebook.com`), `META_API_VERSION` (optional, defaults to `v22.0`)

## Environment-based pixel selection

The pixel ID is chosen based on the Adobe I/O Runtime namespace or workspace name:

| Condition | Pixel param used |
|-----------|-----------------|
| namespace contains `prod` or workspace is `production` | `META_PIXEL_ID` |
| namespace contains `stage` or workspace is `stage` | `META_PIXEL_ID_STAGE` |
| namespace contains `uat` or workspace is `uat` | `META_PIXEL_ID_UAT` |
| anything else (local dev, unknown) | `META_PIXEL_ID_UAT` |

## State and locking

The action uses Adobe I/O State (`@adobe/aio-lib-state`) to prevent the same order from being sent to Meta more than once. The state key is prefixed with `meta-capi:` followed by the full `orderId` (e.g. `meta-capi:VITAMIX-US-1001`).

| Function | State key | Status written | TTL |
|----------|-----------|---------------|-----|
| `claimOrder` | `meta-capi:{orderId}` | `PROCESSING` (with 10-min lock) | 600 s |
| `completeOrder` | `meta-capi:{orderId}` | `PROCESSED` | forever (`-1`) |
| `failOrder` | `meta-capi:{orderId}` | `FAILED` | forever (`-1`) |

**Important:** If an order is found with status `PROCESSED`, it is skipped. If it is `PROCESSING` and the lock has not expired, it is also skipped (prevents concurrent cron overlap).

## event_id and Meta deduplication

The `event_id` field in the CAPI payload is set to the **numeric suffix** of the order ID, extracted via `orderId.split('-').pop()` (e.g. `VITAMIX-US-1001` → `"1001"`).

**This value must exactly match the `eventID` sent by the client-side Meta Pixel for the same purchase.** Meta uses `event_id` to match browser Pixel events against server-side CAPI events and deduplicate them. If the client-side Pixel sends the full order ID (e.g. `"VITAMIX-US-1001"`) but the server sends only `"1001"`, Meta will treat them as two separate events and count the purchase twice in Ads reporting — defeating the purpose of server-side CAPI integration.

Ensure your storefront's Pixel `Purchase` event is configured to send only the numeric order number (without any store prefix) as the `eventID`.

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
        "ph": ["<sha256-hashed phone>"],
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

- All logging uses a shared `Core.Logger('meta-capi')` singleton (via `getLogger()`). Set `LOG_LEVEL` param to `debug` for verbose output.
- The Meta API call in `sendToMeta` has two layers of error handling:
  - **Network errors** (DNS failure, timeout, TLS error) — caught, logged, and re-thrown with a descriptive message
  - **Non-2xx or `parsedBody.error` responses** — treated as failures; logged and thrown so the order is not silently marked `PROCESSED`
- Per-order errors are caught in `main()` without stopping the rest of the batch; the order is marked `FAILED` in state and the loop continues to the next order.
- A top-level uncaught error (e.g. journal fetch failure) returns HTTP 500 with `error: "meta_capi_failed"`.
- Check action logs for `meta-capi` entries when troubleshooting.

## Notes

- The action is designed to be triggered as a scheduled cron job. Each run processes up to 24 hours of journal entries.
- `buildMetaRequestPayload` uses `order.timestamp` for `event_time` when available; falls back to `Date.now()`.
- To test locally, invoke the action with all required params and ensure your `SYNC_STATUS_TOKEN` is passed as a `Bearer` token in the `Authorization` header.
