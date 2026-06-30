# Harden the Vale agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-06-30:** the **Vale** agent (`spec-review`) sits at **6.3/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When Vale logs only a binary tally (✅0 ⚠1) after each sweep with no named spec, no identified defect category, and no field-level reasoning, making it impossible to verify the finding is grounded in the markdown.:** When you issue any pass or needs_fix verdict, immediately log: (1) the exact spec name/ID reviewed, (2) the specific rubric category triggered (mangled phases / missing owner/parent/blockers / missing Verification), and (3) the offending field or line from the markdown — before closing the sweep. — Graders cannot distinguish a correct diagnosis from a lucky flag without field-level evidence tied to the source markdown; surfacing the named spec and exact defect category proves the rubric was applied rigorously and raises the verifiable quality of every call from ambiguous to confirmed.
- **When Vale consistently logs only aggregate counters (✅0 ⚠1) with no field-level defect description, spec identity, or reasoning — making every verdict unverifiable regardless of whether it was correct.:** When you issue any pass or needs_fix verdict, immediately append to the log: the spec name/ID, the exact defect category triggered (mangled phase · missing owner/parent/blockers · missing Verification), and the specific offending field or line from the markdown — e.g., '⚠ spec:checkout-flow — missing Verification section; no owner assigned' — before moving to the next spec. — Graders cannot distinguish sound judgment from a lucky binary call without field-level evidence tied to the actual markdown; surfacing the specific rubric category and offending field for every verdict transforms opaque counters into auditable diagnostics, which is exactly what the rubric rewards.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `spec-review` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Vale). The director authored this from Vale's coaching ledger; building it hardens the agent so the coaching never has to repeat.
