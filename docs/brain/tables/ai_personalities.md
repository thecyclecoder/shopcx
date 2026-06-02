# ai_personalities

Named AI personalities — tone, style, sign-off, emoji policy. Referenced by `ai_channel_config`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `description` | `text` | ✓ |  |
| `tone` | `text` | — | default: `'friendly'` |
| `style_instructions` | `text` | — | default: `''` |
| `sign_off` | `text` | ✓ |  |
| `greeting` | `text` | ✓ |  |
| `emoji_usage` | `text` | — | default: `'minimal'` |
| `language` | `text` | — | default: `'en'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ai_channel_config]].`personality_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ai_personalities")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("ai_personalities")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
