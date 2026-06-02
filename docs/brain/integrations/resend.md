# resend

Resend — transactional email send + inbound parse. Per-workspace credentials. All outbound customer email goes through Resend; inbound parses into tickets via webhook.

## Auth

- **Encrypted on `workspaces`:** `resend_api_key_encrypted`
- **Plain on `workspaces`:** `resend_domain` (verified sending domain), `resend_webhook_signing_secret` (HMAC verification for inbound)
- **From / reply-to addresses** on `workspaces`: `support_email`, `transactional_from_email`, `transactional_from_name`, `transactional_reply_to_email`

## Key endpoints we call

Base: `https://api.resend.com`

| Endpoint | Method | Purpose |
|---|---|---|
| `/emails` | POST | Send outbound. Returns `resend_email_id`. |
| `/emails/{id}` | GET | Fetch send status (rarely used; events come via webhook). |
| `/domains` / `/domains/{id}` | GET / POST | One-time per-workspace domain setup. |

Inbound mail flows through Resend's inbound parse webhook → our webhook handler at `/api/webhooks/resend` (verified via `resend_webhook_signing_secret`).

## Rate limits + retry

- 10 emails/sec per API key by default (raised on request).
- Resend retries transient failures (5xx) internally before bouncing the call back to us.
- We don't retry from our side — email is mostly user-triggered and tracked by event log.

## Tracking

We **don't** use Resend's open/click tracking. Instead, a self-hosted pixel + click redirect (`src/lib/email-tracking.ts`):
- Open pixel: `<img src="https://shopcx.ai/api/email/open?e={id}" />` → writes `opened` event to [[../tables/email_events]]
- Click redirect: rewrite `<a href="...">` to `https://shopcx.ai/api/email/click?e={id}&u={url}` → 302 + `clicked` event

Why: Resend's tracking domain forces a CNAME we don't control, and the data lives in another silo. The `resend_email_id` is the join key for all email events. See [[../tables/email_events]] gotchas.

## Inbound parse

Resend parses the email body and posts to our webhook. Handler:
1. Verifies HMAC signature.
2. Matches to existing ticket via `In-Reply-To` / `References` headers, or creates new ticket.
3. Strips quoted history (`src/lib/email-cleaner.ts`) → stores `body_clean`.
4. Fires `ticket/inbound-message` Inngest event → [[../inngest/unified-ticket-handler]].

## Gotchas

- **`In-Reply-To` threading is the only way to thread.** Subject-only matching is unreliable. Always set `In-Reply-To` + `References` on outbound replies — see `src/lib/email.ts`.
- **Journey CTA emails must thread into the original Gmail conversation.** Use `email_message_id` (the Gmail Message-ID) on the ticket — NOT `resend_email_id` (that's only on our outbound). See [[../journeys/README]] § Email Threading.
- **`resend_email_id` is the join key** for all email events. If it's missing on a `ticket_messages` row, the tracking pixel can't attribute anything to it.
- **Supabase-js silently drops unknown columns on insert.** If you typo `resend_id` instead of `resend_email_id`, the row inserts with NULL and you'll spend an hour debugging missing events. Always check `error` on insert.
- **Inbound webhook is at-least-once.** Idempotency key: `email_message_id` (Gmail Message-ID). Bail if you've already seen it.
- **Domain verification can take hours.** SPF + DKIM + DMARC DNS records.

## Files

- `src/lib/email.ts` — Send helpers (ticket reply, CSAT, invite, journey CTA, dunning, return confirmation, etc.)
- `src/lib/email-tracking.ts` — Self-hosted pixel + redirect logic
- `src/lib/email-cleaner.ts` — Strip quoted history for `body_clean`
- `src/lib/email-utils.ts` — Threading helpers (In-Reply-To, References)
- `src/lib/email-storefront.ts` — Storefront transactional emails
- `src/app/api/webhooks/resend/route.ts` — Inbound parse webhook (TODO if path differs)

## Related

[[../tables/email_events]] · [[../tables/tickets]] · [[../tables/ticket_messages]] · [[../tables/support_emails]] · [[../inngest/deliver-pending-send]] · [[../inngest/unified-ticket-handler]] · [[../inngest/ticket-csat]]
