## What it does

- Constructs a Meta CAPI `events` payload for purchase events
- Sends the payload to the Graph API using the configured pixel and access token
- Uses a small state lock (`order-processing/{orderId}`) to claim and complete order processing

## Required params / environment

- Runtime params (passed into the action): `EDGE_COMMERCE_API_BASE`, `EDGE_COMMERCE_API_ORDERS_TOKEN`, `ORG`, `SITE` (all required for commerce lookups)
- Meta config (env or params): `META_ACCESS_TOKEN` (required), `META_PIXEL_ID`/`META_PIXEL_ID_STAGE`/`META_PIXEL_ID_UAT` (one per environment), `META_API_VERSION` (optional, defaults to `v22.0`)

## Input

The action accepts either a raw JSON body or a base64-encoded JSON payload in `__ow_body`. It also supports being invoked as a cron/runner that queries orders (the implementation calls `getOrder` and `getJournalEntries` when available).

## State and locking

The action uses Adobe I/O State (via `@adobe/aio-lib-state`) to claim orders under the key `order-processing/{orderId}`. `claimOrder` sets a `PROCESSING` status and a TTL; `completeOrder` marks orders as `PROCESSED`.

## Errors and logging

The action uses `@adobe/aio-sdk`'s `Core.Logger` where available; network/Meta response parsing falls back to `console.error` for safety. Check action logs for `meta-capi` entries when troubleshooting.

## Notes

- The payload builder (`buildMetaRequestPayload`) hashes user identifiers and maps order items into `custom_data.contents` for CAPI compatibility.
- To test locally, invoke the action with the required params and a sample order id matching your commerce backend.

