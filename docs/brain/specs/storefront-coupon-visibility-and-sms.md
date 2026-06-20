# Storefront coupon visibility + WELCOME SMS delivery ⏳

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate — landing-page / funnel conversion ([[../lifecycles/storefront-checkout]])

Three defects, all surfaced by one ticket (8e9e325e, Harvey Kletz, 2026-06-20), that combine into a bad customer + AI failure mode: **a customer receives his storefront discount, but neither he nor our AI can tell** — so he complains, and the AI (blind to the applied discount) agrees to refund discounts he already got or never qualified for.

## What happened (the triggering case)

Harvey ordered 1× Amazing Coffee (SHOPCX19) and emailed *"I never received the two discounts (10% + 15%) stated on your site."* Reality:
- **He DID get the 15%** — `WELCOME-P2RJD`, −$11.99 (15% of $79.95), auto-applied at checkout. It's in `orders.payment_details.discount_code`.
- **There is no 10%** on a 1-unit order — quantity breaks are 0% / 8% / 12% for 1 / 2 / 3 units ([[../tables/pricing_rules]]); subscribe-&-save is 25%. He bought 1 unit, one-time.
- The AI saw `orders.discount_codes = []` (empty), reported *"no discounts applied at checkout,"* **blindly agreed** with his 10%+15% claim, and promised a **25% / $21.59** refund — for discounts he'd already received or never qualified for.

Resolution for Harvey (done): showed him the breakdown proving the 15%, issued a goodwill 10% refund ($7.99, Braintree `er04x520`), closed.

## Issue 1 — the applied coupon is missing from `orders.discount_codes` (the AI needs it) ⏳

`orders.discount_codes` is **empty on 100% of storefront orders** (7/7 sampled with a discount), while the real code lives in `orders.payment_details.discount_code` (+ `discount_cents`). Examples: SHOPCX20 `WELCOME-FJQHZ` (−$16.55), SHOPCX19 `WELCOME-P2RJD` (−$11.99), SHOPCX17 `WELCOME-99RA9` (−$23.75) — all with `discount_codes = []`.

**Why it matters:** the orchestrator's order context reads `discount_codes`, so it believes storefront orders have **no discount** — the direct cause of the "no discounts applied" misread and the agree-and-refund failure. The AI needs the coupon code + discount amount on the order it reads.

**Fix:**
- Storefront order creation (`src/app/api/storefront/cart/route.ts` / wherever the order row is written) must persist the applied code into `orders.discount_codes` (and keep `payment_details.discount_code`/`discount_cents` as today).
- Backfill existing storefront orders' `discount_codes` from `payment_details.discount_code`.
- Ensure the orchestrator's order payload surfaces the discount (code + amount) so the AI can answer "did I get my discount?" from data, not guesswork.

## Issue 2 — AI must verify discount claims against order data before agreeing/refunding ⏳

Even with the data present, the orchestrator agreed to a customer's unverified "10% + 15%" claim and computed a refund off it. A discount complaint must be **checked against the order's actual applied discount + the real `pricing_rules`** before any adjustment: confirm what was applied, confirm what the customer was actually eligible for (quantity break depends on cart quantity; subscribe % only on subscriptions; the WELCOME code is the signup offer), and only then decide. Never refund a discount the order already shows, and never invent one that doesn't exist for the cart. (Sibling to the orchestrator-discipline rules in [[../operational-rules]].)

## Issue 3 — WELCOME discount SMS stuck at `queued` ⏳

Harvey signed up for **both** email (03:23:22) and SMS (03:23:45) via the popup (`storefront_leads`, source `popup_discount`). The code `WELCOME-P2RJD` was issued and sent **by SMS** (`sms_message_sid` present, **`sms_status: "queued"`**) — and it **never advanced past `queued`**, with `fallback_emailed_at: null` (never emailed as backup). So the code was delivered to a customer who **never received the text** — he only got the discount because the storefront also auto-applies it on-page. Customers in this state assume the discount failed.

**Fix:**
- Diagnose why WELCOME SMS sits at `queued` in Twilio (number/messaging-service config, A2P registration, carrier filtering) and confirm actual delivery.
- Wire the **email fallback** (`fallback_emailed_at` exists but is unused here) so a customer who consented to email always gets the code if SMS doesn't deliver.
- Consider surfacing the applied/issued code in the order-confirmation regardless of channel.

## Evidence / pointers

- Order: `orders` SHOPCX19 — `payment_details.discount_code = WELCOME-P2RJD`, `discount_cents = 1199`; `discount_codes = []`.
- Lead: `storefront_leads` (email `hkletz@aol.com`) — `email_consent_at`, `sms_consent_at`, `coupon_code_issued`, `sms_message_sid`, `sms_status`.
- Discounts of record: [[../tables/pricing_rules]] (`quantity_breaks` 0/8/12; `subscribe_discount_pct` 25); WELCOME via `src/app/api/lead/route.ts` + `src/app/api/popup/claim/route.ts`.
- Flow: [[../lifecycles/storefront-checkout]].

## Status

⏳ All three issues planned — not yet built. Triggered by ticket 8e9e325e; remediated for the one customer manually. Fixes are the durable work.
