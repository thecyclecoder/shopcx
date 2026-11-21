# `customer_lifecycle_experiment_assignments` — one persisted arm per customer group per experiment

Exactly one persisted arm assignment per customer identity GROUP per experiment. Keyed on the [[customer_links]] `group_id` — one real person = one group across all their linked accounts = ONE arm, so every account of a person shares the same arm. The UNIQUE `(experiment_id, group_id)` constraint is what makes assignment **sticky, idempotent, and fixed at first eligibility**: an arm can never be duplicated or silently flipped once written. Written + read ONLY through [[../libraries/subscriber-experiments]] (`assignArm` / `getArm`). Parent experiment: [[customer_lifecycle_experiments]]. Migration `20270121120000_customer_lifecycle_experiments.sql`. RLS: service-role only. Spec: `subscriber-experiment-harness`.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | default `gen_random_uuid()` |
| `workspace_id` | uuid → [[workspaces]] | cascade |
| `experiment_id` | uuid → [[customer_lifecycle_experiments]] | cascade |
| `group_id` | uuid | the customer identity group id from [[customer_links]] (`group_id`). For an unlinked customer this is the customer's own id (its singleton group). This — NOT a single `customer_id` — is the assignment grain. |
| `arm` | text | `treatment` (gets the reminder) \| `holdout` (gets nothing new). CHECK. The permanent arm, decided once by the sticky hash. |
| `assigned_at` | timestamptz | when the arm was first assigned. default `now()`. |

**Indexes:** `(experiment_id)`; UNIQUE `(experiment_id, group_id)`.

## Gotchas
- **The unique constraint IS the stickiness guarantee.** `assignArm` inserts once; on a conflict it reads the existing row and returns the stored arm. A customer can never silently switch arms, and a race between two concurrent first-touches converges on the single winning insert.
- **Grain is the person, not the account.** Always resolve the full linked-account group ([[customer_links]] `group_id` / `linkedIds`) BEFORE bucketing — a lone `customer_id` would let two accounts of the same person land in opposite arms.
- **Holdout is never reallocated.** Once a group is `holdout` it stays holdout for the life of the experiment — the clean, fixed assignment the 90-day net-revenue verdict is computed on.

## Related
[[customer_lifecycle_experiments]] · [[../libraries/subscriber-experiments]] · [[customer_links]]
