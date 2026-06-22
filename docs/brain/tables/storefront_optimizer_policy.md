# `storefront_optimizer_policy` — the storefront optimizer on-switch (OFF by default)

One row per workspace: the activation + product-scope gate the storefront optimizer (M4) + bandit framework (M1) read read-only before any autonomous **live** action. Mirrors [[iteration_policies]] (the ad iteration engine's control surface) — the owner/Growth-director-authored policy the engine consults but never writes. With `active=false` (the **default**) — or a product not in `product_scope` — the optimizer is **propose-only**: it forms hypotheses and surfaces what it *would* test, but stands up zero `running` experiments, assigns zero live variants, and writes no lander changes. Read via [[../libraries/optimizer-policy]] `loadStorefrontOptimizerPolicy` / `optimizerGateOpen`. Written by the Growth control surface ([[../dashboard/storefront__optimizer]] → `/api/workspaces/[id]/storefront-optimizer-policy`). Migration `20260624130000_storefront_optimizer_policy.sql`. RLS: workspace-member SELECT, service-role write. Part of the [[../goals/storefront-optimizer]] control surface; gates `storefront-optimizer-agent` (M4) + `storefront-experiment-bandit-framework` (M1). See spec `docs/brain/specs/storefront-optimizer-activation-gate.md` + [[../operational-rules]] § North star.

**Primary key:** `id` · **Grain:** one row per workspace (`workspace_id` UNIQUE).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | default `gen_random_uuid()` |
| `workspace_id` | uuid → workspaces | **UNIQUE** (one policy per workspace), cascade |
| `active` | boolean | **default `false`** — the on-switch. `false` ⇒ propose-only |
| `product_scope` | uuid[] | allowlist of `product_id`s the optimizer may touch. Empty (default) = nothing in scope. **Enforced**, not narrative |
| `max_concurrent_experiments` | int | guardrail · default `3` |
| `min_sample_sessions` | int | guardrail · default `50` (mirrors M1 `GUARDRAIL_MIN_SESSIONS`) |
| `holdout_pct` | numeric | guardrail · default `0.10`, CHECK `[0,1]` (sacred control band) |
| `ltv_regression_tolerance` | numeric | guardrail · default `0.15` (mirrors M1 `LTV_REGRESSION_TOLERANCE`) |
| `regression_windows_to_rollback` | int | guardrail · default `2` (mirrors M1 `REGRESSION_WINDOWS_TO_ROLLBACK`) |
| `refund_spike_delta` | numeric | guardrail · default `0.10` (mirrors M1 `REFUND_SPIKE_DELTA`) |
| `version` | int | bumped on each authored edit (Growth Director legibility) · default `1` |
| `created_by` | text | `agent` \| `human` (CHECK, default `human`) — agent-writable later |
| `rationale` | text | why the current settings (supervisability) |
| `activated_by` | uuid → auth.users | who flipped `active=true` (`on delete set null`) |
| `activated_at` | timestamptz | when `active` was last flipped true |
| `created_at` / `updated_at` | timestamptz | default `now()` |

## The gate

`optimizerGateOpen(policy, productId)` = `policy exists && policy.active && productId ∈ product_scope`. Every campaign-enqueue, experiment-activation, and live-variant-serve checks it:

- **Render** ([[../libraries/storefront-experiments]] `loadActiveExperiments`): gate closed ⇒ serves **no** live variant (control content only, zero `experiment_exposure` events). The negative invariant — with the gate off, no path assigns a live variant to a customer.
- **Refresh** ([[../libraries/storefront-experiment-refresh]]): gate closed ⇒ never **promotes** a winner to live traffic (held as `gated_propose_only`). Safety actions (kill, auto-rollback) still run — they only reduce live exposure. Reverting to OFF is graceful.
- **Agent** (M4, when it ships): gate closed ⇒ proposes but enqueues/activates nothing.

## Lifecycle

Created OFF (no row, or `active=false`) ⇒ propose-only. Owner flips `active=true` on the dashboard (stamps `activated_by`/`activated_at`) and adds products to `product_scope` ⇒ the gate opens for those products. Flipping `active=false` reverts to propose-only gracefully.

## Gotchas

- The engine **never** writes this table — only the Growth director / human does (same split as [[iteration_policies]]).
- **Empty `product_scope` = nothing in scope** (most conservative). The spec's "Amazing Coffee only to start" is achieved by the owner adding Amazing Coffee on the dashboard — not hardcoded (no `shopify_*_id`, UUIDs only; the gate can't resolve a product without an explicit scope).
- Guardrail defaults mirror the hardcoded M1 constants in [[../libraries/storefront-experiment-refresh]]; making them table-driven (so the refresh reads them) is a later phase — today they document/bound and the agent (M4) will read them.
- No row yet ⇒ `loadStorefrontOptimizerPolicy` returns null ⇒ gate closed (OFF-by-default holds pre-migration too).
