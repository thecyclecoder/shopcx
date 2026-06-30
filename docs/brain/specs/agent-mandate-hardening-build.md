# Harden the Bo agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-06-30:** the **Bo** agent (`build`) sits at **6.5/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When When facing a multi-phase spec, Bo consistently builds only 1 phase per action and defers the PR, leaving 2-3 phases unbuilt and the spec unsatisfied at conclusion time.:** When you see a spec with N phases, do not exit the action until all N phases are built, tsc is clean, and the PR is merged — treat the entire phase sequence as a single atomic unit of work to complete in one pass, not a per-phase handoff. — The rubric scores on 'spec phases satisfied' and 'PR merged clean' simultaneously; partial delivery never satisfies either criterion regardless of per-phase correctness. Completing all phases in one action eliminates the deferred-PR pattern that is the direct cause of every sub-7 score in this sample.
- **When Bo consistently builds only one phase of a multi-phase spec per action, deferring the PR and leaving two-thirds or more of the required work unbuilt.:** When you see a spec with multiple phases, complete ALL phases in a single action before raising a PR — if a phase is genuinely blocked by an external dependency, explicitly name the blocker and escalate rather than silently deferring. — The rubric requires all spec phases satisfied AND a clean merged PR; stopping after phase 1 fails both criteria every time and forces follow-up churn. Batching all phases in one pass — or escalating with a named blocker — is the only path to a 10.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `build` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Bo). The director authored this from Bo's coaching ledger; building it hardens the agent so the coaching never has to repeat.
