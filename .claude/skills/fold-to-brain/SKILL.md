---
name: fold-to-brain
description: Use when a shipped spec (all phases ✅) has been owner-verified and should be archived — fold its knowledge into the permanent brain pages (lifecycle/table/library/inngest/integration/recipe/dashboard), cross-link, append to the archive index, update README counts, and git rm the spec file. The shipped→verified transition. Triggered by a fold-build or "archive the {slug} spec."
---

# fold-to-brain

A shipped spec lives in `docs/brain/specs/` as a short "live but not yet prod-verified" to-do. Once the **owner** marks it verified, its durable knowledge moves into the permanent brain pages and the spec file is deleted — git history is the immutable archive. This is the `shipped → verified` fold ([[project-management]] § Folding a shipped spec).

## Preconditions (don't fold early)

- **Every phase is ✅** and the H1 title emoji is ✅ — not a single `⏳`/`🚧`.
- The **owner** has confirmed it works in production (the human-only verify gate). Folding is never automatic on ship; it fires on **Mark verified & archive** (a fold-build) or an explicit ask. If phases aren't all ✅ or you can't confirm verification, **stop** — don't fold.

## Procedure

1. **Re-read the spec** end to end. List every concept it introduced — new tables, Inngest fns, libraries, integrations, end-to-end flows, operational moves, dashboard surfaces, cross-cutting rules.
2. **Fold each into its permanent home** (create the page via [[write-brain-page]] if it's genuinely new; otherwise extend the existing page — most folds *extend*):
   - new table → `tables/{name}.md` · new Inngest fn → `inngest/{name}.md` · new lib → `libraries/{name}.md` · new API → `integrations/{name}.md`
   - end-to-end flow → `lifecycles/{name}.md`, with a **"Status / open work"** block reading `Shipped: …` (the house pattern — see [[project-management]])
   - common operational move → `recipes/{name}.md` · dashboard surface → `dashboard/{route}.md`
   - cross-cutting rule → `customer-voice.md` / `operational-rules.md` / `ui-conventions.md` / `orchestrator-tools.md`
3. **Cross-link.** Every touched/new page wikilinks 3–5 relatives and is wikilinked **from** at least one existing page — the brain stays navigable.
4. **Update the README** — `docs/brain/README.md` folder counts, and the Core/Tickets/AI/… category lists if a table landed in one.
5. **Append to the archive index** — one newest-first line to [[archive]]'s `## Index`: `- **{Title}** · verified {YYYY-MM-DD} · → [[lifecycles/{slug}]]`. This is the pointer the board's Archived section reads.
6. **Delete the spec** — `git rm docs/brain/specs/{slug}.md`. The knowledge lives in its permanent homes now; a lingering spec invites drift.
7. **One commit** — fold + cross-links + README + archive-index + delete together.

## Guardrails

- **Nothing is lost.** Knowledge → brain pages, a browsable pointer → [[archive]], the raw spec → always `git show`-recoverable. That triple is what lets the spec be deleted safely — never "keep it just in case."
- **Fold, don't dump.** Integrate the spec's facts into the page's existing flow in the house voice; don't paste the spec body in as a new section.
- **Don't fold an unverified or partial spec** (see Preconditions). A spec with open `⏳`/`🚧` phases stays in `specs/`.
- **To revisit an archived feature**, don't reactivate the deleted spec — author a *fresh* spec from the current brain page ("New spec from brain" re-hydration).
- Under the box worker, **the worker owns git** — make the edits + the `git rm` as file ops and emit your status JSON; the worker commits.

## Related
`docs/brain/project-management.md` (§ Folding a shipped spec into the brain) · `docs/brain/archive.md` · `docs/brain/README.md` · skills: `write-brain-page`, `build-spec` · `docs/brain/lifecycles/ai-learning.md` (example of a folded spec)
