# ticket_views

Saved ticket filter combos. Nested up to 2 levels via parent_id. Live in sidebar.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `filters` | `jsonb` | — | default: `'{}'` |
| `sort_order` | `int4` | ✓ | default: `0` |
| `created_by` | `uuid` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `parent_id` | `uuid` | ✓ | → [[ticket_views]].id |
| `user_id` | `uuid` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `parent_id` → [[ticket_views]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ticket_views]].`parent_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ticket_views")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("ticket_views")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Nested 2 levels deep via `parent_id`. Don't recurse past that.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
