# CSAT lifecycle

How a closed ticket becomes a customer rating, end to end.

## Flow

```
ticket closes → 48h passes
  ↓
ticket-csat-cron (every 15 min) selects:
  status='closed' AND closed_at <= now() - 48h
  AND csat_sent_at IS NULL AND customer_id IS NOT NULL
  ↓
For each: stamp csat_sent_at NOW (idempotency lock), then send email
  ↓
Customer clicks CTA → /csat/{ticket_id}?token={hmac}
  ↓
Gate: "Was your issue resolved?"
  ↓                                ↓
"Not yet"                          "Yes, all good"
  ↓                                ↓
textarea reason                    5-star rating + optional comment
  ↓                                ↓
POST /api/csat/{id}                POST /api/csat/{id}
  action=reopen                    action=rate
  ↓                                ↓
ticket_messages inbound row        ticket_csat row inserted/updated
ticket.status='open'               loyalty_members.points_balance += 500
csat:reopened tag                  ticket_csat.points_awarded = 500
NO ticket_csat row                 thank-you screen
```

## Key design choices

### 1. Gate before rating
Asking "did we resolve it?" first means CSAT scores only come from customers who confirmed resolution. Out-of-policy disputes ("you wouldn't refund me") go through the **reopen path**, not the rating path, so they don't tank the headline number. Reopen rate is the secondary signal — too high suggests AI/agents are auto-closing prematurely.

### 2. Cron, not sleep-step
Original draft used `step.sleep("24h")` after a `ticket/closed` event. Two problems:
1. `ticket/closed` was never emitted anywhere in src/ — pipeline was silently dark.
2. Long sleeps in Inngest are fragile across restarts.

The cron polls the [[../tables/tickets]] table every 15 minutes. The marker column `tickets.csat_sent_at` is set BEFORE the send call, so a Resend failure doesn't cause a re-send storm on the next tick.

### 3. 48-hour delay
Splits the difference between "fresh in memory" (24h) and "fulfillment outcome confirmed" (72h):
- Replacement orders typically arrive within 48h
- Subscription mutations take effect immediately, customer can confirm in portal
- Refunds take 5-10 business days to appear, so even 72h won't help there — accept that physical-money outcomes lag

### 4. Points conditional on COMPLETION, not on RATING
500 loyalty points (~$5 value) awarded for completing the rating regardless of stars given. Awarding only on positive ratings would be paying for positive reviews — gross, and Klaviyo / FTC would call that bait. Points are NOT awarded on the reopen path (you don't pay someone for opening a complaint).

### 5. Token is HMAC-SHA256 of ticket_id
```ts
createHmac("sha256", ENCRYPTION_KEY).update(ticketId).digest("hex").slice(0, 32)
```
No DB lookup needed to validate the link. Anyone with `ticketId + token` can submit, but the token can't be guessed without `ENCRYPTION_KEY`.

## Dashboard slices

Surface at `/dashboard/csat`:
- Headline avg rating + count
- Response rate (submitted / sent)
- Reopen rate (csat:reopened tag count / sent)
- Rating histogram 1-5
- Recent responses with comments inline

A high reopen rate (>15%) is the leading indicator of premature ticket-close. Lower is better.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/inngest/ticket-csat.ts` | Cron — find due, send, stamp |
| `src/lib/email.ts` → `sendCsatEmail` | The email template with resolution gate + 5-star deep-link |
| `src/app/csat/[ticketId]/page.tsx` | Customer-facing mini-site (Next.js page) |
| `src/app/api/csat/[ticketId]/route.ts` | Submit endpoint — both rate + reopen paths |
| `src/app/api/workspaces/[id]/csat/route.ts` | Dashboard stats + recent responses |
| `src/app/dashboard/csat/page.tsx` | Dashboard view |
| `src/app/dashboard/sidebar.tsx` | "CSAT" link under Tickets, alongside AI Analysis |

## Related

[[../tables/ticket_csat]] · [[../tables/tickets]] · [[../tables/loyalty_members]] · [[ticket-lifecycle]] · [[../inngest/ticket-csat]]
