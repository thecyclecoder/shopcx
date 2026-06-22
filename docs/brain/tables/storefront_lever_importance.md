# `storefront_lever_importance` — the learned lever-importance posterior

The agent's persistent **memory**: one learned posterior row per `(lever_id × product_id × lander_type × audience)`. Starts from the lever's cold prior ([[storefront_levers]]) — or a `general`-learning **transfer seed** for a brand-new product — and is Bayesian-updated by each completed M1 experiment outcome ([[storefront_experiments]]), reward = the M3 predicted-LTV-proxy delta. **Append-evidence + recompute → idempotent per experiment.** Decays toward `prior` with age so a written-off lever resurrects. Written/read by [[../libraries/lever-memory]]; maintained by [[../inngest/storefront-lever-memory]]; surfaced on [[../dashboard/storefront__funnel]]. Migration `20260624120000_storefront_lever_memory.sql`. RLS: workspace-member SELECT, service-role write. Part of [[../goals/storefront-optimizer]] (M2). Spec `docs/brain/specs/storefront-lever-importance-memory.md`.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid → workspaces | cascade |
| `lever_id` | uuid → [[storefront_levers]] | cascade |
| `product_id` | uuid → products | cascade |
| `lander_type` | text | `pdp` \| `listicle` \| `beforeafter` \| `advertorial` (CHECK) |
| `audience` | text | audience key (default `'all'`) |
| `importance` | float8 | current posterior `[0,1]` (CHECK). Recomputed from `prior` + `evidence`; decayed toward `prior` with age |
| `prior` | float8 | the value this posterior started from `[0,1]` — the cold lever prior OR a general-learning transfer seed. Decay drifts `importance` back toward this |
| `n_tests` | int | number of contributing experiments (= `evidence.length`) |
| `last_tested_at` | timestamptz | when the most recent experiment committed; drives decay + the re-probe explore bonus |
| `evidence` | jsonb | append-only `[{experiment_id, proxy_delta, signal, weight, action, at}]`. The posterior is recomputed from this, so a re-run never double-counts (idempotent, keyed by `experiment_id`) |
| `scope` | text | `product_specific` \| `general` (CHECK) — only `general` transfers cross-product |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** UNIQUE `(lever_id, product_id, lander_type, audience)` — one posterior per cohort; `(workspace_id, product_id, lander_type)`; partial `(lever_id, lander_type, audience) WHERE scope='general'` — the cross-product transfer lookup.

## How a posterior moves

- **`importance = posteriorFromEvidence(prior, evidence)`** — a weighted average of the prior (`PRIOR_WEIGHT=1`) and each experiment's `signal` (its confidence `weight`). `signal = |proxy_delta| / SIGNAL_SCALE` clamped `[0,1]`: a meaningful proxy lift (or loss) → high signal → importance raised above prior; a ~0 delta → signal≈0 → importance demoted below prior.
- **Decay:** the [[../inngest/storefront-lever-memory]] daily pass sets `importance = prior + (importance − prior)·0.5^(ageDays/30)`. Does **not** touch `evidence`/`last_tested_at` — a fresh experiment recomputes at full strength and resets the clock.
- **Transfer seed:** a brand-new cohort with no row seeds `prior` from the average of `general`-scoped rows for the same lever+lander+audience on *other* products (else the cold lever prior).

## Gotchas

- **Append-evidence, never destructive.** A loss is recorded as much as a win ("commit the learning, win or loss"). An experiment already in `evidence` is a no-op (idempotent).
- **Committed once.** [[../libraries/storefront-experiment-refresh]] commits a learning when an experiment reaches a terminal outcome (promote/kill/rolled_back); the daily re-eval of a `promoted` experiment doesn't re-count it.
- **The map is a tool, not the objective.** It directs test budget; the Growth director + the M3 reconciler supervise it. A surprising swing is surfaced (the `evidence` log + structured logs), not silently trusted.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
