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
- **Campaign counter roll-up:** every batch recounts `sms_campaigns.recipients_sent` / `recipients_failed` for touched campaigns (same recount pattern as [[marketing-text]] send-tick, not a naive increment) so re-drained batches never double-count. Phase 4 adds a `recipients_delivered` counter.

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
- [[../tables/sms_campaigns]] — `recipients_sent`, `recipients_failed`, `updated_at`
- [[../tables/profile_events]] — `metric_name='Received SMS'` on delivered (moves to a watermarked rollup in Phase 4)
- [[../tables/storefront_leads]] — `sms_status`, `sms_status_at`, `updated_at` (popup-coupon fallback)
- [[../tables/sms_marketing_inbound]] — every inbound row (STOP/START + generic replies), `autoresponded` flag tracks the 24h dedupe window

## Tables read (not written)

- [[../tables/sms_campaign_recipients]] — lookup by `message_sid` for the failed per-row path + campaign-recount
- [[../tables/workspaces]] — workspace lookup by shortcode (inbound drain)

## Tuning notes

**Drain-rate dial:** `concurrency.limit` in the function config. Ceiling = `concurrency × batchEvents.maxSize` callbacks in flight regardless of webhook enqueue rate. Today: `8 × 100 = 800` in flight max.

**Latency dial:** `batchEvents.timeout` (5s). Shorter timeout = faster individual runs at the cost of smaller batches; longer timeout = better bulk efficiency at the cost of tail latency.

## Related

[[../integrations/twilio]] · [[../specs/twilio-callback-queue-drain]] · [[marketing-text]] · [[abandoned-cart]]
