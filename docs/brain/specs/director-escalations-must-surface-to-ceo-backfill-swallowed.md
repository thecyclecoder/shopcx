# Reconcile the already-swallowed director escalations (backfill) ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — hardens the Phase-3 CEO-escalation plumbing (`escalateDiagnosisToCeo`) under [[../goals/devops-director]]
**Deferred:** split from `director-escalations-must-surface-to-ceo` (folded → [[../libraries/platform-director]]) — not needed now: Phase 1 already made the surface reliable for all FUTURE escalations (the swallowed-error bug is fixed forward, and the dedupe now keys on an existing notification so a never-surfaced escalation re-emits on its next pass). This phase only reconciles escalations swallowed BEFORE the fix, is explicitly dormant until Platform is flipped `live + autonomous` (an owner-gated prod action that hasn't happened), and the one known stranded escalation (agent-outage-resilience P3) is a grooming decision that gets re-groomed anyway. Build it at/before Platform activation so the CEO inbox is clean when they start relying on the director.

## Phase 1 — reconcile the already-swallowed escalations (backfill) ⏳
- A standing backstop in the director pass: find every `escalated` [[../tables/director_activity]] row with no live matching `dashboard_notifications` (by `dedupe_key`/`spec_slug`) and re-emit the CEO notification once. This retroactively surfaces the agent-outage-resilience P3 escalation (and any sibling) so the CEO can act on decisions that silently stranded.
- Best-effort, idempotent (re-emits once, then the dedupe holds), dormant until live+autonomous.

### Verification — Phase 1
- After the backstop runs, the agent-outage-resilience P3 'your call' escalation appears in the CEO inbox with its recorded reasoning + a deep-link to the spec. A second pass emits no duplicate.