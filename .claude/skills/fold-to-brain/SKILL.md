---
name: fold-to-brain
description: Use when a shipped spec whose MACHINE spec-test has passed OR a complete goal (all milestones rolled up) should be archived — fold its knowledge into the permanent brain pages (lifecycle/table/library/inngest/integration/recipe/dashboard/functions), cross-link, append to the archive index, and flip the DB row to status='folded'. The shipped→folded (spec, on machine spec-test pass — human QA is advisory) / complete→folded (goal) transition. Triggered by a fold-build or "archive the {slug} spec/goal."
---

# fold-to-brain

A shipped spec lives in `public.specs` + `public.spec_phases` (the DB row, post-[[spec-body-table-and-backfill]] / [[spec-readers-from-db-retire-parser]] / [[spec-fold-from-db-row]]). Once its **machine spec-test passes** (agent-verdict `approved`, no open regression — fold-on-spec-test-pass, task #29), its durable knowledge moves into the permanent brain pages and the row is flipped to `status='folded'` (preserved, not deleted — the board's archive view reads it). Any legacy `docs/brain/specs/{slug}.md` carried over from the backfill is `git rm`'d in the same PR; newly-authored specs have no `.md` and skip that step. Git history + the preserved row are the immutable archive. This is the `shipped → folded` fold ([[project-management]] § Folding a shipped spec).

## Preconditions (don't fold early)

- **`public.specs.status === 'shipped'`** — the DB-trigger rollup ([[spec-body-table-and-backfill]]) guarantees this is equivalent to every `spec_phases` row being `shipped`. The worker enforces this guard before dispatching the fold ([[spec-fold-from-db-row]] Phase 1); if you see a non-shipped row, **stop** — don't fold.
- The **machine spec-test has PASSED** (the latest [[spec_test_runs]] is agent-verdict `approved` with no open auto-`fail` regression — the fold trigger). Folding is never automatic on ship; it fires on the machine spec-test pass (Gate B `autoFoldVerifiedSpecs`), the owner's optional **Fold to brain now** override, or an explicit ask. **Human QA is advisory — never required to fold.** A spec whose latest run is `issues`/`needs_human`/`error` (or carries an open regression) is NOT ready: **stop** — don't fold.

## Procedure

1. **Re-read the spec body.** The box worker materializes each shipped row to `{worktree}/.box/spec-{slug}.md` (gitignored; regenerated every dispatch) in the same shape `build-spec` reads. Read that file, NOT `docs/brain/specs/{slug}.md` (it may not exist). List every concept it introduced — new tables, Inngest fns, libraries, integrations, end-to-end flows, operational moves, dashboard surfaces, cross-cutting rules.
2. **Fold each into its permanent home** (create the page via [[write-brain-page]] if it's genuinely new; otherwise extend the existing page — most folds *extend*):
   - new table → `tables/{name}.md` · new Inngest fn → `inngest/{name}.md` · new lib → `libraries/{name}.md` · new API → `integrations/{name}.md`
   - end-to-end flow → `lifecycles/{name}.md`, with a **"Status / open work"** block reading `Shipped: …` (the house pattern — see [[project-management]])
   - common operational move → `recipes/{name}.md` · dashboard surface → `dashboard/{route}.md`
   - cross-cutting rule → `customer-voice.md` / `operational-rules.md` / `ui-conventions.md` / `orchestrator-tools.md`
3. **Cross-link.** Every touched/new page wikilinks 3–5 relatives and is wikilinked **from** at least one existing page — the brain stays navigable.
4. **Update the README** — `docs/brain/README.md` folder counts, and the Core/Tickets/AI/… category lists if a table landed in one.
5. **Append to the archive index** — one newest-first line to [[archive]]'s `## Index`: `- **{Title}** · verified {YYYY-MM-DD} · → [[lifecycles/{slug}]]`. This is the pointer the board's Archived section reads.
6. **Delete the legacy spec markdown if it exists** — `git rm docs/brain/specs/{slug}.md`. Post-[[spec-readers-from-db-retire-parser]] newly-authored specs have NO `.md` on disk (the body lives only in `public.specs`); for those, skip this step — the worker flips `specs.status='folded'` after the PR opens and the row is the archive.
7. **One commit** — fold + cross-links + README + archive-index + (legacy) delete together.

## Guardrails

- **Nothing is lost.** Knowledge → brain pages, a browsable pointer → [[archive]], the raw spec → the preserved `public.specs` row + `spec_phases` children (the worker flips status to `folded`, never deletes), and any legacy `.md` is always `git show`-recoverable. That set is what lets the spec be retired safely — never "keep it just in case."
- **Fold, don't dump.** Integrate the spec's facts into the page's existing flow in the house voice; don't paste the spec body in as a new section.
- **Don't fold an unverified or partial spec** (see Preconditions). A `public.specs` row whose `status !== 'shipped'` stays untouched.
- **To revisit an archived feature**, don't unfold the row — author a *fresh* spec from the current brain page ("New spec from brain" re-hydration).
- Under the box worker, **the worker owns git** — make the edits + the `git rm` (when a legacy `.md` exists) as file ops and emit your status JSON; the worker commits and flips `specs.status='folded'` after the PR opens.

## Folding a GOAL (goal-fold-from-db-row)

A **goal** also folds — the same `complete → folded` archive move, dispatched on the row's table. A goal lives in `public.goals` + `public.goal_milestones` ([[../tables/goals]] · [[../tables/goal_milestones]]), with child specs in `public.specs` (`milestone_id` FK). Unlike specs, goals are **not batched** — one goal per fold job (a goal is a large multi-spec narrative). The box worker's `runGoalFoldJob` (kind=`goal-fold`, shares the concurrency-1 fold lane) drives it.

- **Precondition / GUARD:** `public.goals.status === 'complete'`. The DB rollup ([[../tables/goals]]) makes `complete` ≡ every milestone complete ≡ every child spec `shipped|folded` — so the guard is the same guarantee written twice. A `proposed`/`greenlit` goal can NEVER fold (the worker fails the job with a clear reason). The worker enforces this before dispatch; if the goal isn't `complete`, **stop**.
- **No per-goal markdown — read the materialized copy.** There is NO `docs/brain/goals/{slug}.md` (the per-goal markdown was retired in [[../specs/goal-readers-from-db-retire-parsegoal]]). The worker materializes the goal ROW (+ milestones + joined child specs) to a gitignored `{worktree}/.box/goal-{slug}.md` ([[build-goal-materializer]]) — read THAT.
- **⚠️ NEVER create or write `docs/brain/goals/*.md`.** A folded goal writes its durable knowledge ONLY into the surviving PERMANENT pages — extend the relevant `lifecycles/` (end-to-end flow, "Status / open work" block), `dashboard/` (the surface the goal shipped), `functions/` (the owning function's mandate progress), `tables/` / `libraries/` (new shapes). The preserved `public.goals` row (flipped to `status='folded'`) IS the archive — the board renders it from the row.
- **Archive entry:** create `docs/brain/archive.d/goal-{slug}.md` with ONE line — `- **{Goal title}** · folded {YYYY-MM-DD} · → [[lifecycles/{primary home}]]`. Never hand-edit `archive.md`/`README.md` (generated; aggregates refreshed out-of-band).
- **Worker owns the flip.** Make the brain edits + the archive.d entry as file ops and emit your status JSON; the worker commits, opens the PR, then flips `public.goals.status='folded'` via the [[../libraries/goals-table]] SDK (`setGoalStatus`) — every other column (title, body, outcome, success_metric, owner, parent_goal_id, milestones via FK) is PRESERVED so the board's archive view + audit history render the folded goal unchanged.

## Related
`docs/brain/project-management.md` (§ Folding a shipped spec into the brain) · `docs/brain/archive.md` · `docs/brain/README.md` · skills: `write-brain-page`, `build-spec` · libraries: [[../libraries/build-goal-materializer]] · [[../libraries/goals-table]] · `docs/brain/lifecycles/ai-learning.md` (example of a folded spec)
