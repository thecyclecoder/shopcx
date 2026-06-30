# Positive-close gate must respect escalated_at, not just assigned_to / agent_intervened

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `adc0a293-7a22-471a-8e20-1260c84c6675`

Stacy Zimring's ticket adc0a293 was escalated to the triage routine on turn 1 (subs renewed minutes before the customer pushed their next-dates out). On turn 2 her contextual 'Thank you. I haven't been drinking coffee lately so unopened envelopes are piling up.' was misread as a positive close — the ticket was auto-closed with a sales-y sign-off before the routine ever picked it up. The orchestrator's 'Escalated/agent-assigned ticket — hard gate, every turn' sonnet_prompt would have blocked this, but positive-close detection runs BEFORE the orchestrator, and its agent-handled guard doesn't know about escalated_at.

## Problem (from escalated ticket `adc0a293-7a22-471a-8e20-1260c84c6675`)
src/lib/inngest/unified-ticket-handler.ts ~line 1481 suppresses positive-close only when agent_intervened || assigned_to. Routine-owned escalations (escalate() sets escalated_at + escalated_to=null + assigned_to=null) match neither, so the guard misses them entirely. The prior-unanswered keyword regex and unfulfilled-promise regex are both too narrow to catch every 'thanks + unresolved context' shape (Stacy's 'piling up' / 'I want to get a teammate' triggered neither). The agent-handled OR-list is the load-bearing check because escalated_at IS NOT NULL is the strongest signal that the AI should not be closing on the customer's behalf. setStatus at line 470 already clears escalated_at on every close, so adding escalated_at to the suppression list will not strand legitimately-resolved tickets — the flag stays set only while an active escalation is in flight, which is exactly when we want positive-close suppressed.

**Likely target:** `src/lib/inngest/unified-ticket-handler.ts — extend the agent-handled positive-close suppression block (~line 1481-1486) to also select `escalated_at` from tickets and suppress when escalated_at IS NOT NULL. Distinguish the system-note phrasing for routine-owned (escalated_at set, escalated_to null) vs agent-assigned. Cover with a unit fixture in the existing spec-test-*.ts convention (e.g. spec-test-positive-close-escalated.ts) — load a ticket with escalated_at set, run the positive-close branch with a 'thanks + context' inbound, assert the ticket is NOT closed and the system note records the suppression. Scope is intentionally narrow: do NOT broaden the prior-unanswered keyword regex or the unfulfilled-promise regex — escalated_at IS NOT NULL covers this case more robustly than keyword tuning would.`

## Phases
- **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it would now be handled (or not mis-escalated).

> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket `adc0a293-7a22-471a-8e20-1260c84c6675`. Commission the build from the Roadmap board (owner = cs).
