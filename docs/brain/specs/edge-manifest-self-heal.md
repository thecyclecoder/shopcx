# Edge experiment manifest — self-heal on the refresh cron ✅

**Owner:** [[../functions/platform]] · **Parent:** hardens [[pdp-edge-served-experiments]].

**Found in use 2026-06-23:** the Edge Config experiment manifest (`storefront_experiment_manifest`, read by the PDP middleware) is **only republished on experiment state-change** (`materializeCampaign` / rollback via `republishExperimentManifest`). So experiments that were already `running` before the publish code shipped left the manifest **empty** — the edge had no assignment data despite 3 live experiments (had to publish by hand). Any future drift (a manual DB change, a missed event, a stale entry) has no self-heal.

## Fix
- **The every-5-min `storefront-experiments-refresh` cron also `republishExperimentManifest()`** for each workspace it processes (after the rollup) — so the manifest **always reflects the current set of running/promoted experiments**, self-healing within ≤5 min regardless of how state changed. Idempotent (an upsert of the same manifest is a no-op write).
- Gate on `isEdgeConfigWriteConfigured()` (no-op to the blob fallback when Edge Config isn't provisioned) so it's safe everywhere.
- Keep the existing state-change republish (it's the fast path; the cron is the safety net).

## Verification
- With 3 running experiments and an **empty** manifest, run the refresh cron once → `storefront_experiment_manifest` in Edge Config is populated with those experiments (self-healed, no state-change needed).
- ✅ Manually corrupt/clear the manifest key → within one refresh cycle it's rebuilt to match the live running experiments.
- ✅ No running experiments → the cron writes an empty manifest (or no-ops), never errors.
- ✅ Negative: Edge Config not provisioned → the cron no-ops to the blob fallback, no crash.

## Phase 1 — republish the manifest on the refresh cron ✅
Add `republishExperimentManifest(admin)` to the `storefront-experiments-refresh` per-workspace pass (gated on write-config), idempotent. Brain: [[pdp-edge-served-experiments]] · [[../libraries/storefront-experiments]] · [[../integrations/vercel]].

**Shipped:** `refreshStorefrontExperiments()` ([[../libraries/storefront-experiment-refresh]]) now calls `republishExperimentManifest(admin)` after the rollup, gated on `isEdgeConfigWriteConfigured()` ([[../libraries/experiment-manifest]]) — unconditional self-heal on every refresh tick, idempotent (same-manifest upsert is a no-op), best-effort (never throws). State-change republishes inside the per-experiment loop stay as the fast path. Brain folded into [[../libraries/storefront-experiment-refresh]] + [[../inngest/storefront-experiments]].
