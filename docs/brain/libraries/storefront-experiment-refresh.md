# libraries/storefront-experiment-refresh

The Phase 3→4→5 orchestrator for one storefront-experiment refresh per workspace. Driven by [[../inngest/storefront-experiments]].

**File:** `src/lib/storefront/experiment-refresh.ts` · Uses [[storefront-experiment-attribution]], [[storefront-bandit]], [[storefront-calibration]] · Writes [[../tables/storefront_experiments]] + [[../tables/storefront_experiment_runs]].

## Exports

### `refreshStorefrontExperiments({ workspaceId, trigger, windowDays?, now? })` → `RefreshResult`
1. Opens a run record (`status='running'`); derives `conservative = !(await isProxyCalibrated({ workspaceId }))` ([[storefront-calibration]]) — the M1 bandit's read of M3's single calibration gate (smaller bets + tighter promote thresholds until the slow loop reconciles once).
2. `refreshExperimentAttribution` (idempotent recompute).
3. **Phase 5 guardrail (per experiment, before the bandit):** for the SERVING arm(s) (the promoted arm, else all running arms) — if LTV-per-session sits below control by `LTV_REGRESSION_TOLERANCE` (0.15) it's a regression window (`regression_windows++`); at `REGRESSION_WINDOWS_TO_ROLLBACK` (2), OR a refund-rate excess of `REFUND_SPIKE_DELTA` (0.10) over control, auto-flip `status='rolled_back'` (clears `promoted_variant_id` → control content restored), record the reason + posterior snapshot, and **escalate to Growth** (durable `escalations` + `console.warn`). Guardrail needs `GUARDRAIL_MIN_SESSIONS` (50) on both arms.
4. **Phase 4 decision** (`decideExperiment`) for non-rolled-back experiments → promote/kill/hold; persists status + `last_decision` snapshot.
5. **Self-heal the edge manifest** — after the rollup, an unconditional `republishExperimentManifest(admin)` ([[experiment-cache]]) gated on `isEdgeConfigWriteConfigured()` ([[experiment-manifest]]) republishes `storefront_experiment_manifest` to Edge Config so it always matches the live running/promoted set. Idempotent (an upsert of the same manifest is a no-op write) and best-effort (never throws). The state-change republishes inside the per-experiment loop (promote/kill/rollback) stay as the fast path; this is the ≤5-min safety net for any drift — a manual DB change, a missed event, a stale entry, or experiments that were already `running` before the publish code shipped. See [[../specs/pdp-edge-served-experiments]].
6. Closes the run record with `decisions`/`escalations`/`counts`.

## Gotchas
- **Rollback restores control by status flip only** — it never edits a variant `patch`. Non-`running`/`promoted` experiments simply aren't served at render.
- **Supervisable, not silent** — every decision + the triggering posteriors land on the run record; rollbacks escalate.
- **Edge manifest self-heals on every tick, not only on state change.** The unconditional step-5 republish means the edge always converges to the live set within one refresh cycle; gated on `isEdgeConfigWriteConfigured()`, so it no-ops to the blob fallback when Edge Config isn't provisioned (no crash).
