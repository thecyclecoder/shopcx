# remedies

Per-workspace retention remedies for cancel journey (coupon, pause, skip, frequency_change, free_product, line_item_modifier).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `type` | `text` | — |  |
| `config` | `jsonb` | — | default: `'{}'` |
| `description` | `text` | ✓ |  |
| `enabled` | `bool` | — | default: `true` |
| `priority` | `int4` | — | default: `0` |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `updated_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[remedy_outcomes]].`remedy_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("remedies")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("remedies")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- All remedy options come from this table — never hardcode. AI selects, admins configure.
- Types: `coupon`, `pause`, `skip`, `frequency_change`, `free_product`, `line_item_modifier`.
- Type-specific config lives in the `config` JSONB.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
