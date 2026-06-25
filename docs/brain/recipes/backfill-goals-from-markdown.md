# Backfill goals from markdown

One-time backfill of `docs/brain/goals/*.md` into [[../tables/goals]] + [[../tables/goal_milestones]] — the Phase 3 of [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Script:** `scripts/backfill-goals-from-markdown.ts`

## What it does

For every workspace, in three passes:

1. **Upsert goals + milestones.** Parses each `goals/{slug}.md` via [[../libraries/brain-roadmap]] `parseGoal` (the EXISTING parser, used ONE LAST TIME — readers stay markdown-first until [[../specs/goal-readers-from-db-retire-parsegoal]] cuts over). UPSERTs the [[../tables/goals]] row by `(workspace_id, slug)` and REPLACEs the milestone list under it preserving `id` by `(goal_id, position)` (the same lift-a-thing rule [[../tables/spec_phases]] uses — a retitle keeps the milestone's id so any [[../tables/specs]]`.milestone_id` FK pointing at it survives). **Never overwrites `status` on a re-run** — a CEO greenlight written by [[../specs/goal-greenlight-button-and-author-writes-db]] survives a backfill replay.
2. **Resolve `parent_goal_id`.** Walks each goal's markdown for a `Reports to [[slug]]` wikilink and sets [[../tables/goals]]`.parent_goal_id` to the parent's uuid (a SubGoal is just a goal with a parent — CEO-locked design contract). The `goals_no_cycle` trigger guards against a cycle attempt.
3. **Attach specs to milestones.** Walks every [[../tables/specs]] row in the workspace and matches its `parent` text against the parsed milestones. An unambiguous match (the goal slug appears in the parent text AND the milestone title or `M{N}` prefix matches) sets [[../tables/specs]]`.milestone_id`. A spec with no unambiguous match keeps `milestone_id=null` — the explicit standalone-spec shape (function-mandate / regression / ad-hoc fix).

After `--apply` it prints a status-parity verification — flags any goal where the markdown-parsed status is strictly newer than the DB status (the `proposed → greenlit → complete → folded` rank). `greenlit` and `complete` rows that out-rank the markdown are NOT flagged: a CEO greenlight or a rolled-up completion is expected to lead the file.

## Per-goal output

Each goal prints one summary line:

```
backfilled {slug}: {N} milestones, status={X}, {M} specs attached
```

Plus the parent + proposer when present. Dry-run prints what WOULD insert; `--apply` writes.

## How to run

```sh
# dry run — prints what would change, writes nothing
npx tsx scripts/backfill-goals-from-markdown.ts

# apply — UPSERTs goals + milestones, resolves parent_goal_id, attaches specs
npx tsx scripts/backfill-goals-from-markdown.ts --apply
```

## Idempotent + resumable

Re-running on stable markdown is a no-op:
- `goals` UPSERT by `(workspace_id, slug)` updates only when title / body / outcome / owner change.
- `goal_milestones` REPLACE preserves `id` by position; a renumber or retitle keeps the row.
- `goals.status` is never written by the backfill on a row that already exists (so a CEO greenlight isn't clobbered).
- `specs.milestone_id` is set ONLY when currently null AND the match is unambiguous — a manually-attached spec is not re-attached to a different milestone.

A partial run is safe to restart: pass 2 only sets `parent_goal_id` for rows present in pass 1's slug → uuid map; pass 3 only attaches specs where `milestone_id` is currently null.

## What it does NOT do

- **Does not delete `docs/brain/goals/*.md`** — the markdown stays authoritative until [[../specs/goal-readers-from-db-retire-parsegoal]] retires `parseGoal`. Leaves a rollback path.
- **Does not rewire readers** — [[../libraries/brain-roadmap]] `getGoals` / `getGoal` still read markdown. That cutover is its own spec.
- **Does not author the CEO greenlight UI** — see [[../specs/goal-greenlight-button-and-author-writes-db]].
- **Does not fold** — see [[../specs/goal-fold-from-db-row]].

## Related

[[../specs/goals-milestones-tables-and-backfill]] · [[../tables/goals]] · [[../tables/goal_milestones]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[backfill-specs-from-markdown|backfill-specs-from-markdown (the spec-side equivalent)]] · [[../goals/db-driven-specs]]
