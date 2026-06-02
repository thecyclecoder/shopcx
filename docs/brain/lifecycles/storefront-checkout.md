# Storefront checkout

The custom storefront's PDP → cart → tax-quote → Braintree checkout → order create → CAPI fan-out flow. Replaces Shopify Checkout (saves ~3% per order via Braintree) + Appstle subscription draft (the new flow vaults a Braintree token directly). This is the post-Shopify path; until full cutover, both paths coexist.

See [[../lifecycles/storefront-checkout]] for the system map.

## Cast

- PDP: `(storefront)` route group, SSG + per-product ISR. See `src/app/(storefront)/_lib/render-page.tsx`.
- Pixel: `src/lib/storefront-pixel.ts` + `/api/pixel` endpoint.
- Cart: `/api/cart` + [[../tables/cart_drafts]].
- Tax: [[../integrations/avalara]].
- Payment: [[../integrations/braintree]] (vault + sale).
- Order create: writes [[../tables/orders]] + [[../tables/transactions]].
- CAPI fan-out: [[../tables/event_dispatches]] → [[../integrations/meta-marketing]] CAPI + [[../integrations/klaviyo]] + TikTok + Google.
- Session: [[../tables/storefront_sessions]] (`sid` cookie, 365d).
- Events: [[../tables/storefront_events]] (90d retention).
- Identity: [[../tables/storefront_leads]] → [[../tables/customers]].

## Phase 1 — PDP view

Customer hits the product page (`/{product-slug}` on the storefront subdomain). The pixel module loads:

1. **Read or set `sid` cookie** — UUID v4, first-party, SameSite=Lax, 365d expiry.
2. **Capture landing UTMs** into session storage (one-time, on first PDP visit only).
3. **Capture click IDs** — `fbclid`, `gclid`, `ttclid` from the URL.
4. **Capture Meta cookies** — `_fbp` (browser cookie), `_fbc` (derived from `fbclid`).
5. **Fire `pdp_view`** event with `event_id` (client-generated UUID — same id flows to CAPI sinks for dedup).
6. **IP-derived geo enrichment** happens server-side at `/api/pixel`.

The event lands in [[../tables/storefront_events]] within 500ms (batched via the pixel client). Session row in [[../tables/storefront_sessions]] is upserted with UTMs + click IDs + cookies.

Subsequent events on the same page:

- `pdp_engaged` — first of: CTA click, scroll past 50%, 30s+ on page.
- `pack_selected` — customer chose a tier or bundle (variant + qty + mode + frequency).

## Phase 2 — cart create

Customer clicks "Add to cart" / "Subscribe" → browser POSTs to `/api/cart` with `{line_items, mode, frequency_days, ...}`.

`src/app/api/cart/route.ts`:

1. **Validate every line item** against [[../tables/pricing_rules]] and [[../tables/product_variants]].`price_cents`. Server computes line totals — client price is advisory only.
2. **Record `price_cents_at_add`** on each line so we can detect drift between add + checkout.
3. **Persist cart_drafts row** with workspace_id, line_items (JSONB), totals, expires_at.
4. **Set `cart` cookie** (token-bound, 30d).
5. Return the full draft.

Same endpoint handles `PUT` updates (qty change, line add/remove). Server re-validates every time.

## Phase 3 — customize page

`/customize?token=...` reads the draft. Customer adds upsells, removes items, changes frequency. Each mutation re-hits `/api/cart` for server-validated pricing.

Events fired:

- `customize_view` on mount.
- `upsell_added` / `upsell_skipped` per offer.

## Phase 4 — checkout page

`/checkout?token=...` loads the draft and renders:

- Email / phone (if not already attached).
- Shipping address.
- Billing address (or "same as shipping").
- [[../integrations/braintree]] Hosted Fields (or Drop-in) for card capture.

`braintree-web` SDK runs in the browser, tokenizes the card, returns a `payment_method_nonce`. Card never touches our server.

Tax quote happens at this step:

1. Browser sends address → server.
2. Server calls [[../integrations/avalara]] `transactions/create` (type=SalesOrder, commit:false).
3. Tax line returns. Quote cached on [[../tables/cart_drafts]].`avalara_quote_*` columns.
4. Browser displays the tax line. Re-validation happens at submit.

## Phase 5 — submit

Browser POSTs to `/api/checkout`:

```json
{
  "cart_token": "...",
  "payment_method_nonce": "...",
  "device_data": "...",  // Braintree fraud signal
  "shipping_address": {...},
  "billing_address": {...},
  "email": "...",
  "phone": "..."
}
```

`src/app/api/checkout/route.ts`:

1. **Re-validate totals** from current pricing rules. Catches drift between cart and checkout.
2. **Re-quote tax** if cached quote is stale. Don't trust the cart's snapshot.
3. **Match / create customer**:
   - Look up by email in [[../tables/customers]] (workspace-scoped).
   - If matched + has linked accounts, the full link group is loaded.
   - If not matched, create with `subscription_status='never'` (a lead).
4. **Identity stitch** — write the customer_id back to recent [[../tables/storefront_events]] + [[../tables/storefront_sessions]] for the same `anonymous_id` (90d look-back).
5. **Vault the card** via [[../integrations/braintree]] `paymentMethod.create({customerId, paymentMethodNonce, options: {verifyCard: true, makeDefault: true}})`. Returns `paymentMethodToken`.
6. **Charge** via `transaction.sale({paymentMethodToken, amount, customer, shipping, billing, options: {submitForSettlement: true, storeInVaultOnSuccess: true}, externalVault: ..., deviceData})`.
7. **On success**:
   - Create [[../tables/orders]] row with `braintree_transaction_id`, `braintree_payment_method_token`, `braintree_customer_id`, `cart_token`, attribution UTMs, addresses.
   - Create [[../tables/transactions]] row with `type='initial_checkout'`, `status='settled'`, `attempted_at`, `settled_at`.
   - If subscription mode → create [[../tables/subscriptions]] with `is_internal=true`, `payment_method_token`, `next_billing_date = now() + frequency_days`. This is the new internal-sub path; Appstle is bypassed.
   - Commit the Avalara transaction (type=SalesInvoice, commit:true). Stores `avalara_transaction_code` + `avalara_committed_at` on the order.
   - Mark [[../tables/cart_drafts]].`status='converted'`, `converted_order_id`.
   - Fire `order_placed` storefront event → CAPI fan-out (see Phase 7).
   - Clear the `cart` cookie.
   - Return `{redirect: "/thank-you?order=..."}`.
8. **On failure** (declined, 3DS challenge, gateway error):
   - Return `{error: ...}` with user-friendly text from [[../tables/dunning_error_codes]].
   - Cart stays in `pending` — customer can retry.

## Phase 6 — thank-you

`/thank-you?order={id}` reads the order from [[../tables/orders]]. Fires a rich `order_placed` event with full order context (line items, total, currency, customer email, click IDs) for downstream attribution. This is the Meta/TikTok "Purchase" event.

## Phase 7 — CAPI fan-out

Every event ingested at `/api/pixel` triggers an Inngest fan-out via `storefront/event.created`. For each active [[../tables/event_sinks]] row matching the event_type filter, a [[../tables/event_dispatches]] row is inserted with `status='pending'`.

Sink dispatchers (one Inngest function per sink type):

- `dispatch.meta_capi` → [[../integrations/meta-marketing]] CAPI POST with the same `event_id` (browser pixel + server CAPI dedup on Meta's side).
- `dispatch.tiktok` → TikTok Events API.
- `dispatch.google` → Google Enhanced Conversions.
- `dispatch.klaviyo` → [[../integrations/klaviyo]] Track API.
- `dispatch.custom_webhook` → generic webhook.

Each:

1. Loads sink config, decrypts credentials.
2. Maps our event payload to the sink's schema.
3. Hashes PII (email/phone SHA-256, lowercase + trim first per Meta/TikTok spec).
4. POSTs with `event_id` for dedup + IP + UA + `_fbp` + `_fbc` from the session row.
5. Updates dispatch row with response code + body. Retry on transient failure; after N → `status='dlq'`.

## Identity bootstrap

The identity stitch mechanism — see [[customer-link-confirmation]] for the broader flow. Three mechanisms:

1. **Anonymous-id backfill** — when a lead form / checkout / portal login attaches `customer_id`, all sessions + events for that `anonymous_id` retroactively get the customer_id.
2. **Device-fingerprint backfill** — when a customer browses across devices, fingerprint hash (UA + screen + accept-lang + IP /24) recurs; a ground-truth event anchors a fingerprint → customer pairing and back-attributes 90d of prior events. See PERPETUAL-CAMPAIGNS-SPEC.md.
3. **Shortlink click** — `sx_customer` cookie set from `customers.short_code` in the URL. Cookie-confidence: medium. No retroactive backfill from shortlinks alone (privacy + accuracy).

## Privacy

- Raw IP **never stored** — only IP-derived country / region / city on [[../tables/storefront_sessions]].
- Email + phone hashed before CAPI dispatch; raw values only when the customer identified themselves.
- 90-day rolling deletion on raw events via daily cron ([[../inngest/abandoned-cart]] handles cart drafts; events cron is separate).
- Consent flow gates CAPI dispatch — non-consented users have events dropped at the fan-out stage.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/storefront-pixel.ts` | Browser client lib (track, identify, batching) |
| `src/app/api/pixel/route.ts` | Single ingest endpoint (POST batch + GET image pixel) |
| `src/app/api/cart/route.ts` | Cart create / read / mutate with server price validation |
| `src/app/api/lead/route.ts` | Lead capture → customer match/create + identity stitch |
| `src/app/api/checkout/route.ts` | Braintree vault + sale + order create |
| `src/lib/integrations/braintree.ts` | Gateway client + transaction.sale wrapper |
| `src/lib/integrations/braintree-customer.ts` | Customer create / find |
| `src/lib/avalara.ts` | Tax client |
| `src/lib/avalara-cart.ts` | Cart quote |
| `src/lib/avalara-subscription.ts` | Sub quote |
| `src/lib/identity-stitch.ts` | Anonymous-id backfill |
| `src/lib/cart-gifts.ts` | Free-gift logic |
| `src/lib/shortlink-slug.ts` | Customer short_code resolution |
| `src/app/(storefront)/_lib/render-page.tsx` | PDP composition |
| `src/app/(storefront)/_lib/page-data.ts` | PDP data fetch |
| `src/app/(storefront)/customize/page.tsx` | Customization page |
| `src/app/(storefront)/checkout/page.tsx` | Checkout page |
| `src/app/(storefront)/thank-you/page.tsx` | Confirmation + rich order_placed |
| `src/lib/inngest/storefront-events-fanout.ts` | CAPI fan-out router |
| `src/lib/inngest/sinks/meta-capi.ts` | Meta CAPI sink |
| `src/lib/inngest/sinks/tiktok-events.ts` | TikTok sink |
| `src/lib/inngest/sinks/google-enhanced.ts` | Google sink |
| `src/lib/inngest/sinks/klaviyo.ts` | Klaviyo sink |
| `src/lib/inngest/abandoned-cart.ts` | Sweeps stale cart_drafts |

## Related

[[subscription-billing]] · [[customer-link-confirmation]] · [[../integrations/braintree]] · [[../integrations/avalara]] · [[../integrations/meta-marketing]] · [[../integrations/klaviyo]] · [[../tables/storefront_events]] · [[../tables/storefront_sessions]] · [[../tables/storefront_leads]] · [[../tables/cart_drafts]] · [[../tables/orders]] · [[../tables/transactions]] · [[../tables/event_sinks]] · [[../tables/event_dispatches]] · [[../tables/pricing_rules]] · [[../inngest/abandoned-cart]]
