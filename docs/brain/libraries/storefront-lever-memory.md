# `src/lib/storefront/lever-memory.ts` — the lever-importance memory

The persistent **brain** of the [[../goals/storefront-optimizer]] agent (M2): a hierarchical, learned chapter→component lever-importance map. Seeds with CRO priors ([[../tables/storefront_levers]]), updates to a posterior ([[../tables/storefront_lever_importance]]) from each completed M1 experiment, decays/re-probes, transfers `general` learnings cross-product, and ingests the M3 reconciler's signal. The which-lever-to-test half of the two-level bandit. Spec `docs/brain/specs/storefront-lever-importance-memory.md`.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `updatePosterior` | `({ workspaceId, experiment, rollups, now?, admin? }) → Promise<CommittedLearning \| null>` | Consume a completed M1 experiment; Bayesian-update the tested lever's posterior. Reward = predicted-LTV-proxy delta. Append-evidence + idempotent (deduped by experiment id). `null` if the experiment's `lever` has no taxonomy match. Called by [[storefront-experiment-refresh]] on every terminal (promote/kill/rolled_back) decision. |
| `nextLeverToTest` | `({ workspaceId, productId, landerType, audience?, now?, admin? }) → Promise<NextLeverResult>` | The explore/exploit selector: ranks component-level levers (high posterior = exploit; decayed/never-tested = explore via a UCB bonus). A new cell is seeded from `general` cross-product learnings. The which-lever the M4 agent calls. |
| `decayLeverImportance` | `({ workspaceId, now?, admin? }) → Promise<{ decayed }>` | Recompute every posterior toward its prior as `last_tested_at` ages. Idempotent. Driven daily by [[../inngest/storefront-lever-decay]]. |
| `applyReconciliationSignal` | `({ workspaceId, now?, admin? }) → Promise<{ present, applied }>` | Best-effort intake of the [[../specs/storefront-ltv-proxy-reconciler\|M3]] reconciler's `storefront_ltv_reconciliations` signal; adjusts the named lever class's posteriors. No-op if the table isn't present. |
| `getLeverImportancePanel` | `(admin, workspaceId) → Promise<LeverImportancePanelRow[]>` | Best-effort read for the funnel dashboard's "what the agent believes matters" panel. |
| `computeChapterPriorsFromFunnel` | `({ workspaceId, … }) → Record<string, number>` | The coarse dwell+CTA prior: recompute chapter-level priors from real funnel `chapter_dwell`/`cta_click` share ([[../tables/storefront_events]]). Exported + kept intact as the per-surface FALLBACK for low-traffic surfaces. |
| `seedChapterPriorsFromFunnel` | `({ workspaceId, apply?, admin? }) → { priors, updated }` | Write chapter-level priors onto the global [[../tables/storefront_levers]] rows. **Phase 2**: prefers the outcome-anchored `computeChapterPriorsFromDiagnostics` per (product × lander_type) in the workspace's optimizer product_scope, averaging surface contributions into the global chapter map (per-surface fallback to dwell+CTA is decided inside phase-1). No active policy / empty scope ⇒ degrades to the pre-phase-2 dwell+CTA path directly. Idempotent + apply-gated. Fired daily by [[../inngest/storefront-optimizer]] `storefrontOptimizerCron` as Tier-0 BEFORE the schedule fan-out. |
| `computeChapterPriorsFromDiagnostics` | `({ workspaceId, productId, sinceDays?, admin? }) → Record<LanderType, Record<string, number>>` | Outcome-anchored per-surface chapter prior driven by [[funnel-tree]] `computeBottlenecks`. Carry-limited surface → boost the GET-TO-PRICING chapters (`hero`, `benefits`, `how_it_works`, `ingredients`); close-limited → boost the DECISION chapters (`pricing_table`, `social_proof`, `guarantee`, `cta`); balanced / insufficient_data / no matching lever row → fall back to the dwell+CTA prior for that surface. Read-only; the verdict → chapter-role mapping is FIXED. |
| pure math | `effectFromDelta`, `posteriorMean`, `decayedImportance`, `recomputeImportance` | DB-free, exported for tests. |
| tunables | `PRIOR_STRENGTH=2`, `EFFECT_SCALE=0.2`, `LTV_PER_SESSION_FLOOR=50`, `DECAY_HALF_LIFE_DAYS=45`, `EXPLORE_C=0.35` | |

## The math
- **effect** = `min(1, |relProxyDelta| / EFFECT_SCALE)` — how much the lever moved the proxy (either direction ⇒ it's a lever; ~0 ⇒ it isn't here).
- **base posterior** = `(prior·PRIOR_STRENGTH + Σ effect) / (PRIOR_STRENGTH + n_tests)` — Beta-style conjugate mean.
- **decay** = `prior + (base − prior)·0.5^(ageDays/HALF_LIFE)` — drifts a written-off lever back up toward prior (re-probe) and a high lever back down.
- **score** (nextLeverToTest) = `importance + EXPLORE_C·√(ln(totalTests+2)/(n_tests+1)) + 0.2·min(1, ageDays/HALF_LIFE)`.

## Gotchas
- **Memory is a tool, not the objective** ([[../operational-rules]] § North star). It directs test budget; Growth + the M3 reconciler supervise it — a surprising swing surfaces on the dashboard, it isn't silently trusted.
- **Best-effort, never blocking.** [[storefront-experiment-refresh]] wraps the `updatePosterior` call in try/catch — a memory failure never breaks the supervisable refresh run.
- **`experiment.lever` must map to a `lever_key`.** Unmatched levers (e.g. `chapter_order`) commit no learning (logged). Extend [[../tables/storefront_levers]] to teach a new lever.
