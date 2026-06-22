# `storefront_experiment_runs` — bandit-refresh audit trail

One row per [[../inngest/storefront-experiments]] refresh run — the supervisable record of every bandit decision (promote/kill/rollback) and the posterior snapshot that triggered it. Mirrors [[iteration_runs]] for the ads engine. Migration `20260623120000_storefront_experiments.sql`. RLS: workspace-member SELECT, service-role write.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid → workspaces | cascade |
| `trigger` | text | `cron` \| `manual` (CHECK) |
| `status` | text | `running` \| `complete` \| `failed` (CHECK) |
| `experiments_evaluated` | int | how many running/promoted experiments this run touched |
| `decisions` | jsonb | per-experiment decision snapshots — each `{experiment_id, action, win_prob, posteriors[], rule}` |
| `escalations` | jsonb | regression rollbacks escalated to Growth this run (surface, don't bury) |
| `counts` | jsonb | summary counts (`promoted`, `killed`, `rolled_back`, `attributed_orders`, …) |
| `conservative` | bool | whether the run ran in conservative mode (M3 not yet calibrated) |
| `error` | text | failure message when `status='failed'` |
| `started_at` / `finished_at` | timestamptz | |
| `duration_ms` | int | wall-clock |
| `created_at` | timestamptz | |

**Index:** `(workspace_id, started_at desc)` — the dashboard's recent-runs lookup.

## Gotchas
- **Supervisable, not silent.** Every promote/kill/rollback writes its triggering posterior snapshot here + the rule invoked; a regression rollback also lands in `escalations` and is surfaced on the [[../dashboard/storefront__funnel|funnel dashboard]]. This is the north-star audit trail ([[../operational-rules]] § North star).
