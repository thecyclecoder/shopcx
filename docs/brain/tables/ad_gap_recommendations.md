# ad_gap_recommendations

The persisted, trackable queue for the **Ad Creative Scout's** gaps — the ad-side mirror of [[lander_recommendations]], built for the [[../specs/acquisition-research-hub|Acquisition Research Hub]] (M4 of [[../goals/acquisition-research-engine]]). The ad-gap layer ([[../libraries/ad-gap]] `buildAdGapReport`) computes "competitor angles we don't run" **deterministically on demand** and never persisted them — so an ad gap could not be approved, routed, or tracked. The hub **materializes** each surfaced ad gap here (idempotent on `dedup_key`, always `status='proposed'`); the owner approves → it routes to **Build** (an ad-creative iteration). One row per ad-angle gap. North-star: rows land `proposed` WITH evidence; nothing routes until the owner approves.

Written by [[../libraries/acquisition-hub]] `materializeAdGaps`; reviewed via `src/app/api/ads/acquisition/gaps/[id]`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `product_id` | `uuid` | ✓ | → [[products]].id · ON DELETE SET NULL · **nullable** — ad gaps are angle-clustered at the workspace level (`buildAdGapReport` reasons over the whole [[creative_skeletons]] corpus), unlike [[lander_recommendations]] |
| `gap_type` | `text` | — | default `'ad_angle'` (Phase 1 keys gaps on the angle) |
| `title` | `text` | — | the competitor angle label we don't run |
| `rationale` | `text` | — | the supervisable recommendation sentence |
| `route` | `text` | — | default `'build'` · CHECK ∈ `build` \| `optimizer` (ad gaps only use `build`; `optimizer` reserved for symmetry) |
| `target_slug` | `text` | ✓ | route=`build` only — the proposed ad-iteration spec slug |
| `evidence` | `jsonb` | — | default `'{}'` · `{ brandCount, brands[], maxDaysRunning, totalEstimatedSpend, formats[], offers[], ctas[], ads[] }` off the `AdGapRecommendation` |
| `status` | `text` | — | default `'proposed'` · CHECK ∈ `proposed` \| `approved` \| `rejected` |
| `route_result` | `jsonb` | ✓ | what approval enacted: `{ agent_job_id, spec_slug }` (build) |
| `reviewed_by` | `uuid` | ✓ | → `auth.users`.id · ON DELETE SET NULL |
| `reviewed_at` | `timestamptz` | ✓ | |
| `review_note` | `text` | ✓ | |
| `dedup_key` | `text` | — | `ad-angle:${slugify(label)}` — one rec per angle |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

**Unique:** `(workspace_id, dedup_key)` — re-materializing the deterministic ad-gap report never re-proposes the same angle (insert uses `ignoreDuplicates`, so a settled row is never reset to proposed).
**Index:** `(workspace_id, status, created_at desc)`.
**RLS:** workspace-member SELECT, service-role write (mirrors [[competitors]] / [[lander_recommendations]]).

## Gotchas
- **Materialized on hub load.** `loadHubData` calls `materializeAdGaps` (idempotent) on every GET — new angles appear as `proposed`; approved/rejected rows are preserved (insert-only-new).
- **Shipped/won are DERIVED**, not stored — the hub joins `route_result.agent_job_id` → [[agent_jobs]] (shipped = `completed`) for ad gaps. (Lander gaps may also derive `won` from [[storefront_experiments]] `promoted`.)

Migration `supabase/migrations/20260623140000_ad_gap_recommendations.sql` (apply: `scripts/apply-ad-gap-recommendations-migration.ts`). See [[../specs/acquisition-research-hub]] · [[../libraries/acquisition-hub]] · [[../libraries/ad-gap]].
