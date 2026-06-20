# inngest/popup-sms-delivery-fallback

Popup-coupon **SMS-delivery** fallback — emails the WELCOME code when the SMS that carried it never delivers.

**File:** `src/lib/inngest/popup-sms-delivery-fallback.ts`

## Function

### `popup-sms-delivery-fallback`
- **Trigger:** event `popup/sms-coupon-sent` (fired by `/api/popup/claim` right after a successful coupon SMS send)
- **Retries:** 2

Sleeps **10 minutes** (the delivery window), then re-reads the lead. If the SMS still hasn't reached `delivered` (`storefront_leads.sms_status != 'delivered'` — covers stuck `queued`, carrier `undelivered`/`failed`), the lead consented to email (`email_consent_at IS NOT NULL`), we haven't already emailed (`fallback_emailed_at IS NULL`), and a coupon is on file, it **emails the code** as a backup via [[../libraries/popup-coupon-email]] `sendPopupCouponEmail` (which stamps `fallback_emailed_at`).

## Why

Sibling to [[popup-coupon-fallback]], for the *opposite* case: there the phone step was **abandoned**; here the phone step **completed** and we texted the code, but Twilio never delivered it. The status callback ([[../integrations/twilio]] → `/api/webhooks/twilio/marketing-status`) only advances `sms_status`; a message stuck at `queued` (A2P-registration / carrier-filtering problems) produces **no terminal callback at all**, so a webhook-only trigger would never fire — hence the timer. Triggered by ticket `8e9e325e` (Harvey Kletz, 2026-06-20): his WELCOME SMS sat at `queued`, `fallback_emailed_at` was null, and he never got the text (only got the discount because the storefront auto-applies it on-page).

## Dedup guarantee

`fallback_emailed_at` is the **single shared guard** across both popup fallbacks — [[popup-coupon-fallback]] (abandonment) and this one (undelivered SMS) — so a lead gets **at most one** fallback email total. The two paths are mutually exclusive in practice anyway (abandonment requires `sms_consent_at IS NULL`; this fires only after an SMS send, which sets it). `sendPopupCouponEmail` claims the slot with a conditional `fallback_emailed_at IS NULL` update before sending.

## Tables

- **Read:** [[../tables/storefront_leads]], [[../tables/workspaces]], [[../tables/customers]]
- **Written:** [[../tables/storefront_leads]] (`fallback_emailed_at`, via the shared helper)

---

[[../README]] · [[../integrations/inngest]] · [[../integrations/twilio]] · [[../libraries/popup-coupon-email]] · [[popup-coupon-fallback]] · [[../lifecycles/storefront-checkout]] · [[../../CLAUDE]]
