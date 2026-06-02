# chat_journeys

Active in-flight chat journey state per session (legacy — most chat journeys now use the same `journey_sessions` row as email).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `description` | `text` | ✓ |  |
| `trigger_intent` | `text` | — |  |
| `match_patterns` | `text[]` | ✓ | default: `'{}'` |
| `channels` | `text[]` | — | default: `'{chat}'` |
| `enabled` | `bool` | — | default: `false` |
| `priority` | `int4` | — | default: `0` |
| `steps` | `jsonb` | — | default: `'[]'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("chat_journeys")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("chat_journeys")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
