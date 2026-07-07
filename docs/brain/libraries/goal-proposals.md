# libraries/goal-proposals

The **director-proposed goal** lifecycle ([[../specs/director-proposed-goals]] Phase 1) — a director can **AUTHOR + SURFACE** a goal, but it does **NOT** activate one. The CEO's greenlight stays the activation gate (north star: the CEO owns objectives; directors own progress within approved ones — [[../operational-rules]] § North star).

**File:** `src/lib/agents/goal-proposals.ts`

## Why this exists

Before this, only the CEO could create a goal, and a director could emit a spec card but **not** a goal — so a director's goal ideas were pasted as plain text. This adds a **first-class director-PROPOSED goal**: a director writes a `public.goals` row (`status='proposed'`) for **its own function**, which is **inert** (the [[platform-director]] escort skips it, Pia doesn't decompose it) until the CEO greenlights it — mirroring how a director proposes a spec and the CEO approves the build. Friction removed; the rail (CEO greenlight) preserved.

## The lifecycle

Fully DB-driven (the per-goal markdown was retired in [[../specs/goal-readers-from-db-retire-parsegoal]]): the `public.goals` row IS the goal at every step; nothing commits `docs/brain/goals/{slug}.md`.

1. **Propose** — a director calls `proposeGoal(admin, workspaceId, input)` for its OWN function. It validates the **self-function scope rail** (`assertProposerOwnsFunction` — proposer must equal owner) + the slug, renders the narrative (`buildProposedGoalMarkdown` → `**Status:** proposed`, `**Proposed-by:**`, `**Owner:**`, stored as the goal `body`), **writes the `public.goals` row** via `upsertGoal` (status `proposed`, `proposer_function`, `owner`, `body`, optional `parent_goal_id` for a subgoal), seeds N `public.goal_milestones` rows from the body's `## Decomposition` bullets (zero when Pia owns decomposition), then inserts a `proposed-goal` [[../tables/agent_jobs]] row (`status='queued'`). The row write is **AUTHORITATIVE** — a failure ABORTS the proposal (`{ok:false}`); we never enqueue a greenlight job for a goal with no row to flip. A clobber guard refuses to reset an already-greenlit/complete slug to `proposed`. **No GitHub commit** anywhere on this path.
2. **Surface** — `scripts/builder-worker.ts` `runProposedGoalJob` (FRESH) writes a `proposed_goal` [[../tables/director_activity]] row, then parks the job `needs_approval` with ONE `greenlight_goal` pending action. No markdown commit (the goal row was already written by `proposeGoal`).
3. **Route to the CEO** — [[approval-inbox]] `reconcileApprovalInbox` surfaces it as an Approval Request. **Goals NEVER route to a director:** `proposed-goal` is deliberately absent from `KIND_TO_FUNCTION`, so `resolveApprover` falls through to the **CEO** even when the proposing director is live+autonomous. A director never greenlights any goal — its own or another's.
4. **Decide** — the CEO Approves/Declines the inline `greenlight_goal` action (the unchanged `POST /api/roadmap/approve` → `queued_resume` path). `runProposedGoalJob` (RESUME): on **greenlight** flips the row via `setGoalStatus(goalId, 'greenlit')` ([[../libraries/goals-table]]); on **decline** flips the row to `folded` (the active board filters folded). A missing row is an anomaly → `needs_attention` (no markdown fallback — readers are DB-only).

## Exports

- **`proposeGoal(admin, workspaceId, input)`** → `{ ok, jobId?, error? }` — the writer + enqueuer. Validates scope + slug + required fields, writes the `public.goals` row + the `goal_milestones` seeds (AUTHORITATIVE — aborts with `{ok:false}` on failure), then inserts the `proposed-goal` job. `ProposeGoalInput` = `{ proposerFunction, ownerFunction, slug, title, outcome, successMetric?, target?, body?, parentGoalId? }` (`parentGoalId` carries the planner's SUBGOAL parent).
- **`assertProposerOwnsFunction(proposer, owner)`** → `string | null` — the self-function scope rail (error string when proposer ≠ owner or either is blank, else null). A director can never author a goal for another function.
- **`buildProposedGoalMarkdown(input)`** → `string` — render the goal narrative (`**Status:** proposed` + `**Proposed-by:**` + `**Owner:**`, both the proposer's function) stored as the `goals.body` column. Not committed anywhere — it's the DB row's body.
- **`extractDecompositionMilestones(artifact)`** → `GoalMilestoneInput[]` — pure slicer that pulls top-level `- ` bullets from the body's `## Decomposition` block into milestone seeds (position + title + body). Returns `[]` for the default placeholder body so Pia owns decomposition.
- **`isValidGoalSlug(slug)`** → `boolean` — lowercase-kebab guard.

### Phase 1 blocked_by normalization ([[../specs/pia-decomposition-emits-plain-slug-blocked-by]] Phase 1)

The build-gating in [[agent-jobs]] (`areSpecsGoalMates` + `sequencePromoteCandidates` Kahn sort) looks each `blocked_by` entry up in [[../tables/specs]] by **exact slug match** and does **NOT split on `:`**. A namespaced entry like `goalSlug:specSlug` resolves to no spec — the gate silently treats it as an external blocker and lets the dependent build out of order (observed 2026-07-07: Sol-goal shipped `sol-cheap-execution-over-ticket-direction` before its declared blocker `sol-ticket-direction-artifact`). Phase 1 normalizes Pia's decomposition write-path (`parsePlannerSpecs` in `scripts/builder-worker.ts`) to emit plain member slugs; Phase 2 ([[goal-member-blocked-by]]) validates/repairs existing drift.

- **`normalizePlannerBlockedBySlug(raw)`** → `string | null` — normalize ONE `blocked_by` entry to a plain kebab slug or `null` when junk/unresolvable. Accepts plain slugs, namespaced entries (last colon-segment), wikilinks (`[[slug]]`), wikilink paths (`[[../specs/foo]]`), and anchors (`[[foo#phase-2]]`). Rejects anything that doesn't normalize to a lowercase-kebab slug (via `isValidGoalSlug`). Used at the Pia decomposition write-path.
- **`normalizePlannerBlockedByList(raw, selfSlug)`** → `string[]` — normalize a whole `blocked_by` LIST via the above per-entry. Filters non-strings, drops the spec's own slug (self-block), and dedupes while preserving first-seen order. Non-array input yields `[]` (Pia sometimes omits the field entirely — treat as "no prerequisites").

- Const **`GOAL_PROPOSAL_KIND`** (`"proposed-goal"`), **`GREENLIGHT_GOAL_ACTION_TYPE`** (`"greenlight_goal"`); types **`GoalProposalInstructions`**, **`ProposeGoalInput`**.

The pure helpers are unit-tested (`npm run test:goal-proposals`).

## The box lane

`scripts/builder-worker.ts` `runProposedGoalJob` (dispatched on `kind === "proposed-goal"`; in `RERUNNABLE_KINDS`). FRESH = no `greenlight_goal` action yet → record `director_activity` + park `needs_approval` (the goal row was already written by `proposeGoal`). RESUME = the action is `approved`/`declined` → `setGoalStatus` row flip (`greenlit` / `folded`). No GitHub markdown at any step; a missing row parks `needs_attention` rather than silently dropping.

## Safety invariants

- **Propose, don't self-activate.** A director only ever AUTHORS a `proposed` row; it is inert until the CEO greenlights it. The escort skips `proposed` goals; Pia doesn't decompose them.
- **Own function only.** `assertProposerOwnsFunction` gates every proposal — a director proposes solely for its own function.
- **CEO is always the gate.** `proposed-goal` is unmapped → routes to the CEO; no director (even live+autonomous) greenlights a goal.
- **Row write is AUTHORITATIVE.** A failure aborts the proposal (`{ok:false}`) — the row IS the goal; a greenlight job is never enqueued for a goal with no row to flip.
- **Never clobber.** `proposeGoal` refuses to reset an already-greenlit/complete slug to `proposed` (returns an error). The row write is an upsert keyed on `(workspace_id, slug)` — re-running on the same input is idempotent.
- **No GitHub commits.** Neither `proposeGoal` nor `runProposedGoalJob` touches GitHub — the goal lives in `public.goals` (the per-goal markdown was retired).

## Related

[[../specs/director-proposed-goals]] · [[brain-roadmap]] (`GoalCard.status`/`deriveGoalStatus`) · [[platform-director]] (the escort) · [[approval-inbox]] (routing) · [[approval-router]] · [[../tables/director_activity]] (`proposed_goal`) · [[../tables/agent_jobs]] · [[../goals/devops-director]] · [[../operational-rules]] (§ North star)
