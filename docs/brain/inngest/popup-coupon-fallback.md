# inngest/popup-coupon-fallback

Smart-popup abandonment fallback (storefront-mvp Phase 4e).

**File:** `src/lib/inngest/popup-coupon-fallback.ts`

## Function

### `popup-coupon-fallback`
- **Trigger:** event `popup/email-lead-captured` (fired by `/api/lead` when the popup email step mints a coupon)
- **Retries:** 2

Sleeps **5 minutes**, then: if the lead finished the email step (coupon minted) but **never completed the phone step** (`storefront_leads.sms_consent_at IS NULL`) and we haven't already sent the fallback (`fallback_emailed_at IS NULL`), **email** the coupon code (via [[../libraries/email]] `sendTicketReply`) and stamp `fallback_emailed_at`.

## Dedup guarantee

A lead never gets **both** the SMS and the fallback email: the SMS path (`/api/popup/claim`) sets `sms_consent_at` on success, which makes this job skip. `fallback_emailed_at` guards against re-sends. Unlike the SMS path, the fallback does **NOT** auto-apply the coupon (no validated mobile, and the visitor has left).

## Tables

- **Read:** [[../tables/storefront_leads]], [[../tables/workspaces]], [[../tables/customers]]
- **Written:** [[../tables/storefront_leads]] (`fallback_emailed_at`)

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/popup-decide]] · [[../lifecycles/storefront-checkout]] · [[../../CLAUDE]]
