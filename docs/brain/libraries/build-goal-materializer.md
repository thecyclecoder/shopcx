# libraries/build-goal-materializer

Renders a COMPLETE goal row + its [[../tables/goal_milestones]] children + the joined child [[../tables/specs]] to a temp markdown file the [[../skills/fold-to-brain]] skill consumes when folding a goal. The goal analogue of [[build-spec-materializer]]. Authored by [[../specs/goal-fold-from-db-row]] Phase 1.

**File:** `src/lib/build-goal-materializer.ts`

## Why this exists

A goal lives in `public.goals` + `public.goal_milestones` ([[../tables/goals]] · [[../tables/goal_milestones]]), with child specs in `public.specs` (`milestone_id` FK). When a complete goal is folded, the fold-agent reads the goal's NARRATIVE — but there is NO `docs/brain/goals/{slug}.md` (the per-goal markdown was retired in [[../specs/goal-readers-from-db-retire-parsegoal]] — goals are fully DB-driven). So, exactly like `materializeSpec` does for a spec row, the box worker's `runGoalFoldJob` calls `materializeGoal` to render the goal ROW to `${wt}/.box/goal-${slug}.md` and hands the [[../skills/fold-to-brain]] skill that path. The fold-agent folds the durable knowledge into the PERMANENT brain pages — it NEVER writes `docs/brain/goals/{slug}.md`. The preserved `public.goals` row (flipped to `status='folded'`) IS the archive.

## Exports

- **`materializeGoal(workspaceId, slug, dir)`** → `Promise<string>` — reads the goal via [[goals-table]] `getGoal`, joins each milestone's child specs via [[specs-table]] `listSpecs` (grouped by `milestone_id`), renders the goal-narrative markdown, writes to `${dir}/goal-${slug}.md`, returns the absolute path. Creates `dir` if missing. Throws when no `goals` row exists for `(workspaceId, slug)`.
- **`renderGoalRow(row, milestones)`** → `string` — pure renderer over a `GoalRow` + its resolved `MaterializedMilestone[]`. Exported so tests + this page show the exact shape without disk I/O.
- **`MaterializedMilestone`** — `{ milestone: GoalMilestoneRow; specs: SpecRow[] }`, one milestone + its child specs.

## Rendered shape

- `# {title}` — H1, NO status emoji (status is DB-driven, mirroring `renderSpecRow`).
- `**Owner:** [[../functions/{owner}]] · **Proposed-by:** [[../functions/{proposer}]] · **Status:** {status}` — metadata line (only the parts that exist).
- `**Outcome:** …` and `**Success metric:** …` — the goal's first-class columns.
- The goal's free-form `body` verbatim (carries the **Target:** / **Why now:** / **Model:** lines + decomposition prose).
- `## Decomposition` → one `### {milestone.title}  _(status)_` per milestone (status DERIVED from the milestone's child specs via `deriveMilestoneStatus` — `goal_milestones.status` was dropped in `derive-rollup-status` P3), its body, then a `- [[../specs/{slug}]] — {title} _(status)_` bullet per child spec.

## Wiring

- `scripts/builder-worker.ts` `runGoalFoldJob` (kind=`goal-fold`) calls `materializeGoal(job.workspace_id, slug, "${wt}/.box")` before dispatching the [[../skills/fold-to-brain]] skill — AFTER the `status === 'complete'` guard. The temp `.box/` directory is gitignored, so `git add -A` skips it.
- The materialized file is regenerated on EVERY dispatch (fresh + resume) — the worktree is wiped at the top of every run.
- `goal-fold` shares the concurrency-1 fold lane (doc-only, touches brain index/cross-link files — must not race a feature build or a spec fold).

## Gotchas

- **NEVER writes `docs/brain/goals/`.** The file lands in `.box/goal-{slug}.md`. Per-goal markdown no longer exists for any goal — the row is the source of truth.
- **Guarded to complete goals.** `runGoalFoldJob` refuses to fold (fails the job) unless `goals.status === 'complete'`; `materializeGoal` itself only throws on a missing row, so the guard lives in the worker.
- **Single source of truth for content.** The fold-agent reads the materialized `.box` copy, not a markdown file under `docs/brain/goals/`.

## Related

[[goals-table]] · [[specs-table]] · [[../tables/goals]] · [[../tables/goal_milestones]] · [[../tables/specs]] · [[build-spec-materializer]] · [[../specs/goal-fold-from-db-row]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../skills/fold-to-brain]]
