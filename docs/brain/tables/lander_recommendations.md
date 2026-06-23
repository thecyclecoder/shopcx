# lander_recommendations

Vision-identified **gaps** between competitor landers and ours → supervisable PDP enhancement recommendations — the deliverable half of [[../specs/landing-page-scout]] (M3 of [[../goals/acquisition-research-engine]]). One row per gap. North-star: written `status='proposed'` WITH evidence; the owner approves before it routes to **Build** (a missing component spec) or the **storefront-optimizer** (a structural experiment). Written by [[../libraries/landing-page-scout]] `analyzeLanderGaps`; reviewed via `src/app/api/ads/lander-recommendations`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `product_id` | `uuid` | ✓ | → [[products]].id · ON DELETE SET NULL |
| `gap_type` | `text` | — | snake_case gap handle (`comparison_table`, `founder_story`, `ingredient_breakdown`, `guarantee_badges`, …) |
| `title` | `text` | — | One-line enhancement name |
| `rationale` | `text` | — | The supervisable evidence sentence ("3 of 4 competitors show a comparison table above the fold; ours has none") |
| `route` | `text` | — | CHECK ∈ `build` \| `optimizer` |
| `target_slug` | `text` | ✓ | route=`build` only — the proposed component spec slug the Build session authors |
| `evidence` | `jsonb` | — | default: `'{}'` · `{ competitor_snapshot_ids[], competitor_count, our_snapshot_id }` |
| `status` | `text` | — | default: `'proposed'` · CHECK ∈ `proposed` \| `approved` \| `rejected` |
| `route_result` | `jsonb` | ✓ | What approval enacted: `{ agent_job_id, spec_slug }` (build) or `{ experiment_id }` (optimizer) |
| `reviewed_by` | `uuid` | ✓ | → `auth.users`.id · ON DELETE SET NULL |
| `reviewed_at` | `timestamptz` | ✓ | |
| `review_note` | `text` | ✓ | |
| `dedup_key` | `text` | — | `${product_id\|'ws'}:${gap_type}` — one rec per gap per product |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

**Unique:** `(workspace_id, dedup_key)` — a re-run never re-proposes the same gap.

**Indexes:** `(workspace_id, status, created_at desc)` (owner list), `(workspace_id, product_id)`.

## Foreign keys

**Out (this → others):**
- `workspace_id` → [[workspaces]].`id`
- `product_id` → [[products]].`id`
- `reviewed_by` → `auth.users`.`id`

## Routing on approval

Approving (via `POST /api/ads/lander-recommendations/[id] { action:'approve' }`) calls [[../libraries/landing-page-scout]] `enactRecommendationRoute` BEFORE flipping status (a routing failure leaves the row reviewable):
- **route=`build`** → inserts an [[agent_jobs]] row (`kind='build'`, `spec_slug=target_slug`) — mirrors the storefront-optimizer's missing-tool→build. `route_result.agent_job_id` records it.
- **route=`optimizer`** → inserts a [[storefront_experiments]] DRAFT (`lever='lander-gap:<type>'`) + a control + a structural variant arm. `route_result.experiment_id` records it. Needs `product_id`.

## Gotchas

- **Never auto-approves / auto-routes** — `analyzeLanderGaps` only writes `proposed`; routing happens only inside the owner-gated approve action.
- **Rejected gaps stay rows** — the `dedup_key` blocks re-proposal of a rejected gap on the next run.

## Related

[[../specs/landing-page-scout]] · [[../libraries/landing-page-scout]] · [[lander_snapshots]] · [[agent_jobs]] · [[storefront_experiments]] · [[../specs/storefront-optimizer]]
