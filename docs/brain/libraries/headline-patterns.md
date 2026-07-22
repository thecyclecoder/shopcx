# `src/lib/ads/headline-patterns.ts`

The **SDK chokepoint** for the SHARED, product-agnostic headline-pattern library ([[../tables/ad_headline_patterns]]) — ~13 reusable direct-response formulas keyed by awareness stage. Every read/write goes through here; never raw `.from('ad_headline_patterns')`.

The v3 creative engine composes a headline as **Angle × Pattern**: the angle (from [[angle-palette]]) supplies the raw parts (enemy / mechanism / proof / outcome), the pattern supplies the STRUCTURE, and the awareness stage (temperature) gates which patterns are legal. **The 5 caption variations = 5 patterns on ONE angle.** [[compose-headline]] does the fusion.

Patterns are NOT verbatim templates — they're the grounded north-star STRUCTURE Dahlia flexes toward a competitor's punchiness. A pattern is a shape, not a claim, so it's product-agnostic (no `product_id`); all product intelligence enters at author time via the angle.

## Types

- `AwarenessStage` = `'cold' | 'warm' | 'hot'` (the shared temperature type, re-imported by [[angle-palette]] and [[compose-headline]]).
- `AnglePart` = `'subject' | 'enemy' | 'mechanism' | 'proof' | 'outcome' | 'product' | 'review' | 'offer' | 'guarantee'` — the parts a pattern can consume when filling its structure.
- `HeadlinePattern` — the camelCased row (id, slug, name, structure, awarenessStages, consumes, example, isActive, displayOrder).

## Exports

- **`HEADLINE_PATTERN_SEED`** — the canonical seed array (~13 formulas), `Omit<HeadlinePattern,'id'>`. Shared across ALL products. Grouped by temperature:
  - **❄️ COLD** (intrigue / reframe / no offer): `reframe` (not-X-but-Y) · `curiosity-gap` · `villain-callout` · `mechanism-reveal` · `problem-agitate` · `story` · `question`.
  - **🌤️ WARM** (proof / comparison / specificity — also serve HOT): `social-proof` · `specificity` · `comparison` · `testimonial` · `risk-reversal`.
  - **🔥 HOT** (offer): `offer` (hot only).
  Each seed declares `consumes` (which angle-parts it needs) and `awarenessStages` (which temperatures it's legal for).
- **`listHeadlinePatterns(admin, workspaceId, opts?)` → `Promise<HeadlinePattern[]>`** — active patterns ordered by `displayOrder`. `opts`: `{ awarenessStage?, includeInactive? }`. `awarenessStage` filters in JS on `awarenessStages[]`; `is_active=true` unless `includeInactive`.
- **`getHeadlinePattern(admin, workspaceId, slug)` → `Promise<HeadlinePattern | null>`** — one pattern by slug (`maybeSingle`).
- **`seedHeadlinePatterns(admin, workspaceId)` → `Promise<number>`** — idempotently upserts `HEADLINE_PATTERN_SEED` on `(workspace_id, slug)`; returns the count written. Run once per workspace.

## Callers / purpose

- **Selection (explore):** the v3 selector calls `listHeadlinePatterns({ awarenessStage })` to get the patterns legal for the batch's temperature, then picks a FRESH pattern the chosen angle can fill (cross-checking `consumes` against the angle's populated parts + the [[../tables/ad_creative_combinations]] coverage ledger).
- **[[compose-headline]]** consumes a `HeadlinePattern` as the `pattern` input to `composeHeadline` — its `structure` is the shape, `consumes` tells the model which parts to draw from the angle.
- **Seeding:** a workspace-setup / `_seed-*` script calls `seedHeadlinePatterns` once.

## Gotchas

- **`consumes` is a real gate.** Never hand a pattern an angle that can't fill its parts — a `testimonial` pattern needs `review`, an `offer` pattern needs `offer` (which cold angles never carry). The selector must filter on this or `composeHeadline` will strain against an empty slot.
- **Product-agnostic on purpose.** No `product_id`; one seed set serves all six hero products. Resist adding product-specific patterns — product truth belongs in [[angle-palette]].
- **Awareness mirrors the offer policy.** COLD patterns carry no offer slot; `offer` is hot-only; `risk-reversal` spans warm/hot. This is the same temperature axis the substitution policy in [[compose-headline]] enforces.

[[../tables/ad_headline_patterns]] · [[angle-palette]] · [[compose-headline]] · [[creative-brief]] · [[../README]] · [[../../CLAUDE]]
