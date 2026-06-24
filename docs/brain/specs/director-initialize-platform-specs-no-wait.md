# Initialize unblocked platform specs with no waiting period ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[worker-grading-and-director-management]] — extends the fix-escort lane (`escortFixSpecs`) under [[../goals/devops-director]]
**Found in use 2026-06-24:** the CEO asked why [[orchestrator-retry-5xx]] hasn't started. It's a platform-owned authored fix spec (Repair-signature `vercel:caec228f9136b469`, verdict real-bug), unblocked, with a single `## Phase 1 — close it ⏳` section and ZERO builds ever. It falls through every auto-build lane: the fix-escort lane requires `phases.length === 0`; grooming requires ≥1 ✅ phase; the goal-walk requires a goal link. [[slack-fetch-timeout-hardening]] is in the identical state. CEO policy: a platform-owned spec that checks out should initialize with NO waiting period; other-department specs are only babysat through their phases once started (never initialized by me).

## The bug

[[../libraries/platform-director]] `escortFixSpecs` gates on `card.phases.length === 0 && card.repairSignature && owner === platform`. The box Repair Agent now authors fix specs with a `## Phase 1 — close it ⏳` section, so `phases.length` is 1 (or more) and the lane skips them. These specs have no ✅ phase (grooming skips) and no goal link (the goal-walk skips), so nothing ever queues them. The 7-day `inFlight` cooldown ([[groom-advance-next-phase-after-merge]]) is unrelated — it only affects grooming, which never sees a 0-✅ spec; do not conflate the two.

## Phase 1 — fix the fix-escort gate: any unstarted authored platform fix spec ⏳
- Change the `escortFixSpecs` candidate test from `phases.length === 0` to **no shipped phase** (`counts.shipped === 0`), keeping the rest: `repairSignature` present, `owner === platform`, unblocked, `**Auto-build:** off` excluded, no active build, loop-guard on repeated failures. So a Repair-authored platform fix spec is queued regardless of whether it has 0, 1, or N ⏳ phases — the existing build chain then carries its phases to completion.
- No waiting period: initiation has no prior build, so no cooldown applies. Queue on the next standing pass; write the `escorted_fix` [[../tables/director_activity]] row + the P6 `spec_card_state` mirror as today.
- Brain: [[../libraries/platform-director]] (`escortFixSpecs`, `FixEscortResult`) · [[worker-grading-and-director-management]].

### Verification — Phase 1
- With Platform live+autonomous, orchestrator-retry-5xx and slack-fetch-timeout-hardening each get a `kind='build'` `agent_jobs` row (`created_by=null`, instructions starting `Escorted by the Platform/DevOps Director:`) on the next standing pass, plus an `escorted_fix` `director_activity` row.
- Re-run the sweep → no duplicate build (the spec is now in-flight). A still-blocked fix spec is NOT queued. A fix spec whose build failed ≥ loop-guard cap escalates, not resubmits.

## Phase 2 — initiation lane for non-fix platform specs (no waiting period) ⏳
- A platform-owned, unblocked, unstarted (0 ✅) spec that is NEITHER goal-linked NOR Repair-signed currently has no lane (fix-escort rejects non-fixes, the goal-walk needs a goal, grooming needs a ✅). Per CEO policy I should be able to initialize my OWN department's specs without a waiting period. Add a platform-spec initiation sweep that queues such a spec — gated by the SAME read-only soundness investigation as the approval/groom lanes (a Max `claude -p` verdict that the spec is sound and in-scope) so I don't blind-build a feature, NOT auto-queued blindly.
- Hard rails unchanged: other departments' unstarted specs are NEVER initialized here (they're only babysat via grooming once they have ≥1 ✅ phase); starting a new GOAL still escalates to the CEO; destructive/irreversible/multi-choice still escalate.
- Brain: [[../libraries/platform-director]] · [[platform-director-agent]] · [[board-grooming]].

### Verification — Phase 2
- An unblocked platform-owned planned spec with 0 ✅, no goal link, no Repair-signature → after a passing soundness investigation, a `kind='build'` row + a `director_activity` row; a failed/ambiguous investigation → escalates to the CEO, queues nothing.
- A non-platform unstarted spec → never initialized. A platform spec that is part of an unstarted (0%) goal → still escalates as a new-goal call, not initialized.

## Open decision (for the CEO)
Phase 2 defaults to requiring a soundness investigation before initializing a non-fix platform feature (vs. building it outright). Confirm that gate, or say 'just build any unblocked platform spec that isn't goal/destructive/multi-choice' and I'll drop the investigation step for platform-owned specs.