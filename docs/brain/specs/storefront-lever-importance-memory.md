# Lever-importance model + CRO-learnings memory ⏳

**Owner:** [[../functions/growth]] · **Parent:** M2 — Lever-importance model + CRO-learnings memory
**Blocked-by:** [[storefront-experiment-bandit-framework]]

The persistent **brain** of the [[../goals/storefront-optimizer]] agent — the memory that turns one-off experiments into a compounding system. Today no lever-importance / CRO-memory store exists; the design lives only in the goal doc (§ "The lever-importance model"). This spec builds it: a hierarchical, **learned** chapter→component lever-importance map seeded with CRO **priors** and updated to a **posterior** by each [[storefront-experiment-bandit-framework|M1 experiment]] outcome — a **two-level bandit** (*which lever to test* × *which variant wins*). A headline variant with ~0% LTV-proxy delta demotes "headline" for that `(product × lander-type × audience)`; the agent then spends its next tests on the **high-posterior** levers instead of guessing. Importance scores **decay / get re-probed** so a written-off lever can resurrect (a bolder hero may make the headline matter again), and learnings are tagged **product-specific vs general** for cross-product transfer. Every campaign commits a learning here — **win or loss**. Serves the success metric by directing scarce test budget at the levers that actually move predicted-LTV-per-visitor.

## Phase 1 — the hierarchical lever taxonomy + priors ⏳
- ⏳ planned
- New table `storefront_levers` — the canonical hierarchy: **chapter** level (hero, pricing-table, social-proof, ingredients, FAQ, …) and **component** level decomposing a chapter (hero = `image · headline · benefit_chips · review_snippet · trust_badges`). Columns: `parent_lever_id` (self-FK for chapter→component), `lever_key`, `chapter`, `lander_type` applicability.
- Seed each lever with a CRO **prior** importance (hero dominant, pricing-clarity #2 — the goal's § CRO principles), and seed the chapter-level priors from the **real funnel data we already have**: per-chapter dwell + CTA-click share from [[../tables/storefront_events]] (`chapter_dwell`/`cta_click`, surfaced on [[../dashboard/storefront__funnel]]). Migration + [[write-brain-page]] `tables/storefront_levers.md`.

## Phase 2 — the learned posterior store ⏳
- ⏳ planned
- New table `storefront_lever_importance` — one posterior row per `(lever_id, product_id, lander_type, audience)`: `importance` (current posterior), `prior`, `n_tests`, `last_tested_at`, `evidence` (jsonb of contributing experiment ids + their proxy deltas), `scope` ∈ `product_specific｜general`.
- `src/lib/storefront/lever-memory.ts` — `updatePosterior(experiment)` consumes a completed M1 experiment ([[storefront-experiment-bandit-framework]] outcome + the M3 predicted-LTV-proxy delta as the reward) and Bayesian-updates the tested lever's importance: a meaningful proxy lift raises it, a ~0 delta demotes it. Idempotent per experiment (keyed by experiment id in `evidence`).

## Phase 3 — decay / re-probe (explore on levers) ⏳
- ⏳ planned
- A scheduled pass (Inngest, mirror the M1 refresh cadence) **decays** importance toward the prior as `last_tested_at` ages, so a written-off lever's posterior drifts back up enough to be **re-probed** later. Expose `nextLeverToTest({product, lander_type, audience})` — the explore/exploit selector that returns the highest-value lever to test next (high posterior = exploit; decayed/never-tested = explore), the *which-lever* half of the two-level bandit the M4 agent calls.

## Phase 4 — cross-product transfer + M3 recalibration intake ⏳
- ⏳ planned
- Tag each learning `product_specific` vs `general`; when a new `(product × lander-type × audience)` has no posterior yet, **seed from the `general` learnings** (cross-product transfer) rather than cold priors.
- Subscribe to the [[storefront-ltv-proxy-reconciler|M3 reconciler]]'s recalibration signal: when the slow loop finds a lever class systematically over/under-predicted (e.g. discount-heavy offers churn), adjust that lever's importance posterior accordingly (cross-link to M3 Phase 3; read the signal if present, no hard dependency).
- Surface the importance map on [[../dashboard/storefront__funnel]] (a "what the agent believes matters" panel).

## Safety / invariants
- **Memory is append-evidence, not destructive.** A posterior update appends the contributing experiment to `evidence` and recomputes — a loss is recorded as much as a win (the goal: "commit the learning to memory, win or loss"). Never silently drop a learning.
- **Idempotent updates.** Each experiment updates a posterior exactly once (deduped by experiment id); a re-run never double-counts.
- **Decay keeps exploration alive.** No lever is permanently dead — importance decays toward prior so a written-off lever can resurrect.
- **Scoped + transferable.** Every learning is tagged `product_specific｜general`; only `general` transfers cross-product.
- **The map is a tool, not the objective.** It directs test budget; the [[../functions/growth|Growth director]] + the M3 reconciler supervise it ([[../operational-rules]] § North star). A surprising posterior swing is surfaced, not silently trusted.

## Completion criteria
- `storefront_levers` encodes the chapter→component hierarchy with CRO priors + funnel-data-seeded chapter priors.
- `storefront_lever_importance` holds learned posteriors per `(lever × product × lander-type × audience)`, updated idempotently from M1 experiment outcomes (reward = M3 proxy delta).
- Importance decays with age and `nextLeverToTest` returns an explore/exploit-balanced choice.
- `general` learnings seed a brand-new `(product × lander-type × audience)` (cross-product transfer demonstrated).
- The reconciler's recalibration signal adjusts the relevant posteriors.
- The importance map is surfaced on the funnel dashboard.

## Verification
- Apply the migration → expect `✓ public.storefront_levers has N columns` + `✓ public.storefront_lever_importance has N columns`; confirm the self-FK `parent_lever_id` and the `(lever_id, product_id, lander_type, audience)` unique index.
- `select chapter, lever_key, prior from storefront_levers order by chapter;` → expect the hero/pricing/social-proof hierarchy with hero highest-prior; chapter priors reflect the funnel-data dwell/CTA share.
- Feed a completed M1 experiment with a meaningful proxy lift on the hero image → `select importance, prior, n_tests, evidence from storefront_lever_importance where lever_key='image' and product_id='<amazing-coffee>';` → `importance` raised above `prior`, `n_tests=1`, the experiment id in `evidence`; feed a headline experiment with ~0 delta → that lever's `importance` demoted below prior. Re-feed the same experiment → `n_tests` stable (idempotent).
- Run the decay pass with a stale `last_tested_at` → expect `importance` drifted toward `prior`; call `nextLeverToTest` → expect a decayed/never-tested lever surfaces for re-probe while a high-posterior lever is offered to exploit.
- Query `nextLeverToTest` for a new `(product × lander-type × audience)` with no posteriors → expect it seeded from `general` learnings, not cold priors.
- On `/dashboard/storefront/funnel` → expect a lever-importance panel reflecting the current posteriors.
