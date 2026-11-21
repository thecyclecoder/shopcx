# `customer_lifecycle_experiments` — one row per person-level lifecycle experiment

One row per self-running, person-grain lifecycle experiment — the spine the pre-renewal-reminder 50/50 test rests on. Carries the experiment's proxy metric, its holdout share, its **pre-registered** sample size (power calc) and its stop rule, all written down BEFORE launch so the verdict is credible. The persisted arms live in [[customer_lifecycle_experiment_assignments]]. Written + read ONLY through [[../libraries/subscriber-experiments]] (CLAUDE.md raw-`.from` STOP rule — a guard enforces the chokepoint). Migration `20270121120000_customer_lifecycle_experiments.sql`. RLS: service-role only. Part of goal [[../goals/pre-renewal-reminder-next-order-journey]] (M3 "Self-running 50/50 test"). Spec: `subscriber-experiment-harness`.

**This is deliberately NOT [[storefront_experiments]].** That framework is visitor/render grain with content-patch variants — the wrong grain (visitor, not person) and the wrong lever (content, not send/no-send) for a subscriber messaging test. This harness assigns once, at the person level, and never re-buckets.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | default `gen_random_uuid()` |
| `workspace_id` | uuid → [[workspaces]] | cascade |
| `slug` | text | stable human slug, e.g. `pre-renewal-reminder`. The SDK resolves an experiment by `(workspace_id, slug)`. UNIQUE with `workspace_id`. |
| `status` | text | `draft` \| `running` \| `stopped` \| `complete` (CHECK). Explicit operator lifecycle column — not derived. |
| `proxy_metric` | text | the primary success metric the test is powered to move. Default `'90d_net_revenue_per_customer'`. |
| `holdout_pct` | numeric | share (0..100) of identity groups routed to the TRUE holdout; the remainder goes to treatment. A 50/50 test with a real holdout is `50`. CHECK `[0,100]`. |
| `target_mde` | numeric | pre-registered target minimum detectable effect (relative lift on `proxy_metric`, e.g. `0.05`). |
| `power` | numeric | statistical power `1 - beta` (e.g. `0.8`). |
| `alpha` | numeric | significance level (e.g. `0.05`). |
| `baseline_cv` | numeric | assumed baseline coefficient of variation of `proxy_metric`, feeding the power calc. |
| `required_n_per_arm` | integer | the PRE-REGISTERED required sample size per arm (output of the power calc). The downstream verdict reads THIS fixed N — never decides N after seeing data. |
| `stop_rule` | text | the pre-registered stop rule — when the test ends. |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** `(workspace_id)`; UNIQUE `(workspace_id, slug)`.

## Lifecycle (status)
- `draft` → created, not yet assigning. `running` → actively assigning + sending. `stopped` → kill-switched / paused (stop rule tripped or operator halt). `complete` → verdict is in.

## Gotchas
- **Pre-registration is the point.** `required_n_per_arm` + `stop_rule` are populated at creation time from a power calc ([[../libraries/subscriber-experiments]] `powerCalcRequiredN`). Nothing downstream launches a test whose sample size + stop rule aren't written down — that is what makes the verdict credible.
- **Holdout is sacred + fixed.** `holdout_pct` defines a TRUE holdout that is never reallocated. The M2 reminder sends ask the SDK whether a customer is treatment or holdout; the holdout gets nothing new.
- **Owner + kill switch.** The harness is a node under the `retention` function in [[../libraries/control-tower-node-registry]] with a [[kill_switches]] ancestry. A trip stops NEW assignments (`assignArm` honours the switch) without destroying existing ones — the supervisable-autonomy north star.

## Related
[[customer_lifecycle_experiment_assignments]] · [[../libraries/subscriber-experiments]] · [[customer_links]] · [[kill_switches]] · [[../libraries/control-tower-node-registry]] · [[storefront_experiments]] (the visitor-grain sibling this is deliberately NOT)
