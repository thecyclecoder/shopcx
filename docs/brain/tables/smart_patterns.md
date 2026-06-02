# smart_patterns

Global + workspace-scoped patterns. 3-layer classifier (keywords → embeddings → Haiku fallback).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | ✓ | → [[workspaces]].id |
| `category` | `text` | — |  |
| `name` | `text` | — |  |
| `phrases` | `jsonb` | — | default: `'[]'` |
| `match_target` | `text` | ✓ | default: `'body'` |
| `priority` | `int4` | ✓ | default: `50` |
| `auto_tag` | `text` | ✓ |  |
| `auto_action` | `text` | ✓ |  |
| `active` | `bool` | ✓ | default: `true` |
| `source` | `text` | ✓ | default: `'manual'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `embedding` | `vector` | ✓ |  |
| `embedding_text` | `text` | ✓ |  |
| `description` | `text` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[pattern_feedback]].`pattern_id`
- [[workspace_pattern_overrides]].`pattern_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("smart_patterns")
  .select("id, name, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("smart_patterns")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Global patterns (no `workspace_id`) + workspace-scoped overrides via `workspace_pattern_overrides`.
- 3-layer classifier: keyword match → pgvector embedding → Claude Haiku fallback.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
