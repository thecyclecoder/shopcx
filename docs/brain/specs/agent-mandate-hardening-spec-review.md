# Harden the Vale agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-07-02:** the **Vale** agent (`spec-review`) sits at **6.1/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When when a spec Parent links to ../goals/{slug} but docs/brain/goals/{slug}.md is absent:** resolve the slug through public.goals and validate the relevant public.goal_milestones row; only emit needs_fix when those authoritative rows do not establish the claimed parent — Three actions repeatedly rejected .box/spec-research-sidebar-competitors.md:3 even though src/lib/brain-roadmap.ts:14-23 declares goals DB-authoritative and the live acquisition-research-engine/M4 rows resolve the parent.
- **When when a Parent wikilink names a goal but no corresponding docs/brain/goals markdown file exists:** resolve the goal through public.goals and validate the concrete goal_milestone/milestone_id; never infer that a goal is missing from an intentionally purged markdown path — Four reviews repeated the absent-file diagnosis even though `docs/brain/tables/goals.md:7` defines DB-backed goal reads. The fifth review found the durable check: `.box/spec-research-sidebar-competitors.md:3` names only the general goal and the DB row has milestone_id=null.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `spec-review` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Vale). The director authored this from Vale's coaching ledger; building it hardens the agent so the coaching never has to repeat.
