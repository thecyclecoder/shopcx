# Storefront Platform

ShopCX.ai's post-Shopify storefront. Replaces Shopify (PDP + checkout + customer accounts), Appstle (subscriptions), and any third-party analytics/marketing-pixel layer with first-party infrastructure owned by us. This doc is the umbrella architecture spec for the storefront, tracking pixel, server-side cart, lead capture, Braintree checkout, and the in-house subscription platform.

## Why first-party

| Pain point with the rented stack | Why we own it instead |
|---|---|
| Shopify + Appstle take ~5% combined on every transaction | Braintree gateway only — saves 3%+ per order. |
| Third-party pixels (Meta, TikTok) lose 30-40% of events to ad-blockers | Server-side CAPI fan-out from our own events table. Browser pixel optional, deduped by `event_id`. |
| Funnel data lives in another vendor's silo | Events in our own Postgres, joinable to tickets, orders, journeys, AI orchestrator decisions. |
| Subscription edits require Appstle round-trips | We own the contract. No external API in the hot path. |
| Klaviyo lead capture is a separate funnel | Lead capture writes into the same `customers` table the AI agent and CX system already use. |

## System map

```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│   Storefront    │──▶│  /api/pixel     │──▶│ storefront_     │
│   PDP / Cust /  │   │  (single ingest)│   │ events          │
│   Checkout /    │   └─────────────────┘   │ (source of truth)│
│   Thank-You     │            │            └─────────────────┘
└────────┬────────┘            ▼                     │
         │            ┌─────────────────┐            ▼
         │            │ storefront_     │   ┌─────────────────┐
         │            │ sessions        │   │   Inngest       │
         │            │ (device + UTMs) │   │   fan-out       │
         │            └─────────────────┘   └────────┬────────┘
         │                                           │
         ▼                                           ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│   /api/cart     │   │ /api/lead       │   │ event_sinks     │
│                 │   │                 │   │ ├─ Meta CAPI    │
│ cart_drafts     │   │ storefront_     │   │ ├─ TikTok       │
│ (server-side)   │   │ leads → customer│   │ ├─ Google       │
└────────┬────────┘   └─────────────────┘   │ ├─ Klaviyo      │
         │                                  │ └─ custom       │
         ▼                                  └─────────────────┘
┌─────────────────┐
│  /api/checkout  │
│   Braintree     │
│   Vault + Pay   │
└────────┬────────┘
         ▼
┌─────────────────┐   ┌─────────────────┐
│    orders +     │──▶│ subscriptions   │
│  order events   │   │ (our own)       │
└─────────────────┘   └─────────────────┘
```

## Storefront PDP

Lives under the `(storefront)` route group. SSG with per-product ISR. See `src/app/(storefront)/_lib/render-page.tsx` for the section composition and `src/app/(storefront)/_lib/page-data.ts` for the full data fetch.

Sections (top to bottom): HeroSection, HowItWorks, UGC, Comparison, Ingredients, NutritionistEndorsement, WhatToExpectTimeline, UpsellChapter (when configured), PriceTableSection, BundlePriceTableSection (when upsell + complementarity copy set), Reviews, FAQ, FinalCTA.

Already shipped, no Shopify dependencies in this layer.

## Pixel + Events

### Tables
- **`storefront_sessions`** — one row per `anonymous_id`. Device fingerprint, UTM + click IDs (`fbclid`, `gclid`, `ttclid`), Meta cookies (`_fbp`, `_fbc`), IP-derived geo. Captured once on first PDP visit; `customer_id` backfills on identify.
- **`storefront_events`** — append-only event log. PK is a **client-generated UUID** so server-side CAPI dispatches and (optional) browser pixel events dedupe naturally on platforms like Meta/TikTok. Denormalized `anonymous_id` and `customer_id` for fast funnel queries with no joins.

### Endpoint
- **`POST /api/pixel`** — JSON body, accepts a batch of events. Server enriches with IP-derived geo, Vercel headers, user-agent parse, then upserts the session and inserts the events. Triggers `Inngest event storefront/event.created` for fan-out.
- **`GET /api/pixel?event_id=...&...`** — image-pixel fallback for ad-blocker / no-JS contexts. Returns a 1×1 transparent GIF. Same enrichment + persistence path.

### Client lib
- **`src/lib/storefront-pixel.ts`** — ~50-line module loaded on the PDP. Reads/sets the `sid` cookie (UUID v4, first-party, 365 days, SameSite=Lax), captures landing UTMs once into session storage, exposes `track(eventType, meta)`. Events are batched on a 500ms window or flushed via `navigator.sendBeacon` on unload.

### Defined event types
| Step | event_type | When it fires | Meta |
|---|---|---|---|
| 1 | `pdp_view` | PDP mount | `{ product_id, product_handle, variant_id }` |
| 2 | `pdp_engaged` | First of: CTA click, scroll past 50%, 30s+ on page | `{ trigger }` |
| 3 | `pack_selected` | Select clicked on tier or bundle | `{ variant_id, tier_qty, bundle, mode, frequency_days }` |
| - | `lead_captured` | Email/SMS form submit | `{ email, phone, source, consents }` |
| 4 | `customize_view` | Customization page mount | `{ cart_token }` |
| - | `upsell_added` / `upsell_skipped` | Per upsell offered | `{ product_id, variant_id, qty }` |
| 5 | `checkout_view` | Checkout page mount | `{ cart_token }` |
| - | `checkout_step_completed` | Address / shipping / payment step | `{ step }` |
| 6 | `order_placed` | Server-confirmed payment success | `{ order_id, total_cents, currency }` |

### Identity stitching
Three trigger points; all run the same SQL backfill:

```sql
UPDATE storefront_sessions SET customer_id = $1, updated_at = now()
  WHERE workspace_id = $2 AND anonymous_id = $3 AND customer_id IS NULL;

UPDATE storefront_events SET customer_id = $1
  WHERE workspace_id = $2 AND anonymous_id = $3 AND customer_id IS NULL;
```

Triggers:
1. **Lead capture** — `POST /api/lead` matches email/phone against `customers` or creates a new one (with `subscription_status='never'`), then backfills.
2. **Checkout** — Braintree returns a successful transaction, customer record is finalized, backfill runs.
3. **Logged-in account view** (future) — auth cookie identifies session immediately.

Per the design: **a lead IS a customer** with no orders. We don't keep a parallel lead concept — the Sonnet orchestrator, AI dashboard, segmentation, etc. all work for leads the moment they sign up.

### Retention
- Raw `storefront_events`: **90 days**, cleared by a daily Inngest cron.
- `storefront_sessions`: indefinite (small relative to event volume; enables cohort joins back to a customer's first touch even years later).
- `cart_drafts`: 30 days from last touch, then `status='abandoned'`. Abandoned rows retained for analytics, not deleted.

## Event clearinghouse (CAPI fan-out)

### Tables
- **`event_sinks`** — per-workspace downstream destinations. Sink types: `meta_capi`, `tiktok_events`, `google_enhanced`, `klaviyo`, `custom` (generic webhook). Holds AES-256-GCM encrypted credentials in `config` JSONB, plus a `event_types[]` filter (empty = forward all).
- **`event_dispatches`** — one row per `(event_id, sink_id)`. Tracks `pending` → `sent` / `failed` / `dlq` status, attempts, last response. Drives the Inngest retry loop with exponential backoff.

### Inngest flow
```
storefront/event.created  ▶  dispatch.fan_out  ▶  for each active sink:
                                                    └─ dispatch.meta_capi
                                                    └─ dispatch.tiktok
                                                    └─ dispatch.google
                                                    └─ dispatch.klaviyo
                                                    └─ dispatch.custom_webhook
```

Each sink-specific function:
1. Reads the matching `event_dispatches` row (status=pending).
2. Loads sink config, decrypts credentials.
3. Maps our event payload to the sink's schema (e.g. our `pack_selected` → Meta `AddToCart`).
4. POSTs with `event_id` for dedup, IP + UA from session, hashed PII (email/phone SHA-256 per Meta/TikTok spec).
5. Updates dispatch row with response code + body. On failure, schedules retry; after N attempts, sets `status='dlq'`.

### Dual-tracking pattern
For Meta and TikTok specifically, modern best practice is to fire from BOTH the browser pixel AND server CAPI. Both use the same `event_id` for dedup. Server-side covers ad-blocked users; browser-side gives the platforms a richer fingerprint for attribution. We support either or both per sink — the `event_sinks.config` flags which mode is active.

### Attribution capture
Every session row holds:
- UTMs: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`
- Click IDs: `fbclid` (Meta), `gclid` (Google), `ttclid` (TikTok)
- Cookies: `_fbp` (Meta browser cookie), `_fbc` (Meta click cookie derived from `fbclid`)

Every CAPI dispatch pulls these from the session row so events flow back to the right ad campaign.

## Server-side cart

`cart_drafts` is the canonical cart state. Client never trusts client-side prices.

### Endpoints
- **`POST /api/cart`** — create or mutate. Accepts `{ line_items, mode, frequency_days, discount_code, shipping_address?, ... }`. Server validates each line item against current `pricing_rules`, recomputes subtotals, persists, returns the full draft. Sets the `cart` cookie (token-bound).
- **`GET /api/cart`** — read current draft. Cookie-bound.
- **`DELETE /api/cart/items/[index]`** — remove a line.
- **`POST /api/cart/identify`** — attach `email` (and optionally phone). Triggers the same identity-stitch backfill.

### Lifecycle
1. PDP `pack_selected` → client posts to `/api/cart` → server creates draft, sets cookie.
2. Customization page reads draft via `GET /api/cart`, allows upsell adds, posts back.
3. Checkout page reads draft, collects address/payment, posts to `/api/checkout` (Braintree flow below).
4. On payment success: `cart_drafts.status='converted'`, `converted_order_id` links to the new order. Cookie cleared.
5. Drafts past `expires_at` with no conversion → cron flips `status='abandoned'`. Available for "abandoned cart" email/SMS automation.

### Price validation
Every mutation re-derives line totals from current `pricing_rules` and `product_variants.price_cents`. A `price_cents_at_add` field on each line item records the price the customer saw when they added the item — used to detect price changes between add and checkout (and decide whether to warn the customer or just honor the original).

## Lead capture

### Flow
1. Customer interacts with capture surface (PDP popup, exit-intent modal, footer form, etc.) and submits email and/or phone with explicit marketing consent.
2. `POST /api/lead` accepts `{ email, phone, email_consent, sms_consent, source, anonymous_id }`.
3. Server tries to match an existing `customers` row by email/phone. If matched: update marketing consent fields, attach `anonymous_id` to the customer's history. If not: create a new `customers` row with `subscription_status='never'`, `email_marketing_status='subscribed'` (or `sms_marketing_status='subscribed'`), and link it to the anonymous session.
4. Write a `storefront_leads` row with `customer_id` set.
5. Issue a coupon code if the capture surface is configured to (e.g. `SHOPCX` for the discount popup). Record on `storefront_leads.coupon_code_issued`.
6. Fire `lead_captured` event.
7. Identity-stitch backfill — all prior events and sessions tied to this anonymous_id now get `customer_id`.

### Sources
`source` is a free-form string but conventions are:
- `pdp_popup` — first-visit coupon popup on the PDP
- `exit_intent` — modal triggered by mouse-leave / tab-blur
- `footer` — static newsletter signup
- `chat_widget` — captured during a chat conversation
- `journey_signup` — discount signup journey completion

## Custom checkout (Braintree)

### Why Braintree
- ~2.59% + 0.49 per transaction vs Shopify Payments' ~2.9% + 0.30 + Shopify platform fee.
- Tokenized vaulted payments — card never touches our server.
- Native subscription billing primitive (`paymentMethodToken` we can charge anytime) — no third-party subscription tool needed.
- Excellent fraud signals (Kount integration, AVS, advanced fraud rules).

### Flow
1. Customer hits `/checkout?token={cart_token}` — page loads the draft, customer fills in:
   - Email / phone (if not already on the draft)
   - Shipping address
   - Billing address (or "same as shipping")
   - Payment — Braintree Drop-in or Hosted Fields collects card → tokenizes client-side
2. Browser receives a `payment_method_nonce` from Braintree (the card never touches us).
3. **`POST /api/checkout`** body: `{ cart_token, payment_method_nonce, device_data, addresses, email, phone }`.
4. Server:
   - Re-validates the draft's totals (catches price drift between cart and checkout).
   - Creates / matches the customer record.
   - Calls Braintree: `paymentMethod.create({ customerId, paymentMethodNonce, options: { verifyCard: true, makeDefault: true } })` to vault the card.
   - Calls Braintree: `transaction.sale({ paymentMethodToken, amount, customer, shipping, billing, options: { submitForSettlement: true, storeInVaultOnSuccess: true } })`.
   - On success: create the `orders` row, mark `cart_drafts.status='converted'`, fire `order_placed` event, fan out to CAPI sinks.
5. Server-side response redirects to `/thank-you?order={id}`. Thank-you page reads the order, fires a confirmation `order_placed` event with the order context (rich payload for Meta/TikTok Purchase events).

### Vaulted payment for subscriptions
On successful sale, Braintree returns a `paymentMethodToken`. Stored on the new `subscriptions` row. For every recurring billing cycle (handled by our subscription scheduler, not Braintree's own subscription module), we call:

```
transaction.sale({
  paymentMethodToken,   // the vaulted card
  customerId,
  amount: cycle.total_cents / 100,
  options: { submitForSettlement: true }
})
```

If the transaction is declined, the existing dunning system (`src/lib/dunning.ts`) kicks in — same payday-aware retry + customer communication flow we already run today, but against Braintree responses instead of Shopify's.

### 3DS / SCA
Braintree's hosted fields handle 3DS challenges automatically. For card vaulting at first checkout we use 3DS via Braintree's API; subsequent recurring sales use the vaulted token + `external_vault.previous_network_transaction_id` to satisfy SCA exemptions.

## In-house subscription platform

Replaces Appstle. Lives in the existing `subscriptions` table (already in place) but with the following changes:

### Source of truth
- `subscriptions.shopify_contract_id` → repurposed/deprecated. New `subscriptions.our_id` (UUID PK) becomes canonical.
- `payment_method_token` (Braintree vault token) added to `subscriptions`.
- `next_billing_date` driven by our scheduler, not Appstle.
- All mutations (pause, resume, skip, frequency change, cancel) become direct UPDATEs to our row — no external API call.

### Scheduler
An Inngest cron `subscription/billing-tick` runs every hour and:
1. Selects subs with `next_billing_date <= now() + 1h AND status = 'active'`.
2. For each: re-computes the cycle line items + total from current `pricing_rules` (or the sub's locked-in price for grandfathered subs).
3. Calls Braintree `transaction.sale({ paymentMethodToken })`.
4. On success: creates `orders` row, advances `next_billing_date` by `billing_interval`, fires `order_placed` event.
5. On decline: triggers the existing dunning flow.

### Customer self-serve actions
The existing portal (`/api/portal`) already handles pause/resume/cancel/skip/frequency change via Appstle. We swap the Appstle calls for direct DB updates + Braintree where relevant. The portal UI stays unchanged.

### Migration from Appstle
Out of scope for this doc — covered separately when we cut over.

## Build order

1. **Migration** — six tables in one migration. ✅
2. **`/api/pixel` + client lib + PDP wiring** — pdp_view, pdp_engaged, pack_selected.
3. **`/api/cart`** — create / read / mutate, price validation.
4. **Inngest fan-out skeleton + Meta CAPI sink** — proves the clearinghouse end-to-end with one real downstream.
5. **Customization page** — `/customize?token=...` reads cart_drafts, allows upsell adds, fires customize_view + upsell_added.
6. **`/dashboard/storefront/funnel`** — internal dashboard with funnel charts, drop-off rates, attribution breakdown.
7. **Custom checkout page** — `/checkout?token=...` with Braintree Hosted Fields → vault + sale.
8. **Subscription platform cutover** — flip `subscriptions` to our own scheduler, deprecate Appstle calls.
9. **Remaining CAPI sinks** — TikTok, Google Enhanced Conversions, Klaviyo.
10. **Lead capture surfaces** — PDP popup, exit-intent modal, footer form.

## Key files

| File | Purpose |
|---|---|
| `supabase/migrations/20260513160000_storefront_tracking.sql` | All six tables + indexes + RLS. |
| `src/app/api/pixel/route.ts` | Single ingest endpoint (POST batch + GET image pixel). |
| `src/lib/storefront-pixel.ts` | Browser client lib (track, identify, batching). |
| `src/app/api/cart/route.ts` | Server-side cart create/read/mutate. |
| `src/app/api/lead/route.ts` | Lead capture → customer create/match + backfill. |
| `src/app/api/checkout/route.ts` | Braintree vault + sale, order creation, CAPI fan-out. |
| `src/lib/inngest/storefront-events-fanout.ts` | Inngest fan-out router. |
| `src/lib/inngest/sinks/meta-capi.ts` | Meta CAPI sink. |
| `src/lib/inngest/sinks/tiktok-events.ts` | TikTok Events API sink. |
| `src/lib/inngest/sinks/google-enhanced.ts` | Google Enhanced Conversions sink. |
| `src/lib/inngest/sinks/klaviyo.ts` | Klaviyo Track API sink. |
| `src/lib/inngest/subscription-billing.ts` | Recurring billing scheduler (replaces Appstle). |
| `src/app/(storefront)/customize/page.tsx` | Customization page. |
| `src/app/(storefront)/checkout/page.tsx` | Custom checkout (Braintree Hosted Fields). |
| `src/app/(storefront)/thank-you/page.tsx` | Confirmation + order_placed firing. |
| `src/app/dashboard/storefront/funnel/page.tsx` | Internal funnel dashboard. |

## Conventions

- **Event IDs are client-generated UUIDs** and serve as the `storefront_events` primary key. Same UUID flows to all CAPI sinks for downstream dedup.
- **All cart pricing is server-validated** on every mutation — no exception. Client price displays are advisory only.
- **Sensitive creds (Braintree access tokens, CAPI access tokens) are AES-256-GCM encrypted** in the same pattern as Shopify/Klaviyo creds today.
- **Leads = customers**. A lead is a customer with no orders. Marketing consent flags + `subscription_status='never'` is the natural state. No parallel `leads` table for the customer concept; `storefront_leads` only logs the capture event.
- **One source of truth for events**: `storefront_events`. CAPI sinks are read-side fan-out, never authoritative.
- **PII hashing**: email/phone are SHA-256 hashed before being sent to Meta / TikTok / Google, per their CAPI specs.
- **Cookies are first-party**: `sid` (anonymous_id, 365d), `cart` (cart token, 30d), `consent` (cookie consent state). All `SameSite=Lax`, `Secure` in production.

## Privacy

- Raw IP is **not** stored. Only IP-derived country/region/city on `storefront_sessions`.
- Email / phone hashed before CAPI dispatch; raw values only stored when the customer explicitly identifies (lead capture, checkout, account login).
- 90-day rolling deletion on raw events; sessions retained indefinitely (no raw PII on sessions).
- Customer-facing consent flow (cookie banner + email/SMS consent on lead capture) sets `email_consent_at` / `sms_consent_at` timestamps. CAPI events for non-consented users are dropped at the fan-out stage.
