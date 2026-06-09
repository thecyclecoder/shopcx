# inngest/meta-capi-dispatch

The Meta CAPI fan-out: `storefront_events` → `event_dispatches` → Meta Conversions API. Storefront-mvp Phase 3.

**File:** `src/lib/inngest/meta-capi-dispatch.ts`

## Function

### `meta-capi-dispatch-cron`
- **Trigger:** cron `* * * * *` (every minute)
- **Retries:** 1 · **Concurrency:** 1

Per active `meta_capi` sink:
1. **Seed** — find mapped storefront events (ViewContent/AddToCart/InitiateCheckout/Purchase/Lead) from the last 20 min that have no [[../tables/event_dispatches]] row for this sink yet → insert `pending` (idempotent via the `(event_id, sink_id)` unique key). Honors the sink's `event_types` filter (empty = all mapped).
2. **Send** — pull `pending` + retryable `failed` dispatches (`attempts < 5`), load each event + its session (+ customer for email/phone/name), build `CapiEvent` payloads ([[../libraries/meta-capi]] does the hashing), and POST one batch via `sendCapiEvents`.
3. **Record** — write `sent` / `failed` / `dlq` (≥5 attempts) + response code/body back on the dispatch row.

## Why a cron sweep (not a per-event emit)

Decouples delivery from the hot `/api/pixel` path, batches one POST per sink per tick, and the `event_dispatches` row IS the retry ledger (a failed send stays `failed`, retried next tick until `dlq`). Dedup with the browser pixel is automatic — both carry `event_id = storefront_events.id`, so Meta collapses them in its 48h window.

## Tables

- **Read:** [[../tables/event_sinks]], [[../tables/storefront_events]], [[../tables/storefront_sessions]], [[../tables/customers]]
- **Written:** [[../tables/event_dispatches]]

## Match-quality notes

We don't store raw client IP (`storefront_sessions` keeps only geo), so `client_ip_address` is absent; match relies on hashed email/phone (when the session identified) + `fbp`/`fbc` (cookie or derived from `fbclid`) + user-agent + hashed `external_id`.

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/meta-capi]] · [[../lifecycles/storefront-checkout]] · [[../../CLAUDE]]
