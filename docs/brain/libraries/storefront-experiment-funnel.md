# libraries/storefront-experiment-funnel

Phase 1 of the [[../specs/storefront-test-detail-page]]: builds the side-by-side **per-arm funnel** the owner-facing test detail page renders — the same numbers the bandit decides on, plus the three funnel rates the bandit doesn't persist.

**File:** `src/lib/storefront/experiment-funnel.ts` · Reads [[../tables/storefront_experiment_variants]] (persisted rollups) + [[../tables/storefront_events]] · Uses `winProbabilityVsControl` from [[storefront-bandit]]. Read-only — never writes (the bandit's [[storefront-experiment-attribution]] owns the rollup columns).

## Exports

### `computeExperimentFunnel({ admin, workspaceId, variants, draws? })` → `ArmFunnel[]`
For one experiment's variants:
1. **Outcome counts (bandit source of truth):** `sessions`, `conversions`, `sub_attach`, `revenue_cents`, `ltv_proxy_cents`, `alpha`/`beta` are read straight off the persisted `storefront_experiment_variants` columns — **no divergent math**, so the detail page and the promote/kill decision never disagree.
2. **Funnel rates (event-derived):** `engagement_rate`, `atc_rate`, `lead_rate` are computed fresh from `storefront_events`, keyed on the **same exposure spine** the attribution lib uses — an `experiment_exposure` event carries `meta.variant_id` + a `session_id`, so a session counts toward an arm's engagement/ATC/lead iff it was exposed to that arm. Internal/bot exposures were already dropped at write time, so this never counts team/crawler noise.
3. **Win-probability:** `win_prob` per non-control arm = Monte-Carlo `P(arm beats control)` over the Beta-Bernoulli posterior (the bandit's `winProbabilityVsControl`, default 4000 draws). `null` on the control arm.

Returns per-arm `sessions`/derived rates/per-visitor values (`revenue_per_visitor_cents`, `ltv_per_visitor_cents`) + posterior + `win_prob`. Lift-vs-control is computed in the page from these (control's value as baseline).

- **Engagement signal:** an exposed session is "engaged" if it fired any `chapter_view` / `chapter_dwell` / `scroll_depth` event (the spec's "chapter dwell / scroll-depth share"). Engagement % = engaged exposed sessions ÷ `sessions`.
- **Denominator is the bandit's `sessions`** (persisted exposed-session count), so every rate shares the bandit's denominator.

## Gotchas
- **Session-keyed, sticky.** A session belongs to at most one arm of an experiment (sticky assignment), so `session_id → variant_id` is unambiguous.
- **Bounded fetch.** ATC/lead/engagement events are pulled `.in("session_id", …)` over the exposed-session set (chunked 200), not the whole event log.
- **No exposures yet → all zeroes, not an error** (the detail page renders zeroes for a fresh experiment).

## Consumers
- `GET /api/workspaces/[id]/storefront-experiments/[experimentId]` → the detail page [[../dashboard/storefront__optimizer]].
