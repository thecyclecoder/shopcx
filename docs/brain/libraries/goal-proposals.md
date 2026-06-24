# libraries/goal-proposals

The **director-proposed goal** lifecycle ([[../specs/director-proposed-goals]] Phase 1) — a director can **AUTHOR + SURFACE** a goal, but it does **NOT** activate one. The CEO's greenlight stays the activation gate (north star: the CEO owns objectives; directors own progress within approved ones — [[../operational-rules]] § North star).

**File:** `src/lib/agents/goal-proposals.ts`

## Why this exists

Before this, only the CEO could create a goal artifact, and a director could emit a spec card but **not** a goal — so a director's goal ideas were pasted as plain text. This adds a **first-class director-PROPOSED goal**: a director authors a `docs/brain/goals/{slug}.md` for **its own function**, marked `**Status:** proposed`, which is **inert** (the [[platform-director]] escort skips it, Pia doesn't decompose it) until the CEO greenlights it — mirroring how a director proposes a spec and the CEO approves the build. Friction removed; the rail (CEO greenlight) preserved.

## The lifecycle

1. **Propose** — a director calls `proposeGoal(admin, workspaceId, input)` for its OWN function. It validates the **self-function scope rail** (`assertProposerOwnsFunction` — proposer must equal owner) + the slug, renders the artifact (`buildProposedGoalMarkdown` → `**Status:** proposed`, `**Proposed-by:**`, `**Owner:**`), and inserts a `proposed-goal` [[../tables/agent_jobs]] row (`status='queued'`) carrying the artifact in `instructions`. **No GitHub commit here** — the box worker owns all commits (the db_health/coverage-register pattern).
2. **Commit + surface** — `scripts/builder-worker.ts` `runProposedGoalJob` (FRESH) commits `docs/brain/goals/{slug}.md` via `putFileMain` (refusing to clobber an existing slug), writes a `proposed_goal` [[../tables/director_activity]] row, and parks the job `needs_approval` with ONE `greenlight_goal` pending action.
3. **Route to the CEO** — [[approval-inbox]] `reconcileApprovalInbox` surfaces it as an Approval Request. **Goals NEVER route to a director:** `proposed-goal` is deliberately absent from `KIND_TO_FUNCTION`, so `resolveApprover` falls through to the **CEO** even when the proposing director is live+autonomous. A director never greenlights any goal — its own or another's.
4. **Decide** — the CEO Approves/Declines the inline `greenlight_goal` action (the unchanged `POST /api/roadmap/approve` → `queued_resume` path). `runProposedGoalJob` (RESUME): on **greenlight** flips `**Status:** greenlit` on main (`setGoalStatusLine`); on **decline** deletes the inert artifact (git history is the immutable archive).

## Exports

- **`proposeGoal(admin, workspaceId, input)`** → `{ ok, jobId?, error? }` — the enqueuer. Validates scope + slug + required fields, then inserts the `proposed-goal` job. `ProposeGoalInput` = `{ proposerFunction, ownerFunction, slug, title, outcome, successMetric?, target?, body? }`.
- **`assertProposerOwnsFunction(proposer, owner)`** → `string | null` — the self-function scope rail (error string when proposer ≠ owner or either is blank, else null). A director can never author a goal for another function.
- **`buildProposedGoalMarkdown(input)`** → `string` — render the board-parseable proposed-goal doc carrying `**Status:** proposed` + `**Proposed-by:**` + `**Owner:**` (both the proposer's function).
- **`setGoalStatusLine(raw, status)`** → `string` — flip the first `**Status:**` line to `status` (proposed → greenlit on the CEO's greenlight); inserts one under the H1 for a legacy goal that lacks the line. Pure.
- **`isValidGoalSlug(slug)`** → `boolean` — lowercase-kebab guard.
- Const **`GOAL_PROPOSAL_KIND`** (`"proposed-goal"`), **`GREENLIGHT_GOAL_ACTION_TYPE`** (`"greenlight_goal"`); types **`GoalProposalInstructions`**, **`ProposeGoalInput`**, **`GoalStatusLiteral`**.

The pure helpers are unit-tested (`npm run test:goal-proposals`).

## The box lane

`scripts/builder-worker.ts` `runProposedGoalJob` (dispatched on `kind === "proposed-goal"`; in `RERUNNABLE_KINDS`). FRESH = no `greenlight_goal` action yet → commit the inert artifact + park `needs_approval`. RESUME = the action is `approved`/`declined` → greenlight-flip or archive-delete. Best-effort; a missing/clobbering/commit failure parks `needs_attention` rather than silently dropping.

## Safety invariants

- **Propose, don't self-activate.** A director only ever AUTHORS a `proposed` artifact; it is inert until the CEO greenlights it. The escort skips `proposed` goals; Pia doesn't decompose them.
- **Own function only.** `assertProposerOwnsFunction` gates every proposal — a director proposes solely for its own function.
- **CEO is always the gate.** `proposed-goal` is unmapped → routes to the CEO; no director (even live+autonomous) greenlights a goal.
- **Never clobber.** A fresh proposal refuses to overwrite an existing goal of the same slug (parks `needs_attention`).
- **All commits in the worker.** `proposeGoal` never touches GitHub — the box worker holds the token + owns commit/flip/delete.

## Related

[[../specs/director-proposed-goals]] · [[brain-roadmap]] (`GoalCard.status`/`deriveGoalStatus`) · [[platform-director]] (the escort) · [[approval-inbox]] (routing) · [[approval-router]] · [[../tables/director_activity]] (`proposed_goal`) · [[../tables/agent_jobs]] · [[../goals/devops-director]] · [[../operational-rules]] (§ North star)
