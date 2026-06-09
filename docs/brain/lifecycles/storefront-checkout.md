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
- `add_to_cart` — fired at the **same** pack-select → /customize moment (the real add-to-cart). Distinct event name so analytics + Meta CAPI (AddToCart) key off it directly.

### Phase 2 on-site instrumentation (chapter / scroll / CTA)

`StorefrontChapterTracker` (`(storefront)/_components/`) mounts once per PDP next to `StorefrontPixelInit`. It **observes the existing `[data-section]` nodes** (every in-flow section already renders `<section data-section="…">`) — no `<Chapter>` wrapper or HOC, which is why it works with the `dynamic()`-imported sections (it scans the live DOM post-hydration + re-scans after 1.5s). `data-chapter-index` is stamped at runtime by DOM order.

- `chapter_view` — a section was ≥50% visible for ≥1s (filters fast scroll-pasts). Once per chapter per page. **Jump-aware:** when a scroll-to-price CTA is clicked, chapters flown past are suppressed; the `pricing` chapter's view carries `origin_chapter` + `arrived_via_jump`.
- `chapter_dwell` — accumulated active-time per chapter (`dwell_ms`), flushed on pagehide/visibility-hidden.
- `scroll_depth` — `max_depth_pct` + `reversals` (yo-yo / comparison signal), flushed on exit.
- `cta_click` — any `[data-cta]` click, tagged `cta_kind` + origin `chapter`. **`ShopCTA` is the single chokepoint** — it auto-stamps `data-cta`/`data-cta-kind` from its href (`#pricing` → `scroll_to_price`, `#buy-…` → `pack_select`).

Rollup: `/api/workspaces/[id]/storefront-funnel` returns `chapterPerformance` (reach, reach %, avg dwell, →pricing sessions, **view→pricing %** = the effectiveness metric) rendered on the funnel dashboard.

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

## Phase 4.5 — OTP gate on existing-customer match

When the email field loses focus (debounced), the client POSTs to `/api/checkout/otp/start` with `{cart_token, email, channel: "sms"|"email"}`. The server:

1. Looks up the email in [[../tables/customers]] (workspace-scoped).
2. **Skips OTP for bare leads** — only triggers when the matched customer has order history OR a subscription. Random email entries don't get challenged.
3. If gated: creates an [[../tables/auth_otp_sessions]] row with `cart_token` + `customer_id`, calls [[../integrations/twilio]] Verify via `src/lib/twilio-verify.ts` → `startVerification(channel)`. Twilio sends the code; we don't store it.
4. Phone-spoofing defense: the OTP is sent to the customer's `phone` on file from `customers`, NOT a phone entered at checkout. A fraudster who knows the email can't redirect the code to their own phone.
5. Client renders an OTP modal. Customer enters the code → `/api/checkout/otp/verify` calls `checkVerification(code)` against Twilio, then on success backfills `cart_drafts.customer_id` + `email` + `phone` so the rest of the checkout flow has the linked identity.

Resend support: `/api/checkout/otp/resend` re-fires `startVerification` (rate-limited by Twilio).

## Phase 4.6 — Subscription choice for verified existing customers

Once OTP succeeds AND the cart has subscribe-mode items AND the customer has at least one active `is_internal=true` subscription, the checkout renders a three-way choice card (`/api/checkout/existing-subs` returns the customer's active subs):

- **Add to existing sub — next renewal only** — line items appended to the existing sub's `items` JSONB; nothing bills today.
- **Order now + add to sub** *(default)* — one-time Braintree charge today using the vaulted payment method, AND the items get added to the existing sub for future renewals.
- **Create new subscription** — original behavior; spins up a fresh `subscriptions` row.

The choice rides on the submit payload as `subscription_action: "add_next_renewal" | "order_now_and_add" | "new"`. Checkout's `/api/checkout` route branches accordingly. Customers WITHOUT an existing active internal sub never see this card — they go straight to the standard subscribe flow.

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

## Phase 7 — CAPI fan-out ✅ (Meta shipped; cron-based, not per-event)

**Shipped design (storefront-mvp Phase 3):** a **cron sweep**, NOT a per-event `storefront/event.created` emit (the original plan). [[../inngest/meta-capi-dispatch]] runs every minute: for each active `meta_capi` [[../tables/event_sinks]] it seeds `pending` [[../tables/event_dispatches]] for recent mapped events, sends pending+failed via [[../libraries/meta-capi]] `sendCapiEvents`, and records `sent`/`failed`/`dlq`. The cron decouples delivery from the `/api/pixel` hot path; `event_dispatches` is the retry ledger. Browser pixel + server CAPI dedup on Meta's side via the shared `event_id` (= `storefront_events.id`) — the browser `fbq` is injected by [[../libraries/storefront-pixel]] `initMetaPixel`.

Event map (browser ⇄ server, same id): `pdp_view`→ViewContent, `add_to_cart`→AddToCart, `checkout_view`→InitiateCheckout, `order_placed`→Purchase, `lead_captured`→Lead.

The meta-capi sender:
1. Resolves the sink, decrypts the access token.
2. Maps our event → Meta standard event.
3. Hashes PII (SHA-256, lowercase + trim) — em/ph/fn/ln/ct/st/zp/country/external_id; passes `_fbp`/`_fbc` (cookie or derived from `fbclid`) + UA unhashed. Raw IP isn't stored, so `client_ip_address` is absent.
4. POSTs the batch with each `event_id` for dedup.
5. Updates the dispatch row with response code + body; after `MAX_ATTEMPTS` → `dlq`.

**Not yet built:** TikTok / Google / Klaviyo-Track / custom-webhook sink dispatchers (the `event_sinks` schema supports them; only `meta_capi` has a sender). Klaviyo leads currently go via [[../libraries/klaviyo-lead]] from `/api/lead`, not the sink path.

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

## Status / open work

**Shipped:** All seven phases — PDP pixel, cart create + server validation, customize, checkout (Braintree Hosted Fields + Avalara tax quote), **OTP gate (Phase 4.5)**, **subscription choice card (Phase 4.6)**, submit (vault + charge + order + commit tax), thank-you, CAPI fan-out. OTP gate is wired at `/api/checkout/otp/{start,verify,resend}` and triggered for matched customers with order history or active subs. Subscription choice card at `/api/checkout/existing-subs` shows three options when authenticated + subscribe items + active internal sub.

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- `aeb8b074` Checkout: free-gift image fix, identity stitch, guarantee badge
- `6b85f4b5` Braintree direct refunds + quantity-reduction positive-close fix
- `f3d1f969` Customize page: heal stale carts on load

**Open questions:** None.

## Related

[[subscription-billing]] · [[customer-link-confirmation]] · [[../integrations/braintree]] · [[../integrations/avalara]] · [[../integrations/meta-marketing]] · [[../integrations/klaviyo]] · [[../integrations/twilio]] · [[../tables/storefront_events]] · [[../tables/storefront_sessions]] · [[../tables/storefront_leads]] · [[../tables/cart_drafts]] · [[../tables/orders]] · [[../tables/transactions]] · [[../tables/auth_otp_sessions]] · [[../tables/event_sinks]] · [[../tables/event_dispatches]] · [[../tables/pricing_rules]] · [[../libraries/twilio-verify]] · [[../inngest/abandoned-cart]]
