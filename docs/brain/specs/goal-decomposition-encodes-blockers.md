# Goal-decomposition planner encodes Blocked-by (self-sequencing plans) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[goal-decomposition-engine]] + [[spec-blockers]]. · **Found in use 2026-06-22:** the engine's first real run (the [[../goals/storefront-optimizer]] tree) proposed a correct 7-spec decomposition but **set no dependencies** — so approving all 7 would fan out 7 builds at once and M4 (the agent) would build before M1 (its framework) exists. The owner had to approve in manual waves.

The whole [[spec-blockers]] mechanism is already built — a spec's `**Blocked-by:** [[a]], [[b]]` header gates its build (`queueRoadmapBuild` refuses an uncleared blocker) and **auto-queues the build when the last blocker ships** (spec-blockers Phase 2). The only gap: **the goal-decomposition planner doesn't emit dependencies**, so the authored specs never get a `**Blocked-by:**` line. Close that and a goal plan becomes **self-sequencing** — approve the whole tree at once, builds fire in dependency order automatically.

## Fix (planner-only — the enforcement already exists)
- **Propose phase** (`runPlanJob`, the proposing prompt in `scripts/builder-worker.ts`): instruct the planner that every proposed branch MUST declare its **prerequisites** — a `blocked_by: [<slug>, …]` listing the sibling proposed specs (or already-existing specs) it depends on (e.g. the agent spec is `blocked_by` the framework + memory + metric specs). Acyclic; a slug must reference another proposed branch or a real spec. Carry `blocked_by` on the pending-action `spec` object.
- **Resume phase** (authoring approved specs): when writing each spec's markdown, emit the **`**Blocked-by:** [[slug]], [[slug]]`** header line (same format `brain-roadmap.ts` already parses) from `blocked_by` — but **only include blockers that were themselves approved** (drop declined ones so a spec isn't permanently blocked by a branch the owner rejected).
- **Queue phase:** unchanged — rely on the existing build-gate. Approving the whole tree authors all specs; only the **unblocked** ones queue a build immediately; the rest **auto-queue as their blockers ship** (spec-blockers Phase 2). No manual waving.

## Verification
- Re-run a plan on a multi-level goal (or re-plan [[../goals/storefront-optimizer]]) → each proposed branch carries `blocked_by`; the foundation specs have none, dependents list their prereqs (no cycles).
- Approve the **entire** tree at once → each authored spec markdown has the correct `**Blocked-by:**` line; only the unblocked foundation spec(s) get a build queued; dependents sit blocked (the board shows the blocker chip).
- When a blocker ships → its dependents' builds **auto-queue** (no human action) — i.e. the full tree builds in dependency order from one approval.
- Decline a branch that others depended on → those dependents' `**Blocked-by:**` drops the declined slug (not left dangling-blocked forever).
- Negative: a flat goal with independent specs → all `blocked_by: []`, all queue immediately (no false serialization).

## Phase 1 — emit blocked_by in propose + write Blocked-by on author ✅
- ✅ Added the self-sequencing dependency instruction + `blocked_by` to the planner's propose prompt + JSON schema (`runPlanJob` propose branch, `scripts/builder-worker.ts`); carried `blocked_by` (string-slug list, malformed entries dropped) onto the `ProposedSpec` interface + the pending-action `spec` object.
- ✅ Resume authoring now computes an **approved-blockers-only** list per spec (drops any blocker slug the owner declined; keeps approved siblings + already-existing specs) and instructs the authoring agent to write the `**Blocked-by:** [[slug]], [[slug]]` header (the exact format `brain-roadmap.ts` parses) immediately after the Owner/Parent line — only when the spec declares blockers.
- Enforcement is unchanged: `queueRoadmapBuild` already refuses an uncleared blocker and spec-blockers Phase 2 auto-queues dependents as blockers ship, so approving the whole tree self-sequences with no manual waving.

Brain: [[goal-decomposition-engine]] · [[spec-blockers]] · [[../libraries/roadmap-actions]] · [[../libraries/brain-roadmap]].
