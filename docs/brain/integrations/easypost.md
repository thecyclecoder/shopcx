# easypost

EasyPost — return label purchase + reverse-shipment tracking. We use EasyPost for ALL return labels (not Shopify Shipping) because we want USPS-pinned pricing + on-demand label purchase + delivered-event tracking.

## Auth

- **Encrypted on `workspaces`:**
  - `easypost_live_api_key_encrypted` — production API key
  - `easypost_test_api_key_encrypted` — sandbox API key
- **Plain on `workspaces`:**
  - `easypost_test_mode` (bool) — which key to use
  - `easypost_webhook_secret` — HMAC verification for inbound tracking webhooks
  - `return_address` (JSONB) — pickup address
  - `default_return_parcel` (JSONB) — default parcel dims/weight

Standard HTTP basic auth: `Authorization: Basic base64(API_KEY:)`.

## Key endpoints we call

Uses the `@easypost/api` npm SDK (no raw HTTP). The SDK targets `https://api.easypost.com/v2`.

| SDK call | Purpose |
|---|---|
| `Address.create` | Validate + create address objects (from + to) |
| `Parcel.create` | Build the parcel (length / width / height / weight) |
| `Shipment.create` | Create a shipment (combines addresses + parcel + options) |
| `Shipment.buy` | Purchase the lowest USPS rate (falls back to other carriers only if USPS has none) |
| `Tracker.retrieve` / Tracker webhooks | Per-shipment status: pre_transit → in_transit → delivered |

## Rate limits + retry

- 50 req/min default; can be raised. We rarely hit this.
- SDK does not auto-retry. Failures bubble up; callers decide.

## Webhooks

Inbound tracking webhook → handler verifies `easypost_webhook_secret` → matches by `easypost_shipment_id` → updates [[../tables/returns]].`status` / `delivered_at` / `tracking_status`.

**On `delivered` OR `available_for_pickup` event:** fires Inngest `returns/process-delivery` → [[../inngest/returns]] → instantly fires `returns/issue-refund`. No 24h wait, no inventory dispose. Phase 2 fix — `available_for_pickup` (USPS post-office / locker delivery) used to stamp the return as delivered but never fire the event (guaranteed-stuck refund); the dispatch now checks a `DELIVERED_TRACKER_STATUSES` set so both statuses converge on one dispatch site.

**Fail-loud webhook.** The route uses the `inngest` client (not a raw `fetch` to `https://inn.gs/e/<key>` — that gap silently swallowed dispatch failures + returned 200 so EasyPost never retried), checks the returns-update error and returns 500 on failure, and returns 500 on any `inngest.send` throw so EasyPost's own retry policy engages. `src/app/api/webhooks/easypost/route.ts`.

## Gotchas

- **USPS pinned.** `Shipment.buy` calls bias to USPS; only falls back when USPS has no rate. Reason: cheapest reliable carrier for our return volume.
- **`is_return: true` on the wrong endpoint causes from/to swap.** Past bug: the improve-tab `create_return` action set `is_return: true` directly on `Shipment.create` → USPS printed labels with swapped addresses → packages came back to *customers*, not to us. Fix: always use `createFullReturn()` in `src/lib/shopify-returns.ts` which builds the right address pair manually.
- **`net_refund_cents` is set at return-creation** and the pipeline trusts it. Never re-derive at refund time. See returns rules in CLAUDE.md.
- **`freeLabel: true`** = we eat the EasyPost cost (label_cost_cents = 0). Crisis returns + tenured-customer goodwill returns use this.
- **Refund fires on EasyPost `delivered`, not carrier first-scan.** See feedback_return_refund_trigger.
- **Imported returns** (not created by us — `easypost_shipment_id IS NULL`) should never be auto-refunded. Always filter `.not("easypost_shipment_id", "is", null)`.
- **Test mode keys** can buy labels against the USPS sandbox — but the labels are NOT usable. Production cutover requires flipping `easypost_test_mode = false`.
- **Webhook log-level for tracker statuses.** The webhook handler logs `return_to_sender`, `failure`, `error`, and `cancelled` tracker statuses at `console.warn` (not error), because these are normal business signals (USPS bouncing a package back, delivery failures due to address issues, etc.), not code faults. Logging at warn avoids creating false Control Tower error incidents for fully-handled business events; the workspace still receives the dashboard notification and the webhook returns 200 OK. See src/app/api/webhooks/easypost/route.ts lines 186–205.

## Shipment fact packs — the read-side rail for every agent-facing stall claim

Any agent-facing surface that claims where a shipment is or how long it has been stalled goes through the shared **shipment fact pack** helper ([[../libraries/shipment-facts]] · `src/lib/shipment-facts.ts`), which computes a live pack from a `lookupTracking` call (`src/lib/easypost.ts:452`): the ordered event list with each event's real `datetime`, the last-scan timestamp, the derived days-since-last-scan, the live status, and whether an `est_delivery_date` is present. The cached `orders.easypost_*` columns are a fallback ONLY when the live call fails, and in that case the pack labels the values as cached with their `easypost_checked_at` age rather than presenting them as current — the cached row carries NO per-scan timestamp (`easypost_checked_at` is when WE last asked, not when the carrier last scanned). Callers MUST NOT infer a stall duration from `amplifier_shipped_at`; the ship date is when we handed the package over, not when the carrier last touched it (on Suzanne's order those differed by three days). One live call per distinct tracking number per session, deduped by `createShipmentFactPackReader`.

Consumers today:

- **CS Director brief** (`scripts/builder-worker.ts` `loadCsDirectorCallBrief`) — one line per recent tracked shipment, in the "LIVE SHIPMENT FACT PACKS" section.
- **Order-tracking workflow** (`src/lib/workflow-executor.ts` `executeOrderTracking`) — replaces the inline `lookupTracking` call; internal notes cite the live scan age, and a live-call failure logs a CACHED-labeled note (checked-at + age) rather than a bare status line that reads as current.

Derived-from ticket 8e2c87d6 (Suzanne Ross, 2026-08-24): cached row said `in_transit` at a Nevada facility; the live read showed the last scan was eleven days old with no estimated delivery.

## Files

- `src/lib/easypost.ts` — SDK wrapper, address validation, rate selection
- `src/lib/shipment-facts.ts` — [[../libraries/shipment-facts|shipment fact pack helper]] (live tracker read + derived days-since-last-scan)
- `src/lib/shopify-returns.ts` — `createFullReturn()` (Shopify return + EasyPost label + stored refund amount)
- `src/lib/easypost-order-sync.ts` — Per-order shipment + tracker creation
- `src/lib/easypost-email.ts` — Return label email send

## Related

[[../tables/returns]] · [[../tables/replacements]] · [[../tables/orders]] · [[../inngest/returns]] · [[../inngest/delivery-audit]]
