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
- `add_to_cart` — fired at the **same** pack-select moment (the real add-to-cart), BEFORE the `/api/cart` POST + navigation. Distinct event name so analytics + Meta CAPI (AddToCart) key off it directly. Independent of where pack-select navigates next, so the customize-bypass (Phase 3) does NOT drop it.

### Phase 2 on-site instrumentation (chapter / scroll / CTA)

`StorefrontChapterTracker` (`(storefront)/_components/`) mounts once per PDP next to `StorefrontPixelInit`. It **observes the existing `[data-section]` nodes** (every in-flow section already renders `<section data-section="…">`) — no `<Chapter>` wrapper or HOC, which is why it works with the `dynamic()`-imported sections (it scans the live DOM post-hydration + re-scans after 1.5s). `data-chapter-index` is stamped at runtime by DOM order.

- `chapter_view` — a section was ≥50% visible for ≥1s (filters fast scroll-pasts). Once per chapter per page. **Jump-aware:** when a scroll-to-price CTA is clicked, chapters flown past are suppressed; the `pricing` chapter's view carries `origin_chapter` + `arrived_via_jump`.
- `chapter_dwell` — accumulated active-time per chapter (`dwell_ms`), flushed on pagehide/visibility-hidden.
- `scroll_depth` — `max_depth_pct` + `reversals` (yo-yo / comparison signal), flushed on exit.
- `cta_click` — any `[data-cta]` click, tagged `cta_kind` + origin `chapter`. **`ShopCTA` is the single chokepoint** — it auto-stamps `data-cta`/`data-cta-kind` from its href (`#pricing` → `scroll_to_price`, `#buy-…` → `pack_select`).

Rollup: `/api/workspaces/[id]/storefront-funnel` returns `chapterPerformance` (reach, reach %, avg dwell, →pricing sessions, **view→pricing %** = the effectiveness metric) rendered on the funnel dashboard.

### PDP composition (sections)

`render-page.tsx` renders the hero, then a shared `StandardChapters` body: How It Works → Ingredients → **Recommended by Nutritionists** → Upsell → PriceTable → BundlePriceTable → UGC → Comparison → What-to-Expect → Reviews → FAQ → Final CTA → Brand Trust. The **advertorial + before/after variant landers reuse the SAME `StandardChapters`** after their unique intro chapters — variants must never carry fewer chapters than the main PDP (only the first 1–3 differ).

Trust / conversion elements:
- **Guarantee bar** (`CompleteOrderBanner`) — sticky top bar; with an open cart it shows "Complete your order", otherwise the resting "Love It in 30 Days or Your Money Back" which opens a trust modal with a `GuaranteeSeal` SVG badge.
- **"As Seen On" press row** (`PressLogos`) — labeled, brand-tinted, high under the hero headline; reads `press_1..5` [[../tables/product_media]] slots.
- **Benefit-bar lead-in** — problem/solution headline + transition above the benefit cards, from [[../tables/product_page_content]].`benefit_bar_intro`/`benefit_bar_transition` (renders only when set).
- **Per-cup price banners** on price/bundle cards (vs $3–6 coffee / $5–8 latte). **Mount-gated** (`useEffect` flag) because they reflect the live coupon-aware price — gating avoids a structural hydration mismatch.
- **Trust chips** (`TrustChipRow`) — allergen-free claims use green checks (a red circle-slash read as a negation, e.g. "not sugar free").
- **Hamburger menu** deep-links to `[data-section]` chapters (Testimonials/Ingredients/How It Works/What Nutritionists Say/FAQs/Shop Now).

### Survey chapter (recommender)

The `SurveyChapter` (after the hero) is a **personalized recommender**, not just a lead-gate: one question per screen (cups/day → health goal → coffee style) with per-question imagery (Nano Banana Pro, `survey_q1..q3` media slots), then a **recommendation** rendered as a real inline `PriceCard` (1 cup→1-pack, 2→2-pack, 3-4→3-pack) or `BundleCard` (chose "with creamer" → Coffee+Creamer bundle), with checkout available at any time. An optional email→phone step applies the **same** popup discount on-page via `useSetAutoCoupon` (`AutoCouponProvider`) and reprices live — never stacked (one offer). `survey_step` fires per step (anon included) for funnel visibility. Reuses `/api/lead` + `/api/popup/claim` (source `survey_chapter`). Superseded the older gate-the-code design (spec verified + archived 2026-06-18 — see [[../archive]]).

**Coupon-SMS delivery + status sync.** `/api/popup/claim` validates the phone (Twilio Lookup, SMS-capable mobile only), then texts the already-minted code and records `sms_message_sid` + `sms_status='queued'` on the [[../tables/storefront_leads]] row. The send passes an explicit per-message `StatusCallback` → `POST /api/webhooks/twilio/marketing-status`, whose no-recipient branch matches the lead by `sms_message_sid` and advances `sms_status` (`queued → sent → delivered` / `undelivered` / `failed`). This callback is **required** because the popup SMS goes direct from the short code (no Messaging Service), so absent it `sms_status` would freeze at `queued` even after delivery (ticket 8e9e325e). It also fires `popup/sms-coupon-sent` to arm the 10-min email fallback ([[../inngest/popup-sms-delivery-fallback]]) — which now keys off the truthful `sms_status`, so a delivered text no longer triggers a false fallback email. Legacy rows stuck at `queued` are reconciled by `scripts/backfill-popup-sms-status.ts` (polls the Twilio Messages API).

## Phase 2 — cart create

Customer clicks "Add to cart" / "Subscribe" → browser POSTs to `/api/cart` with `{line_items, mode, frequency_days, ...}`.

`src/app/api/cart/route.ts`:

1. **Validate + price every line item** against [[../tables/pricing_rules]] and [[../tables/product_variants]].`price_cents` — client price is advisory only. Unit price = `msrp × (1 − quantity_break%) × (1 − subscribe%)`. The **quantity break is CROSS-PRODUCT**: the route sums ALL line quantities (a coffee + a creamer = 2 units → the qty-2 break), then applies each line's own rule break at that cart-wide total — mirroring how the price-table columns + bundle cards quote it (`buildTiersFromRule` / `computeBundleCard`). ⚠️ Pre-2026-06-16 the cart applied ONLY the subscribe discount and silently dropped the quantity break (a stale "breaks are pre-grouped on the storefront" comment) — so bundles AND single-product multi-packs were over-charged vs the displayed price. Fixed in `cart/route.ts` (two-pass: total qty → apply break).
2. **Record `price_cents_at_add`** on each line so we can detect drift between add + checkout.
3. **Persist cart_drafts row** with workspace_id, line_items (JSONB), totals, expires_at.
4. **Set `cart` cookie** (token-bound, 30d).
5. Return the full draft.

Same endpoint handles `PUT` updates (qty change, line add/remove). Server re-validates every time.

## Phase 3 — customize page (opt-in since 2026-06-16)

`/customize?token=...` reads the draft. Customer adds upsells, removes items, changes frequency. Each mutation re-hits `/api/cart` for server-validated pricing.

**Customize-bypass funnel.** When `workspaces.storefront_skip_customize` is true (on for Superfoods, A/B-toggleable without a deploy), **pack-select navigates straight to `/checkout`** and customize becomes an opt-in escape hatch — not a default funnel step. The worksheet is non-load-bearing: every choice (variant by position, `subscribe` mode, default frequency from `pricing_rules.available_frequencies[].default`) already has a sensible default baked in by `/api/cart` at cart-create, so most buyers don't need it.

- **Nav gate:** `StorefrontPixelInit.tsx` picks `dest = skipCustomize ? "/checkout" : "/customize"` on cart-create success (`render-page.tsx` → `_lib/page-data.ts` surface the flag to the PDP; `checkout/page.tsx` passes `skip_customize` to `CheckoutClient`).
- **Opt-in editor:** with the bypass on, `CheckoutClient` renders an obvious **"Customize your order"** button under the cart-items summary (→ `/customize?token=…`); off, it's the subtle "Make changes" link. The customize page already loads standalone by token and its "Continue" returns to `/checkout?token=…`, so the round-trip works unchanged.
- **`customize_view` becomes a rare event** on the default path (fires only for opt-in users) — acceptable; the [[../dashboard/storefront__funnel]] treats chapters/steps as optional.

Events fired:

- `customize_view` on mount.
- `upsell_added` / `upsell_skipped` per offer.

## Phase 4 — checkout page

`/checkout?token=...` loads the draft and renders. `checkout_view` (→ Meta `InitiateCheckout`) fires on mount, **guarded once per cart token** via `sessionStorage` (`cx_checkout_view_{token}`): with the customize-bypass on, checkout is both the first page AND the return target from the opt-in customize round-trip, so the guard stops a round-trip from double-counting `InitiateCheckout`.

- Email / phone (if not already attached).
- Shipping address.
- Billing address (or "same as shipping").
- [[../integrations/braintree]] Hosted Fields (or Drop-in) for card capture — plus PayPal via the Braintree Drop-in / PayPal Vault flow. Vaulted rows land in [[../tables/customer_payment_methods]] with `payment_type` = `credit_card` OR `paypal_account` (the latter carries `paypal_email` instead of `last4` / `card_brand`; see [[../libraries/braintree-customer]] `paypalEmail`). **Founder directive (2026-07-10):** the storefront is NOT card-only — a checkout-stuck customer can pay via PayPal too. When the failing rail is Shopify's Shop Pay OTP, we default to concierging the sale via [[../recipes/checkout-stuck-concierge-flow]] instead of dead-ending them with "try another card / PayPal / Shop Pay".

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
3. If gated: creates an [[../tables/auth_otp_sessions]] row with `cart_token` + `customer_id`, calls [[../integrations/twilio]] Verify via `src/lib/twilio-verify.ts` → `startVerificationWithFallback({ phoneE164, email, requested })`. SMS is primary; if the SMS send fails (carrier reject / unreachable) and an email is on file, it **transparently retries over email** and returns `channel` = what actually sent + `fell_back: true`. The client uses that to show the truthful "we texted your phone •••12" vs "we emailed •••@x.com" copy (and a "couldn't reach your phone, emailed instead" note on fallback) rather than promising a text that never arrived. Twilio sends the code; we don't store it.
4. Phone-spoofing defense: the OTP is sent to the customer's `phone` on file from `customers`, NOT a phone entered at checkout. A fraudster who knows the email can't redirect the code to their own phone.
5. Client renders an OTP modal. Customer enters the code → `/api/checkout/otp/verify` calls `checkVerification(code)` against Twilio, then on success backfills `cart_drafts.customer_id` + `email` + `phone` so the rest of the checkout flow has the linked identity.

Resend support: `/api/checkout/otp/resend` re-fires through the same `startVerificationWithFallback` (rate-limited 60s/session), so an explicit "Text me a code instead" that fails also falls back to email. Customers who can't get a code can **dismiss the modal and check out as a guest** (`dismissOtpAsGuest` — stays unauthenticated, won't re-prompt). The portal login reuses the same backend but has **no guest escape** (auth is required there) — see [[customer-portal]].

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
   - Create [[../tables/orders]] row with `braintree_transaction_id`, `braintree_payment_method_token`, `braintree_customer_id`, `cart_token`, addresses. **Attribution** (`attributed_utm_*`/`landing_site`/`referring_site`) is backfilled **first-touch** right after the identity stitch — copied from the visitor's earliest [[../tables/storefront_sessions]] row carrying a `utm_source` (so a Meta-sourced sale shows `attributed_utm_source='meta'` on the order itself).
   - Create [[../tables/transactions]] row with `type='initial_checkout'`, `status='settled'`, `attempted_at`, `settled_at`.
   - If subscription mode → create [[../tables/subscriptions]] with `is_internal=true`, `payment_method_token`, `next_billing_date = now() + frequency_days`. This is the new internal-sub path; Appstle is bypassed.
   - Commit the Avalara transaction (type=SalesInvoice, commit:true). Stores `avalara_transaction_code` + `avalara_committed_at` on the order.
   - Mark [[../tables/cart_drafts]].`status='converted'`, `converted_order_id`.
   - **Create the canonical `order_placed` storefront event server-side**, keyed to the converting session (falls back to the customer's most-recent session when the cart had no `anonymous_id`, e.g. recovery/coupon links). This guarantees the event exists — and thus the CAPI Purchase fires (Phase 7) — even when the browser pixel is blocked/missed. The server mints `order_placed_event_id` and returns it; the browser reuses it so its `fbq` Purchase + the pixel enqueue dedupe against this one (no double Purchase). → CAPI fan-out (Phase 7).
   - Clear the `cart` cookie.
   - Return `{order_id, order_number, order_placed_event_id, ...}` (client redirects to `/thank-you?order=...`).
8. **On failure** (declined, 3DS challenge, gateway error):
   - Return `{error: ...}` with user-friendly text from [[../tables/dunning_error_codes]].
   - Cart stays in `pending` — customer can retry.

## Phase 6 — thank-you

`/thank-you?order={id}` reads the order from [[../tables/orders]] and renders the confirmation. It does **NOT** fire `order_placed` — that's fired once from the checkout page right after the confirmed charge (most reliable capture point) using the server's `order_placed_event_id`, and the server also created the canonical row in Phase 5. The thank-you page only fires Meta `PageView`.

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
| `src/app/(storefront)/_components/StorefrontPixelInit.tsx` | Pack-select cart-create + nav (`/checkout` vs `/customize` gated on `skipCustomize`) |
| `src/app/(storefront)/_lib/render-page.tsx` | PDP composition (passes `skipCustomize`) |
| `src/app/(storefront)/_lib/page-data.ts` | PDP data fetch (surfaces `storefront_skip_customize`) |
| `src/app/(storefront)/customize/page.tsx` | Customization page (opt-in editor) |
| `src/app/(storefront)/checkout/page.tsx` | Checkout page (passes `skip_customize` to client) |
| `src/app/(storefront)/checkout/_components/CheckoutClient.tsx` | "Customize your order" button + `checkout_view` once-per-token guard |
| `src/app/(storefront)/thank-you/page.tsx` | Confirmation + rich order_placed |
| `src/lib/inngest/storefront-events-fanout.ts` | CAPI fan-out router |
| `src/lib/inngest/sinks/meta-capi.ts` | Meta CAPI sink |
| `src/lib/inngest/sinks/tiktok-events.ts` | TikTok sink |
| `src/lib/inngest/sinks/google-enhanced.ts` | Google sink |
| `src/lib/inngest/sinks/klaviyo.ts` | Klaviyo sink |
| `src/lib/inngest/abandoned-cart.ts` | Sweeps stale cart_drafts |

## Status / open work

**Shipped:** All seven phases — PDP pixel, cart create + server validation, customize, checkout (Braintree Hosted Fields + Avalara tax quote), **OTP gate (Phase 4.5)**, **subscription choice card (Phase 4.6)**, submit (vault + charge + order + commit tax), thank-you, CAPI fan-out. OTP gate is wired at `/api/checkout/otp/{start,verify,resend}` and triggered for matched customers with order history or active subs. Subscription choice card at `/api/checkout/existing-subs` shows three options when authenticated + subscribe items + active internal sub. **Customize-bypass** (`workspaces.storefront_skip_customize`, on for Superfoods): pack-select goes straight to `/checkout`, customize is an opt-in "Customize your order" button on checkout, `add_to_cart`/CAPI unchanged (fires at pack-select), `checkout_view`/`InitiateCheckout` guarded once-per-token. A/B-toggleable without a deploy — verified in production 2026-06-18. **PPR metadata boundary fix** (root cause + real fix — supersedes the earlier `htmlLimitedBots: /(?!)/` band-aid, which did NOT work): the "Expected the resume to render <div> in this slot but instead it rendered <__next_metadata_boundary__>" CSR bail (digest 34312922, recurring across /store, /widget, /portal, /help) is caused by Next 16's app-page handler short-circuit `serveStreamingMetadata = botType && isRoutePPREnabled ? false : …`, which forces the BLOCKING metadata shell for every HTML-limited bot (Bingbot, facebookexternalhit, Slackbot, Applebot, Twitterbot, LinkedInBot, …) on a PPR route — IGNORING `htmlLimitedBots` — while the build-time shell is the streaming `<div hidden>` shape; a bot-triggered ISR revalidate poisons the cached shell and the next resume mismatches. `htmlLimitedBots` only governs non-bot UAs and can't reach that branch, and `dynamic`/`experimental_ppr` route opt-outs are rejected under cacheComponents. **Fixed in `src/proxy.ts`**: HTML-limited bot UAs are neutralized at the edge (real UA forwarded in `x-original-user-agent`) so `getBotType()` returns undefined and bots take the same streaming branch as the prerendered shell — shapes match, full SSR HTML preserved for SEO. Threaded through `updateSession(request, overrideHeaders)` so the custom-domain/subdomain rewrites forward it too. Validated in an isolated Next 16.2.9 repro: pre-fix Slackbot got a bare-boundary shell, post-fix all six bot UAs are byte-identical to Chrome. See [[../recipes/next16-metadata-boundary-csr-bail]]. **PDP caching via Next.js 16 cacheComponents**: PDP pages (`[slug]`, `blog`, `blog/[handle]`, `links`) + `storefront-img` route use `'use cache'; cacheLife({…})` for edge-cached rendering. Removed incompatible `revalidate`, `runtime = "edge"`, and explicit `dynamicParams = true` exports per [[operational-rules]] § Next.js layout patterns; cacheLife handles the cache-revalidation boundary. Verified in production 2026-06-25. **Blueprint lander visibility gate — `forbidden()` 403 returns**: blueprint PDP landers (draft, rolled-back, owner-preview-only) have an owner-vs-public visibility gate at `src/app/(storefront)/store/[workspace]/[slug]/page.tsx:308/317/324` that calls Next 16's `forbidden()` interrupt, which requires `experimental.authInterrupts: true` in `next.config.ts`; without the flag, non-owner requests 500 with "forbidden() is not enabled" instead of receiving a clean 403. Added the flag and `scripts/_check-authinterrupts-when-forbidden-imported.ts` predeploy guard that exits non-zero if any src file imports `forbidden` but the flag is missing. See [[../recipes/next16-authinterrupts-forbidden-flag]]. **Empty-params preview-build guard:** under cacheComponents an empty `generateStaticParams` is a hard build error, so the three storefront SSG helpers (`listPublishedProducts`, `listBlogWorkspaceParams`, `listBlogPostParams`) fall back to one `__placeholder__` sentinel param (→ build-time `notFound()`, real paths via ISR) when the build-time DB query returns zero rows — this is what was killing `claude/build-*` PREVIEW deploys while prod built clean (NOT an env-var gap; preview & prod share the same Supabase creds). See [[../recipes/next16-empty-generate-static-params-preview-build]].

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- `storefront-coupon-visibility-and-sms` (Issue 3) popup-coupon SMS now passes a `StatusCallback` → `storefront_leads.sms_status` syncs truthfully (was frozen at `queued`); reconciliation backfill `scripts/backfill-popup-sms-status.ts` for legacy rows (ticket 8e9e325e)
- `checkout-customize-bypass` Pack-select → `/checkout` bypass (customize opt-in), gated on `workspaces.storefront_skip_customize`; `checkout_view` once-per-token guard (verified 2026-06-18)
- `6b83532f` (PR #31) Storefront PDP enhancements: guarantee bar + trust modal, As-Seen-On press row, trust-chip fix, menu chapter nav, variant chapter parity, benefit-bar lead-in, **survey recommender rebuild**, per-cup banners, and the **cross-product quantity-break checkout fix** (card ↔ checkout now agree)
- `aeb8b074` Checkout: free-gift image fix, identity stitch, guarantee badge
- `6b85f4b5` Braintree direct refunds + quantity-reduction positive-close fix
- `f3d1f969` Customize page: heal stale carts on load

**Open questions:** None.

## Related

[[subscription-billing]] · [[customer-link-confirmation]] · [[../integrations/braintree]] · [[../integrations/avalara]] · [[../integrations/meta-marketing]] · [[../integrations/klaviyo]] · [[../integrations/twilio]] · [[../tables/storefront_events]] · [[../tables/storefront_sessions]] · [[../tables/storefront_leads]] · [[../tables/cart_drafts]] · [[../tables/orders]] · [[../tables/transactions]] · [[../tables/auth_otp_sessions]] · [[../tables/event_sinks]] · [[../tables/event_dispatches]] · [[../tables/pricing_rules]] · [[../libraries/twilio-verify]] · [[../libraries/client-error-reporter]] · [[../inngest/abandoned-cart]]

Client-side JS crashes across these surfaces (PDP / customize / checkout / thank-you) are captured by the `<ClientErrorReporter>` mounted in `(storefront)/layout.tsx` → `/api/client-errors` → `error_events` `source='client'`, surfaced in the Control Tower **Client errors** panel. See [[../libraries/client-error-reporter]].
