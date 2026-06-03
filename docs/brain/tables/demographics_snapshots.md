# demographics_snapshots

Per-workspace cohort demographic snapshots (frozen view of a segment at a point in time).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | ✓ | → [[products]].id |
| `total_customers` | `int4` | — | default: `0` |
| `enriched_count` | `int4` | — | default: `0` |
| `gender_distribution` | `jsonb` | — | default: `'{}'` |
| `age_distribution` | `jsonb` | — | default: `'{}'` |
| `income_distribution` | `jsonb` | — | default: `'{}'` |
| `urban_distribution` | `jsonb` | — | default: `'{}'` |
| `buyer_type_distribution` | `jsonb` | — | default: `'{}'` |
| `top_health_priorities` | `jsonb` | — | default: `'[]'` |
| `suggested_target_customer` | `text` | ✓ |  |
| `archetype_tuples` | `jsonb` | ✓ | write-through cache of the **JOINT** four-field demographic archetypes (gender × age × life_stage × income) + cohort basis — basis for the ad-tool avatar proposal generator. Added by `supabase/migrations/20260604140000_ad_tool_archetype_cache.sql`. |
| `computed_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("demographics_snapshots")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

## Gotchas

- Every distribution column (`gender_distribution`, `age_distribution`, …) stores **MARGINAL** distributions only — each field independently. The **JOINT** four-field archetype tuples (e.g. "female · 55-64 · family · 80-100k") live ONLY in `archetype_tuples`, populated by the ad-tool avatar proposal generator ([[../libraries/ad-avatar-proposals]]) as a write-through cache (recomputes when absent / stale >7 days / forced). `archetype_tuples` is the four-field tuple only — never `health_priorities`/`buyer_type`/geo.
- Probe before assuming — see [[../README]] § Probing technique.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
