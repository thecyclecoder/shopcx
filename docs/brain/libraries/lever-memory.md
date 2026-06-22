# libraries/lever-memory

The persistent **brain** of the [[../goals/storefront-optimizer]] agent (M2): a hierarchical, learned chapter→component lever-importance map seeded with CRO priors and updated to a posterior by each M1 experiment outcome — the **which-lever** half of the two-level bandit (which lever to test × which variant wins).

**File:** `src/lib/storefront/lever-memory.ts` · Tables [[../tables/storefront_levers]] + [[../tables/storefront_lever_importance]] · Committed from [[storefront-experiment-refresh]] · Maintained by [[../inngest/storefront-lever-memory]] · Surfaced on [[../dashboard/storefront__funnel]]. Spec `docs/brain/specs/storefront-lever-importance-memory.md`.

## Exports

### `updatePosterior({ experimentId, admin?, now?, rollups? })` → `UpdatePosteriorResult`
Consume ONE completed M1 experiment (status promoted/killed/rolled_back) and Bayesian-update the tested lever's importance for its `(product × lander_type × audience)`. Resolves the experiment's `lever` to a canonical lever (`resolveLever`), computes the reward from the variant rollups (`rewardFromRollups`), appends an evidence entry, and recomputes `importance` from prior + evidence. **Idempotent** — an experiment already in `evidence` returns `skipped_idempotent`. Commits a loss as much as a win.

### `nextLeverToTest({ workspaceId, productId, landerType, audience?, admin?, now? })` → `NextLeverResult`
The which-lever bandit: rank the applicable levers by a **UCB explore/exploit** score (`decayedImportance + EXPLORE_C·√(ln(ΣtESTS+1)/(n_tests+1))`) and return the highest-value lever to test next (`pick`) + the ranked `candidates`. High decayed posterior = **exploit**; never-tested or stale/decayed = **explore**. A never-tested cohort seeds from `general` learnings (cross-product transfer) via `seedFor`, else the cold prior. Each candidate carries a `reason` (`tested` / `stale_decayed_reprobe` / `untested_general_transfer` / `untested_cold_prior`) for supervisability.

### `decayLeverImportance({ workspaceId, admin?, now? })` → `DecayResult`
Drift every posterior in a workspace toward its prior by age (persisted). Keeps exploration alive — a written-off lever rises back toward prior so it gets re-probed. Does not touch `evidence`/`last_tested_at`. Driven daily by [[../inngest/storefront-lever-memory]].

### `applyReconcilerSignals({ workspaceId, admin?, now? })` → `ReconcilerResult`
Intake the M3 reconciler's recalibration signal ([[../specs/storefront-ltv-proxy-reconciler]] Phase 3): scale the matching posteriors when the ~4-month slow loop finds a lever class systematically over/under-predicted. Reads `storefront_lever_recalibration` if present; **no-op** otherwise (soft dependency — M3 not yet shipped).

### Pure helpers
`posteriorFromEvidence(prior, evidence)`, `decayedImportance(row, now)`, `rewardFromRollups(rollups)`, `seedFor(admin, lever, cohort)`, `resolveLever(admin, leverText)`.

### Tunables
`PRIOR_WEIGHT=1`, `SIGNAL_SCALE=0.5`, `FULL_CONFIDENCE_SESSIONS=500`, `MIN_EVIDENCE_WEIGHT=0.5`, `DECAY_HALF_LIFE_DAYS=30`, `EXPLORE_C=0.4`, `STALE_AFTER_DAYS=45`.

## Gotchas

- **Reward = magnitude.** `signal = |proxy_delta|` — a big win OR a big loss both prove the lever is high-leverage; a ~0 delta proves it isn't (demote). Decay/re-probe lets a written-off lever resurrect.
- **Decay and updates don't fight.** `updatePosterior` recomputes from evidence (idempotent, runs once per experiment); decay only drifts between tests. A new experiment resets to full strength.
- **Scope gates transfer.** Only `general`-scoped posteriors seed a new product's cold cohort; `product_specific` stays put.

---

[[../README]] · [[../../CLAUDE]]
