# Spec lifecycle + archival — verify → fold → archive → re-hydrate ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

Refine the spec lifecycle so shipped specs don't pile up in "Shipped" forever, and add a **Verified** gate distinct from Shipped. Today ✅ = built + deployed (the build pipeline stamps it); there's no signal for *"I tested it in production and it works."* This spec adds that gate + a clean archival flow, with **git as the immutable archive** and **re-hydration from the brain** so nothing is ever lost.

**Business outcome:** the board stays honest — "Shipped" becomes a short, real to-do list ("live but not yet prod-verified"), and verified features retire into their permanent brain home (lifecycle/table/dashboard pages) instead of cluttering the board.

## The model
- **Shipped (✅)** = built + deployed (automated). **Verified** = owner-confirmed in production (human gate, after shipping).
- On **Verify**: the spec's durable knowledge folds into brain pages (it should already be there from ship time), a one-line entry is added to a brain **archive index**, and the spec file is `git rm`'d. Git history is the immutable archive — a deleted spec is always `git show`-recoverable.
- **Re-hydrate**: revisiting a feature generates a *fresh* spec from the *current* brain (the lifecycle page, or a git-recovered spec as seed) — better than reactivating a stale snapshot. This is the authoring chat in reverse.

## Phase 1 — Verified gate + archive index ⏳
- ⏳ Brain **archive index** page `docs/brain/archive.md` (or a section) — one line per verified feature: `title · shipped/verified date · → lifecycle link`. This is the browsable "visual archive."
- ⏳ Board: relabel the Shipped column **"Shipped — awaiting verification"**; a shipped card gets a **"Mark verified & archive"** action (owner).

## Phase 2 — Verify → fold-build ⏳
- ⏳ "Mark verified & archive" queues a **fold-build** (reuses the build pipeline + the `fold-to-brain` skill, [[repo-skills-catalog]]): the agent confirms the spec is folded into the right brain pages, appends the archive-index entry, `git rm`s the spec, opens a PR. Owner merges → the spec leaves the board.
- ⏳ Net convention change to [[../project-management]]: `shipped → verified → fold + delete + archive-index` (was `shipped → fold + delete`).

## Phase 3 — Board: Archived section ⏳
- ⏳ A collapsed **"Archived"** section on the board reads `archive.md` and lists verified features (link → their lifecycle page). Keeps them browsable without git spelunking.

## Phase 4 — Re-hydrate ("New spec from brain") ⏳
- ⏳ A **"New spec from brain"** entry: pick a brain page (lifecycle/dashboard/table) or an archived entry → the authoring chat seeds Opus with that page → drafts a fresh spec to extend/fix it → normal Build flow.

## Safety / invariants
- **Nothing is ever lost** — deleting a spec is git-recoverable; durable knowledge is in the brain pages; the archive index keeps a browsable pointer.
- **Verify is owner-only** and human (never automated) — it's the "I tested it" gate.
- Re-hydration always reads the **current** brain, not the stale spec snapshot.

## Completion criteria
- A shipped spec can be marked **verified** → folds + archives + leaves the board via a PR you merge.
- The board's "Shipped" column only shows shipped-not-yet-verified specs; an Archived section lists verified ones.
- "New spec from brain" drafts a fresh spec from a chosen brain page.

## Related
[[roadmap-build-console]] · [[build-approval-gates]] · [[repo-skills-catalog]] · [[../lifecycles/roadmap-build-console]] · [[../dashboard/roadmap]] · [[../dashboard/brain]] · [[../project-management]]
