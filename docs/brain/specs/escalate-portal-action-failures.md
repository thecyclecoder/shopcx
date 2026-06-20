# Portal-action-failure triage must escalate, not just tag needs-human ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `11746b62-8e6b-4e18-9c39-498ee12401d6`

When the portal-action-failure remediator (src/lib/portal/remediation.ts) decides a failed portal action needs a human — disposition==='human' (line 318), auto-heal exhausted past MAX_HEAL_ATTEMPTS (line 349), no automatic replay for the route (line 365), and a non-transient error surfacing on retry (line 382) — it must actually escalate the ticket, not merely add a needs-human tag and a note. Set escalated_to (resolve the workspace owner via workspace_members where role='owner', mirroring src/app/api/todos/[id]/reject/route.ts:96-105), escalated_at=now, and escalation_reason=the triage reason, in each of those branches. This puts the ticket in the escalation queue that /api/escalated and the escalated=true filter (src/app/api/tickets/route.ts:68) surface. The two branches at lines 354 and 387 currently return action:'escalated' while only tagging — make the effect match the return. Because the hand-off guard at line 293 already short-circuits when escalated_to is set, escalation becomes the idempotency guard too; retire the now-redundant needs-human tag (or keep it only as a secondary label, not the routing mechanism). Add/refresh the brain page for remediation.ts to document the escalation behavior.

## Problem (from ticket `11746b62-8e6b-4e18-9c39-498ee12401d6`)
Portal-action-failed tickets (e.g. this one — Jessica Ollet's failed replacevariants) are created left open and, when triaged to a human, only get a needs-human tag — which isn't surfaced in any human-facing queue. They never set escalated_to, so they never enter the escalation queue and silently pile up unseen. The founder flagged that these need to be escalated, and that the needs-human tag is not helpful.

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the ticket scenario → confirm the fixed behavior, and that the ticket that surfaced it would now be handled correctly.

> Authored by the box Improve agent from ticket `11746b62-8e6b-4e18-9c39-498ee12401d6`. Commission the build from the Roadmap board (owner = cs).
