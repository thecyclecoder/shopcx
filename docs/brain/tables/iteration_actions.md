# iteration_actions

The Storefront Iteration Engine's **Phase 4c** action ledger — the audit /
idempotency / reversal substrate for every **autonomous** decision (pause ·
unpause · scale_up · scale_down · replenish_creative) at the adset/campaign grain.
Each row cites its authority ([[iteration_policies]] version) and trigger (the
[[iteration_scorecards_daily]] row), carries before/after budget + status for
reversal, and records the Meta result once executed. The **engine appends/updates
this table only** (never [[iteration_policies]]). Written by
[[../libraries/meta__decision-engine]] `persistActions` (invoked by the Phase 5
cron; Phase 6a updates rows with execution results). Migration
`20260620150000_iteration_policy_action_tables.sql`. RLS: workspace-member SELECT,
service-role write. See [[../specs/storefront-iteration-engine]] (Phase 4c).

**Primary key:** `id`

## Grain

One row per `(workspace_id, meta_ad_account_id, object_id, action_type,
snapshot_date)` (unique) — at most one action of a given type per object per
scorecard day, so a cron re-run never double-acts. Per-object **cooldown** is
enforced on top in code (`loadRecentActions` + `per_object_cooldown_hours`).

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `snapshot_date` | `date` | — | the scorecard day this was decided on |
| `level` | `text` | — | `adset` \| `campaign` (CHECK) |
| `object_id` | `text` | — | Meta adset/campaign id acted on |
| `label` | `text` | ✓ | human-legible object name at decision time |
| `action_type` | `text` | — | `pause` \| `unpause` \| `scale_up` \| `scale_down` \| `replenish_creative` (CHECK) |
| `rationale` | `text` | — | surfaced reasoning: trigger + policy rule invoked |
| `policy_version_id` | `uuid` | ✓ | → [[iteration_policies]].id (authorizing version) |
| `triggering_scorecard_id` | `uuid` | ✓ | → [[iteration_scorecards_daily]].id (the row this cites) |
| `before_budget_cents` | `bigint` | ✓ | budget before the action |
| `before_status` | `text` | ✓ | Meta status before the action |
| `after_budget_cents` | `bigint` | ✓ | intended/applied budget after |
| `after_status` | `text` | ✓ | intended/applied status after |
| `status` | `text` | — | `decided` \| `executed` \| `failed` \| `escalated` \| `reversed` (CHECK, default `decided`) |
| `guardrail` | `text` | ✓ | which guardrail fired (escalated rows): `min_budget_floor` \| `per_account_daily_budget_delta_ceiling` \| `never_pause_list` |
| `external_result` | `jsonb` | ✓ | Phase 6a write-back: `{ meta_*_id, graph_response, ... }` |
| `executed_at` | `timestamptz` | ✓ | Phase 6a execution time |
| `outcome_roas` | `numeric` | ✓ | ROAS measured AFTER the action (reconcile stage) |
| `outcome_revenue_cents` | `bigint` | ✓ | revenue measured after |
| `outcome_window_days` | `int` | ✓ | window the outcome was measured over |
| `outcome_evaluated_at` | `timestamptz` | ✓ | when the outcome was measured |
| `reverses_action_id` | `uuid` | ✓ | → [[iteration_actions]].id — this action reverts that one |
| `reversed_by_action_id` | `uuid` | ✓ | → [[iteration_actions]].id — this action was reverted by that one |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

## Indexes

- `(workspace_id, meta_ad_account_id, created_at)` — `loadRecentActions` lookback.
- `(workspace_id, object_id, created_at)` — per-object cooldown + graduated-failure history.
- `(meta_ad_account_id, status, snapshot_date)` — daily action list per account.
- unique `(workspace_id, meta_ad_account_id, object_id, action_type, snapshot_date)`.

## Lifecycle

`decided` (4a decided, Phase 5 persisted) → (Phase 6a executes) → `executed`
(with `external_result`/`executed_at`) | `failed`. A guardrail hit is persisted
`escalated` with `guardrail` set — flagged for the Growth Director, **not
executed**. The reconcile stage (Phase 5) measures `outcome_*` and may emit a
reversing action, linking the two via `reverses_action_id` / `reversed_by_action_id`
(the reverted row flips to `reversed`).

## Consumers

- [[../libraries/meta__decision-engine]] `loadRecentActions` reads this for
  cooldown enforcement + graduated-failure (was-recently-scaled, last-pause).
- Phase 6a adapters update execution state + `external_result`.

## Gotchas

- The engine **never** writes [[iteration_policies]] — it only appends/updates
  this ledger.
- A `decided` row is a planned action, **not** a Meta change yet — Phase 6a is
  what touches Meta. Don't infer live state from `decided`/`escalated` rows.
- Monetary fields are **cents**.
