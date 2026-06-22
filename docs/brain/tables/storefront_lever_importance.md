# `storefront_lever_importance` — the learned lever-importance posterior store

One LEARNED posterior per `(lever × product × lander_type × audience)` cell: the optimizer agent's memory of which levers actually move predicted-LTV-per-visitor for a given product/lander/audience. Seeded from the [[storefront_levers]] CRO prior (or a `general` cross-product transfer) and updated to a posterior by each completed M1 experiment ([[../libraries/storefront-experiment-refresh]] → [[../libraries/storefront-lever-memory]] `updatePosterior`). Migration `20260624120000_storefront_levers.sql`. RLS: workspace-member SELECT, service-role write. Part of the [[../goals/storefront-optimizer]] (M2). Spec `docs/brain/specs/storefront-lever-importance-memory.md`.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid → workspaces | cascade |
| `lever_id` | uuid → [[storefront_levers]] | cascade |
| `product_id` | uuid → products | cascade |
| `lander_type` | text | `pdp` \| `listicle` \| `beforeafter` \| `advertorial` (CHECK) |
| `audience` | text | audience key (default `'all'`) |
| `importance` | double precision | current posterior in `[0,1]` (CHECK) — decay-adjusted at every write |
| `prior` | double precision | the prior this cell started from (CRO prior or transferred `general` seed) |
| `n_tests` | int | `= evidence.length` — the contributing experiment count |
| `last_tested_at` | timestamptz | last experiment that contributed; the decay clock |
| `evidence` | jsonb | append-only array of `{ experiment_id, proxy_delta, effect, won, source, at }` |
| `scope` | text | `product_specific` \| `general` (CHECK) — only `general` transfers cross-product |
| `seeded_from` | text | `cro_prior` \| `general_transfer` — where the initial prior came from |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** unique `(lever_id, product_id, lander_type, audience)` — one learning per cell; `(workspace_id, product_id, lander_type, audience)`; `(lever_id, scope)` — the cross-product transfer lookup.

## How the posterior moves
- **Reward = predicted-LTV-proxy delta.** `updatePosterior` reads the experiment's variant rollups, computes the best-arm-vs-control relative LTV-per-session delta, maps it to a `[0,1]` `effect` (a meaningful move ⇒ the lever matters ⇒ raise; a ~0 delta ⇒ it doesn't move the needle here ⇒ demote), appends an `evidence` entry, and **recomputes** `importance` from `prior + all evidence effects` (a Beta-style mean, prior weighed as `PRIOR_STRENGTH=2` pseudo-tests).
- **Decay.** The daily [[../inngest/storefront-lever-decay]] pass recomputes `importance` toward `prior` as `last_tested_at` ages (half-life 45d) — a written-off lever drifts back up to be re-probed.
- **Transfer.** A brand-new cell on a `general` lever seeds its `prior` from the average `importance` of that lever's `general`-scoped rows on OTHER products (`seeded_from='general_transfer'`), not the cold CRO prior.
- **M3 intake.** [[../libraries/storefront-lever-memory]] `applyReconciliationSignal` ingests the [[../specs/storefront-ltv-proxy-reconciler|M3 reconciler]]'s recalibration signal (`storefront_ltv_reconciliations`) if present, appending `source='m3_reconciler'` evidence keyed `m3:<id>` (best-effort, no hard dependency).

## Gotchas
- **Append-evidence, never destructive.** A loss is recorded as much as a win; `importance` is always DERIVED from `prior + evidence`, never set in place. Don't write `importance` directly — go through `updatePosterior` / the decay pass.
- **Idempotent.** Each experiment contributes once (deduped by `experiment_id` in `evidence`); a re-run leaves `n_tests` stable.
- **`importance` is decay-adjusted, `prior` is fixed.** `importance - prior` is what testing taught it (surfaced on the funnel dashboard's "what the agent believes matters" panel).
