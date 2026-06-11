# libraries/meta-capi

Server-side Meta Conversions API (CAPI) sender + sink resolver for the storefront. Storefront-mvp Phase 3.

**File:** `src/lib/meta-capi.ts`

We run **both** the browser pixel (`fbq`, wired in [[storefront-pixel]]) and this server CAPI stream, **deduped on a shared `event_id`** (= `storefront_events.id`). CAPI-only yields poor match quality because the browser pixel is what sets `_fbp`/`_fbc`; both together is Meta's 2026 guidance for paid accounts.

## Credentials

Live in [[../tables/event_sinks]]`.config` for the `meta_capi` sink: `{ pixel_id, access_token_enc, test_event_code? }`. Only the access token is secret (AES-256-GCM via [[crypto]]); `pixel_id` is public (ships in the browser snippet). There is **one active meta_capi sink per workspace** (first active row wins).

## Exports

| Export | Purpose |
|---|---|
| `getActiveMetaSink(workspaceId)` | Resolve + decrypt the active sink → `{ sinkId, pixelId, accessToken, testEventCode, eventTypes }`. Server-only. |
| `getMetaPixelId(workspaceId)` | Pixel id only (public, no decrypt) — for the browser snippet on PDP/checkout/thank-you. |
| `META_EVENT_MAP` / `metaEventName(type)` | Our event type → Meta standard event. **Must mirror `META_EVENT_MAP` in [[storefront-pixel]]** so browser + server fire the same name under the same id. |
| `deriveFbc(fbc, fbclid, eventTimeMs)` | Build `_fbc` (`fb.1.<ms>.<fbclid>`) when the cookie wasn't captured. |
| `sendCapiEvents(sink, events[])` | POST a batch to `graph.facebook.com/v21.0/{pixel_id}/events`. Hashes PII (SHA-256 of normalized em/ph/fn/ln/ct/st/zp/country + external_id), passes fbp/fbc/ip/ua unhashed. Never throws — returns `{ ok, status, body }` for the dispatcher to record. |
| `resolveMetaContent(workspaceId, events[])` | Batch-resolve catalog `content_ids` for events → `Map<eventId, { contentIds, numItems? }>`. **UUID→meta_id translation happens HERE only** — our event stream is all-UUID; this is the single egress where Shopify-derived catalog ids appear. Refs resolve tolerantly (our UUID OR `shopify_variant_id` OR `sku` → `meta_id`). Sources per type: `pdp_view`→product's variants; `add_to_cart`→meta variant/primary/upsell; `checkout_view`→[[../tables/cart_drafts]].line_items; `order_placed`→[[../tables/orders]].line_items. content_type is always `product` (catalog is variant-level). |

## Event map (browser ⇄ server, same `event_id`)

| storefront event | Meta standard |
|---|---|
| `pdp_view` | ViewContent |
| `add_to_cart` | AddToCart |
| `checkout_view` | InitiateCheckout |
| `order_placed` | Purchase |
| `lead_captured` | Lead |

Events not in the map (chapter_view/dwell/scroll_depth/cta_click) are internal telemetry — never forwarded.

## Fan-out

The cron [[../inngest/meta-capi-dispatch]] seeds [[../tables/event_dispatches]] from recent events, calls `resolveMetaContent` once per batch to attach `content_ids`/`content_type`/`num_items`, then `sendCapiEvents`. This module is the pure sender + resolver; it does no DB writes beyond read-only lookups.

## content_ids — catalog matching

The Meta catalog (fed from Shopify) keys items by raw numeric Shopify variant id. Our app/events never carry Shopify ids — only UUIDs. The bridge is [[../tables/product_variants]].`meta_id` (copied from `shopify_variant_id`). `resolveMetaContent` does the UUID→meta_id lookup at send time, so the catalog keeps matching even after Shopify ids are dropped. The **browser pixel deliberately sends NO content_ids** ([[storefront-pixel]] `fireMetaPixel`) — it would only have UUIDs, which aren't catalog ids; the deduped server event supplies them.

---

[[../README]] · [[storefront-pixel]] · [[crypto]] · [[../inngest/meta-capi-dispatch]] · [[../tables/event_sinks]] · [[../tables/event_dispatches]] · [[../lifecycles/storefront-checkout]] · [[../../CLAUDE]]
