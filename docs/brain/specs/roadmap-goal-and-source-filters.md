# Roadmap filters — focused goal-progress view + filter by source ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends the roadmap/build-console (the board at `/dashboard/roadmap`). The board now carries specs from four origins (goals, the planner, the repair agent, manual) — it needs filtering so the owner can focus on one goal's progress instead of scanning everything.

## Goal filter — the focused progress view (primary)
- A **goal selector** (dropdown of every `docs/brain/goals/*.md`) at the top of the board. Pick one → the board shows **only that goal's specs**, plus a **progress header**: `Storefront Optimizer — 1/6 shipped · 2 building · 3 planned`.
- **How a spec maps to a goal:** primarily the **goal doc's `[[spec-slug]]` wikilinks** (the planner wikilinks every authored spec into its goal doc, and goal docs list their milestone specs) — the reliable signal. Secondarily, a spec whose `**Parent:**` references the goal (its slug or a milestone of it). Union of both.
- "All goals" (default) shows the full board as today. The selection is sticky (URL param) so a goal view is shareable/bookmarkable.

## Source filter — by what created it (secondary)
- Chips: **All · 🎯 Goal · 🔧 Repair · ✋ Manual**. Per-spec source derived (no new field needed):
  - **🔧 Repair** — the spec body has a `**Repair-signature:**` line (authored by the box Repair Agent).
  - **🎯 Goal** — the spec is wikilinked from a goal doc (planner-authored / goal milestone).
  - **✋ Manual** — neither (hand-written).
- Composes with the goal filter + the existing **search bar** (all three AND together).

## Implementation
- Client-side, mirroring the existing search: each card already carries `data-spec-search`; add **`data-goal`** (the goal slug(s) it belongs to, or empty) and **`data-source`** (`repair`/`goal`/`manual`). The goal dropdown + source chips toggle card visibility by those attributes; the progress header counts visible cards by status.
- Server side: `getRoadmap` (or the page loader) resolves goal→spec membership once (read each goal doc's wikilinks + match parents) and the per-spec source, passing them to each `Card`. Reuse `parentLabel`/the goals list; no schema change.

## Verification
- Pick a goal (e.g. Storefront Optimizer) → only its specs show, with an accurate `X/Y shipped · N building` header; "All goals" restores the full board; the selection persists in the URL.
- Source chip **🔧 Repair** → only `Repair-signature` specs; **🎯 Goal** → only goal-linked specs; **✋ Manual** → the rest; **All** → everything.
- Goal + Source + search compose (AND) — e.g. Storefront Optimizer goal + Manual source + "hero" matches only manual hero specs under that goal.
- A spec linked from a goal doc shows under that goal; a repair spec with no goal shows under Manual/Repair, not a goal; counts in the progress header match the visible cards.
- Negative: a goal with no specs yet → empty board + `0/0` header (not an error); a spec in multiple goals (rare) shows under each.

## Phase 1 — goal selector + source chips + progress header ⏳
Derive goal-membership (goal-doc wikilinks ∪ parent match) + per-spec source in the loader; add the goal dropdown, source chips, and the goal-progress header to `/dashboard/roadmap`, composing with the search. Brain: [[../libraries/brain-roadmap]] · [[../dashboard/roadmap]] (if present) · [[../ui-conventions]].
