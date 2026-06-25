# PM-DB agent toolkit — agents read/edit/write the project-management DB through tools, never raw SQL

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/db-driven-specs]] — M3 (authoring + building write/read the DB)
**Blocked-by:** [[spec-body-table-and-backfill]], [[goals-milestones-tables-and-backfill]]

As the project-management layer becomes data ([[../goals/db-driven-specs]]: `goals` → `goal_milestones` → `specs` → `spec_phases`, all relational tables with FKs), every agent that touches it — Bo (build), Ada (director disposition + escort), Pia (decomposition), Vale (spec-review), Fenn (fold), the CEO chat — needs to READ and WRITE that state. They must **NOT** issue raw SQL against prod PM tables: it's fragile (a focused human + agents both produced `uuid LIKE` errors, column mismatches, and a brittle parent-string matcher building this very migration), unsupervisable, and one bad `UPDATE` from corrupting the backlog. This spec gives them a **bounded, typed toolkit** — the supervisable interface the north star ([[../operational-rules]] § North star) requires.

## Phase 1 — the typed library (complete the read/edit/write surface)

Extend [[../libraries/specs-table]] (`src/lib/specs-table.ts` — `upsertSpec`/`movePhase`/`getSpec`/`listSpecs`) and [[../libraries/goals-table]] (`src/lib/goals-table.ts`) into the full surface, each enforcing the invariants (status rolls up from children, PR/SHA provenance, parent-cycle guards, owner-scoping):
- **Read:** `getSpec(slug)`, `listSpecs(filter)`, `getGoal(slug)`, `listGoals`, `getMilestone(id)`, `listMilestones(goalId)`, `getPhase`, `specsForMilestone(milestoneId)`.
- **Edit/write:** `setSpecStatus`, `movePhase(phaseId, newSpecId, position)`, `linkSpecToMilestone(specId, milestoneId)`, `setMilestoneStatus` (or rely on the rollup trigger), `greenlightGoal(slug)`, `reparentGoal(goalId, parentGoalId)`, `createSpec`/`createGoal`/`createMilestone`.
- A **spec is operational state** — every writer appends an audit row (who/why), mirrors the existing `spec_status_history` discipline.

## Phase 2 — expose it as AGENT TOOLS

Wire the library as named tools the box agents call (the orchestrator-data-tools pattern — [[../orchestrator-tools]]), so Bo/Ada/Pia/Vale/Fenn invoke `getSpec` / `setSpecStatus` / `linkSpecToMilestone` instead of SQL. The agents' prompts gain a hard rule: **PM state is read/written ONLY through these tools; raw SQL against `specs`/`goals`/`goal_milestones`/`spec_phases` is forbidden.** Read-only tools for everyone; write tools owner-scoped (an agent can only flip a card it owns, mirroring the director `spec-status` action).

## Phase 3 — fix the milestone backfill + relink (the bug that motivated this)

The `goals-milestones` backfill mis-parsed several goals' milestones — it read the **`## Decomposition`** section's spec-wikilinks as milestone titles instead of the **`## Milestone seeds`** section, so `db-driven-specs`' milestones are titled `../specs/spec-readers-from-db-retire-parser` instead of `M5 — …`, and the cascade specs can't link (`specs.milestone_id` stays null for them). Fix the parse (read the milestone seeds, M{N} / M-{NAME} prefixes), re-backfill the affected goals' milestones through the toolkit's validated `createMilestone`/`linkSpecToMilestone` (NOT ad-hoc SQL), and re-run the spec→milestone linking so every milestone-parented spec is attached. This is the concrete proof the toolkit prevents: the bug exists *because* the backfill was a hand-written SQL script with no validated writer.

## Safety / invariants
- No agent issues raw SQL against the PM tables — only the toolkit. The toolkit is the single chokepoint where the invariants (rollup, provenance, cycle-guard, owner-scope) are enforced.
- Write tools are owner-scoped + audited; read tools are open.
- The toolkit reads the relational tables (`specs`/`spec_phases`/`goals`/`goal_milestones`), aligning agents with the db-driven source ahead of the M2 reader-cutover.

## Completion criteria
- `src/lib/specs-table.ts` + `src/lib/goals-table.ts` expose the full read/edit/write surface above, each with invariant enforcement + an audit trail.
- The box agents (Bo/Ada/Pia/Vale/Fenn) call the toolkit tools; their prompts forbid raw PM SQL; a grep shows no agent path issuing SQL against `specs`/`goals`/`goal_milestones`/`spec_phases`.
- The milestone backfill is fixed: `db-driven-specs` (+ the other mis-parsed goals) have correctly-titled milestones, and `specs.milestone_id` is populated for every milestone-parented spec; `goals-milestones-tables-and-backfill`'s spec-test passes its `milestone_id` check.
