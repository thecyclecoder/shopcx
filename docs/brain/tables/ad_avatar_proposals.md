# ad_avatar_proposals

AI-proposed spokesperson archetypes for a product, grounded in a demographic snapshot. When confirmed, a row is promoted to [[ad_avatars]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `archetype_brief` | `jsonb` | ✓ | `{name, wardrobe, setting, hook_delivery_style, photoshoot_brief}` |
| `demographic_basis` | `jsonb` | ✓ | `{cohort_size, gender_share, age_range_share, life_stage_share, income_bracket_share, used_fallback_snapshot}` — **FOUR-field tuple only** (gender / age_range / life_stage / income_bracket) |
| `status` | `text` | — | default: `'proposed'` · `proposed` \| `confirmed` \| `rejected` \| `archived` |
| `confirmed_avatar_id` | `uuid` | ✓ | → [[ad_avatars]].id |
| `created_by` | `uuid` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `confirmed_avatar_id` → [[ad_avatars]].`id`
- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_avatars]].`proposed_from_id`

## Common queries

### List proposals for a product (newest first)
```ts
const { data } = await admin.from("ad_avatar_proposals")
  .select("id, status, archetype_brief, demographic_basis, confirmed_avatar_id")
  .eq("workspace_id", workspaceId)
  .eq("product_id", productId)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("ad_avatar_proposals")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

## Gotchas

- Enum values are **lowercase** (`status`).
- `demographic_basis` is a strict **four-field tuple** — gender_share / age_range_share / life_stage_share / income_bracket_share (plus cohort_size + used_fallback_snapshot). **Never** include `health_priorities`, `buyer_type`, or `geo`.
- Confirming a proposal sets `status='confirmed'` and links `confirmed_avatar_id` → the new [[ad_avatars]] row (which back-links via `proposed_from_id`).
- Written by `src/lib/ad-avatar-proposals.ts`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
