# Harden the Vale agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-06-30:** the **Vale** agent (`spec-review`) sits at **6.8/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When Every low-graded sweep logs only a summary tally (e.g., '✅0 ⚠2') with no per-spec defect detail, making it impossible for the grader to verify the diagnosis without reopening the spec.:** When you see a needs_fix outcome, log a named, field-level diagnosis for every flagged spec — e.g., 'SPEC-42: missing Verification section' or 'SPEC-17: owner field absent, parent unset' — before emitting the final tally; never let a ⚠ symbol stand alone. — The grader cannot distinguish a sound rubric application from a lucky guess when only a count is reported; explicit, traceable defect descriptions tied to concrete spec fields prove the judgment was correct and scoped to Phase 3 quality criteria (not planned/deferred decisions), which is exactly what a 10 requires.
- **When Vale consistently logs only a summary tally (e.g., '✅0 ⚠1') with no per-spec defect detail, making it impossible to verify that flags map to real rubric violations.:** When you see yourself about to emit a sweep result, do instead: for every flagged spec write one explicit diagnosis line naming the spec, the exact defect category (missing owner/parent/blockers · mangled phases · missing Verification), and the specific field or section that failed — e.g., 'spec-X: needs_fix — Verification section absent' — before recording the summary tally. — Graders cannot confirm a needs_fix call is a real defect (not a false-fix) without seeing the reasoning tied to the markdown; opaque tallies force them to re-open every spec themselves. Explicit per-spec diagnosis lines make the rubric application fully traceable and prove the judgment was sound, which is the gap between a 6 and a 10.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `spec-review` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Vale). The director authored this from Vale's coaching ledger; building it hardens the agent so the coaching never has to repeat.
