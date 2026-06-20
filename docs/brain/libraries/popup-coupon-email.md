# libraries/popup-coupon-email

The shared "here's your popup discount code" fallback email.

**File:** `src/lib/popup/coupon-email.ts`

## Export — `sendPopupCouponEmail({ workspaceId, customerId, email, couponCode, productHandle? })`

Builds + sends the coupon-code email (subject *"Your discount code inside"*) via [[email]] `sendTicketReply`, including a cross-device **redeem link** (`buildPopupRedeemUrl` from [[popup-decide|popup/redeem-link]]) when a `productHandle` is given so the customer lands back on the PDP with the code auto-applied. Returns `{ emailed:true } | { skipped } | { error }`.

**Dedup is built in.** Before sending it **claims the slot** with a conditional `storefront_leads.fallback_emailed_at IS NULL → now()` update; if another path already claimed it, returns `{ skipped:"already_sent" }`. On a send failure it **releases** the claim (sets `fallback_emailed_at` back to null) so a retry / the other path can try again — no phantom stamp with no email out.

## Callers

Two Inngest fallbacks deliver this same email for the two ways SMS isn't what lands the code — both deduped against each other by the shared `fallback_emailed_at` guard this helper owns:

- [[../inngest/popup-coupon-fallback]] — **abandonment**: lead finished the email step but never completed the phone step (5-min timer).
- [[../inngest/popup-sms-delivery-fallback]] — **undelivered SMS**: lead completed the phone step and we texted the code, but it never reached `delivered` (10-min timer).

Extracted from the inline body that previously lived in `popup-coupon-fallback.ts` so both paths stay byte-identical. Triggered by ticket `8e9e325e` (Harvey Kletz) — a WELCOME SMS stuck at `queued` with no email backup.

## Tables

- **Read:** [[../tables/storefront_leads]], [[../tables/workspaces]], [[../tables/customers]]
- **Written:** [[../tables/storefront_leads]] (`fallback_emailed_at`)

---

[[../README]] · [[../lifecycles/storefront-checkout]] · [[email]] · [[../inngest/popup-coupon-fallback]] · [[../inngest/popup-sms-delivery-fallback]] · [[../../CLAUDE]]
