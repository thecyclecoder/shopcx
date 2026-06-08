# Storefront MVP — Amazing Coffee subscription funnel ⏳

**Goal:** stand up a paid-traffic funnel for Amazing Coffee that we **own end-to-end** — PDP → customize → checkout → thank-you → portal sub-management — so we stop sending ad traffic to Shopify, own the subscription on our internal rails, and instrument the whole thing for Meta (CAPI) + on-site conversion intelligence.

**Why now:** the ad account needs to perform, and routing paid traffic to Shopify means we don't own the subscription or the data. The Amazing Coffee PDP is already strong; the gaps are (a) the customer can't *manage* an internal sub in the portal, (b) the site is "Meta-dark" (no pixel, no CAPI), and (c) there's no real lead-capture funnel.

Designed in a working session 2026-06-08. This spec bakes in those decisions. Audited file:lines below were captured from a read-only audit and may drift — re-verify before editing.

## Current state (from audit)

- ✅ **Checkout already creates INTERNAL subs** — `api/checkout/route.ts:566-603` inserts `subscriptions` with `is_internal:true`, Braintree vault+charge, Avalara tax (commit-before-charge, void-on-fail), order, fulfillment, confirmation email. Internal renewal scheduler (`internal-subscription-renewals.ts`) bills them. Sub-choice (new/add/one-time) + OTP wired. This is the hard part and it's done.
- ❌ **Portal can't manage internal subs** — most handlers call Appstle inline, bypassing the `is_internal` branch.
- ❌ **Meta-dark** — no `fbq` browser pixel, no CAPI. `event_sinks`/`event_dispatches` tables exist but no code reads them; the `meta-capi.ts` sender the brain describes does not exist.
- ⚠️ **Lead capture** exists but `/api/lead` insert is silently broken, and the only capture UI is deep in the funnel.
- ⚠️ Brain (`lifecycles/storefront-checkout.md`, `lifecycles/customer-portal.md`) is **drifted** — claims CAPI/portal features shipped that aren't. Reconcile as we go.

---

## Phase 1 — Internal subscription management 🚧

The checkout makes internal subs; the customer must be able to live with one. Most fixes are **wiring** (the internal branches already exist in the lib layer) — the only net-new is the coupon bridge and the Appstle→internal migration helper.

**Build status (2026-06-08):**
- ✅ **1a portal handlers** wired internal-aware: pause, resume, change-date, address (+ local persist), replace-variants (swap/qty/add), coupon (apply/remove), loyalty-apply. *Pending:* payment-method update (part of 1c).
- ✅ **1b coupon engine** shipped: `coupons` table + `src/lib/coupons.ts` (resolver internal→Shopify, apply/remove, mint, compute+consume) + internal renewal scheduler applies discounts. *Refinements:* tax-on-discounted-base, internal-path floor check.
- 🚧 **1c migration helper** `migrateCustomerAppstleSubsToInternal` (`src/lib/migrate-to-internal.ts`) built (atomic create→verify→cancel, rollback on cancel-fail). *NOT yet wired into live checkout / portal payment-update — needs a runtime test against real Appstle data first (it cancels real contracts).*

### 1a. Wire the broken portal handlers through the internal branches
Each handler below calls Appstle inline; route it through the existing internal-aware helper and **persist the change to the local `subscriptions` row** (the internal scheduler bills from `items`/`shipping_address`/`applied_discounts`).

- ⏳ **Swap / add / change-quantity** — `portal/handlers/replace-variants.ts:188` (Appstle-only; the portal's main item path). Route through `subSwapVariant` / `subAddItem` / `subChangeQuantity` (`subscription-items.ts`, already internal-aware). **Re-assert line price after any qty change** (replaceVariants resets to MSRP — see [[../lifecycles/subscription-billing]] § money-safety).
- ⏳ **Update shipping address** — `address.ts:97`. Route through an internal-aware path AND write the address to the local row (today it never persists locally → internal scheduler ships/taxes to the old address).
- ⏳ **Pause / Resume** — `pause.ts` / `resume.ts` (inline `appstlePut`) → `appstleSubscriptionAction("pause"|"resume")`.
- ⏳ **Change next order date** (also the de-facto skip) — `change-date.ts:60` → `appstleUpdateNextBillingDate` (internal branch exists). Use the `08:00Z` slot (see money-safety).
- ⏳ **Coupon apply/remove + loyalty-apply** — `coupon.ts`, `loyalty-apply-subscription.ts` → the coupon engine in 1b (so discounts land on the internal sub's `applied_discounts`).
- ⏳ **Payment method update** — not implemented in the in-house portal at all. Build add/update via Braintree Hosted Fields → vault token → `customer_payment_methods`, and trigger the migration in 1c.

### 1b. Coupon bridge + internal `coupons` table
Today `internalSubApplyDiscount` only stores `{title: code}` — no method/value, and the scheduler doesn't apply it. Build a real engine.

- ⏳ **New `coupons` table** (net-new; not `coupon_mappings`). Normalized model:
  ```
  code · type ("percentage" | "fixed_amount") · value · scope ("order", always)
  recurring_cycle_limit (int | null)   -- 1 = one charge · N · null = forever
  customer_id (uuid | null)            -- when set: only this customer, single-use
  single_use (bool) · used_at · stackable (true)
  ```
- ⏳ **`applied_discounts` entry** carries the resolved definition + `remaining_cycles` so the scheduler can compute the reduction without re-resolving.
- ⏳ **Resolver** (`resolveCoupon(code, customerId)`): internal table first (**internal wins**) → else **real-time Shopify Admin API lookup** of the code, reading its `recurringCycleLimit` (1 / N / always) and percentage/amount. **Ignore Shopify product scope — always treat as entire-order.** Shopify path is transitional (legacy codes) until the internal table is the only source.
- ⏳ **Scheduler applies + consumes** — `internal-subscription.ts` charge math reduces the order by the order-level discount, decrements `remaining_cycles` per renewal, and removes the entry from `applied_discounts` at 0. "1 charge" auto-expires after first application (initial order *or* next renewal, whichever it lands on).
- ⏳ **Floor guardrail** — a coupon can't push a line below its grandfathered floor (mirror the existing floor check).
- ⏳ **Customer-scoped one-time coupons** (used by the popup, Phase 4): minted per-lead, `customer_id`-scoped, `single_use`, stacks on subscribe + qty.

### 1c. `migrateToInternal()` — strangler migration off Appstle
**Principle: any time we capture a payment method, move the sub onto our internal rails.** Shared helper called from checkout add-to-sub AND portal payment-method update.

- ⏳ When the target sub is **Appstle**: read its live line items + **current per-line prices** (grandfathered — not MSRP), build ONE merged internal sub = existing items + new items, **inherit the Appstle cadence + `next_billing_date`**, bill future renewals on the freshly-vaulted **Braintree** token.
- ⏳ **Atomic + verified**: create + verify the internal sub FIRST, then cancel the Appstle contract. Never cancel before the internal sub is confirmed (customer must never be left sub-less). Idempotent (a checkout retry must not double-create / double-cancel).
- ⏳ Target already **internal** → plain `appendCartItemsToSub`, no migration.
- ⏳ **Migrate-on-any-checkout:** whenever a checkout captures a payment method, scan the customer for **any** active Appstle subscriptions and migrate **each** to internal on the freshly-vaulted Braintree token — even subs unrelated to the current cart. A plain new-sub checkout still sweeps their other Appstle subs onto our rails; add-to-sub is just the case where one of them also merges the cart items. **Cancelling the Appstle contract is part of every migration** (after the internal sub is created + verified).
- ⏳ Wire into the checkout `route.ts` (post-charge, payment-method in hand), `appendCartItemsToSub`, and the new portal payment-update path.

---

## Phase 2 — On-site instrumentation: chapter / CTA / scroll emitter ⏳

One foundation, three payoffs: the smart popup (Phase 4), chapter-performance analytics, and the Meta pixel stream (Phase 3). The ~16 PDP sections already exist as named components in `(storefront)/_sections/`.

- ⏳ **`<Chapter id index>` wrapper** around each section — stamps `data-chapter` + `data-chapter-index`. One component to maintain; gives free chapter attribution to anything inside it.
- ⏳ **One IntersectionObserver** → `chapter_view` (**= ≥1s of ≥50% visible**, filters fast scroll-pasts), tracks the **active chapter**, accumulates `chapter_dwell`. **Jump-aware:** suppress `chapter_view` for chapters flown past during a programmatic scroll-to-price (tag `passed_via_jump`); record the **origin chapter** on price arrival.
- ⏳ **`scroll_depth`** — max depth %, direction, reversals (the yo-yo / comparison signals).
- ⏳ **`cta_click`** — extend the existing delegated capture-phase click handler: tag CTAs `data-cta` (+ `data-cta-kind`). Almost all chapter CTAs are **scroll-to-price** (`kind:"scroll_to_price"`) → a click means "this chapter persuaded them to go to pricing." Handler reads `closest('[data-chapter]')` for the chapter. `pack_selected` stays the canonical cart-creating click; union for CTA analytics.
- ⏳ **AddToCart = pack-select → /customize** — the `pack_selected` → cart-draft transition IS the real add-to-cart moment. Emit `add_to_cart` there (don't invent a separate event).
- ⏳ **Fix `/api/pixel` allowlist** (`pixel/route.ts:37-48`) — add `chapter_view`/`chapter_dwell`/`scroll_depth`/`cta_click`/`add_to_cart`; fix the dropped `checkout_completed`; remove dead entries.
- ⏳ **Chapter-performance rollup** — per chapter: reach rate (scroll funnel), dwell, **viewed→scroll-to-price-CTA rate** (the key effectiveness metric), and convert-correlation → which chapters sell vs. create friction.

---

## Phase 3 — Meta pixel + CAPI ⏳

**Decision: run BOTH browser pixel and server CAPI, deduped** (CAPI-only = ~4/10 match quality because the browser pixel is what sets `_fbp`/`_fbc`). Meta's 2026 guidance for paid accounts. The whole CAPI layer is currently unbuilt.

- ⏳ **Browser `fbq` pixel** on the storefront layout — sets `_fbp`/`_fbc`, fires `ViewContent` (PDP), `AddToCart` (pack-select), `InitiateCheckout`, `Purchase`, `Lead`, each with a shared **`event_id`**.
- ⏳ **Server CAPI sender** — build the fan-out (emit `storefront/event.created` or cron over `storefront_events` → `event_dispatches` per active `event_sinks` → Meta sender). POST `graph.facebook.com/v.../{pixel_id}/events`: `event_name`, `event_time`, `action_source:"website"`, hashed `user_data` (SHA-256 lowercased/trimmed em/ph + `fbp`/`fbc` + ip/ua), `custom_data` (value/currency/contents), reused `event_id`, system-user `access_token`.
- ⏳ **Dedup** — same `event_id` browser + server (48h window). `storefront_events` PK already mints `event_id`.
- ⏳ **Event map:** `pdp_view`→ViewContent, `add_to_cart`→AddToCart, `checkout_view`→InitiateCheckout, `order_placed`→Purchase, lead→Lead.
- ⏳ Capture `fbclid`/`gclid`/`ttclid` → derive `fbc` server-side as a fallback for match quality.

---

## Phase 4 — Smart popup + quiz (lead capture) ⏳

The "smart form." A behaviorally-triggered popup that **stays silent for locked-in buyers** (protect margin) and intervenes only on hesitation/indecision, capturing the lead and offering a big stacked discount.

### 4a. Candidacy gate (cheap, no AI — protects spend)
Disqualify before any decision: dwell < ~20s · no real engagement · **bot signals** (`navigator.webdriver`, headless fp, no pointer movement, crawler UAs — reuse `fraud-detector.ts`) · already converting/selected · already shown this session · returning customer with active sub. One decision per session, cached.

### 4b. Decider — `decidePopup(sessionTimeline) → { show, variant, reason }`
- ⏳ **Rules first** (deterministic, instant, free):
  - *Price hesitation → discount variant:* price-cards reviewed (scrolled through, ≥15s, no `pack_selected`) · customize → back to PDP · clicked scroll-to-price CTA → at price → no select (highest-confidence) · price-section yo-yo · tab-away-and-return (the mobile exit-intent replacement).
  - *Indecision → quiz variant:* scroll-reversals between price cards · rage/confused taps in price area · long compare with no select.
- ⏳ **Haiku as the A/B challenger** behind the same signature — classify hesitation type from the messy timeline; A/B vs rules.
- ⏳ **Outcome logging** (shown? engaged? converted?) from day one — proves "smart" beats a dumb timer, tunes the prompt, seeds a future propensity model.
- ⏳ **Backstops:** one AI call per candidate session; **daily budget cap** → fall back to rules.
- **Mobile-first** (90% of traffic): no `mouseleave`; price table is vertical cards reviewed by downward scroll.

### 4c. Offer mechanics — full value stack (coupon + free shipping + free gift)
The advertised offer is the **whole stack**, not just the price discount:
- ⏳ **Price discount** = 3-pack quantity break (**12%**) + subscribe-and-save (**25%**) + **15%** signup coupon (Phase 1b, customer-scoped, single-use), applied **multiplicatively**: `1 − 0.88 × 0.75 × 0.85 ≈ **44% off MSRP**`. (Adding them = 52% overstates it.)
- ⏳ **Plus free shipping** (waive the live shipping rate) **and a free mixer** (free-gift line via `cart-gifts.ts`).
- ⏳ **Advertised value = the full stack:** `product-discount $ + free-shipping value + free-mixer MSRP`, surfaced as a **$ amount saved** and/or **effective % off the full retail bundle** (product MSRP + shipping + mixer MSRP). Freebies push the headline well past 44%.
- ⏳ **Computed LIVE** (pricing tiers + live shipping rate + gift MSRP) so it never goes stale; build prints the current number.
- ⏳ Coupon is **minted at capture but never shown on screen** — revealed only via SMS (4e) and auto-applied on a valid mobile.

### 4d. Gamified design (simple wins)
- ⏳ No required images (or pull from product images); **SVG + design elements** to gamify. Fun, lightweight.
- ⏳ **"You've been selected"** framing — as if their visit randomly triggered our biggest discount and they got it. One-time only. Urgency. **Countdown clock.**
- ⏳ Both the popup and the quiz are incentivized by the same big stacked savings.

### 4e. Multi-step form (the smart form) — survey → email → phone → confirmation
Multi-step, **saving at each step** (progressive capture — a partial lead is still a lead), with an escalating value exchange that pushes phone capture:

1. ⏳ **Survey** (quiz variant only; discount variant skips straight to email):
   - Q1: **"How many cups of coffee do you drink every day?"** → pack-size recommendation.
   - Q2: **"What's most important to your health?"** — options from `product_benefit_selections` (lose weight, fight aging, …).
   - **Log answers on the customer record** (cups/day + health goal) for segmentation / Klaviyo / personalization.
2. ⏳ **Email** — "Enter your email to unlock your code." On submit: identify/create customer + lead row, fire Klaviyo + CAPI **Lead**, **mint the customer-scoped coupon**. **Saved immediately** (bail here = email lead captured).
3. ⏳ **Phone** — "Get your coupon delivered right now." Validate with **Twilio Lookup (line-type intelligence)** — must be a real **SMS-capable mobile**, else **block advancing** (no fake numbers get the discount; keeps the SMS list clean). Capture SMS consent. **Saved immediately.**
4. ⏳ **Confirmation** — **never shows the code.** "Check your phone for your discount." Send the coupon via SMS from the **marketing shortcode** (same Twilio number as marketing), and **auto-apply** the customer-scoped coupon to the current cart/checkout session — *because* a valid mobile was submitted (it's on their order AND texted to them).

- ⏳ **Abandonment fallback (email-only leads):** if they finish the **email** step but **not** the **phone** step, wait **5 minutes** (Inngest delayed job) then **email** them the coupon code. **Do NOT auto-apply to the session** (no validated mobile / they've left). Recovers the lead's value without requiring phone.

### 4f. Lead-capture plumbing fixes
- ⏳ Fix `/api/lead` insert (`lead/route.ts:120-121`): map `email_consent`→`email_consent_at`, same SMS; switch `.insert()`→`.upsert(onConflict: workspace_id,email)`; stamp `session_id`. (Today no lead rows are written.)
- ⏳ On capture: fire **Lead** to Klaviyo (profile upsert/subscribe) + **Meta CAPI Lead** (hashed em/ph + fbp/fbc from session). Identity linkage (`stitchVisitor` + `sid` cookie) already matches lead→later purchase — no new work there.

---

## Phase 5 — Checkout hardening + smoke test ⏳

- ⏳ One real live end-to-end **subscribe purchase** through checkout (Braintree sale + Avalara commit + fulfillment + internal sub created).
- ⏳ Alert on `add_to_sub` failure *after* a successful charge (`route.ts:540`, currently log-only — customer charged, items don't join sub).
- ⏳ Alert on Avalara error → silent $0 tax (`route.ts:229-234`).
- ⏳ Discount-code at checkout (`cart/route.ts:201` stub) — now covered by the Phase 1b coupon engine.

---

## Cross-cutting

- ⏳ **Brain reconciliation** — fold reality into `lifecycles/storefront-checkout.md` (Hosted Fields not Drop-in; `sub_mode` = `new_sub`/`add_to_sub`/`renewal_only`; Amplifier handoff; fraud gate; internal renewals cron; CAPI is *new*, not shipped) and `lifecycles/customer-portal.md` (drop "no known gaps"; document internal-sub support). Every phase updates the relevant brain pages in its PR.
- New tables → brain pages: `coupons`. New events documented on `storefront_events` / a tracking page.

## Safety / invariants

- **Appstle→internal is atomic:** create + verify internal, THEN cancel Appstle. Idempotent.
- **Preserve grandfathered per-line prices** on any migration / qty change; re-assert price after `replaceVariants`; verify against **live Appstle**, not the lagging DB; billing dates at `08:00Z`. ([[../lifecycles/subscription-billing]] § money-safety.)
- **Coupons never breach the grandfathered floor.**
- **Popup protects margin** — never interrupt or discount a decisive buyer; one decision/session; bot + daily-budget caps on AI.
- **CAPI dedup** — every browser event has a server twin with the same `event_id`.

## Completion criteria

- ⏳ A customer with an internal sub can do every portal action (swap/add/qty/address/pause/resume/date/coupon/payment) and the internal scheduler bills correctly.
- ⏳ `coupons` table + resolver (internal + real-time Shopify) + scheduler application + cycle-limit consumption working; customer-scoped one-time coupon mints + stacks.
- ⏳ add-to-sub / payment-update migrate an Appstle sub to internal, atomically, prices preserved.
- ⏳ Chapter/CTA/scroll events flow to `storefront_events`; chapter-performance rollup renders.
- ⏳ Browser pixel + CAPI live for ViewContent/AddToCart/InitiateCheckout/Purchase/Lead, deduped; Events Manager shows good match quality.
- ⏳ Smart popup gates → decides (rules) → shows discount/quiz variant → mints coupon → captures lead → fires Klaviyo + CAPI Lead; quiz answers on the customer record; outcomes logged.
- ⏳ One live subscribe purchase completes end-to-end.

## Open questions

- `<Chapter>` wrapper vs. a HOC for the dynamically-imported sections (PriceTable/Bundle/Reviews/FAQ are `dynamic()`).
- Quiz recommendation logic — pure mapping (cups/day → pack) or scored against benefits?
- Where quiz answers live — columns on `customers` vs. a `quiz_responses` table (lean table for extensibility).
- CAPI fan-out trigger — Inngest event per pixel write vs. a batched cron over `storefront_events`.
- Twilio Lookup — block VoIP, or allow SMS-capable VoIP (mobile-only is stricter)? Lookup cost is per-check but only runs post-email, so volume is bounded.
- Coupon delivery dedup — the 5-min email fallback must only fire if the phone step never completed, so a lead never gets both the SMS *and* the fallback email.

## Related

[[../lifecycles/storefront-checkout]] · [[../lifecycles/customer-portal]] · [[../lifecycles/subscription-billing]] · [[../integrations/meta-marketing]] · [[../tables/product_pricing_tiers]] · [[../tables/storefront_events]] · [[../tables/storefront_leads]] · [[README]]
