# libraries/blueprint-build-submit

Author deterministic build specs from verified [[../tables/lander_blueprints]] rows and submit them to [[../functions/growth]]'s mandate-anchored queue. Bridge between Cleo's blueprint verification and Ada's build-once-live queue — the moment a blueprint is ready, this module deterministically composes a spec + submits it to `public.specs` with **mandate parent** (Growth's "Ad-matched landing pages"), never a bare goal ([[../specs/blueprint-specs-mandate-parent]] Phase 1, shipped).

**File:** `src/lib/blueprint-build-submit.ts`

## Why this exists

Lander blueprints are perpetual [[../functions/growth]] acquisition work — they should anchor to the Growth mandate, not a finite milestone. A bare-goal parent causes Vale spec-review to bounce on the Parent check (specs must anchor to a specific milestone or mandate). By routing through this module's `submitBlueprintBuild`, every submitted spec inherits the durable mandate parent, bypassing the gotcha.

## Key insight — mandate parent, not milestone

The spec slug is deterministic (`lander-build-{funnel}-{product}-{shortid}`). The parent is hardcoded to Growth's "Ad-matched landing pages" mandate:

```
parentKind: "mandate"
parentRef: "growth#ad-matched-landing-pages"
```

Read the mandate in [[../functions/growth]] § "Ad-matched landing pages". The goal planner can still attach a `milestone_id` separately if a specific goal wants to claim the spec — the mandate is the durable anchor Vale checks, and the goal attachment is a separate layer (⚠ if omitted from the composed input, authorSpecRowStructured forces it to null).

## Exports

- **`composeBuildSpec(blueprint, productTitle, productHandle)`** → `{ slug, input }` — compose the deterministic **input** [[../tables/StructuredSpecInput]] (owner, parent, title, three phases) and collision-safe slug off the blueprint's funnel type, product, and id tail. The parent prose names the Growth mandate; the typed fields are `parentKind: "mandate"` + `parentRef: "growth#ad-matched-landing-pages"`. **Pure function, no side effects.**
- **`submitBlueprintBuild(workspaceId, blueprintId)`** → `{ status: "submitted" | "error", blueprint_id, build_spec_slug?, reason? }` — load the blueprint, compose the spec, call [[../libraries/author-spec]] `authorSpecRowStructured` with the mandate parent, and stamp the submission. **Idempotent:** if already submitted, returns the existing slug without duping the spec row (checks `getBlueprintBuildSubmission` first).
- **`setBlueprintBuildSubmission(workspaceId, blueprintId, buildSpecSlug)`** — upsert the `lander_blueprint_build_submission` row, linking blueprint → spec slug (used for outcome lineage).

## Callers

- [[../libraries/cleo-blueprint]] `runCleoBlueprintSweep` — enqueues `submitBlueprintBuild` on newly `blueprint_complete` rows.
- `src/app/api/developer/content/blueprint/submit/route.ts` — allows manual submission (admin/operator-gated for testing/recovery).

## Related

[[../specs/blueprint-specs-mandate-parent]] · [[../functions/growth]] — "Ad-matched landing pages" mandate · [[../tables/lander_blueprints]] · [[../libraries/author-spec]] · [[../libraries/cleo-blueprint]] · [[../lifecycles/advertorial-landers]]

## Status / open work

✅ **Shipped** (2026-07-05, Phase 1) — mandate parent now enforced. Open work: none identified.
