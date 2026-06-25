# Recipe: backfill goals from markdown (`backfill-goals-from-markdown`)

One-time backfill that populates the DB-resident goal hierarchy — [[../tables/goals]] + [[../tables/goal_milestones]] — from `docs/brain/goals/*.md`, then attaches every existing [[../tables/specs]] row to its milestone via the `milestone_id` FK. The foundation of [[../specs/goals-milestones-tables-and-backfill]] Phase 3 (db-driven-specs M5): run the existing [[../libraries/brain-roadmap]] `parseGoal` ONE LAST TIME and upsert via [[../libraries/goals-table]] `upsertGoal`.

**Tool:** `scripts/backfill-goals-from-markdown.ts`. Dry-run by default; `--apply` writes. Idempotent + resumable (UPSERT by `(workspace_id, slug)`; milestone REPLACE by `(goal_id, position)` preserving stable ids — so a [[../tables/specs]] `milestone_id` FK is never silently unattached on a retitle).

## Commands

```bash
# Dry run — prints what WOULD insert per goal, per workspace
npx tsx scripts/backfill-goals-from-markdown.ts

# Apply — writes rows; after the loop, flags any goal whose status mismatches the markdown
npx tsx scripts/backfill-goals-from-markdown.ts --apply
```

## What it does, per workspace × goal (3 passes)

### Pass 1 — UPSERT goals + milestones

1. Read every `docs/brain/goals/{slug}.md` from disk (skipping `README.md`).
2. Read every `docs/brain/specs/*.md` ONCE — feeds [[../libraries/brain-roadmap]] `parseGoal` (for the rollup percentage) and is reused for the milestone_id attachment pass.
3. Run `parseGoal(slug, raw, specs)` for title / outcome / successMetric / owner / proposedBy / status / milestones (`{ id: "M0"…, name, status, specSlugs }`).
4. UPSERT via [[../libraries/goals-table]] `upsertGoal` — milestone titles come out as `M{N} — <name>` (mirroring the markdown `### M{N} — …` shape). The DB trigger `goal_milestones_rollup` rolls `goals.status` after each milestone write (terminal-ish `proposed` / `folded` are left alone — see [[../tables/goals]] § Rolled-up status). `parent_goal_id` is left null in this pass — it's resolved in pass 2.

### Pass 2 — resolve `parent_goal_id`

The goal markdown's parent link sits in different shapes across docs:

- A "Reports to [[<slug>]]" phrase in the Target paragraph or Ownership line.
- A "Parent: …[[<slug>]]" phrase in the Ownership line.

The recipe scans both shapes; first hit wins. The matched `<slug>` is looked up against the goal ids upserted in pass 1 and written back via a single `UPDATE goals SET parent_goal_id=…`. The `goals_parent_cycle` BEFORE trigger walks the chain on the write and rejects a self-ancestor.

A goal that doesn't reference a parent stays top-level (parent_goal_id=null).

### Pass 3 — attach specs.milestone_id

For every spec `.md` in `docs/brain/specs/`:

1. Parse the `**Parent:**` header line.
2. Extract the goal slug from the wikilink (`[[../goals/<slug>]]`) and the milestone key — prefer the `M{N}` prefix, otherwise the milestone title text after a separator.
3. Match the milestone key against the parsed goal's milestones:
   - `M{N}` ⇒ exact id match.
   - title ⇒ case-insensitive prefix-or-prefixed-by match, **only if unambiguous** (single match).
4. Look up the milestone's id via `(goal_id, position)`.
5. UPDATE `public.specs.milestone_id` (which fires `specs_milestone_rollup`, recomputing `goal_milestones.status` for the new milestone).

A spec whose `**Parent:**` points at a function mandate (e.g. `[[../functions/platform]] — operational mandate`), a sibling spec, or doesn't resolve to a known milestone keeps `milestone_id=null` — that's the intended standalone shape ([[../specs/goals-milestones-tables-and-backfill]] § Safety / invariants).

## Verification (post-apply)

The script re-reads every persisted `goals.status` and compares to the markdown parse:

- Exact match → silent.
- `expected=greenlit, got=complete` → tolerated (the rollup may legitimately advance once every milestone lands).
- Any other divergence → flagged for human review; **does NOT silently overwrite**.

Print includes `goals upserted=N, milestones placed=M, specs attached=K`.

## Idempotency

- `goals` UPSERT by `(workspace_id, slug)` — re-run leaves the row in place, only bumps `updated_at`.
- `goal_milestones` REPLACE by `(goal_id, position)` — matching positions UPDATE in place (preserving stable `id`). New positions INSERT; vanished positions DELETE. Stable across re-runs — [[../tables/specs]] `milestone_id` FKs survive a retitle (the FK is `on delete set null`; a destroy+recreate would null every child link).
- A re-run after `--apply` is a no-op for the row content.

## Out of scope (this recipe)

- **Deleting `docs/brain/goals/*.md`.** The markdown stays in the repo until [[../specs/goal-readers-from-db-retire-parsegoal]] retires the parser — rollback path if any row is wrong. No `git rm` here.
- **Rewiring readers.** `getGoals` / `getGoal` ([[../libraries/brain-roadmap|L1004]]) still read markdown.
- **The CEO greenlight UI** ([[../specs/goal-greenlight-button-and-author-writes-db]]) and **fold** ([[../specs/goal-fold-from-db-row]]) own their own surfaces.

## Gotchas

- **The proposed-goal rail.** A `proposed` goal NEVER auto-flips to `complete` — the rollup is terminal-ish on `proposed`. Re-runs of the backfill carry the markdown's `Status: proposed`; only an explicit CEO greenlight (via [[../libraries/goals-table]] `setGoalStatus`) moves it to `greenlit`. Mismatch verification tolerates the rollup's legitimate `greenlit → complete` advance but flags `proposed → anything`.
- **Spec-Parent matching is conservative.** Ambiguous matches (a milestone-title prefix that matches two milestones) skip the attachment rather than guess. The spec keeps `milestone_id=null` — re-run after fixing the milestone title to disambiguate.
- **Parent-cycle protection rejects bad assignments.** The pass-2 UPDATE may fail if the markdown encodes a cycle (e.g. A→B→A); the script logs the rejection and continues. Fix the markdown and re-run.
- **Workspace-scoped.** Every workspace in `public.workspaces` gets the full goal set written. Per-workspace lookups for milestones (pass 3) avoid bleed.

## Related

[[../specs/goals-milestones-tables-and-backfill]] · [[../tables/goals]] · [[../tables/goal_milestones]] · [[../tables/specs]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[backfill-specs-from-markdown]] · [[write-a-migration-apply-script]]
