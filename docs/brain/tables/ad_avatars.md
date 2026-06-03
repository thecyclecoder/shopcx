# ad_avatars

Confirmed AI spokesperson characters (Higgsfield) used to render talking-head ad footage. Max 10 per workspace. Promoted from [[ad_avatar_proposals]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | ✓ |  |
| `higgsfield_character_id` | `text` | ✓ | from Higgsfield `create_character` |
| `reference_image_urls` | `text[]` | ✓ |  |
| `created_by` | `uuid` | ✓ |  |
| `status` | `text` | — | default: `'active'` · `active` \| `archived` |
| `cost_cents` | `int4` | — | default: `0` (≈250 = $2.50 / 40 credits) |
| `last_used_at` | `timestamptz` | ✓ |  |
| `proposed_from_id` | `uuid` | ✓ | → [[ad_avatar_proposals]].id (lineage) |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `proposed_from_id` → [[ad_avatar_proposals]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_avatar_proposals]].`confirmed_avatar_id`
- [[ad_campaigns]].`avatar_id`

## Common queries

### Active avatars per workspace
```ts
const { data } = await admin.from("ad_avatars")
  .select("id, name, higgsfield_character_id, last_used_at")
  .eq("workspace_id", workspaceId)
  .eq("status", "active")
  .order("last_used_at", { ascending: false, nullsFirst: false });
```

### Count since a given time
```ts
const { count } = await admin.from("ad_avatars")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Enum values are **lowercase** (`status`).
- **Hard cap of 10 active avatars per workspace** — creating a character costs ≈40 Higgsfield credits ($2.50), so reuse over re-create.
- `proposed_from_id` carries lineage back to the [[ad_avatar_proposals]] row this avatar was confirmed from.
- [[ad_campaigns]].`avatar_id` is `ON DELETE SET NULL` — deleting an avatar orphans its campaigns rather than cascading.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
