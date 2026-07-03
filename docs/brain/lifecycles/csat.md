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
Eligibility guard (skip + stamp, send nothing) if ANY:
  - no customer-facing outbound message ever sent
    (no ticket_messages direction='outbound' AND visibility != 'internal')
  - tickets.do_not_reply = true
  - tags overlap SKIP_TAGS (outreach / cls:outreach / spam:bot)
  ↓
Otherwise: stamp csat_sent_at NOW (idempotency lock), then send email
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

### 3. 48-hour delay + 7-day cap
**Send window: 48h-7d after close.** Splits the difference between "fresh in memory" (24h) and "fulfillment outcome confirmed" (72h):
- Replacement orders typically arrive within 48h
- Subscription mutations take effect immediately, customer can confirm in portal
- Refunds take 5-10 business days to appear, so even 72h won't help there — accept that physical-money outcomes lag

The 7d upper bound prevents the migration-day backlog from blasting CSAT emails on every closed ticket since the dawn of time (those read as spam to the recipient). Tickets older than 7d with `csat_sent_at IS NULL` are stamped as skipped on the first cron tick, so they stop showing up in the query.

### 3a. Only survey tickets we actually answered
The cron used to survey every closed ticket with a `customer_id`, with no check on whether we engaged the customer. OOF / auto-reply / spam tickets the AI correctly ignored still got "how did we do?" emails — and the auto-responder's mailbox rated 1, polluting the CSAT average (origin: ticket `f5d1be18`, an OOF reply to a marketing blast with zero customer-facing outbound). The eligibility guard now skips (and stamps `csat_sent_at` so they leave the scan window) any ticket that is missing a customer-facing outbound message (the load-bearing, universal signal — `ticket_messages` has no `direction='outbound' AND visibility != 'internal'` row), is `do_not_reply = true`, or carries a `SKIP_TAGS` tag. `SKIP_TAGS` lives in `src/lib/ticket-tags.ts`, shared with the ticket-analyzer so the two consumers can't drift. Note `ai_turn_count` is NOT a usable signal — it's 0 on legit angry-customer tickets too.

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
- **"Create ticket" button** on every CSAT row (label changes based on whether a comment exists). Two modes:
  - **With comment** ("Create ticket from this comment"): comment becomes the first inbound external message; subject = first line of comment (capped 80 chars); fires the `ticket/inbound-message` Inngest event so the orchestrator routes it like a real new inbound (pattern matching, journey triggering, Sonnet decision). Used when the customer hid a new request inside the CSAT comment (e.g. 5★ + "I actually need to cancel my subscription").
  - **Without comment** ("Create ticket for this customer"): empty new ticket on the customer; subject = `Follow-up from "{original ticket subject}"`; system note records the CSAT origin; orchestrator is NOT fired (no customer message for it to chew on). The agent opens the conversation themselves. Used when the rating alone is signal enough to follow up but there's no comment body to parse.

Both modes tag the new ticket `from_csat` and add a system note linking back to the source ticket + CSAT row.

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

## Status / open work

**Shipped:** Cron-driven send 48h post-close, resolution gate (yes → rate path, no → reopen path), 5-star rating + comment on separate screens, 500-point award on completion, already-submitted guard, dashboard view at `/dashboard/csat` — all shipped today. Owner-only soft-exclude control (reversible + audited): workspace owners can exclude a CSAT from the CS-quality stats via the dashboard when the response reflects a product complaint rather than service failure; excluded rows drop from count/avg/by_rating/response_rate aggregates but remain visible in the list (dimmed with reason) so the owner can reverse via the Exclude/Include toggle. Permission gated strictly to owner role (admin/agent get 403).

**Known gaps / not yet shipped:** None.

**Recent activity:**
- `a6844aaa` CSAT: resolution-gate survey + cron-driven send + dashboard
- `75b38ab0` CSAT: split rating/comment into two screens + already-submitted guard
- `af32d630` Delete stale CSAT [id] routes — superseded by [ticketId]

**Open questions:** None.

## Related

[[../tables/ticket_csat]] · [[../tables/tickets]] · [[../tables/loyalty_members]] · [[ticket-lifecycle]] · [[../inngest/ticket-csat]]
