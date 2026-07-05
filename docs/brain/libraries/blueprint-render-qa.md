# libraries/blueprint-render-qa

Phase-3 QA predicate for the "build the {slug} lander" spec chain — a pure read that answers "would the storefront render for this blueprint match what Carrie wrote?" with per-block evidence. Called from `scripts/qa-and-snapshot-blueprint-render.ts` (dry-run + `--apply`) to gate the [[../libraries/lander-blueprints]] `setBlueprintRenderedUrl` snapshot on a green report — a broken block would advertise a broken page. Parented to [[../functions/growth]]'s "Ad-matched landing pages" mandate via the same spec chain that ships [[blueprint-render]] + [[blueprint-preview-gate]] + [[blueprint-experiment-wiring]] + [[blueprint-build-submit]].

**File:** `src/lib/blueprint-render-qa.ts`

## Why this exists

The Phase 1 render reader ([[blueprint-render]] `loadBlueprintRenderContent`) resolves each block's copy + image URL for the storefront section, but the resolver is silent on drift: a truncated content payload, a swapped image slot, or a whitespace-normalized copy pass would render 200 and only surface as a bad advertorial. The QA predicate is the reader's DUAL — it takes the SAME blueprint + calls the SAME reader, then asserts three invariants byte-by-byte before the founder ships the URL.

## Invariants asserted (all three must hold)

1. **Byte-identical copy per block.** `blueprint.content.blocks[i].copy === render.blocks[i].copy` for every block. Indexing is parallel; no reorder, no whitespace normalization. A `copy_mismatch` issue names the diverging block index + role.
2. **Every image slot resolves to a real product_media row.** A block whose `role` infers an image slot (hero / testimonial / ugc / before-after / press / lifestyle / ingredient) must have resolved a non-null `imageUrl`. A null there produces a `missing_image` issue — the block would render text-only on the live page.
3. **Structural parity.** `render.blocks.length === blueprint.content.blocks.length`. A `block_count_mismatch` issue captures an off-by-one that would only be visible on the live page (a truncated last block would silently disappear from a paragraph pass otherwise).

The image-slot predicate is DUPLICATED inside this file (`blockExpectsImage`) so the QA's classifier is INDEPENDENT of the render's ([[blueprint-render]] `inferMediaCategoryForBlock`). That catches a drift where the render silently stopped resolving a slot the blueprint still expects filled — otherwise the QA would inherit the render's blind spot.

## Exports

- **`runBlueprintRenderQa(workspaceId, blueprintId)`** → `Promise<BlueprintRenderQaReport>` — the single entrypoint. Reads the blueprint by `(workspace_id, id)`; loads the render via [[blueprint-render]] `loadBlueprintRenderContent(workspace_id, product_id, funnel_type)`; walks the parallel block arrays and captures every violation into `issues[]`. Never throws — a DB / load failure is captured as a `load_failed` / `content_missing` issue so the caller can print the report + decide. `ok = issues.length === 0`.
- **`BlueprintRenderQaReport`** / **`BlueprintRenderQaIssue`** — types.

## Callers

- `scripts/qa-and-snapshot-blueprint-render.ts` — Phase-3 apply script. Dry-runs the QA by default (prints the report; exits non-zero on FAIL); `--apply` runs the QA + stamps the rendered URL via [[../libraries/lander-blueprints]] `setBlueprintRenderedUrl` on PASS. A failed QA MUST NOT stamp a rendered URL — the guard prevents advertising a broken page.

## Guard / write-side invariant

Read-only by construction — this file never mutates. The paired write (the URL snapshot) lives in [[../libraries/lander-blueprints]] `setBlueprintRenderedUrl` and is compare-and-set-gated on `(workspace_id, id)` + `.select("id")` (exactly one row transitioned; bails on zero). The QA's PASS is the caller's precondition for calling the write — never the write's own guard.

## Gotchas

- **Byte-identical means byte-identical.** The render component's paragraph split (`paragraphsOf` in `BlueprintLander.tsx`) is a DISPLAY concern; the block-level `copy` string in `render.blocks[i].copy` is preserved verbatim from `blueprint.content.blocks[i].copy`. If a future rendering pass ever normalizes copy (trims trailing whitespace, collapses double-spaces), that shift will show up here as `copy_mismatch` — either fix the render or accept the drift by loosening the QA, never both silently.
- **Image slots are a role-derived heuristic.** A block whose `role` doesn't match the classifier (`hero` / `testimonial` / `ugc` / `before_after` / `press` / `lifestyle` / `ingredient`) is treated as copy-only; a missing image on such a block is NOT an issue. A new funnel type that carries a novel image-carrying role needs to be added to both `blockExpectsImage` here and `inferMediaCategoryForBlock` in [[blueprint-render]] — the QA catches the drift only if both were updated.
- **Never runs against `staging` / preview data.** The reader hits the same [[../tables/product_media]] + [[../tables/lander_content_gaps]] rows the storefront reads at request time, so the QA verdict is what the LIVE page will render — no separate "QA data" surface.

## Related

[[blueprint-render]] · [[../libraries/lander-blueprints]] · [[blueprint-preview-gate]] · [[blueprint-experiment-wiring]] · [[blueprint-build-submit]] · [[../lifecycles/lander-from-teardown]] · [[../tables/lander_blueprints]] · [[../tables/product_media]] · [[../tables/lander_content_gaps]] · [[../functions/growth]] · [[../goals/acquisition-research-engine]]

## Status / open work

✅ **Shipped** (2026-07-05, Phase 3 of `lander-build-advertorial-listicle-amazing-coffee-23e0ea01`). Open work: none identified — the QA runs against any blueprint the render reader can serve, so the next funnel type inherits it for free.
