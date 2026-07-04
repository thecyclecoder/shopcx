# inngest/sms-callback-drain

Bounded, batched drain for Twilio SMS callbacks. Consumes fast-ack events from the two webhook routes and lands the DB writes off the request path — the Postgres self-DDoS blocker that motivated [[../specs/twilio-callback-queue-drain]].

**File:** `src/lib/inngest/sms-callback-drain.ts`

## Functions

### `sms-callback-drain`
- **Trigger:** event `sms/status-callback.received` (enqueued by [[../integrations/twilio]] `POST /api/webhooks/twilio/marketing-status`).
- **Concurrency:** `concurrency: [{ limit: 8 }]` — the drain-rate DIAL. Bump/cut here when Postgres headroom changes. Same pattern as [[abandoned-cart]] `abandoned-cart-reminder`.
- **Batching:** `batchEvents: { maxSize: 100, timeout: "5s" }` — Inngest hands the handler up to 100 callbacks per run; the 5s tail keeps a quiet stream moving.
- **Split:** delivered/sent → bulk transition UPDATE per group; failed/undelivered → per-row (needs `customer_id` to flip `customers.phone_status` on fatal carrier codes).
- **Idempotency:** dedup by `MessageSid` within batch (highest lifecycle rank wins), then stage-rank guards on the bulk UPDATEs — `sent` only advances rows in `['scheduled','sending','sent']`, `delivered` only touches `['scheduled','sending','sent','delivered']`. A re-delivered batch (Twilio retry) leaves identical row state.
- **Out-of-order:** delivered-before-sent ends in `delivered` (not `sent`) — the `sent` UPDATE excludes rows already `delivered`.
- **Storefront-leads fallback:** any `MessageSid` that isn't a campaign recipient is UPDATE'd against `storefront_leads.sms_message_sid` — the popup-coupon SMS sends direct from the short code with this route as its `StatusCallback` (per [[../integrations/twilio]]).
- **Campaign counter roll-up:** every batch recounts `sms_campaigns.recipients_sent` / `recipients_delivered` / `recipients_failed` for touched campaigns (same recount pattern as [[marketing-text]] send-tick, not a naive increment) so re-drained batches never double-count. `recipients_delivered` was added in Phase 4 alongside the profile-event rollup so segmentation and the campaign-detail dashboard share one source of truth for the delivered count.

### `received-sms-rollup-cron`
- **Trigger:** cron `*/5 * * * *` (every 5 min).
- **Concurrency:** `concurrency: [{ limit: 1 }]` — deterministic flag flip; no two runs racing for the same candidate.
- **What it does:** selects up to 2000 `sms_campaign_recipients` where `delivered_at IS NOT NULL AND received_sms_logged_at IS NULL` (backed by partial index `idx_sms_campaign_recipients_rollup_pending`), bulk-inserts one `profile_events` row per row-with-customer (`metric_name='Received SMS'`, `datetime = delivered_at`, `attributed_campaign_id = campaign_id`), then stamps `received_sms_logged_at = now()` on every candidate (with-or-without customer).
- **Why the flag, not a watermark:** exactly-once by construction. A second cron pass immediately after picks zero candidates because the flag is set. Recipients with no `customer_id` (rare — internal test sends) still get flagged so the scan never re-considers them.
- **Why moved off the drain hot path:** Phase 1 mandate was "zero DB writes on the webhook request path". Phase 2 kept the profile-event insert inside the drain batch as a stopgap. Phase 4 finishes the move so the drain does only status/campaign counter writes and segmentation reads the same `delivered_at` timestamp Twilio actually stamped (not the drain's `now()`, which lags by up to `batchEvents.timeout`).

### `sms-inbound-drain`
- **Trigger:** event `sms/inbound.received` (enqueued by [[../integrations/twilio]] `POST /api/webhooks/twilio/marketing-sms`).
- **Concurrency:** `concurrency: [{ limit: 4 }]` — inbound volume is a fraction of status-callback volume (STOP-storms after a big blast are the main scenario), so a lower ceiling keeps DB write pressure predictable.
- **No batching** — every inbound is a per-customer state change and Shopify consent mutation; batching adds complexity without win.
- **STOP / START classification:** trust `params.OptOutType` (Twilio Advanced Opt-Out only), then keyword match on the body. Same rules as the pre-fast-ack inline code (whole-message or first-word match, never substring — a "thanks!" reply doesn't unsubscribe).
- **Consent flip:** workspace lookup by `to.replace('+','')` against `workspaces.twilio_phone_number` (holds the bare shortcode digits for marketing); phone match via `find_customers_by_phone` RPC (uses the last-10-digits expression index — verified via EXPLAIN); per-matched-customer Shopify mutation (`unsubscribeFromSmsMarketing` / `subscribeToSmsMarketing`) then `customers.sms_marketing_status` UPDATE. Skips rows already in the target state (idempotency).
- **STOP/START autoresponder:** none — Twilio's Advanced Opt-Out already sends the carrier-mandated confirmation from its edge; a second reply looks broken.
- **Generic-reply autoresponder:** dedupe-gated (24h window, one autoresponse per `(shortcode, from_phone)`). Sends via `sendSMS(workspace_id, from, AUTORESPONSE_TEXT)` because Phase 1 fast-ack drops the TwiML response body.

## Upstream events

- `sms/status-callback.received` — `{ params: Record<string,string>, url: string }`. `params` is the Twilio URL-encoded form body parsed into a plain object; `params.MessageSid` is the idempotency key.
- `sms/inbound.received` — same envelope shape. `params.From` / `params.To` / `params.Body` / `params.OptOutType` drive STOP/START + reply routing; `params.MessageSid` deduplicates.

## Downstream events sent

_None._

## Tables written

- [[../tables/sms_campaign_recipients]] — `status`, `sent_at`, `delivered_at`, `error`, `updated_at` (status-callback drain)
- [[../tables/customers]] — `phone_status`, `phone_status_code`, `phone_status_at` on fatal carrier codes (21211/21217/21407/21421/21610/21612/21614/21660/30003-30008) from the status-callback drain; `sms_marketing_status`, `updated_at` on STOP/START from the inbound drain
- [[../tables/sms_campaigns]] — `recipients_sent`, `recipients_delivered`, `recipients_failed`, `updated_at`
- [[../tables/sms_campaign_recipients]] — `received_sms_logged_at` set by `received-sms-rollup-cron` after emitting the `profile_events` "Received SMS" row (Phase 4 idempotency flag)
- [[../tables/profile_events]] — one row per delivered recipient: `metric_name='Received SMS'`, `datetime=delivered_at`, `attributed_campaign_id=campaign_id`. Written by `received-sms-rollup-cron` — NOT by the drain hot path (Phase 4 hoist).
- [[../tables/storefront_leads]] — `sms_status`, `sms_status_at`, `updated_at` (popup-coupon fallback)
- [[../tables/sms_marketing_inbound]] — every inbound row (STOP/START + generic replies), `autoresponded` flag tracks the 24h dedupe window

## Tables read (not written)

- [[../tables/sms_campaign_recipients]] — lookup by `message_sid` for the failed per-row path + campaign-recount
- [[../tables/workspaces]] — workspace lookup by shortcode (inbound drain)

## Tuning notes

**Drain-rate dial (concurrency).** `concurrency.limit` in the `smsCallbackDrain` config at `src/lib/inngest/sms-callback-drain.ts:99` — single-line change. Ceiling = `concurrency × batchEvents.maxSize` callbacks in flight regardless of webhook enqueue rate. Today: `8 × 100 = 800` in flight max. Bump when Postgres headroom is available (watch `pg_stat_activity` for idle-in-transaction); cut on evidence of DB pressure (Supabase 521 gateway errors, statement timeouts). Same location holds the `sms-inbound-drain` limit (`4`) and `received-sms-rollup-cron` limit (`1`).

**Batch-size dial.** `batchEvents.maxSize` at the same line — larger batches = fewer round-trips per callback but bigger UPDATE row sets. 100 is the sweet spot at 800 in-flight ceiling; going above ~500 starts to fight the pooler statement timeout on the bulk UPDATE step.

**Latency dial.** `batchEvents.timeout` (5s). Shorter timeout = faster individual runs at the cost of smaller batches; longer timeout = better bulk efficiency at the cost of tail latency.

## Phase 5 backpressure proof — burst-load harness

`scripts/_burst-load-drain-harness.ts` synthesizes 20k `sms/status-callback.received` events against a seed workspace + campaign, includes a duplicate segment (~10%) and an out-of-order segment (~5%, `delivered` before `sent`), and polls `sms_campaign_recipients` for convergence. Deterministic MessageSids per `--seed`, so a second run against the same seed lands the same sids and hits the idempotency path (bulk UPDATE returns the same row set; stage-rank guards keep state stable). Underscore-prefix throwaway per [[../recipes/script-conventions]].

Run:

```
npx tsx scripts/_burst-load-drain-harness.ts \
  --workspace <uuid> --campaign <uuid> --seed twilio-drain-harness-v1
```

**Status:** ⏳ harness on branch; owner runs against a staging workspace/campaign to record the peak-concurrency screenshot from the Inngest dashboard (the sampler here can't reach Inngest Cloud's run catalog — dashboard is authoritative). Expected result: peak concurrent runs ≤ 8, zero Postgres 521/timeout events, re-run leaves row counts unchanged.

## Related

[[../integrations/twilio]] · [[../specs/twilio-callback-queue-drain]] · [[marketing-text]] · [[abandoned-cart]]
