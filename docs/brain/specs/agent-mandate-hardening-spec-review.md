# Harden the Vale agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-07-02:** the **Vale** agent (`spec-review`) sits at **6.9/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When when a spec passes the structural quality checklist and the review output is tempted to recommend planned or deferred:** Emit only pass/needs_fix plus concrete defects; leave planned/deferred disposition to Ada unless the active rubric explicitly delegates that decision. — This batch’s correct quality pass also emitted a `planned` Vale recommendation, despite the supplied Phase-3 rubric limiting Vale to quality review.
- **When when a spec has valid Owner/Parent metadata, ordered phases, and concrete Verification:** emit only `pass` with the quality rationale; do not recommend planned or deferred, because scheduling disposition belongs to Ada — The reviewed specs were structurally sound at .box/spec-box-failed-build-supersede-and-dismiss.md:3-17, .box/spec-pm-agent-activation-contract.md:3-19, and .box/spec-fix-vault-post-merge-diff-backstop-7fbde0.md:3-28, yet all three decisions added `vale_disposition=planned`.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `spec-review` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Vale). The director authored this from Vale's coaching ledger; building it hardens the agent so the coaching never has to repeat.
