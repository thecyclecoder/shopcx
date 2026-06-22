# libraries/storefront-experiments

The read-side of the storefront experiment framework (Phase 2): deterministic sticky assignment + reversible content patching, consumed by the lander render path. See spec `docs/brain/specs/storefront-experiment-bandit-framework.md`.

**File:** `src/lib/storefront/experiments.ts` · Tables [[../tables/storefront_experiments]] + [[../tables/storefront_experiment_variants]] · Render caller: `src/app/(storefront)/store/[workspace]/[slug]/page.tsx` → [[advertorial-pages]] content.

## Exports

### `assignVariant(identityKey, experiment, variants, opts?)` → `Assignment | null`
Deterministic, STICKY arm assignment. Hashes `${identityKey}:${experiment.id}` (sha256 → unit float) so a given identity (`customer_id ?? anonymous_id`) never flips arms. Holdout band `[0, holdout_pct)` → control (sacred, never reallocated); `promoted` → the winner serves all non-holdout traffic; `running` → explore arms split the non-holdout band, with `opts.conservative` reserving `CONSERVATIVE_EXPLORE_SHARE` (0.34) for explore and the rest to control.

### `applyVariantPatch(content, patch)` → `AdvertorialContent`
Applies a variant's reversible `VariantPatch` (`headline`/`dek`/`publication`/`sponsorLabel`/`heroCaption`/`heroImageUrl`/`chapterHeading`/`chapterParagraphs`/`chapterOrder[]`/`reasonsOrder[]`) over the control lander content. Empty patch → content unchanged. Copy/hero/chapter only — never an offer.

### `resolveExperimentsForRender({ admin, workspaceId, productId, renderVariant, identityKey, content, conservative? })` → `{ content, exposures }`
The one call the lander render makes: loads active experiments for the `(product, lander_type)` (`landerTypeForVariant`: `reasons`→`listicle`), sticky-assigns, patches the content, and returns the `experiment_exposure` payloads the client pixel emits. Null identity → no experiments served (can't sticky-assign). Best-effort: returns the unpatched content if the tables are absent.

### Also: `hashToUnit`, `landerTypeForVariant`, `loadActiveExperiments`, types `ExperimentRow`/`VariantRow`/`VariantPatch`/`ExperimentExposureMeta`.

## Gotchas
- **No DB-persisted assignment.** Stickiness is a pure hash of identity+experiment; the bandit does DISCRETE reallocation (promote/kill/rollback), not per-request re-bucketing, so arms don't wobble.
- **Render reads the `sid` cookie** — only in the already-dynamic `?variant=&angle=` branch, so the static PDP is preserved.
- Exposure emission is client-side via [[../lifecycles/storefront-checkout|the pixel]] (`experiment_exposure`), deduped + internal/bot-filtered there.
