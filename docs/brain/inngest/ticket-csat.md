# inngest/ticket-csat

Cron that sends CSAT surveys 48h after a ticket closes. Stamps `tickets.csat_sent_at`; writes no score (the score/rating lands later in [[../tables/ticket_csat]] when the customer responds).

**File:** `src/lib/inngest/ticket-csat.ts`

## Functions

### `ticket-csat-cron`
- **Trigger:** cron `*/15 * * * *` (every 15 min) — NOT an Inngest event
- **Retries:** 2 · **Concurrency:** 1

Two passes per tick:

1. **`skip-too-old`** — closed tickets with `csat_sent_at IS NULL` whose `closed_at` is older than the 7d max-age cutoff get stamped `csat_sent_at = now()` (skipped, never surveyed). Drains the migration-day backlog so the cron doesn't rescan ancient tickets forever.
2. **`find-due` + per-ticket `send-{id}`** — closed tickets with a `customer_id`, `csat_sent_at IS NULL`, and `closed_at` in the 48h–7d window (batch 50, oldest first). For each, an **eligibility guard** runs before the send:
   - Skip (stamp `csat_sent_at`, send nothing) when ANY of:
     1. **No customer-facing outbound message** — `ticket_messages` has no row with `direction='outbound' AND visibility != 'internal'`. The principled signal: if we never sent the customer anything, there's nothing to rate. Catches OOF/auto-reply/"AI did nothing" tickets.
     2. `tickets.do_not_reply = true` — AI intentionally didn't reply (wrong company / spam).
     3. Tags overlap `SKIP_TAGS` (`outreach`, `cls:outreach`, `spam:bot`) — cheap pre-filter, shared with [[../libraries/ticket-analyzer]] via `src/lib/ticket-tags.ts`.
   - Otherwise: stamp `csat_sent_at` first (so a Resend hiccup doesn't re-fire next tick), then send the survey email via [[../integrations/resend]].

**Returns:** `{ sent, skipped_too_old, skipped_no_reply, batch_size }`.

## Downstream events sent

_None._

## Tables written

- [[../tables/tickets]] — sets `csat_sent_at` (on both send and skip)

## Tables read (not written)

- [[../tables/tickets]]
- [[../tables/ticket_messages]] — eligibility check (customer-facing outbound exists?)
- [[../tables/customers]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../lifecycles/csat]] · [[../../CLAUDE]]
