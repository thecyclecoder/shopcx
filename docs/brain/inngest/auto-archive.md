# inngest/auto-archive

Archives closed tickets older than threshold (sets `archived_at`).

**File:** `src/lib/inngest/auto-archive.ts`

## Functions

### `tickets-auto-archive`
- **Trigger:** cron `0 9 * * *`
- **Retries:** 1
- **Candidates:** `status='closed'` AND `closed_at` older than 7 days AND **`escalated_at IS NULL`**.

## Invariant: an escalated ticket is never archived-while-escalated

Archiving hides a ticket from active views, so an escalated ticket archived while still flagged reads as "handled" but isn't — that's how the escalated+archived backlog formed. Enforced at every archive path:

- **Auto-archiver** (here) — *skips* escalated tickets (`.is("escalated_at", null)`). An escalated closed ticket stays out of the archive until it's unescalated (i.e. actually handled).
- **Manual archive** (`PATCH /api/tickets/[id]`) — setting `status='archived'` also clears `escalated_to` / `escalated_at` / `escalation_reason` in the same update (unescalate-on-archive).
- **Merge** ([[../libraries/ticket-merge]]) — the source stub is unescalated (escalation moved to the target) *before* it's archived.


## Downstream events sent

_None._

## Tables written

- [[../tables/tickets]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
