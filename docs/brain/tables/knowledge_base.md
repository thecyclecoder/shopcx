# knowledge_base

Help center articles — slug, content_html, view_count, helpful_yes/no. Public-facing.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `title` | `text` | — |  |
| `content` | `text` | — |  |
| `category` | `text` | — |  |
| `active` | `bool` | — | default: `true` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `product_name` | `text` | ✓ |  |
| `product_shopify_id` | `text` | ✓ |  |
| `source` | `text` | — | default: `'manual'` |
| `slug` | `text` | ✓ |  |
| `published` | `bool` | ✓ | default: `false` |
| `content_html` | `text` | ✓ |  |
| `excerpt` | `text` | ✓ |  |
| `product_id` | `uuid` | ✓ | → [[products]].id |
| `view_count` | `int4` | — | default: `0` |
| `helpful_yes` | `int4` | — | default: `0` |
| `helpful_no` | `int4` | — | default: `0` |
| `crisis_id` | `uuid` | ✓ | → [[crisis_events]].id |

## Foreign keys

**Out (this → others):**

- `crisis_id` → [[crisis_events]].`id`
- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[kb_chunks]].`kb_id`
- [[knowledge_gaps]].`created_kb_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("knowledge_base")
  .select("id, title, created_at, updated_at, slug")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("knowledge_base")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
