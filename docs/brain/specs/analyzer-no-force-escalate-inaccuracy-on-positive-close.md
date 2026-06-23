# Don't force-escalate an 'inaccuracy'-only flag on a high-score positively-closed ticket ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `9a6e53d9-2cd6-4203-a521-d47a15755b2b`

Ticket 9a6e53d9 (Laurie Predmore) was force-escalated to a human purely because the grader tagged a harmless closing phrase ('your loyalty points stay intact') as an 'inaccuracy', even though the ticket scored 7/10 and the customer closed positively after a clean resolution. Ground truth confirmed loyalty fully intact (1775 points + 6 unused $15 codes; the $15 was a cash refund). The fix stops the analyzer sending this narrow class to a human while leaving every genuinely harmful path untouched.

## Problem (from escalated ticket `9a6e53d9-2cd6-4203-a521-d47a15755b2b`)
In src/lib/ticket-analyzer.ts, applySeverityActions sets forceEscalate = hasSevereIssue || customerThreat, where hasSevereIssue is true for ANY issue typed inaccuracy/false_promise/broken_action (SEVERE_ISSUE_TYPES, line 31). This fires at ANY score and regardless of a positive close (lines 721/735/744). The grader rubric caps real factual errors at score <=5, yet a 7/10 ticket can still carry an 'inaccuracy'-typed issue for cosmetic phrasing — and that alone re-opens + escalates a happy, well-resolved ticket to a human, the same churn the code already prevents on the customerThreat path (Melissa Sachs 246163b4 comment, lines 102/722-733).

**Likely target:** `src/lib/ticket-analyzer.ts — in applySeverityActions, when the ONLY severe-issue trigger is the 'inaccuracy' type (i.e. issues contain no false_promise and no broken_action) AND score >= 7 AND the ticket's current close is a positive close, do NOT set the force-escalate path; log a non-actionable system note instead. Detect positive close DETERMINISTICALLY by scanning ticket_messages for an internal system note whose body contains '[System] Positive close. Ticket closed.' (the exact string from src/lib/inngest/unified-ticket-handler.ts:1593) and confirm it is the most recent lifecycle event — i.e. it occurs AFTER any prior '[Auto-Analysis] Re-opened'/escalation note and after the last unanswered inbound customer message, so a re-opened-then-reclosed ticket like this one (which had a prior score-3 reopen) is classified correctly. Do NOT key the gate on ticket.status/closed_at/resolved_at from the line-783 fetch: the analyzer only runs on closed tickets, so status='closed' is near-universal and would suppress the override globally. Leave false_promise and broken_action escalating exactly as today (no heal-verification gating — verify_refund_issued is an unimplemented future recipe at lines 86-87, so gating those types would create a silent-drop hole). Keep the customerThreat path, the score<=6 paths, and the selectResearchRecipes hook (line 756) unchanged. Add a regression comment referencing ticket 9a6e53d9.`

## Phases
- ✅ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- ✅ Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it would now be handled (or not mis-escalated).

> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket `9a6e53d9-2cd6-4203-a521-d47a15755b2b`. Commission the build from the Roadmap board (owner = cs).
