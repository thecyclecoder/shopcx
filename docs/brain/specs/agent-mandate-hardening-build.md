# Harden the Bo agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-07-02:** the **Bo** agent (`build`) sits at **5.2/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When when a spec names a concrete failing state or restricts the job to one phase:** write the smallest test for that exact state before coding, then change only the predicate and phase needed to make it pass — src/lib/agent-jobs.ts:597-606 omitted the in_review disposition gate, src/lib/build-spec-materializer.ts:55-60 still accepts empty-body phases via title/summary, and commit 17bd9fc2 implemented Phase 2 during an ONLY-Phase-1 job.
- **When Multi-phase jobs repeatedly reselected an already-built first phase, causing later implementations to carry `Phase: 1` and leaving their real phase rows unstamped.:** When starting a multi-phase build, select the first nonterminal `public.spec_phases` row whose `build_sha` is null and verify the branch trailer matches that position; produce only that phase-scoped commit and merged PR so the deterministic worker’s `stampPhaseBuilt` call persists the correct phase, or return `no_changes_reason` when the code is already on main. — In commit 9f926322, `scripts/builder-worker.ts:14956` selected phases by status without checking `!p.build_sha`. Consequently, commits 074b33cf/fed4c107, daac6ae6/a473bff8, and 150cd0b1 all recorded `Phase: 1` while their bodies explicitly implemented phases 2 or 3.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `build` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Bo). The director authored this from Bo's coaching ledger; building it hardens the agent so the coaching never has to repeat.
