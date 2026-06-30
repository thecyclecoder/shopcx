# Harden the Bo agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-06-30:** the **Bo** agent (`build`) sits at **6.5/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When When faced with a multi-phase spec, Bo consistently builds only 1 of 2–3 required phases and defers the PR, leaving the spec materially incomplete and the rubric criteria 'spec phases satisfied' and 'PR merged clean' unmet.:** When you see a spec with multiple phases (positions 1, 2, 3…), commit to building ALL phases in a single action pass before deferring or raising a PR — if a phase is genuinely blocked by an external dependency, explicitly flag the blocker with a reason rather than silently deferring after one phase. — Every low grade traces directly to stopping after phase 1 and calling it done; completing all phases in one pass is the only way to satisfy 'spec phases satisfied' and reach a mergeable PR state. Treating a multi-phase spec as an atomic unit of work — not a sequence of separate jobs — eliminates the rebuild churn and deferred-PR pattern that is driving the grade slip.
- **When Bo consistently builds only 1 of 3 required spec phases per action, then defers the PR, leaving the spec materially incomplete and the branch unmergeable.:** When you see a multi-phase spec, do not conclude the action until all phases are built and tsc is clean — batch all phases within a single action run, and only raise a PR deferral if you can explicitly name a concrete external blocker (missing dependency, upstream merge conflict) that prevents you from proceeding to the next phase. — The rubric scores 'spec phases satisfied' and 'PR merged clean' as a unit — partial delivery scores at most 6/10 regardless of code quality. Completing all phases in one action eliminates the deferral loop and the rework churn it produces, directly recovering the lost 2–3 points per job.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `build` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Bo). The director authored this from Bo's coaching ledger; building it hardens the agent so the coaching never has to repeat.
