# `src/lib/ads/angle-palette.ts`

The **SDK chokepoint** for a product's clean, curated angle palette ([[../tables/product_angle_palette]]) — the v3 creative engine's fan-out: **Product → Ingredient → Theme → Problem-Angle**. Every read and write of the palette goes through here; never raw `.from('product_angle_palette')`.

An angle is the **substance half** of a headline: it carries the raw parts a headline needs (enemy / mechanism / proof / outcome) plus the demand signal that SELECTS it, the `evidenceTier` (a proof STYLE, never a filter), and the coverage memory (`timesUsed` / `lastUsedAt` / `status`). The **structure half** is a pattern from [[headline-patterns]]; [[compose-headline]] fuses them into a finished headline.

**Two governing principles (CEO 2026-07-21):**
- **Demand SELECTS the angle; scientific evidence REINFORCES it — never the reverse.** These are marketing tools. `searchDemand` is the selector; `evidenceTier` is the honesty layer that decides HOW to prove a chosen angle, not WHETHER to run it.
- **Angles are keyed on PROBLEM**, not ingredient — one ingredient fans across many problem-lanes. The unique key is `(workspace, product, theme, problem)`.

Populated once per hero product by a `_seed-angle-palette-*.ts` script, then extended by Dahlia's fan-out (`source='dahlia_fanned'`) when a theme runs low on fresh combinations.

## Types

- `AngleTheme` = `'beauty' | 'longevity' | 'healthy_weight' | 'energy_performance' | 'focus' | 'gut'` — the top-level positioning menu, audience tag, and coverage axis.
- `EvidenceTier` = `'science_strong' | 'science_modest' | 'customer_only'`.
- `SearchDemand` = `'high' | 'medium' | 'low'`.
- `AngleSource` = `'seeded' | 'dahlia_fanned' | 'competitor_mapped'`.
- `AngleStatus` = `'fresh' | 'testing' | 'crowned' | 'retired'`.
- `ProductAngle` — the camelCased row (id, productId, theme, problem, ingredients, benefitKey, enemy, mechanism, desiredOutcome, proofText, proofKind, evidenceTier, backingReviewIds, searchDemand, awarenessStages, source, timesUsed, lastUsedAt, status, isActive, displayOrder, notes).
- `AnglePaletteInput` — the shape a seed/fan-out author writes (coverage fields default server-side).

## Exports

- **`listAnglePalette(admin, workspaceId, productId, opts?)` → `Promise<ProductAngle[]>`** — a product's palette ordered by `displayOrder`. `opts`: `{ theme?, status?, awarenessStage?, includeInactive? }`. `theme`/`status` filter in SQL; `awarenessStage` filters in JS on the `awarenessStages[]` array; `is_active=true` unless `includeInactive`.
- **`listPaletteThemes(admin, workspaceId, productId)` → `Promise<AngleTheme[]>`** — the distinct themes present in the active palette (the coverage axis for theme-spread selection). Built on `listAnglePalette`.
- **`upsertAngle(admin, workspaceId, productId, input: AnglePaletteInput)` → `Promise<string>`** — idempotent upsert on `(workspace_id, product_id, theme, problem)`; returns the row id. Defaults `awarenessStages` to `['cold','warm','hot']` and `source` to `'seeded'` when omitted.
- **`markAngleUsed(admin, angleId, atIso)` → `Promise<void>`** — read-then-write bump of `timesUsed` + set `lastUsedAt`. The coverage/freshness heartbeat, called when an angle ships in an ad.
- **`setAngleStatus(admin, angleId, status: AngleStatus)` → `Promise<void>`** — the lifecycle transition `fresh → testing → crowned/retired`.

## Callers / purpose

- **Selection (explore):** the v3 selector reads `listAnglePalette` + `listPaletteThemes` to spread N creatives across DIFFERENT themes (kills mono-angle convergence), then gap-fills demand-weighted within a theme.
- **[[compose-headline]]** consumes a `ProductAngle` as the `angle` input to `composeHeadline` — the enemy/mechanism/proof/outcome fill the pattern's structure, and `evidenceTier` sets the proof-style rule.
- **Coverage loop:** `markAngleUsed` fires on post; `setAngleStatus` promotes/retires as the factor-rollup crowns winners.
- Grounded against the [[product-intelligence]] chokepoint at seed time — `benefitKey` links [[../tables/product_benefit_selections]].`benefit_name`, and `backingReviewIds` cite real reviews.

## Gotchas

- **`markAngleUsed` is read-then-write, not atomic** — two concurrent posts of the same angle can each read the same `timesUsed` and both write `n+1` (losing one increment). Coverage is a freshness heuristic, not billing; acceptable today, but don't rely on the exact count for anything load-bearing.
- **`evidenceTier` never filters.** It's carried straight through to [[compose-headline]] as a proof-STYLE directive. A `customer_only` angle is fully viable — it just leads with the review instead of a clinical claim.
- **This is the v3 replacement for the polluted `product_ad_angles`.** Don't cross-write; the legacy table is untouched and out of the v3 path.

[[../tables/product_angle_palette]] · [[headline-patterns]] · [[compose-headline]] · [[product-intelligence]] · [[creative-brief]] · [[../README]] · [[../../CLAUDE]]
