# The open-ticket defect check measures neglect, not ticket age

`scripts/open-tickets.ts list` scans every OPEN ticket in the workspace and flags the dropped hand-offs. In steady state every open ticket should be escalated to the CEO, assigned to a human, or brand new — anything else is a defect.

## The rule (do not decide from age alone)

A ticket is a DEFECT only when **all four** hold:

- open
- NOT escalated
- NOT assigned to a human
- **untouched** for longer than the just-created grace (30 minutes)

The last requirement is what stops a reopened old thread from ever being reported as a dropped hand-off.

## Why: the reopened-thread false positive

The prior version decided the defect branch from `age = now − created_at` alone. So the moment a customer replied to an old thread the ticket reopened and was instantly reported as a defect that had supposedly been sitting unowned for days — even while an agent was actively answering it.

On 2026-09-02 a customer reopened an 8-day-old thread. The agent replied three minutes later and closed it. The queue view still flagged it as a week-old dropped hand-off and the founder was told to investigate a pipeline bug that did not exist. The cost is not the wasted look — it is that a detector which cries wolf gets ignored, and the real dropped hand-offs this check exists to catch go with it.

## The five states the queue view now reports

The predicate is [[../libraries/escalation-health]] `classifyEscalationHealth({ ageMin, idleMin, escalatedTo, assignedTo, graceMin })`. It is pure so the CLI runnable stays testable. The runnable prints:

| verdict | when | not a defect because |
|---|---|---|
| `escalated → CEO` | `escalated_to` is set | the CEO owns it |
| `owned by <name> — human-worked` | `assigned_to` is set | a human owns it |
| `new (Xm) — still in flow` | age within the grace | still normal handling |
| `reopened Xm ago — in flow` | old ticket, touched inside the grace | a customer just reopened it and an agent is actively answering |
| `⚠️ DEFECT — untouched Xd, NOT escalated` | old AND untouched past the grace | genuinely dropped |

The reopened case is surfaced (not silently hidden) because a human reading the queue still wants to see a reopened old ticket — it just is not a dropped hand-off. Silently hiding it would trade a false positive for a false negative.

## Related

- Predicate: [[../libraries/escalation-health]]
- Escalation lifecycle: [[../recipes/escalate-ticket]]
- The dropped-hand-off signal feeds the CS function's [[../functions/cs]] "Escalation triage quality" mandate
