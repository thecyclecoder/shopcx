# inngest/meta-capi-dispatch

The Meta CAPI fan-out: `storefront_events` → `event_dispatches` → Meta Conversions API. Storefront-mvp Phase 3.

**File:** `src/lib/inngest/meta-capi-dispatch.ts`

## Function

### `meta-capi-dispatch-cron`
- **Trigger:** cron `* * * * *` (every minute)
- **Retries:** 1 · **Concurrency:** 1

Per active `meta_capi` sink:
1. **Seed** — find mapped storefront events (ViewContent/AddToCart/InitiateCheckout/Purchase/Lead) from the last 20 min that have no [[../tables/event_dispatches]] row for this sink yet → insert `pending` (idempotent via the `(event_id, sink_id)` unique key). Honors the sink's `event_types` filter (empty = all mapped).
1b. **Seed safety net (`order_placed` only)** — re-scan `order_placed` events across Meta's **7-day** acceptance window and seed any still undispatched. The 20-min lookback in step 1 keys off `created_at`, so an event whose `created_at` is *already* older than the window when the row is inserted — a server-side **backfill** recreating a pixel-missed purchase with `created_at = order time` — would never be seeded and the Purchase would silently never reach Meta. Because the money event funds the ad account, it gets this wider idempotent sweep. (This is exactly how SHOPCX11 went missing: a `source: server_backfill` `order_placed` row, backdated to the order time, sat outside every tick's 20-min window.)
1c. **Renewals excluded from Purchase** — before seeding, any `order_placed` event whose order is a **renewal** (`orders.source_name` contains `"subscription"` — i.e. `recurring` per [[../libraries/order-bucketing]]) is dropped, so recurring subscription billing never reaches Meta as a `Purchase`. Renewals aren't ad conversions and are already excluded from ROAS on our side; this keeps Meta-attributed conversions in sync. Today `order_placed` is only emitted by the storefront checkout for **new** orders (the internal-renewal function and Shopify sync emit none), so this is defense-in-depth against a future immediate "order now" / renewal-via-storefront path emitting one. Verified 2026-06-18: 0 of the recent `order_placed` events referenced a renewal.
2. **Send** — pull `pending` + retryable `failed` dispatches (`attempts < 5`), load each event + its session (+ customer for email/phone/name), build `CapiEvent` payloads ([[../libraries/meta-capi]] does the hashing), and POST one batch via `sendCapiEvents`. No date filter here — the send step picks up any `pending` row regardless of age, so seeding is the only place a late event can be dropped.
3. **Record** — write `sent` / `failed` / `dlq` (≥5 attempts) + response code/body back on the dispatch row.

## Why a cron sweep (not a per-event emit)

Decouples delivery from the hot `/api/pixel` path, batches one POST per sink per tick, and the `event_dispatches` row IS the retry ledger (a failed send stays `failed`, retried next tick until `dlq`). Dedup with the browser pixel is automatic — both carry `event_id = storefront_events.id`, so Meta collapses them in its 48h window.

## Tables

- **Read:** [[../tables/event_sinks]], [[../tables/storefront_events]], [[../tables/storefront_sessions]], [[../tables/customers]]
- **Written:** [[../tables/event_dispatches]]

## Match-quality notes

We don't store raw client IP (`storefront_sessions` keeps only geo), so `client_ip_address` is absent; match relies on hashed email/phone (when the session identified) + `fbp`/`fbc` (cookie or derived from `fbclid`) + user-agent + hashed `external_id`.

**First-touch `fbc` recovery:** `fbc` ties the conversion to the ad click and is derived from the `fbclid` that lands in the URL — but `fbclid` is captured on the **first-touch** session, while the event (especially the server-created `order_placed`, which can fall back to a later session) may sit on a session with no click id. When the event's own session has neither `fbc` nor `fbclid`, the dispatcher recovers the visitor's **earliest** `fbc`/`fbclid` (by `customer_id`, else `anonymous_id`) and stamps the derived `fb.1.<ts>.<fbclid>` with that landing's time. Without this, a buyer who clicked the ad then converted in a later/direct session (e.g. via a recovery link) would reach Meta with no click match.

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/meta-capi]] · [[../lifecycles/storefront-checkout]] · [[../../CLAUDE]]
