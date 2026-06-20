# iteration_recommendations

The Storefront Iteration Engine's **Phase 4b** output — typed, rationale-backed
recommendations for anything that opens a **new live spend line** (new campaign/adset,
new benefit angle, new lander variant, offer test). Every row is created
`status='pending'` for Dylan to approve/reject; **nothing here goes live
automatically** — Phase 6b executes approved rows as PAUSED drafts and writes external
ids back into `external_result`. Written by [[../libraries/meta__decision-engine]]
`persistRecommendations` ([[../inngest/meta-performance]] `meta-decision-engine`).
Migration `20260620140000_iteration_recommendations.sql`. RLS: workspace-member SELECT,
service-role write. See [[../specs/storefront-iteration-engine]] (Phase 4b).

**Primary key:** `id`

## Grain

One row per `(workspace_id, meta_ad_account_id, snapshot_date, action_type, dedup_key)`
— `dedup_key` is a stable signature of `action_type` + target + key params, so a cron
re-run for the same day re-upserts rather than double-recommending.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `snapshot_date` | `date` | — | the scorecard day reasoned over |
| `action_type` | `text` | — | `new_static_adset` \| `new_video_adset` \| `new_campaign` \| `test_benefit_angle` \| `new_lander_variant` \| `offer_test` (CHECK) |
| `status` | `text` | — | `pending` \| `approved` \| `rejected` \| `executed` \| `failed` (CHECK, default `pending`) |
| `persona` | `text` | ✓ | `direct_response_marketer` \| `offer_designer` \| `media_buyer` (CHECK) |
| `title` | `text` | ✓ | short human label |
| `rationale` | `text` | — | the reasoning surfaced to Dylan |
| `source_metrics` | `jsonb` | — | the scorecard numbers cited (default `{}`) |
| `expected_impact` | `text` | ✓ | predicted effect, in words |
| `confidence` | `numeric` | ✓ | 0..1 model confidence |
| `target_object_level` | `text` | ✓ | `account` \| `campaign` \| `adset` \| `angle` \| `variant` (CHECK) |
| `target_object_id` | `text` | ✓ | meta object id \| angle uuid \| variant slug \| null (net-new) |
| `params` | `jsonb` | — | structured params the Phase 6b adapter needs (default `{}`) |
| `source_scorecard_ids` | `uuid[]` | — | [[iteration_scorecards_daily]] rows this was derived from (default `{}`) |
| `dedup_key` | `text` | — | idempotency signature within a day |
| `reviewed_by` | `uuid` | ✓ | → `auth.users`.id (reviewer) |
| `reviewed_at` | `timestamptz` | ✓ | approve/reject time |
| `review_note` | `text` | ✓ | reviewer note |
| `executed_at` | `timestamptz` | ✓ | Phase 6b execution time |
| `external_result` | `jsonb` | ✓ | Phase 6b write-back: `{ ad_publish_job_id, meta_*_id, ... }` |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

## Indexes

- `(meta_ad_account_id, status, snapshot_date)` — review queue per account.
- `(workspace_id, status, created_at)` — workspace-wide pending list.
- unique `(workspace_id, meta_ad_account_id, snapshot_date, action_type, dedup_key)`.

## Lifecycle

`pending` → (review surface) → `approved` | `rejected`; an `approved` row → (Phase 6b)
→ `executed` | `failed`. The review surface is
`src/app/api/ads/iteration-recommendations/route.ts` (GET) + `[id]/route.ts`
(POST `{ action: "approve" | "reject" }`). On approve the route fires
`meta/execute-recommendation` → [[../libraries/meta__recommendation-execute]]
`executeRecommendation`: an enabled type (`new_static_adset`/`new_video_adset`) creates
a PAUSED [[ad_publish_jobs]] draft and the publisher writes the meta ids back
(`status='executed'`); a deferred type stays `approved` with `external_result.deferred`.

## Gotchas

- **Only `pending` rows are reviewable** — the approve/reject route 409s on an
  already-decided row (idempotent re-approve guard).
- **Approve fires execution but never goes live** — the Phase 6b draft is always
  `publish_active=false` (PAUSED). Phases 4b and earlier never write to Meta.
- The autonomous half of Phase 4 (4a) lands in `iteration_actions` (Phase 4c), **not**
  here — this table is recommendations only.
- An execution that can't proceed (deferred adapter, or missing build inputs) leaves
  the row `approved` with `external_result.deferred` — it is **not** marked `failed`.

See [[../libraries/meta__decision-engine]] · [[../libraries/meta__recommendation-execute]] · [[../specs/storefront-iteration-engine]].
