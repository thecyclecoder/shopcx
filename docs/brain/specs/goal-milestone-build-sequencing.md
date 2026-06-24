# Goal milestone builds must be dependency-ordered + director-sequenced ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/devops-director]] — hardens the goal→decompose→approve→build pipeline ([[../specs/goal-decomposition-engine|Pia]] + the director escort)
**Found in use 2026-06-24:** Pia decomposed [[platform-department-scorecard]] + [[grow-surface-platform-agent-team]] at 03:32 with NO `Blocked-by:` deps on the milestone specs. On approval, 5 milestone builds (platform-scorecard-surface/weekly/monthly, fleet-spend-governor, fleet-cost-metering) fanned out CONCURRENTLY at 03:45, out of order → 4 jammed in `needs_input`, fleet-cost-metering in `needs_approval` to the director (unapprovable — prerequisites don't exist). Two root causes: Pia emits no dependency DAG, and the approval path enqueues milestone builds directly instead of through the director's dependency-aware escort.

## North star — ordered, gated, never a free-for-all

A goal is a DAG of milestones; building them concurrently without deps corrupts the build (later specs reference earlier ones' outputs). The director sequences; Bo builds only the unblocked frontier. The CEO greenlights the GOAL; the director sequences the BUILDS.

## Phase 1 — Pia always emits the dependency DAG (decomposition integrity) ⏳
- The [[../specs/goal-decomposition-engine|goal-decomposition planner]] MUST declare dependencies: each milestone spec gets a `**Blocked-by:**` line naming its prerequisite milestone spec(s) (M2 blocked-by M1, the metrics before the surfacing, etc.), so the existing [[../specs/spec-blockers|spec-blockers]] chokepoint (`queueRoadmapBuild` refuses a blocked build; auto-queues the dependent on the blocker's merge) staggers them.
- A decomposition that emits a FLAT, blocker-less multi-milestone list is INVALID — validate and reject/re-plan before it's proposed to the CEO. A genuinely-parallel milestone (no dep) is allowed but must be explicit, not the default.
- Brain: [[../specs/goal-decomposition-engine]] · the plan-goal skill · [[../specs/spec-blockers]] · [[../libraries/brain-roadmap]] (the `Blocked-by` parse).

### Verification — Phase 1
- Pia decomposing a multi-milestone goal emits each dependent milestone spec with a correct `**Blocked-by:**` line; a proposed tree with sequential milestones and no blockers fails validation and is re-planned. The roadmap board shows the 🔒 Blocked chip on the not-yet-ready milestones.

## Phase 2 — approved milestones route through the director, not a direct fan-out ⏳
- Greenlighting a goal's milestones marks them approved-to-build but does NOT directly enqueue concurrent builds. The director's `escortApprovedGoals` sequences them — releasing only the UNBLOCKED frontier (respecting `Blocked-by` + lane capacity), the rest auto-queue as their blockers merge (the existing reactive auto-queue).
- Remove/disable any path that auto-enqueues all milestone builds on greenlight. The greenlight → director-escort handoff is the only route to a build.
- Brain: [[../libraries/platform-director]] (`escortApprovedGoals`) · the approval/greenlight path · [[../specs/spec-blockers]].

### Verification — Phase 2
- Greenlighting a goal with milestones M1→M2→M3 results in ONLY M1 building; M2 builds when M1 merges; M3 after M2. No concurrent out-of-order fan-out. A build-approval to the director never arrives for a milestone whose blockers are unmerged.

## Phase 3 — reconcile the current out-of-order pileup ⏳
- Detect goal-milestone builds that fanned out concurrently without deps (the 03:45 cluster) and recover: HOLD/cancel the ones whose prerequisites aren't built (fleet-cost-metering, fleet-spend-governor — the M4 cost-governor; platform-scorecard-surface — the surfacing), let the foundational ones land (the metric specs), apply the inferred `Blocked-by` order, and re-release in sequence. Idempotent; logs a `reconciled_sequence` [[../tables/director_activity]] row.
- One-shot for the current mess + a standing guard against a future blocker-less fan-out slipping through.

### Verification — Phase 3
- The 5 stuck builds resolve to an ordered sequence: metric specs build first, then platform-scorecard-surface; roster-sync/deploy/security before fleet cost-governor. No build sits in needs_input/needs_approval for a missing prerequisite. Re-running the reconcile is a no-op.

## Open decision (for the CEO)
How Pia infers the DAG: (a) the milestone seeds in the goal explicitly state deps (you/I write 'M2 needs M1' in the goal), or (b) Pia infers a default linear M1→M2→… order and you correct it at greenlight. Default: Pia proposes the DAG (explicit Blocked-by per milestone) and surfaces it for your greenlight, so you see and can edit the order before anything builds.