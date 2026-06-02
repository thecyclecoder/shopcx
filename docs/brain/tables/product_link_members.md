# product_link_members

Members of a `product_link_groups` row.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `group_id` | `uuid` | — | → [[product_link_groups]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `value` | `text` | — |  |
| `display_order` | `int4` | — | default: `0` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `group_id` → [[product_link_groups]].`id`
- `product_id` → [[products]].`id`

**In (others → this):**

_None._

## Common queries

### Count since a given time
```ts
const { count } = await admin.from("product_link_members")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
