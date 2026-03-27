# Worktree: Snooze Tickets

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-snooze feature/snooze-tickets
cd ../shopcx-snooze
npm install
```

Work in `/Users/admin/Projects/shopcx-snooze` — NOT main.

## What to Build

Agents can snooze a ticket until a specific date/time. The ticket disappears from the active queue and reopens automatically when the snooze expires.

## Database Changes

### Migration
```sql
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tickets_snoozed ON public.tickets(snoozed_until) WHERE snoozed_until IS NOT NULL;
```

## API Changes

### `src/app/api/tickets/[id]/route.ts` (PATCH)
Add `snoozed_until` to the allowed PATCH fields. When set:
- Set status to `pending` (or keep current)
- The ticket should be excluded from the active queue

### Ticket list API (`src/app/api/tickets/route.ts`)
Add filter: exclude tickets where `snoozed_until > now()` from default queries.
Add a new filter option `?snoozed=true` to show only snoozed tickets.

## Inngest Function: `src/lib/inngest/ticket-snooze.ts`

```typescript
export const ticketUnsnooze = inngest.createFunction(
  {
    id: "ticket-unsnooze",
    retries: 1,
    triggers: [{ cron: "*/5 * * * *" }], // Every 5 minutes
  },
  async ({ step }) => {
    await step.run("unsnooze-tickets", async () => {
      const admin = createAdminClient();
      // Find tickets where snoozed_until <= now
      const { data: snoozed } = await admin
        .from("tickets")
        .select("id")
        .lte("snoozed_until", new Date().toISOString())
        .not("snoozed_until", "is", null);

      for (const ticket of snoozed || []) {
        await admin.from("tickets").update({
          snoozed_until: null,
          status: "open",
        }).eq("id", ticket.id);
      }

      return { unsnoozed: snoozed?.length || 0 };
    });
  }
);
```

Register in `src/app/api/inngest/route.ts`.

## UI Changes

### Ticket Detail (`src/app/dashboard/tickets/[id]/page.tsx`)

Add a "Snooze" button in the ticket actions area:
- Click → dropdown with options:
  - Later today (4 hours)
  - Tomorrow morning (9am)
  - Next week (Monday 9am)
  - Custom date/time picker
- When snoozed: show banner "Snoozed until [date]" with "Unsnooze" button
- Snoozing adds an internal note: "Ticket snoozed until [date] by [agent]"

### Ticket List (`src/app/dashboard/tickets/page.tsx`)
- Snoozed tickets should be hidden from default view
- Add a "Snoozed" filter option or sidebar count
- Snoozed tickets show a clock icon and snooze date

## Testing
1. Snooze a ticket for 5 minutes
2. Verify it disappears from queue
3. Wait 5 minutes → verify it reappears as open
4. Snooze + unsnooze manually
5. Custom date picker works

## When Done
Push to `feature/snooze-tickets` branch. Tell the merge manager (main terminal) to merge.
