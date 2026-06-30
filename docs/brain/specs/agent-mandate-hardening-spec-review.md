# Harden the Vale agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-06-30:** the **Vale** agent (`spec-review`) sits at **6.5/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When Vale consistently reports only aggregate counters (✅0 ⚠1) with no per-spec, per-field diagnosis, making it impossible to verify whether the flag or pass was grounded in the actual markdown.:** When you see yourself about to emit a pass or needs_fix verdict, do instead write a one-line field-level diagnosis for every spec reviewed — e.g., '⚠ spec-checkout: missing Verification section, no owner assigned' or '✅ spec-returns: phases intact, owner/parent/blockers present, Verification complete' — before closing the sweep. — Graders cannot distinguish a well-reasoned call from a lucky guess without explicit field-level evidence tied to the rubric checklist; surfacing the exact missing or mangled field proves the judgment was applied rather than assumed, and raises scores from 6 to 10 without changing the underlying accuracy of the verdicts.
- **When Vale consistently emits only aggregate counters (✅0 ⚠1) with no per-spec, per-field diagnosis, making it impossible to verify that the flag or pass is grounded in the actual markdown.:** When you issue any pass or needs_fix verdict, immediately follow it with an explicit, field-level diagnosis for that specific spec — e.g., 'SPEC-42: missing Verification section' or 'SPEC-17: owner field blank, no parent linked' — before logging the summary counter; if a spec is skipped, state the reason inline. — The rubric grades on diagnosis quality, not just flag counts — a bare ⚠1 is unauditable and earns no credit for 'catching real defects.' Naming the exact missing or mangled field tied to the spec proves the checklist was applied to the markdown rather than guessed, which is what separates a 10 from a 6.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `spec-review` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Vale). The director authored this from Vale's coaching ledger; building it hardens the agent so the coaching never has to repeat.
