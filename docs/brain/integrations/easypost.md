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

**On `delivered` event:** fires Inngest `returns/process-delivery` → [[../inngest/returns]] → instantly fires `returns/issue-refund`. No 24h wait, no inventory dispose.

## Gotchas

- **USPS pinned.** `Shipment.buy` calls bias to USPS; only falls back when USPS has no rate. Reason: cheapest reliable carrier for our return volume.
- **`is_return: true` on the wrong endpoint causes from/to swap.** Past bug: the improve-tab `create_return` action set `is_return: true` directly on `Shipment.create` → USPS printed labels with swapped addresses → packages came back to *customers*, not to us. Fix: always use `createFullReturn()` in `src/lib/shopify-returns.ts` which builds the right address pair manually.
- **`net_refund_cents` is set at return-creation** and the pipeline trusts it. Never re-derive at refund time. See returns rules in CLAUDE.md.
- **`freeLabel: true`** = we eat the EasyPost cost (label_cost_cents = 0). Crisis returns + tenured-customer goodwill returns use this.
- **Refund fires on EasyPost `delivered`, not carrier first-scan.** See feedback_return_refund_trigger.
- **Imported returns** (not created by us — `easypost_shipment_id IS NULL`) should never be auto-refunded. Always filter `.not("easypost_shipment_id", "is", null)`.
- **Test mode keys** can buy labels against the USPS sandbox — but the labels are NOT usable. Production cutover requires flipping `easypost_test_mode = false`.

## Files

- `src/lib/easypost.ts` — SDK wrapper, address validation, rate selection
- `src/lib/shopify-returns.ts` — `createFullReturn()` (Shopify return + EasyPost label + stored refund amount)
- `src/lib/easypost-order-sync.ts` — Per-order shipment + tracker creation
- `src/lib/easypost-email.ts` — Return label email send

## Related

[[../tables/returns]] · [[../tables/replacements]] · [[../tables/orders]] · [[../inngest/returns]] · [[../inngest/delivery-audit]]
