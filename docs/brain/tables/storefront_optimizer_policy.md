# storefront_optimizer_policy

The **control surface** for the Storefront Optimizer agent (M4) — the on-switch,
the enforced product scope, and the editable guardrails the agent reads to bound
every campaign. The storefront analogue of [[iteration_policies]] (the ad engine's
Growth-Director control surface): agent-**legible** + agent-**writable** (typed
fields, rationale, authorship) so the future **Growth director** operates it later
— but the engine reads it **read-only and never writes its own policy**. With
**`active=false` (the table default) the agent does not even propose** (fully idle)
— the safe-by-default invariant, enforced in [[../libraries/storefront-optimizer-policy]]
`evaluateProposalGate`. Migration `20260627120000_storefront_optimizer_policy.sql`.
RLS: workspace-member SELECT, service-role write. See
[[../specs/storefront-optimizer-activation-gate]] · [[../functions/growth]].

**Primary key:** `id`

## Grain

**One row per workspace** (`workspace_id` is `unique`). No versioning — edits update
the single row in place (`updated_by`/`updated_at` stamp who last changed it). This
is simpler than [[iteration_policies]]' version ledger because the gate is a small,
directly-editable surface, not a supersede-on-activate policy history.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · **unique** (one policy per workspace) |
| `active` | `boolean` | — | default **`false`** · "the agent proposes campaigns at all." OFF ⇒ fully idle |
| `product_scope` | `uuid[]` | — | default `{}` · enforced allowlist of [[products]].id the optimizer may touch |
| `auto_run_reversible` | `boolean` | — | default **`false`** · later opt-in: reversible levers may auto-run without the per-campaign tap (offers/structural stay gated regardless) |
| `max_concurrent_experiments` | `int` | — | default `3` · run-wide cap on live experiments |
| `min_sample` | `int` | — | default `200` · min per-arm exposures before a decision |
| `holdout_pct` | `numeric` | — | default `0.10` · sacred control band per experiment (fraction) |
| `auto_rollback_ltv_tolerance` | `numeric` | — | default `0.15` · LTV-proxy regression tolerance vs control (fraction) |
| `auto_rollback_windows` | `int` | — | default `2` · consecutive regressing windows before auto-rollback |
| `auto_rollback_refund_spike_delta` | `numeric` | — | default `0.10` · refund-rate spike over control that rolls back (fraction) |
| `created_by` | `text` | — | `agent` \| `human` (CHECK, default `human`) — lets the Growth director self-author later |
| `updated_by` | `uuid` | ✓ | an `auth.users`.id (plain uuid, **no FK** — the pooler apply role lacks REFERENCES on the `auth` schema) · who last edited the policy |
| `rationale` | `text` | ✓ | why this policy is set as it is (Growth legibility) |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

## Indexes

- partial `(workspace_id) where active = true` — fast lookup of switched-on workspaces.
- `unique (workspace_id)` (column constraint) — one policy row per workspace.

## Seed

The migration seeds the **Superfoods** workspace (resolved from the Amazing Coffee
product row, `ea433e56-0aa4-4b46-9107-feb11f77f533`) **`active=true`,
`product_scope=[amazing-coffee]`, `auto_run_reversible=false`** — the optimizer is
ON in **propose-and-approve** mode, scoped to Amazing Coffee, the moment M4 ships
(`on conflict (workspace_id) do nothing`, idempotent). The table default for every
*other* workspace is `active=false`.

## Consumers

- [[../libraries/storefront-optimizer-policy]] `loadOptimizerPolicy` /
  `evaluateProposalGate` — the gate M4 reads before proposing. Null/`active=false`
  ⇒ zero proposals; out-of-scope product ⇒ refused; reversible+opt-in ⇒ may
  auto-run, else a `needs_approval` Build/Approve card.
- The dashboard control surface `/dashboard/storefront/optimizer` (writes via
  `/api/workspaces/[id]/storefront-optimizer-policy`) — the on/off + scope +
  `auto_run_reversible` + guardrail editor. **Only humans/Growth edit it here.**

## Gotchas

- The optimizer agent **never** writes this table — only the Growth director / a
  human does (via the dashboard). Mirrors [[iteration_policies]]' read-only-to-engine
  contract.
- `product_scope` is **enforced in code**, not narrative — a proposal/activation for
  a product not in the allowlist is *refused*, even if a lander exists.
- `*_pct` / `*_tolerance` / `*_delta` are **fractions** (0.10 = 10%), not percents.
- `auto_run_reversible` only ever unlocks **reversible** levers; offer + structural
  changes are always approval-gated.
