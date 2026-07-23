# iteration_policies

The Storefront Iteration Engine's **Phase 4c** control surface — the versioned,
typed policy the engine reads to bound every autonomous action. This is the future
**AI Growth Director's** governance table: the Growth Director (or a human) authors
new versions with a rationale; the **engine reads the active version read-only and
never writes it**. With **no active version, the engine takes zero autonomous
actions** (the core safety invariant — enforced in [[../libraries/meta__decision-engine]]
`loadActivePolicy`). Global in v1 (`campaign_id`/`meta_ad_account_id` null);
non-null scoping is a reserved per-object override the engine can honor with no
migration. Migration `20260620150000_iteration_policy_action_tables.sql`. RLS:
workspace-member SELECT, service-role write. See
[[../specs/storefront-iteration-engine]] (Phase 4c) + [[../functions/growth]].

**Primary key:** `id`

## Grain

One row per policy **version**. `version` is unique per workspace among global
(campaign-less) rows (partial unique index). At most **one** `status='active'`
global row exists per workspace (partial unique index `iteration_policies_one_active_idx`)
— activating a new version supersedes the prior active one.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` · stamped onto every [[iteration_actions]] |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | ✓ | → [[meta_ad_accounts]].id · reserved scope (null = workspace-global) |
| `campaign_id` | `text` | ✓ | per-campaign override (reserved; null = global) |
| `version` | `int` | — | monotonically increasing per workspace scope |
| `status` | `text` | — | `pending` \| `active` \| `superseded` (CHECK, default `pending`) |
| `created_by` | `text` | — | `agent` \| `human` (CHECK, default `human`) |
| `rationale` | `text` | ✓ | why this version exists (Growth Director legibility) |
| `roas_floor` | `numeric` | — | ROAS below which an object underperforms |
| `scale_up_roas_trigger` | `numeric` | — | ROAS at/above which to scale up |
| `scale_up_step_pct` | `numeric` | — | per-step budget increase (e.g. 0.20) |
| `scale_up_cap_pct` | `numeric` | — | max single-step increase |
| `scale_down_step_pct` | `numeric` | — | budget reduction on underperformance |
| `pause_min_spend_cents` | `bigint` | — | min window spend before pause is eligible |
| `pause_window_days` | `int` | — | window the pause trigger evaluates |
| `unpause_sales_after_pause` | `bigint` | — | sales (cents) since pause to consider unpausing |
| `unpause_lookback_days` | `int` | — | how far back to look for the pause + sales |
| `min_creatives_per_adset` | `int` | — | replenish trigger |
| `per_object_cooldown_hours` | `int` | — | min hours between actions on one object |
| `per_account_daily_budget_delta_ceiling_cents` | `bigint` | — | run-wide budget-change ceiling |
| `min_budget_floor_cents` | `bigint` | ✓ | never scale an object below this (null = no floor) |
| `never_pause_object_ids` | `text[]` | — | never fully pause these objects (default `{}`) |
| `mode` | `text` | — | `shadow` \| `armed` (CHECK, default `shadow`) — freshly activated versions ALWAYS start `shadow` (read-only branch — plan only, no [[iteration_actions]] / [[ad_publish_jobs]] writes). A separate flip surface (spec `media-buyer-armed-flip-surface`) moves a version to `armed` after human review. Migration `20260708021500_iteration_policies_mode.sql`. |
| `activated_by` | `uuid` | ✓ | → `auth.users`.id (who flipped pending → active) |
| `activated_at` | `timestamptz` | ✓ | activation time |
| `superseded_by` | `uuid` | ✓ | → [[iteration_policies]].id (the version that replaced this) |
| `superseded_at` | `timestamptz` | ✓ | supersede time |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |
| `dahlia_rubric_min_composite` | `int` | — | default `7` — the per-workspace THRESHOLD Max's Phase-2 5-axis [[ad_creative_copy_qc_verdicts]]`.dahlia_rubric` composite (0..10) must clear before a Dahlia creative flips to `ad_campaigns.status='ready'` in Bianca's ready-to-test bin. Read by [[../libraries/dahlia-rubric-gate]] `resolveDahliaRubricMinComposite` — same fail-closed shape as `resolveLf8UnderperformanceThreshold` (a missing/errored row refuses to authorize an auto-bin). Tunable per workspace so the bar ratchets up as Dahlia's baseline improves; the migration seeds every row at `7` (spec's opening bar). [[../specs/dahlia-researches-from-winners-flow-ad-library]] Phase 3. |
| `slow_kill_min_spend_cents` | `int` | — | default `60000` — spend floor (cents) at/above which a converter with CAC > `slow_kill_max_cpa_cents` is a dud (kill before the $1,200 deadline). Closes the 2026-07-12 over-correction where an over-CPA converter runs to the deadline (Amazing Coffee $1,199 / CAC $400). CEO 2026-07-15 rule: once an adset has spent ≥ $600, if CAC > $300 it is a dud. Consumed by [[../libraries/testing-results-sdk]] `tierForTest` (SSOT — Bianca's kill and the dashboard dud badge read the same verdict). Migration `20261205120000_iteration_policies_slow_kill_knobs.sql`. |
| `slow_kill_max_cpa_cents` | `int` | — | default `30000` — CAC ceiling (cents) past `slow_kill_min_spend_cents`; a converter with CAC > this is a dud. ~2× the $150 crown target and over the $220 hold band, so a promising converter is never touched (the skeptic v3 $226 near-miss protection is preserved by design). CEO 2026-07-15. Consumed by [[../libraries/testing-results-sdk]] `tierForTest`. Migration `20261205120000_iteration_policies_slow_kill_knobs.sql`. |

## Indexes

- partial unique `(workspace_id, version) where campaign_id is null` — one version number per global policy line.
- partial unique `(workspace_id) where status='active' and campaign_id is null` — at most one active global policy.
- `(workspace_id, status, version)` — version history per workspace.

## Lifecycle

`pending` → (human flips, v1; `activated_by`/`activated_at` set) → `active`;
activating a new version sets the prior active row to `superseded`
(`superseded_by`/`superseded_at`). Field design (`created_by='agent'`) allows the
Growth Director to self-author + self-activate later with no migration.

**Shadow-default invariant (media-buyer-shadow-mode Phase 1).** Every freshly
authored + activated version starts `mode='shadow'` — the media-buyer runtime
computes the plan but writes ZERO [[iteration_actions]] / [[ad_publish_jobs]]
rows, emitting `*_shadow` [[director_activity]] rows instead so a human can
concur/dissent before the loop moves budget. The flip to `mode='armed'` is a
separate, audited surface (spec `media-buyer-armed-flip-surface`). Existing
`status='active'` rows backfilled to `armed` on the migration so the pre-shadow
armed workspaces keep their runtime behavior.

## Consumers

- [[../libraries/meta__decision-engine]] `loadActivePolicy` reads the latest
  `status='active'` row per workspace (typed `IterationPolicy` contract). Null ⇒
  zero autonomous actions.
- Every [[iteration_actions]] row stamps `policy_version_id` = the authorizing
  version, so each action is traceable to the policy that allowed it.

## Gotchas

- The engine **never** writes this table — only the Growth Director / human does.
  Policy edits are versioned + activation-gated.
- v1 is **global**: rows have null `campaign_id`/`meta_ad_account_id`. Don't read
  per-campaign overrides until that path ships.
- Monetary thresholds are **cents**; `*_pct` fields are fractions (0.20 = 20%).
