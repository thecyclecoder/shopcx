# macros

Canned response templates with embeddings + AI-suggestion counters. Discoverable by Sonnet.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `body_text` | `text` | — |  |
| `body_html` | `text` | ✓ |  |
| `category` | `text` | ✓ |  |
| `tags` | `text[]` | ✓ | default: `'{}'` |
| `variables` | `text[]` | ✓ | default: `'{}'` |
| `actions` | `jsonb` | ✓ | default: `'[]'` |
| `gorgias_id` | `int4` | ✓ |  |
| `active` | `bool` | — | default: `true` |
| `usage_count` | `int4` | — | default: `0` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `embedding` | `vector` | ✓ |  |
| `embedding_text` | `text` | ✓ |  |
| `product_id` | `uuid` | ✓ | → [[products]].id |
| `ai_suggest_count` | `int4` | — | default: `0` |
| `ai_accept_count` | `int4` | — | default: `0` |
| `ai_reject_count` | `int4` | — | default: `0` |
| `ai_edit_count` | `int4` | — | default: `0` |
| `last_suggested_at` | `timestamptz` | ✓ |  |
| `crisis_id` | `uuid` | ✓ | → [[crisis_events]].id |

## Foreign keys

**Out (this → others):**

- `crisis_id` → [[crisis_events]].`id`
- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ai_workflows]].`preferred_macro_id`
- [[macro_usage_log]].`macro_id`
- [[ticket_messages]].`macro_id`
- [[tickets]].`ai_suggested_macro_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("macros")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("macros")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Embeddings (1536) for similarity search.
- AI-suggestion counters: `ai_suggest_count`, `ai_accept_count`, `ai_reject_count`, `ai_edit_count` — drive acceptance-rate badges in settings.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
