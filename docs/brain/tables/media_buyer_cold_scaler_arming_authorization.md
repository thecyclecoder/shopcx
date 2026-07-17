# media_buyer_cold_scaler_arming_authorization

Per-workspace **weekly arming authorization** for the Media Buyer agent's COLD SCALER cohort — Phase 1 of [[../specs/bianca-cold-scaler-arming-gate-shadow-to-armed]] (M4 milestone of [[../goals/bianca-temperature-aware-campaign-structure]]). One row per `(workspace_id, meta_ad_account_id, cold_scaler_cohort_id, iso_week)` pins whether the cold scaler cohort is authorized to move from `mode='shadow'` (audit-only) to `mode='armed'` (executor may move budget) for that ISO week.

**Why it exists.** The Bianca M4 north-star is that the scaler ships with its OWN shadow→armed arming — a scaler with no arming rail is exactly the ungradable autonomous-spend surface the goal names as the one thing it must not create. Three preconditions must all clear before the executor may move budget: (1) shadow-vs-review AGREEMENT rate ≥ 0.8 on ≥ 20 reviewed COLD-SCALER shadow actions over 14d, (2) at least 7 consecutive `band='green'` [[media_buyer_sensor_trust]] snapshots, (3) cold-scaler [[../libraries/blended-cac-ltv]] `cacLtvRatio ≥ 3` (or under the caller's target). Any failing predicate lands `allowed=false` + a structured `reasons` payload naming the branch that refused, and the gate escalates to the CEO via [[../libraries/platform-director]] `escalateDiagnosisToCeo` + writes a Growth-owned [[director_activity]] row (`action_kind='cold_scaler_arming_denied'`).

**Distinct from [[media_buyer_arming_authorization]]** — the sibling table authorizes the TEST cohort's shadow→armed flip; this one authorizes the COLD SCALER cohort's flip. Two tables, two independent authorizations — the test rail's arming decision does NOT imply the scaler rail's, and vice versa. Same three preconditions but scoped to disjoint samples (the loader filters shadow reviews to `metadata.surface='cold_scaler'`).

**Distinct from the neighbouring signals.** Keep them straight:

- [[media_buyer_shadow_reviews]] carries one review per shadow action — INPUT to the agreement precondition (filtered by parent `director_activity.metadata.surface='cold_scaler'`).
- [[media_buyer_sensor_trust]] is the per-day sensor-quality signal — INPUT to the trust-streak precondition.
- [[media_buyer_cold_scaler_cohorts]] designates the SCALER campaign + daily USD ceiling — the FK on `cold_scaler_cohort_id` points at that row.
- **This** table is the AUTHORITATIVE WEEK-SCOPED VERDICT the graduate-crowned-winners spec reads to decide whether to move budget onto the scaler.

**Scope axes** — every row is workspace-scoped (`workspace_id NOT NULL`); the ad-account + cohort + week axes are the sample bucketing:

- `meta_ad_account_id` — `NULL` = workspace-wide row; non-null = per-account row. The `runColdScalerArmingGate` runner computes both.
- `cold_scaler_cohort_id` — NOT NULL · → [[media_buyer_cold_scaler_cohorts]].id · ON DELETE CASCADE. Every row is scoped to one scaler cohort — a workspace with multiple active cohorts (one per product in a shared Meta account) carries independent authorizations.
- `iso_week` — ISO 8601 week label (`YYYY-Www`, e.g. `2026-W28`). The sample window resets weekly — a row is valid for THAT week only.

**Owner-editable? No.** Service-role written only — [[../libraries/media-buyer__cold-scaler-arming-gate]] `runColdScalerArmingGate` is the sole writer. Workspace members can `SELECT` (RLS) so the future Media Buyer surface can display the allow/deny + reasons, but they never edit rows directly. To re-authorise a denied cohort, fix the failing predicate then re-run the gate.

**Ships empty.** Every workspace starts with zero rows. The graduate-crowned-winners spec treats a missing / expired row as **denied** (a rail-equivalent refusal). A workspace that has never run the cold-scaler arming lane has an OFF-by-default scaler surface — that's the correct behaviour and the direct realization of the Bianca M4 "human-vetoable arming" guardrail.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · `NULL` = workspace-wide; non-null = per-account |
| `cold_scaler_cohort_id` | `uuid` | NOT NULL · → [[media_buyer_cold_scaler_cohorts]].id · ON DELETE CASCADE |
| `iso_week` | `text` | NOT NULL · ISO 8601 week label (`YYYY-Www`) |
| `allowed` | `bool` | NOT NULL · `true` = every precondition cleared; `false` = at least one denial branch fired |
| `reasons` | `jsonb` | NOT NULL default `'[]'` · `{ reasons: [{code, detail}], metrics: {reviewedCount, concurredCount, agreementRate, consecutiveGreenCount, cacLtvRatio, target} }` — the structured payload behind the verdict (branch codes + measurements) |
| `evaluated_at` | `timestamptz` | NOT NULL default `now()` · the wall-clock the gate ran |
| `expires_at` | `timestamptz` | NOT NULL · `evaluated_at + 7d` — the graduate spec treats a row past `expires_at` as denied even if `allowed=true` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by the `media_buyer_cold_scaler_arming_authorization_touch_updated_at` trigger on any upsert re-write |

## Indexes

- `media_buyer_cold_scaler_arming_authorization_ws_account_cohort_week_key` — UNIQUE `(workspace_id, coalesce(meta_ad_account_id::text, ''), cold_scaler_cohort_id, iso_week)`. One row per `(workspace, meta_ad_account, cold_scaler_cohort, iso_week)`; folding NULL `meta_ad_account_id` to `''` lets a workspace-wide row coexist with per-account rows for the same `(cohort, week)`. Expression index — the runner writes through a manual select-then-write compare-and-set (Supabase-js's `.upsert(...,{onConflict})` can't target an expression index; same reasoning as `media_buyer_arming_authorization`).

## Triggers

- `media_buyer_cold_scaler_arming_authorization_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()` so an upsert re-write leaves a fresh timestamp for the graduate spec to compare against.

## Who writes / reads

- **Writer:** [[../libraries/media-buyer__cold-scaler-arming-gate]] `runColdScalerArmingGate` — the sole writer. Service-role only, invoked from a Growth-supervised box lane on cadence.
- **Reader:** [[../libraries/media-buyer__cold-scaler-arming-gate]] `readLatestColdScalerArmingAuthorization` — the graduate-crowned-winners spec's chokepoint. Returns the newest row for `(workspaceId, metaAdAccountId, coldScalerCohortId)`; the graduate spec refuses to move budget when the row is missing, `allowed=false`, or past `expires_at`.

## Deny branches (`reasons[].code`)

- `insufficient_sample` — fewer than 20 reviewed cold-scaler shadow actions in the last 14d.
- `low_agreement` — concur rate below 0.8.
- `trust_no_snapshots` — zero sensor-trust snapshots in the window.
- `trust_streak_short` — fewer than 7 consecutive `band='green'` snapshots ending at the latest.
- `cac_ltv_below_target` — cold-scaler `cacLtvRatio` present but under the target (default 3×).
- `cac_ltv_unknown` — cold-scaler `cacLtvRatio` null (no CAC / no LTV / no mapped ad account).

## Gotchas

- **Missing row = denied.** The graduate spec treats "no row" the same as `allowed=false`. This is the Bianca M4 "human-vetoable arming rail" north-star encoded at the read site.
- **Week-scoped, not rolling.** Each ISO week gets its own row. A `2026-W28` allow does NOT imply `2026-W29` — the sample window resets weekly and the gate must re-run.
- **`expires_at` short-circuits stale rows.** Even an `allowed=true` row past its `expires_at` reads as denied. The 7d TTL matches the ISO-week semantic.
- **`reasons.metrics` is the audit truth.** The `reasons` JSON carries both the branch codes AND the measurements so the CEO card / director grader / re-run comparison can cite the numbers without re-derivation.
- **Cohort-scoped, not account-scoped.** A workspace with two active scaler cohorts (e.g. Coffee vs Creamer in a shared Meta ad account) carries INDEPENDENT authorizations — arming one does NOT arm the other. The FK on `cold_scaler_cohort_id` is the load-bearing distinction from [[media_buyer_arming_authorization]].
- **Shadow sample discriminator is `metadata.surface='cold_scaler'`.** The loader joins to `director_activity.metadata` and filters — a scaler shadow review with an unset / mistyped `surface` is silently excluded. Use [[../libraries/media-buyer__cold-scaler-arming-gate]] `writeColdScalerShadowActivity` to stamp the flag consistently.

## Migration

- **[[../specs/bianca-cold-scaler-arming-gate-shadow-to-armed]] Phase 1:** `supabase/migrations/20261023120000_media_buyer_cold_scaler_arming_authorization.sql` — apply with `npx tsx scripts/apply-media-buyer-cold-scaler-arming-authorization-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy DO $$ IF NOT EXISTS blocks, `create unique index if not exists`). RLS: service-role full access + workspace-member SELECT (mirrors [[media_buyer_arming_authorization]]).

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[media_buyer_cold_scaler_cohorts]] · [[media_buyer_arming_authorization]] · [[media_buyer_shadow_reviews]] · [[media_buyer_sensor_trust]] · [[director_activity]] · [[../libraries/media-buyer__cold-scaler-arming-gate]] · [[../libraries/media-buyer__arming-gate]] · [[../libraries/blended-cac-ltv]] · [[../specs/bianca-cold-scaler-arming-gate-shadow-to-armed]] · [[../goals/bianca-temperature-aware-campaign-structure]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
