# `storefront_experiment_variants` — one row per experiment arm

One row per arm of a [[storefront_experiments]] hypothesis: the control/holdout arm plus each variant under test. Each variant carries a **reversible content patch** over the DB-driven lander ([[advertorial_pages]]) plus the Thompson-sampling posterior state and the attributed exposure→outcome rollups. Read at render by [[../libraries/storefront-experiments]] `assignVariant`/`applyVariantPatch`; posteriors + rollups written by [[../libraries/storefront-experiment-attribution]] + [[../libraries/storefront-bandit]] via [[../inngest/storefront-experiments]]. Migration `20260623120000_storefront_experiments.sql`. RLS: workspace-member SELECT, service-role write.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | the `variant_id` carried in `experiment_exposure` event `meta` |
| `experiment_id` | uuid → [[storefront_experiments]] | cascade |
| `workspace_id` | uuid → workspaces | cascade (denormalized for RLS + queries, mirrors [[storefront_events]]) |
| `label` | text | human arm label (e.g. `control`, `headline-B`) |
| `is_control` | bool | the control/holdout arm — exactly one per experiment (partial unique index). Its `patch` is `{}` |
| `patch` | jsonb | the reversible content patch over the lander — `{headline, dek, publication, sponsorLabel, heroCaption, heroImageUrl, chapterHeading, chapterParagraphs, chapterOrder[], reasonsOrder[]}`. Applied by `applyVariantPatch`. NEVER a code deploy / offer / pricing change |
| `alpha` / `beta` | float8 | Beta-Bernoulli posterior over the conversion proxy (default `1`/`1` = uniform prior) |
| `reward_sum` / `n` | float8 / int | numeric-reward posterior inputs (predicted-LTV proxy sum / observation count) |
| `sessions` | int | attributed exposed sessions (Phase 3 rollup) |
| `conversions` | int | attributed conversions in the delayed-purchase window |
| `sub_attach` | int | attributed subscription conversions (sub-attach) |
| `revenue_cents` | int8 | attributed order revenue |
| `ltv_proxy_cents` | int8 | recorded predicted-LTV proxy (sub-attach × est-sub-LTV + one-time margin). M3 owns calibrating the proxy weights; this spec records the raw stream |
| `last_rolled_up_at` | timestamptz | last attribution refresh stamp |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** `(experiment_id)`; partial unique `(experiment_id) where is_control` — the holdout-is-sacred guarantee.

## Gotchas
- **Idempotent rollups.** Phase 3 recomputes `sessions`/`conversions`/`sub_attach`/`revenue_cents`/`ltv_proxy_cents` from the source exposure→order join each refresh and overwrites — a re-run never double-counts (the [[../specs/storefront-iteration-engine]] Phase 3 lesson). The posterior (`alpha`/`beta`) is derived from these, not incremented.
- **`patch` is the only live lever.** Promote/kill/rollback never edit `patch`; they flip the parent experiment `status` (+ `promoted_variant_id`). Restoring control = serving no patch.
- **Control arm reward is the rollback baseline.** Phase 5 compares each non-control arm's `ltv_proxy_cents` per session against the control arm's; below tolerance for `>=2` windows → auto-rollback.
