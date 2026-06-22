# libraries/storefront-bandit

Phase 4 of the storefront experiment framework: pure Thompson-sampling math + the promote/kill decision over variant posteriors. No DB.

**File:** `src/lib/storefront/bandit.ts` · Consumes `VariantRollupResult` from [[storefront-experiment-attribution]] · Driven by [[storefront-experiment-refresh]].

## Exports

### `decideExperiment(rollups, { conservative, draws?, rng? })` → `BanditDecision`
Computes each non-control arm's win-probability vs control (Monte-Carlo over the Beta-Bernoulli posteriors), then decides:
- **promote** the best arm when `winProb >= promoteWinProb` AND both it + control clear the `minExposureFloor`.
- **kill** when the best arm's `winProb <= killWinProb` (control clearly wins) at the floor.
- **hold** otherwise (incl. below the exposure floor).
Returns the `posteriors[]` snapshot (per-arm sessions/conversions/alpha/beta/winProb/ltvPerSession) + the `rule` invoked, for supervisability.

### `winProbabilityVsControl(arm, control, draws?, rng?)`, `sampleBeta(alpha, beta, rng?)`
Beta sampler (two Gamma draws, Marsaglia–Tsang) + Monte-Carlo P(arm > control).

### Thresholds
`NORMAL_THRESHOLDS` (promote 0.95 / kill 0.05 / floor 200) vs `CONSERVATIVE_THRESHOLDS` (0.99 / 0.02 / 500). `thresholdsFor(conservative)`.

## Gotchas
- **Conservative until M3 calibrates** — tighter promote bar + higher floor; the traffic-share throttle is separate (in [[storefront-experiments]] `assignVariant`).
- **Holdout is sacred** — the bandit promotes/kills/holds; it never reallocates the holdout band.
