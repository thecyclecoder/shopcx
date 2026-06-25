# libraries/goal-proposals

The **director-proposed goal** lifecycle ([[../specs/director-proposed-goals]] Phase 1) — a director can **AUTHOR + SURFACE** a goal, but it does **NOT** activate one. The CEO's greenlight stays the activation gate (north star: the CEO owns objectives; directors own progress within approved ones — [[../operational-rules]] § North star).

**File:** `src/lib/agents/goal-proposals.ts`

## Why this exists

Before this, only the CEO could create a goal artifact, and a director could emit a spec card but **not** a goal — so a director's goal ideas were pasted as plain text. This adds a **first-class director-PROPOSED goal**: a director authors a `docs/brain/goals/{slug}.md` for **its own function**, marked `**Status:** proposed`, which is **inert** (the [[platform-director]] escort skips it, Pia doesn't decompose it) until the CEO greenlights it — mirroring how a director proposes a spec and the CEO approves the build. Friction removed; the rail (CEO greenlight) preserved.

## The lifecycle

Post [[../specs/goal-greenlight-button-and-author-writes-db]] Phase 2 the DB row is the truth; the markdown mirror commit is transitional (retired in [[../specs/goal-readers-from-db-retire-parsegoal]]):

1. **Propose** — a director calls `proposeGoal(admin, workspaceId, input)` for its OWN function. It validates the **self-function scope rail** (`assertProposerOwnsFunction` — proposer must equal owner) + the slug, renders the artifact (`buildProposedGoalMarkdown` → `**Status:** proposed`, `**Proposed-by:**`, `**Owner:**`), **writes the `public.goals` row** via `upsertGoal` (status `proposed`, `proposer_function`, `owner`, `body=artifact`, optional `parent_goal_id` for a subgoal), seeds N `public.goal_milestones` rows from the body's `## Decomposition` bullets (zero when Pia owns decomposition), then inserts a `proposed-goal` [[../tables/agent_jobs]] row (`status='queued'`) carrying the artifact in `instructions`. The row write is **best-effort** — if the [[../specs/goals-milestones-tables-and-backfill]] migration hasn't applied yet, the upsert error is logged and the lifecycle continues (the worker's RESUME path falls back to the markdown flip). **No GitHub commit here** — the box worker owns the mirror commit (the db_health/coverage-register pattern).
2. **Mirror + surface** — `scripts/builder-worker.ts` `runProposedGoalJob` (FRESH) commits `docs/brain/goals/{slug}.md` via `putFileMain` (refusing to clobber an existing slug) — the transitional markdown mirror that keeps the [[brain-roadmap]] `parseGoal` / `getGoals` readers green until the [[../specs/goal-readers-from-db-retire-parsegoal]] cutover. Writes a `proposed_goal` [[../tables/director_activity]] row, then parks the job `needs_approval` with ONE `greenlight_goal` pending action.
3. **Route to the CEO** — [[approval-inbox]] `reconcileApprovalInbox` surfaces it as an Approval Request. **Goals NEVER route to a director:** `proposed-goal` is deliberately absent from `KIND_TO_FUNCTION`, so `resolveApprover` falls through to the **CEO** even when the proposing director is live+autonomous. A director never greenlights any goal — its own or another's.
4. **Decide** — the CEO Approves/Declines the inline `greenlight_goal` action (the unchanged `POST /api/roadmap/approve` → `queued_resume` path). `runProposedGoalJob` (RESUME) — Phase 3 path: on **greenlight** flips the row via `setGoalStatus(goalId, 'greenlit')` ([[../libraries/goals-table]]); on **decline** flips the row to `folded` (the active board filters folded). When no row exists yet (transitional), falls back to the markdown `setGoalStatusLine` flip / inert-artifact delete.

## Exports

- **`proposeGoal(admin, workspaceId, input)`** → `{ ok, jobId?, error? }` — the writer + enqueuer. Validates scope + slug + required fields, writes the `public.goals` row (best-effort) + the `goal_milestones` seeds, then inserts the `proposed-goal` job. `ProposeGoalInput` = `{ proposerFunction, ownerFunction, slug, title, outcome, successMetric?, target?, body?, parentGoalId? }` (`parentGoalId` carries the planner's SUBGOAL parent).
- **`assertProposerOwnsFunction(proposer, owner)`** → `string | null` — the self-function scope rail (error string when proposer ≠ owner or either is blank, else null). A director can never author a goal for another function.
- **`buildProposedGoalMarkdown(input)`** → `string` — render the board-parseable proposed-goal doc carrying `**Status:** proposed` + `**Proposed-by:**` + `**Owner:**` (both the proposer's function).
- **`extractDecompositionMilestones(artifact)`** → `GoalMilestoneInput[]` — pure slicer that pulls top-level `- ` bullets from the artifact's `## Decomposition` block into milestone seeds (position + title + body). Returns `[]` for the default placeholder body so Pia owns decomposition.
- **`setGoalStatusLine(raw, status)`** → `string` — flip the first `**Status:**` line to `status`; inserts one under the H1 for a legacy goal that lacks the line. Pure. **Transitional** — the live writer is now `setGoalStatus` on the row (Phase 1); this helper survives only for the worker's no-row fallback path.
- **`isValidGoalSlug(slug)`** → `boolean` — lowercase-kebab guard.
- Const **`GOAL_PROPOSAL_KIND`** (`"proposed-goal"`), **`GREENLIGHT_GOAL_ACTION_TYPE`** (`"greenlight_goal"`); types **`GoalProposalInstructions`**, **`ProposeGoalInput`**, **`GoalStatusLiteral`**.

The pure helpers are unit-tested (`npm run test:goal-proposals`).

## The box lane

`scripts/builder-worker.ts` `runProposedGoalJob` (dispatched on `kind === "proposed-goal"`; in `RERUNNABLE_KINDS`). FRESH = no `greenlight_goal` action yet → commit the markdown mirror + park `needs_approval`. RESUME = the action is `approved`/`declined` → row flip (Phase 3) with a markdown fallback (the no-row transitional path). Best-effort; a missing/clobbering/commit failure parks `needs_attention` rather than silently dropping.

## Safety invariants

- **Propose, don't self-activate.** A director only ever AUTHORS a `proposed` row; it is inert until the CEO greenlights it. The escort skips `proposed` goals; Pia doesn't decompose them.
- **Own function only.** `assertProposerOwnsFunction` gates every proposal — a director proposes solely for its own function.
- **CEO is always the gate.** `proposed-goal` is unmapped → routes to the CEO; no director (even live+autonomous) greenlights a goal.
- **Row write is best-effort.** A failure (missing table, RLS error) is logged + swallowed so the worker's markdown commit + RESUME-fallback keep the lifecycle live in the transitional window. Once [[../specs/goals-milestones-tables-and-backfill]] is applied in prod, every proposer call writes a real row.
- **Never clobber.** A fresh markdown mirror refuses to overwrite an existing goal of the same slug (parks `needs_attention`). The row write is an upsert keyed on `(workspace_id, slug)` — re-running on the same input is idempotent.
- **All GitHub commits in the worker.** `proposeGoal` never touches GitHub — the box worker holds the token + owns the transitional mirror commit.

## Related

[[../specs/director-proposed-goals]] · [[brain-roadmap]] (`GoalCard.status`/`deriveGoalStatus`) · [[platform-director]] (the escort) · [[approval-inbox]] (routing) · [[approval-router]] · [[../tables/director_activity]] (`proposed_goal`) · [[../tables/agent_jobs]] · [[../goals/devops-director]] · [[../operational-rules]] (§ North star)
