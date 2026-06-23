# libraries/storefront-experiments

The read-side of the storefront experiment framework (Phase 2): deterministic sticky assignment + reversible content patching, consumed by the lander render path. See spec `docs/brain/specs/storefront-experiment-bandit-framework.md`.

**File:** `src/lib/storefront/experiments.ts` · Tables [[../tables/storefront_experiments]] + [[../tables/storefront_experiment_variants]] · Render caller: `src/app/(storefront)/store/[workspace]/[slug]/page.tsx` → [[advertorial-pages]] content.

## Exports

### `assignVariant(identityKey, experiment, variants, opts?)` → `Assignment | null`
Deterministic, STICKY arm assignment. Hashes `${identityKey}:${experiment.id}` (sha256 → unit float) so a given identity (`customer_id ?? anonymous_id`) never flips arms. Holdout band `[0, holdout_pct)` → control (sacred, never reallocated); `promoted` → the winner serves all non-holdout traffic; `running` → explore arms split the non-holdout band, with `opts.conservative` reserving `CONSERVATIVE_EXPLORE_SHARE` (0.34) for explore and the rest to control.

### `applyVariantPatch(content, patch)` → `AdvertorialContent`
Applies a variant's reversible `VariantPatch` (`headline`/`dek`/`publication`/`sponsorLabel`/`heroCaption`/`heroImageUrl`/`chapterHeading`/`chapterParagraphs`/`chapterOrder[]`/`reasonsOrder[]`) over the control lander content. Empty patch → content unchanged. Copy/hero/chapter only — never an offer.

### `resolveExperimentsForRender({ admin, workspaceId, productId, renderVariant, identityKey, content, conservative?, preview? })` → `{ content, exposures }`
The one call the lander render makes: loads active experiments for the `(product, lander_type)` (`landerTypeForVariant`: `reasons`→`listicle`), sticky-assigns, patches the content, and returns the `experiment_exposure` payloads the client pixel emits. Null identity → no experiments served (can't sticky-assign). Best-effort: returns the unpatched content if the tables are absent.

**Preview mode (`preview: { experimentId, variantId }`)** — the owner-only test-detail preview link (`?sx_preview=<experimentId>:<variantId>`, [[../specs/storefront-test-detail-page]]) **forces that one arm's patch** regardless of sticky assignment or identity (any status, via `loadExperimentById`), so the owner sees exactly what a shopper in that arm sees. The link also carries `sx_internal=1`, so the emitted exposure is dropped at the pixel write — the bandit is never polluted (reuses the existing internal-traffic exclusion). Returns `{ content, exposures: [] }` if the experiment isn't in the workspace / doesn't match the product / the variant is unknown.

### `resolvePdpExperimentsForRender({ admin, workspaceId, productId, identityKey, conservative?, preview? })` → `{ heroImageUrl, exposures }`
The **bare PDP** counterpart of `resolveExperimentsForRender` (pdp-experiment-wiring Phase 1). The PDP is the odd render model: no `AdvertorialContent`, and its hero comes from `media_by_slot["hero"]` (product media), so instead of patching content this returns the assigned arm's **`heroImageUrl` override** (the only PDP lever today) + the exposures. Same sticky-assign + preview semantics, scoped to `lander_type='pdp'`. The render caller (`store/[workspace]/[slug]/page.tsx`) applies the URL over the hero slot via a local `applyPdpHeroOverride` clone (responsive variants nulled → `pictureSources` falls back to the plain edge-proxied URL; control hero dims/alt kept). Best-effort: `{ heroImageUrl: null, exposures: [] }` when tables absent / no identity / no active PDP experiment / preview mismatch.

### Also: `hashToUnit`, `landerTypeForVariant`, `renderVariantForLanderType` (inverse; `pdp`→`advertorial`), `parsePreviewParam` (`"<expId>:<variantId>"`→parts), `loadActiveExperiments`, `loadExperimentById`, types `ExperimentRow`/`VariantRow`/`VariantPatch`/`ExperimentExposureMeta`.

## Gotchas
- **No DB-persisted assignment.** Stickiness is a pure hash of identity+experiment; the bandit does DISCRETE reallocation (promote/kill/rollback), not per-request re-bucketing, so arms don't wobble.
- **Render reads the `sid` cookie** in the `?variant=&angle=` lander branch (already dynamic), AND on the **bare PDP** — but there it's gated on `loadActiveExperiments(…, "pdp")` returning a hit, so the PDP stays ISR-cached unless a PDP experiment is actually running (pdp-experiment-wiring Phase 1's dynamic-only-when-testing). `sx_preview` forces an arm with no cookie (dynamic via searchParams).
- Exposure emission is client-side via [[../lifecycles/storefront-checkout|the pixel]] (`experiment_exposure`), deduped + internal/bot-filtered there.
