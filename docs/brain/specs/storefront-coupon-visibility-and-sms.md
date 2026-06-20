# Storefront coupon visibility + WELCOME SMS delivery 🚧

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate — landing-page / funnel conversion ([[../lifecycles/storefront-checkout]])

Three defects, all surfaced by one ticket (8e9e325e, Harvey Kletz, 2026-06-20), that combine into a bad customer + AI failure mode: **a customer receives his storefront discount, but neither he nor our AI can tell** — so he complains, and the AI (blind to the applied discount) agrees to refund discounts he already got or never qualified for.

## What happened (the triggering case)

Harvey ordered 1× Amazing Coffee (SHOPCX19) and emailed *"I never received the two discounts (10% + 15%) stated on your site."* Reality:
- **He DID get the 15%** — `WELCOME-P2RJD`, −$11.99 (15% of $79.95), auto-applied at checkout. It's in `orders.payment_details.discount_code`.
- **There is no 10%** on a 1-unit order — quantity breaks are 0% / 8% / 12% for 1 / 2 / 3 units ([[../tables/pricing_rules]]); subscribe-&-save is 25%. He bought 1 unit, one-time.
- The AI saw `orders.discount_codes = []` (empty), reported *"no discounts applied at checkout,"* **blindly agreed** with his 10%+15% claim, and promised a **25% / $21.59** refund — for discounts he'd already received or never qualified for.

Resolution for Harvey (done): showed him the breakdown proving the 15%, issued a goodwill 10% refund ($7.99, Braintree `er04x520`), closed.

## Issue 1 — the applied coupon is missing from `orders.discount_codes` (the AI needs it) 🚧 (code ✅, backfill pending approval)

`orders.discount_codes` is **empty on 100% of storefront orders** (7/7 sampled with a discount), while the real code lives in `orders.payment_details.discount_code` (+ `discount_cents`). Examples: SHOPCX20 `WELCOME-FJQHZ` (−$16.55), SHOPCX19 `WELCOME-P2RJD` (−$11.99), SHOPCX17 `WELCOME-99RA9` (−$23.75) — all with `discount_codes = []`.

**Why it matters:** the orchestrator's order context reads `discount_codes`, so it believes storefront orders have **no discount** — the direct cause of the "no discounts applied" misread and the agree-and-refund failure. The AI needs the coupon code + discount amount on the order it reads.

**Fix:**
- Storefront order creation (`src/app/api/storefront/cart/route.ts` / wherever the order row is written) must persist the applied code into `orders.discount_codes` (and keep `payment_details.discount_code`/`discount_cents` as today).
- Backfill existing storefront orders' `discount_codes` from `payment_details.discount_code`.
- Ensure the orchestrator's order payload surfaces the discount (code + amount) so the AI can answer "did I get my discount?" from data, not guesswork.

**Landed:**
- `src/app/api/checkout/route.ts` — the order insert now writes `discount_codes: discountCents > 0 && couponCode ? [couponCode] : []` (same string-array shape Shopify orders use), keeping `payment_details.discount_code`/`discount_cents` as before.
- `src/lib/sonnet-orchestrator-v2.ts` — the order context query now also selects `payment_details`; the per-order `coupons:` line prefers `discount_codes`, **falls back to `payment_details.discount_code`** (so un-backfilled legacy orders still show their code), and appends the dollar amount: `coupons: WELCOME-P2RJD (-$11.99)`.
- `scripts/backfill-storefront-order-discount-codes.ts` — dry-run-by-default, `--apply` to write; cursor-paginated + idempotent. Sets `discount_codes = [payment_details.discount_code]` for `source_name='storefront'` orders whose `discount_codes` is empty. **Pending owner approval to run against prod.**

## Issue 2 — AI must verify discount claims against order data before agreeing/refunding ✅

Even with the data present, the orchestrator agreed to a customer's unverified "10% + 15%" claim and computed a refund off it. A discount complaint must be **checked against the order's actual applied discount + the real `pricing_rules`** before any adjustment: confirm what was applied, confirm what the customer was actually eligible for (quantity break depends on cart quantity; subscribe % only on subscriptions; the WELCOME code is the signup offer), and only then decide. Never refund a discount the order already shows, and never invent one that doesn't exist for the cart. (Sibling to the orchestrator-discipline rules in [[../operational-rules]].)

**Landed:**
- `src/lib/sonnet-orchestrator-v2.ts` — a static **DISCOUNT-CLAIM VERIFICATION** block in the orchestrator system prompt: never agree-and-refund; check the order's applied `coupons` field first, then real eligibility (quantity break depends on cart unit count — a 1-unit order earns no multi-unit break; subscribe-% only on subscriptions; WELCOME is the one-time signup offer, not stackable); escalate if the math is ambiguous.
- `docs/brain/operational-rules.md` § Orchestrator discipline — the durable sibling rule, with the ticket-`8e9e325e` worked example.

## Issue 3 — WELCOME discount SMS stuck at `queued` 🚧 (email fallback ✅, Twilio root-cause = owner op task)

Harvey signed up for **both** email (03:23:22) and SMS (03:23:45) via the popup (`storefront_leads`, source `popup_discount`). The code `WELCOME-P2RJD` was issued and sent **by SMS** (`sms_message_sid` present, **`sms_status: "queued"`**) — and it **never advanced past `queued`**, with `fallback_emailed_at: null` (never emailed as backup). So the code was delivered to a customer who **never received the text** — he only got the discount because the storefront also auto-applies it on-page. Customers in this state assume the discount failed.

**Fix:**
- Diagnose why WELCOME SMS sits at `queued` in Twilio (number/messaging-service config, A2P registration, carrier filtering) and confirm actual delivery.
- Wire the **email fallback** (`fallback_emailed_at` exists but is unused here) so a customer who consented to email always gets the code if SMS doesn't deliver.
- Consider surfacing the applied/issued code in the order-confirmation regardless of channel.

**Landed (email fallback — the durable code fix):**
- `src/lib/popup/coupon-email.ts` (new) — `sendPopupCouponEmail(...)`, extracted from the abandonment-fallback's inline body so both fallbacks send the byte-identical email. Owns the `fallback_emailed_at` dedup (conditional claim + release-on-failure).
- `src/lib/inngest/popup-sms-delivery-fallback.ts` (new) — Inngest fn on event `popup/sms-coupon-sent`; sleeps 10 min, then if `sms_status != 'delivered'` + `email_consent_at` set + not already emailed, emails the code. The timer (not the webhook) is the trigger **because a stuck-`queued` message produces no terminal Twilio callback** — exactly Harvey's case. Registered in `src/app/api/inngest/route.ts`.
- `src/app/api/popup/claim/route.ts` — fires `popup/sms-coupon-sent` after a successful coupon SMS send.
- `src/lib/inngest/popup-coupon-fallback.ts` — refactored onto the shared helper; the two fallbacks now share `fallback_emailed_at` so a lead gets at most one fallback email total.

**Still open (NOT code — owner operational task):**
- **Twilio root-cause diagnosis** of *why* WELCOME SMS sits at `queued` (Messaging Service config, A2P 10DLC registration status, carrier filtering) requires Twilio console access and cannot be done from the build box. The email fallback above makes the customer impact non-blocking regardless, but the underlying SMS deliverability should be diagnosed by the owner.
- **Order-confirmation code surfacing** ("Consider…") deferred — the discount already appears in the order totals (`payment_details.discount_cents`), and the applied code now lives in `orders.discount_codes`; rendering the literal code on the thank-you page is a separate UI change, not required for the AI-visibility or delivery fixes.

## Evidence / pointers

- Order: `orders` SHOPCX19 — `payment_details.discount_code = WELCOME-P2RJD`, `discount_cents = 1199`; `discount_codes = []`.
- Lead: `storefront_leads` (email `hkletz@aol.com`) — `email_consent_at`, `sms_consent_at`, `coupon_code_issued`, `sms_message_sid`, `sms_status`.
- Discounts of record: [[../tables/pricing_rules]] (`quantity_breaks` 0/8/12; `subscribe_discount_pct` 25); WELCOME via `src/app/api/lead/route.ts` + `src/app/api/popup/claim/route.ts`.
- Flow: [[../lifecycles/storefront-checkout]].

## Verification

- **Issue 1 (checkout writes the code):** place a storefront order with a coupon applied (e.g. via the popup auto-apply) → in `orders` the new row has `discount_codes = ["WELCOME-XXXXX"]` AND `payment_details.discount_code` set to the same code. Expect both populated, not `[]`.
- **Issue 1 (orchestrator sees it):** open a ticket from a customer with a discounted storefront order and ask the AI a discount question → the order context line reads `… | coupons: WELCOME-XXXXX (-$11.99) | …` (code + dollar amount), not `coupons: none`.
- **Issue 1 (backfill):** run `npx tsx scripts/backfill-storefront-order-discount-codes.ts` (dry-run) → prints the count of storefront orders missing `discount_codes` + sample order numbers. Then `--apply` → those orders' `discount_codes` populated from `payment_details.discount_code`; re-running the dry-run reports `0 need backfill` (idempotent).
- **Issue 2 (no agree-and-refund):** simulate Harvey's message ("I never received the two discounts (10% + 15%)") on a 1-unit one-time order that already shows `WELCOME-…` → the AI should confirm the 15% WELCOME was applied (cite code + amount), state a 1-unit one-time order earns no quantity break and no second %, and NOT promise a 25% refund. Expect a data-grounded explanation, not blind agreement.
- **Issue 3 (email fallback on stuck SMS):** complete the popup phone step so a coupon SMS is sent (lead gets `sms_status='queued'`, `email_consent_at` set), then leave `sms_status` un-advanced (no `delivered` callback) → ~10 min later expect a "Your discount code inside" email with the code, and `storefront_leads.fallback_emailed_at` stamped. If the Twilio callback marks the message `delivered` within the window → expect NO email (skipped `sms_delivered`).
- **Issue 3 (dedup):** a lead that already got the abandonment email (`fallback_emailed_at` set) must never also get the delivery-fallback email, and vice-versa → at most one fallback email per lead.
- **Issue 3 (Twilio root cause — owner):** in the Twilio console, confirm the Messaging Service A2P 10DLC campaign registration status and check whether `queued` WELCOME messages are carrier-filtered; confirm actual handset delivery on a live test number.

## Status

🚧 **Issue 2 shipped; Issues 1 & 3 code shipped, one gated action + one owner op task remain.**
- Issue 1 — code landed (checkout write + orchestrator surfacing); the historical backfill is authored and **awaits owner approval** to run against prod.
- Issue 2 — shipped (system-prompt guardrail + operational-rules sibling). `npx tsc --noEmit` clean.
- Issue 3 — email-fallback code shipped (new shared helper + `popup-sms-delivery-fallback` Inngest fn + event wiring + brain pages). The Twilio deliverability **root-cause diagnosis remains an owner operational task** (needs Twilio console access, not buildable from the box).

Triggered by ticket 8e9e325e; remediated for the one customer manually. Fixes above are the durable work.
