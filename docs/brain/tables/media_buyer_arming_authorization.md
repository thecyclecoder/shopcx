# media_buyer_arming_authorization

Per-workspace **weekly arming authorization** for the Media Buyer agent — Phase 1 of [[../specs/media-buyer-arming-gate]] (M3 milestone of [[../goals/autonomous-media-buyer-supervision]]). One row per `(workspace_id, meta_ad_account_id, iso_week)` pins whether the Media Buyer cohort is authorized to move from `mode='shadow'` (audit-only) to `mode='armed'` (executor may act) for that ISO week.

**Why it exists.** M3 formalises the goal's "once armed, blended CAC held at/under the LTV-derived target" criterion as a **pre-arming precondition**, not a post-hoc alarm. Three preconditions must all clear before the executor may execute: (1) shadow-vs-review AGREEMENT rate ≥ 0.8 on ≥ 20 reviewed shadow actions over 14d, (2) at least 7 consecutive `band='green'` [[media_buyer_sensor_trust]] snapshots, (3) blended [[../libraries/blended-cac-ltv]] `cacLtvRatio ≥ 3` (or under the caller's target). Any failing predicate lands `allowed=false` + a structured `reasons` payload naming the branch that refused, and the gate escalates to the CEO via [[../libraries/platform-director]] `escalateDiagnosisToCeo` + writes a Growth-owned [[director_activity]] row (`action_kind='media_buyer_arming_denied'`).

**Distinct from the neighbouring signals.** Keep them straight:

- [[media_buyer_shadow_reviews]] carries one review per shadow action — INPUT to the agreement precondition.
- [[media_buyer_sensor_trust]] is the per-day sensor-quality signal — INPUT to the trust-streak precondition.
- [[media_buyer_test_cohorts]] designates the entry rail at PUBLISH time (test ad set + daily USD ceiling).
- **This** table is the AUTHORITATIVE WEEK-SCOPED VERDICT the executor reads to decide whether to arm.

**Scope axes** — every row is workspace-scoped (`workspace_id NOT NULL`); the ad-account + week axes are the sample bucketing:

- `meta_ad_account_id` — `NULL` = workspace-wide row; non-null = per-account row. The `runMediaBuyerArmingGate` runner computes both, matching how the sensor-trust probe scopes its rows.
- `iso_week` — ISO 8601 week label (`YYYY-Www`, e.g. `2026-W28`). The sample window resets weekly — a row is valid for THAT week only.

**Owner-editable? No.** Service-role written only — [[../libraries/media-buyer__arming-gate]] `runMediaBuyerArmingGate` is the sole writer. Workspace members can `SELECT` (RLS) so the future Media Buyer surface can display the allow/deny + reasons, but they never edit rows directly. To re-authorise a denied cohort, fix the failing predicate then re-run the gate.

**Ships empty.** Every workspace starts with zero rows. The Media Buyer executor treats a missing / expired row as **denied** (a rail-equivalent refusal). A workspace that has never run the arming-gate lane has an OFF-by-default Media Buyer — that's the correct behaviour.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · `NULL` = workspace-wide; non-null = per-account |
| `iso_week` | `text` | NOT NULL · ISO 8601 week label (`YYYY-Www`) |
| `allowed` | `bool` | NOT NULL · `true` = every precondition cleared; `false` = at least one denial branch fired |
| `reasons` | `jsonb` | NOT NULL default `'[]'` · `{ reasons: [{code, detail}], metrics: {...} }` — the structured payload behind the verdict (branch codes + measurements) |
| `evaluated_at` | `timestamptz` | NOT NULL default `now()` · the wall-clock the gate ran |
| `expires_at` | `timestamptz` | NOT NULL · `evaluated_at + 7d` — the executor treats a row past `expires_at` as denied even if `allowed=true` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by the `media_buyer_arming_authorization_touch_updated_at` trigger on any upsert re-write |

## Indexes

- `media_buyer_arming_authorization_ws_account_week_key` — UNIQUE `(workspace_id, coalesce(meta_ad_account_id::text, ''), iso_week)`. One row per `(workspace, meta_ad_account, iso_week)`; folding NULL `meta_ad_account_id` to `''` lets a workspace-wide row coexist with per-account rows for the same week. The runner writes through `.upsert(..., { onConflict: 'workspace_id,meta_ad_account_id,iso_week' })`.

## Triggers

- `media_buyer_arming_authorization_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()` so an upsert re-write leaves a fresh timestamp for the executor to compare against.

## Who writes / reads

- **Writer:** [[../libraries/media-buyer__arming-gate]] `runMediaBuyerArmingGate` — the sole writer. Service-role only, invoked from a Growth-supervised box lane on cadence.
- **Reader (planned):** the Media Buyer executor — reads the newest row for `(workspaceId, metaAdAccountId, isoWeek)` and refuses to switch `mode='armed'` when `allowed=false` OR the row is expired. Until the executor's arm-lane lands, the row exists as evidence for the flip only.

## Deny branches (`reasons[].code`)

- `insufficient_sample` — fewer than 20 reviewed shadow actions in the last 14d.
- `low_agreement` — concur rate below 0.8.
- `trust_no_snapshots` — zero sensor-trust snapshots in the window.
- `trust_streak_short` — fewer than 7 consecutive `band='green'` snapshots ending at the latest.
- `blended_cac_ltv_below_target` — blended `cacLtvRatio` present but under the target (default 3×).
- `blended_cac_ltv_unknown` — blended `cacLtvRatio` null (no CAC / no LTV / no mapped ad account).

## Gotchas

- **Missing row = denied.** The executor treats "no row" the same as `allowed=false`. This is the goal's "hitting a rail = escalate, not execute" north-star encoded at the read site.
- **Week-scoped, not rolling.** Each ISO week gets its own row. A `2026-W28` allow does NOT imply `2026-W29` — the sample window resets weekly and the gate must re-run.
- **`expires_at` short-circuits stale rows.** Even an `allowed=true` row past its `expires_at` reads as denied. The 7d TTL matches the ISO-week semantic — a row authored on the last day of a week expires early in the next.
- **`reasons.metrics` is the audit truth.** The `reasons` JSON carries both the branch codes AND the measurements (reviewed count, agreement rate, consecutive-green count, cacLtvRatio) so the CEO card / director grader / re-run comparison can cite the numbers without re-derivation.
