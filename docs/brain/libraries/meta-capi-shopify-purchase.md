# `src/lib/meta-capi-shopify-purchase.ts` — Shopify `orders/create` → Meta CAPI Purchase

The **server half** of the Shopify pixel pair. The web pixel fires a browser Purchase on `checkout_completed`; this fires the server copy off the order webhook, carrying the hashed PII the browser never sees.

**Context.** The Meta sales-channel app was uninstalled 2026-09-02, taking the pixel *and* its CAPI with it. Everything on `superfoodscompany.com` is now ours: [[../../shopify-extension/extensions/meta-pixel|the web pixel]] (collector) → [[../lifecycles/shopify-meta-capi]] → [[meta-capi]] `sendCapiEvents`.

## The two rules that carry the weight

**1. Renewals never send.** Founder rule 2026-09-02. Of ~435 weekly Shopify orders only **~45 are new web checkouts** — the rest are `subscription_contract_checkout_one` (348) and `internal_subscription_renewal` (26). Crediting those as ad conversions would inflate acquisition ROAS by roughly 10x and steer Meta's optimiser toward people who already subscribe.

The filter is a **positive allowlist** (`CAPI_ALLOWED_SOURCE_NAMES = {"web"}`), not a denylist: a Shopify channel we've never seen defaults to NOT sending. A denylist would leak the first renewal-ish source someone adds.

**2. The dedup id must match the pixel byte for byte.**

```
browser  checkout_completed  → `shopify_purchase_${checkout.order.id}`
server   orders/create       → `shopify_purchase_${payload.id}`
```

`checkout.order.id` is non-null **only** on `checkout_completed` (per `@shopify/web-pixels-extension` types) — exactly where it's needed. Meta dedups on `(event_name, event_id)` and keeps the richer copy, which is the server one. If these strings ever drift, every purchase counts twice.

## Exports

| Export | Notes |
|---|---|
| `buildShopifyPurchaseEvent(payload, opts?)` | **Pure.** Decides send/skip and builds the `CapiEvent`. Skip reasons: `not_web_source` · `no_order_id` · `zero_value` · `test_order`. Pure so the renewal rule is testable without Supabase or Meta. |
| `sendShopifyPurchase(workspaceId, payload, opts?)` | Resolves the sink and sends. **Never throws** — a tracking failure must not fail the webhook, or Shopify retries the whole order ingest. |
| `CAPI_ALLOWED_SOURCE_NAMES` | The allowlist. Currently `{"web"}`. |
| `PurchaseSkipReason` / `ShopifyPurchaseDecision` | Verdict shapes. |

## Match keys sent

`email · phone · first/last name · city · state · zip · country · external_id` (all SHA-256 normalized by [[meta-capi]]), plus unhashed `fbp` / `fbc` / IP / UA. `deriveFbc` reconstructs `_fbc` from an `fbclid` when no cookie was captured.

Verified live 2026-09-02 against Test Events: **13 user-data keys**, `Processed`, `events_received: 1`, zero warnings. For contrast, the retired Shopify app pixel carried email on 125 of ~4,500 weekly events and was otherwise cookie-only.

## Caller

[[../../src/app/api/webhooks/shopify/route.ts|`/api/webhooks/shopify`]] on topic **`orders/create` only** — never `orders/updated`, so a later edit to an order cannot emit a second conversion.

## Related

[[meta-capi]] (sender + hashing) · [[../lifecycles/shopify-meta-capi]] · [[../integrations/meta-graph]] · [[../tables/event_sinks]] · [[storefront-pixel]] (the in-house storefront's equivalent)
