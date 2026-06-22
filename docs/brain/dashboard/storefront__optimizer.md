# Dashboard · storefront/optimizer

The owner/Growth **control surface** for the storefront optimizer — the on-switch + product scope + guardrails.

**Route:** `/dashboard/storefront/optimizer`

## Features

**Page title:** Storefront Optimizer

**Rendering:** `"use client"` component (client-side state + fetch).

**The on-switch:** a toggle bound to [[../tables/storefront_optimizer_policy]] `active`. OFF by default ⇒ **propose-only** (the agent surfaces what it would test but runs zero live experiments, assigns zero live variants, writes no lander changes). Flipping it on stamps `activated_by`/`activated_at`. Mirrors the ad engine's [[../tables/iteration_policies]] activation. The supervisable "go" per [[../operational-rules]] § North star.

**Product scope:** a checkbox allowlist of the workspace's active products → `product_scope`. **Enforced**, not advisory — a product not in scope is never touched even when active. Start with Amazing Coffee. Warns when active with an empty scope (nothing will run).

**Guardrails:** editable bounds (`max_concurrent_experiments`, `min_sample_sessions`, `holdout_pct`, `ltv_regression_tolerance`, `regression_windows_to_rollback`, `refund_spike_delta`) — the bounded proxy the optimizer + bandit operate within. Defaults mirror the M1 constants in [[../libraries/storefront-experiment-refresh]].

## API endpoints called

- `GET/PATCH /api/workspaces/[id]/storefront-optimizer-policy` — read/write the policy (owner/admin only). PATCH bumps `version` + stamps the activation audit.
- `GET /api/workspaces/[id]/products?status=active` — the product picker for scope.

## Permissions

Owner/admin (the API route checks `workspace_members.role ∈ {owner, admin}`).

## Related

[[../tables/storefront_optimizer_policy]] · [[../libraries/optimizer-policy]] · spec `docs/brain/specs/storefront-optimizer-activation-gate.md` · [[../goals/storefront-optimizer]]
