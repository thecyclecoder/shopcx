# Dashboard · storefront/funnel

_TODO: page purpose._

**Route:** `/dashboard/storefront/funnel`

## Features

**Page title:** Storefront funnel

**Rendering:** `"use client"` component (client-side state + fetch).

**Running experiments panel:** surfaces active [[../tables/storefront_experiments]] (status `running`/`promoted`) with each arm's sessions / CVR / sub-attach and posterior **win-probability vs control** — computed in the funnel API route via [[../libraries/storefront-bandit]] `winProbabilityVsControl` and returned as `runningExperiments`. The supervisable surface for the bandit (storefront-experiment-bandit-framework Phase 4).

**"What the agent believes matters" panel:** surfaces the learned lever-importance posteriors ([[../tables/storefront_lever_importance]]) per `(lever × product × lander × audience)` — current `importance`, the delta vs `prior` (what testing taught it), scope (general/product), `n_tests`, and last-tested age. Returned as `leverImportance` via [[../libraries/storefront-lever-memory]] `getLeverImportancePanel`. The supervisable surface for the M2 lever-importance memory (storefront-lever-importance-memory Phase 4).

**Predicted-LTV-per-visitor panel:** surfaces the M3 reward the bandit optimizes ([[../tables/storefront_ltv_metrics]]) per `(product × lander × audience)` — visitors, sub-attach, est-sub-LTV, predicted LTV/visitor, and the **week-over-week** delta (current snapshot vs the newest snapshot ≥7 days older). Returned as `predictedLtv` from the funnel API route (`buildPredictedLtv`). Shows an **"uncalibrated — betting conservatively"** badge until M3's slow loop reconciles once. The supervisable surface for the M3 LTV-proxy reconciler (storefront-ltv-proxy-reconciler Phase 4).

## Sub-routes

_None._

## API endpoints called

_None detected via static fetch() scan._

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/storefront/funnel/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
