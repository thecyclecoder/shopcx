# libraries/escalation-health

The pure predicate behind `scripts/open-tickets.ts list` — classifies each open ticket into one of five escalation-health states so the CLI runnable can render a queue view whose "dropped hand-off" flag actually means neglect.

**File:** `src/lib/escalation-health.ts`

## The problem it solves

`scripts/open-tickets.ts` used to decide the defect branch from ticket AGE (`now − created_at`) alone. The moment a customer replied to an old thread the ticket reopened and was instantly reported as a dropped hand-off that had supposedly been sitting unowned for days — even while an agent was actively answering it. The 2026-09-02 case: an 8-day-old thread was reopened, an agent replied three minutes later and closed it, and the queue view still flagged it as a week-old defect. The cost is not the wasted look — it is that a detector which cries wolf gets ignored, and the real dropped hand-offs the check exists to catch go with it.

The fix separates AGE (how long ago the thread started) from IDLE (how long since anyone touched it). Only idle indicates neglect.

## Signature

```ts
import { classifyEscalationHealth } from "@/lib/escalation-health";

classifyEscalationHealth({
  ageMin: number,                  // now − created_at, in minutes
  idleMin: number,                 // now − updated_at, in minutes
  escalatedTo: string | null,      // tickets.escalated_to
  assignedTo: string | null,       // tickets.assigned_to
  graceMin: number,                // just-created / just-touched grace (30 in scripts/open-tickets.ts)
}): EscalationHealth
```

`EscalationHealth` is a discriminated union — one of:

- `{ state: "escalated" }` — CEO owns it
- `{ state: "assigned" }` — a human owns it (the CLI resolves `assignedTo` → `display_name` for the print)
- `{ state: "new"; ageMin }` — brand new, still in the just-created grace
- `{ state: "reopened"; idleMin }` — old ticket, touched inside the grace (customer just reopened it and an agent is actively answering)
- `{ state: "defect"; idleMin }` — old AND untouched past the grace, i.e. a dropped hand-off

## Precedence

`escalated` > `assigned` > `new` (`ageMin ≤ graceMin`) > `reopened` (`idleMin ≤ graceMin`) > `defect`.

An assigned reopened ticket is still `assigned` — a human already owns it. An escalated old ticket is still `escalated` — the CEO owns it.

## Why pure

`scripts/open-tickets.ts` is a CLI runnable — the logic cannot be unit-tested in place. The predicate is extracted here so `src/lib/escalation-health.test.ts` can pin the five states + the two boundaries (idle == grace still counts as reopened, idle == grace+1 fires the defect). The CLI keeps the async pieces (workspace_members display_name lookup, human-formatted durations).

## Related

- Runnable: `scripts/open-tickets.ts`
- Recipe: [[../recipes/open-tickets-queue]]
- The dropped-hand-off signal feeds the CS function's [[../functions/cs]] "Escalation triage quality" mandate — a false positive in it degrades the exact signal the mandate depends on.
