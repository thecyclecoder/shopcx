# Auto-Archive Tickets — Spec

## Overview

Tickets are automatically archived 7 days after being closed. Archived tickets are read-only and cannot be reopened. Customer replies to archived tickets create a new ticket that runs through normal processing (journeys → workflows → AI).

---

## 1. Ticket Status Change

### 1a. New status: `archived`
- Add `archived` to the ticket status enum: `open`, `pending`, `closed`, `archived`
- Migration: `ALTER TYPE ticket_status ADD VALUE 'archived';`
- Archived tickets are **permanently read-only** — no status changes, no replies, no assignment changes

### 1b. Archive timestamp
- Add `archived_at timestamptz` column to `tickets` table for audit/filtering

---

## 2. Inngest Cron: Auto-Archive

### 2a. Function: `tickets/auto-archive`
- **Schedule**: Runs daily (e.g., 3 AM workspace timezone, or just UTC)
- **Logic**: Archive tickets that have been continuously closed for 7 days. Use `closed_at` (see 2c) as the reference, NOT `updated_at` (which could be stale from unrelated updates).
  ```sql
  UPDATE tickets
  SET status = 'archived', archived_at = now()
  WHERE status = 'closed'
    AND closed_at IS NOT NULL
    AND closed_at < now() - interval '7 days'
  ```
- Process in batches (500 at a time) to avoid long-running queries
- Log count of archived tickets per run

### 2c. Clock reset on re-open
- Add `closed_at timestamptz` column to `tickets` table (if not already present).
- Whenever a ticket is set to `closed`, set `closed_at = now()`.
- Whenever a closed ticket is re-opened (status changes from `closed` to `open`), set `closed_at = NULL`.
- When the ticket is closed again, `closed_at` is set fresh — this resets the 7-day archive clock.
- The cron uses `closed_at` as the reference timestamp, so a re-open/re-close cycle always gets a full 7 days.

### 2b. No re-open path
- Once archived, there is NO way to change the status back. The UI should not show any status change controls on archived tickets. The backend should reject any status update on archived tickets.

---

## 3. Email Inbound: Reply to Archived Ticket

### 3a. Current behavior
- Inbound emails match to existing tickets via `In-Reply-To` / `References` headers or subject line threading
- If a match is found, the reply is added to that ticket and status is set to `open`

### 3b. New behavior for archived tickets
- When an inbound email matches an archived ticket:
  - Do **NOT** add the message to the archived ticket
  - Do **NOT** reopen the archived ticket
  - Instead: create a **new ticket** with:
    - Same customer, same channel
    - The inbound message as the first message
    - Reference to the original archived ticket (optional: `parent_ticket_id` or a note like "Continued from #XXXX")
    - Status: `open`
  - The new ticket runs through the normal priority order: rules → journey check → pattern match → workflow → AI draft
- This applies to all inbound channels (email, chat, portal, etc.), not just email

---

## 4. Dashboard UI

### 4a. Ticket queue filters
- Add `archived` to the status filter dropdown
- **Default view**: archived tickets are **excluded** from the default queue (only show open/pending/closed)
- Agents can filter to see archived tickets explicitly

### 4b. Ticket detail (archived)
- Show an "Archived" status badge (gray or muted color)
- Show a banner: "This ticket was archived on {date}. Archived tickets are read-only."
- **Hide/disable**: reply composer, status dropdown, assignment dropdown, tag editor, all action buttons
- Messages are still fully readable and scrollable
- Customer sidebar still shows full customer info (read-only context)

### 4c. Ticket views
- Existing saved views that filter by status should work with `archived`
- The default "All tickets" view should exclude archived unless the filter explicitly includes it

---

## 5. Ticket Count Updates

- Sidebar ticket counts (open, pending) should **not** include archived
- Dashboard stats ("open tickets", "pending tickets") should **not** include archived
- If there's a "closed" count anywhere, archived should be separate from closed

---

## 6. API Guards

- `PATCH /api/tickets/[id]` — reject any update if ticket status is `archived` (return 400: "Archived tickets cannot be modified")
- `POST /api/tickets/[id]/messages` — reject new messages on archived tickets (return 400: "Archived tickets are read-only")
- The only write allowed on an archived ticket is the initial archive operation itself (via the cron)

---

## File Changes Summary

| File | Change |
|------|--------|
| `supabase/migrations/XXXXXX_ticket_auto_archive.sql` | Add `archived` to status enum, add `archived_at` + `closed_at` columns |
| `src/lib/inngest/auto-archive.ts` | New: daily cron to archive closed tickets older than 7 days |
| `src/app/api/tickets/[id]/route.ts` | Reject updates on archived tickets |
| `src/app/api/tickets/[id]/messages/route.ts` | Reject new messages on archived tickets |
| Email inbound handler (webhook) | Check for archived ticket match → create new ticket instead of threading |
| Ticket queue page | Add `archived` filter, exclude from defaults |
| Ticket detail page | Read-only mode for archived tickets with banner |
| Sidebar / dashboard stats | Exclude archived from counts |
