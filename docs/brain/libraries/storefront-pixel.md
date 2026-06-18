# libraries/storefront-pixel

First-party storefront pixel client lib — emits to our `/api/pixel` ([[../tables/storefront_events]]) **and** mirrors mapped events to Meta's browser `fbq` pixel (storefront-mvp Phase 3). Handles batching, `sendBeacon` on unload, and per-session attribution capture.

**File:** `src/lib/storefront-pixel.ts`

## Exports

### `initPixel` — function

```ts
function initPixel(opts: { workspaceId: string; customerId?: string | null; metaPixelId?: string | null })
```

Call once per page (top-level layout effect) BEFORE any `track()`. Idempotent — only the first call captures attribution. When `metaPixelId` is passed it boots the Meta browser pixel via `initMetaPixel` (injects `fbq`, `init`, base `PageView`). The id is threaded from page-data → PDP / checkout / thank-you.

### `track` — function

```ts
function track(eventType: string, meta?: EventMeta, eventId?: string)
```

Writes a `storefront_events` row, then mirrors to `fbq` for mapped events via `fireMetaPixel`. `eventId` (the `storefront_events` row id) is reused as the Meta `eventID` so the **server CAPI twin** ([[meta-capi]] / [[../inngest/meta-capi-dispatch]]) deduplicates inside Meta's 48h window. Pass the canonical `order_placed` id at checkout so the browser Purchase and the CAPI Purchase share one `event_id`.

### `identify` — function

```ts
function identify(id: string)
```

### `getAnonymousId` — function

```ts
function getAnonymousId() : string | null
```

## Meta browser pixel (Phase 3)

`META_EVENT_MAP` maps first-party event types → Meta standard events; events not in the map (`chapter_view`/`chapter_dwell`/`scroll_depth`/`cta_click`) are internal-only telemetry and never reach `fbq`:

| First-party event | Meta standard event |
|---|---|
| `pdp_view` | `ViewContent` |
| `add_to_cart` | `AddToCart` |
| `checkout_view` | `InitiateCheckout` |
| `order_placed` | `Purchase` |
| `lead_captured` | `Lead` |

`buildSessionContext()` (frozen into `sessionStorage` on first `initPixel`) captures landing url, referrer, UTM params, `fbclid`/`gclid`/`ttclid`, and Meta's `_fbp`/`_fbc` cookies — the attribution payload the server CAPI sender hashes for match quality (`fbc` derived server-side from `fbclid` when the cookie is absent — see [[meta-capi]] `deriveFbc`).

## Callers

- `src/app/(storefront)/_components/StorefrontPixelInit.tsx`
- `src/app/(storefront)/checkout/_components/CheckoutClient.tsx`
- `src/app/(storefront)/customize/_components/CustomizeClient.tsx`
- `src/app/(storefront)/thank-you/_components/ThankYouClient.tsx`

## Gotchas

- **Dedup hinges on a shared `event_id`.** A `track()` that omits `eventId` mints a fresh UUID, so the browser Purchase and the CAPI Purchase would diverge into two events. Always thread the `order_placed` row id through both paths.
- The Meta pixel only boots when `metaPixelId` is supplied to `initPixel`; with no `meta_capi` event_sink configured the storefront stays Meta-dark on the browser side (CAPI also no-ops).

---

[[../README]] · [[../lifecycles/storefront-checkout]] · [[meta-capi]] · [[../inngest/meta-capi-dispatch]] · [[../tables/storefront_events]] · [[../integrations/meta-marketing]] · [[../../CLAUDE]]
