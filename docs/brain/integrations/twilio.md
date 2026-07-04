# twilio

Twilio — SMS send + receive, phone number validation (Lookup v2), customer phone verification (Verify v2).

## Auth

- **Env (account-level, shared across workspaces):**
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_VERIFY_HOST` — optional override
- **Per-workspace on `workspaces`:**
  - `twilio_phone_number` — the SMS sender phone number for transactional SMS
  - `twilio_marketing_messaging_service_sid` — Messaging Service SID for marketing SMS (separate sender pool)
  - `twilio_verify_service_sid` — Verify v2 service SID for customer phone-number verification

Standard Twilio basic auth: `Authorization: Basic base64(SID:TOKEN)`.

## Key endpoints we call

| Endpoint | Purpose |
|---|---|
| `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json` | Send SMS / MMS (marketing + transactional) |
| `https://lookups.twilio.com/v2/PhoneNumbers/{phone}?Fields=line_type_intelligence` | Validate phone number + detect landline (rejects landlines from journeys) |
| `https://verify.twilio.com/v2/Services/{ServiceSID}/Verifications` | Start OTP verification |
| `https://verify.twilio.com/v2/Services/{ServiceSID}/VerificationCheck` | Confirm OTP code |

`MessagingServiceSid` (marketing) vs `From=+1...` (transactional) — separate sender pools so marketing throughput doesn't congest transactional.

## Rate limits + retry

- ~100 messages/sec per long code / short code / Messaging Service.
- 429 = throttled; back off + retry.
- `marketing-text.ts` send-tick batches per 5-min window; on failure marks the recipient `failed` and moves on (no auto-retry per-recipient).
- Twilio's MessagingService handles fallback between numbers in the pool automatically.

## Webhook signature

Inbound SMS + status callbacks: Twilio HMAC signature in `X-Twilio-Signature`. Verify per [twilio.com/docs/usage/security#validating-requests](https://www.twilio.com/docs/usage/security#validating-requests) — `src/lib/twilio.ts` has the validator.

Inbound SMS flows into [[../tables/sms_marketing_inbound]] (STOP / HELP / replies). STOP unsubscribes via Shopify marketing consent mutation. See `src/lib/shopify-marketing.ts`.

**Status callback → `storefront_leads` sync.** `POST /api/webhooks/twilio/marketing-status` handles delivery callbacks for *both* campaign sends and the popup-coupon SMS. Marketing sends match [[../tables/sms_campaign_recipients]] by `message_sid`; if no recipient matches, the no-recipient branch matches [[../tables/storefront_leads]] by `sms_message_sid` and syncs `sms_status` + `sms_status_at`. The popup-coupon send (`src/app/api/popup/claim/route.ts`) sends **direct from the short code** (no Messaging Service) so it must pass this route as an explicit per-message `StatusCallback` (`sendSMS(..., { statusCallback })`) — otherwise Twilio fires no delivery callback and `sms_status` freezes at the `queued` written on send even after delivery (ticket 8e9e325e). Reconcile rows sent before that fix with `scripts/backfill-popup-sms-status.ts` (polls the Twilio Messages API for stuck `queued` leads).

### Fast-ack + drain (Phase 1 shipped)

Both Twilio webhooks (`marketing-status` + `marketing-sms`) do **zero Postgres work on the request path**. They verify the signature, parse the URL-encoded body, and enqueue a single Inngest event; a bounded/batched drain consumer processes the event off the request path. Callback storms (~100k+ callbacks after a ~50k-recipient blast) no longer touch the DB from the webhook Lambda.

| Route | Fast-ack event | Payload | Producer |
|---|---|---|---|
| `POST /api/webhooks/twilio/marketing-status` | `sms/status-callback.received` | `{ params: Record<string,string>, url: string }` — parsed Twilio form body + request URL. `params.MessageSid` is the consumer's idempotency key. | `src/app/api/webhooks/twilio/marketing-status/route.ts` |
| `POST /api/webhooks/twilio/marketing-sms` | `sms/inbound.received` | `{ params: Record<string,string>, url: string }` — same shape. `params.MessageSid` is the consumer's idempotency key; `params.From` / `params.To` / `params.Body` drive STOP/START + inbound-log. | `src/app/api/webhooks/twilio/marketing-sms/route.ts` |

Signature-check behavior is preserved: bad signature → 200 empty body, no event enqueued (silent drop, so Twilio doesn't retry). The `marketing-sms` autoresponder (previously TwiML in the response body) now sends out-of-band via the Twilio API from the drain consumer — STOP/START confirmations remain Twilio's Advanced Opt-Out at the carrier edge.

Consumers register in [[../inngest/sms-callback-drain]] (Phase 2+).

## Verify v2 (customer phone OTP)

Used for storefront passwordless auth + portal verification. `src/lib/twilio-verify.ts`. Don't pass arbitrary phone numbers — Twilio Verify rate-limits per-phone aggressively, and abuse drives up cost.

## Gotchas

- **Landlines reject SMS silently in some carriers.** Always use Lookup v2 with `line_type_intelligence` and reject `landline` / `voip` before subscribing a number. See `src/app/api/validate-phone/route.ts`.
- **+1 prefix.** Twilio expects E.164 (`+18583349198`); user-facing inputs are typed as `(858) 334-9198`. Phone helpers in `src/lib/marketing-text-timezone.ts` and journey forms auto-prepend.
- **STOP keyword unsubscribes immediately at Twilio's edge.** We still ingest the inbound SMS so we can mirror the marketing consent flip in Shopify.
- **MessagingService delivery is async** — the API returns `queued`, not `delivered`. Use status callbacks (`message_sid`) + [[../tables/sms_campaign_recipients]] join.
- **Missing index on `sms_campaign_recipients.message_sid` caused past DB lockups.** See project_db_lockup_diagnosis. Always join via index.
- **Phone area-code timezone resolution is a fallback only** in `src/lib/marketing-text-timezone.ts`. Shipping zip → tz beats area code (people port numbers).

## Files

- `src/lib/twilio.ts` — SMS send + webhook signature verifier
- `src/lib/twilio-verify.ts` — Verify v2 OTP flow
- `src/lib/marketing-text-timezone.ts` — Resolution chain (customer tz → shipping zip → area code → workspace fallback)
- `src/lib/inngest/marketing-text.ts` — Send pipeline
- `src/app/api/validate-phone/route.ts` — Lookup v2 endpoint

## Related

[[../tables/sms_campaigns]] · [[../tables/sms_campaign_recipients]] · [[../tables/sms_send_candidates]] · [[../tables/sms_marketing_inbound]] · [[../tables/marketing_shortlinks]] · [[../tables/marketing_shortlink_clicks]] · [[../tables/auth_otp_sessions]] · [[../inngest/marketing-text]]
