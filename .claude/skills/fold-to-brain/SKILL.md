---
name: fold-to-brain
description: Use when a shipped spec (all phases ✅) has been owner-verified and should be archived — fold its knowledge into the permanent brain pages (lifecycle/table/library/inngest/integration/recipe/dashboard), cross-link, append to the archive index, update README counts, and git rm the spec file. The shipped→verified transition. Triggered by a fold-build or "archive the {slug} spec."
---

# fold-to-brain

A shipped spec lives in `public.specs` + `public.spec_phases` (the DB row, post-[[spec-body-table-and-backfill]] / [[spec-readers-from-db-retire-parser]] / [[spec-fold-from-db-row]]). Once the **owner** marks it verified, its durable knowledge moves into the permanent brain pages and the row is flipped to `status='folded'` (preserved, not deleted — the board's archive view reads it). Any legacy `docs/brain/specs/{slug}.md` carried over from the backfill is `git rm`'d in the same PR; newly-authored specs have no `.md` and skip that step. Git history + the preserved row are the immutable archive. This is the `shipped → verified` fold ([[project-management]] § Folding a shipped spec).

## Preconditions (don't fold early)

- **`public.specs.status === 'shipped'`** — the DB-trigger rollup ([[spec-body-table-and-backfill]]) guarantees this is equivalent to every `spec_phases` row being `shipped`. The worker enforces this guard before dispatching the fold ([[spec-fold-from-db-row]] Phase 1); if you see a non-shipped row, **stop** — don't fold.
- The **owner** has confirmed it works in production (the human-only verify gate). Folding is never automatic on ship; it fires on **Mark verified & archive** (a fold-build) or an explicit ask. If you can't confirm verification, **stop** — don't fold.

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

## Related
`docs/brain/project-management.md` (§ Folding a shipped spec into the brain) · `docs/brain/archive.md` · `docs/brain/README.md` · skills: `write-brain-page`, `build-spec` · `docs/brain/lifecycles/ai-learning.md` (example of a folded spec)
