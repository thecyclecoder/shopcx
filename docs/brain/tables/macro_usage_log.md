# macro_usage_log

Per-use tracking of every macro send — source (ai/agent), outcome (accepted/rejected/personalized).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `macro_id` | `uuid` | — | → [[macros]].id |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `message_id` | `uuid` | ✓ | → [[ticket_messages]].id |
| `user_id` | `uuid` | ✓ |  |
| `source` | `text` | — |  |
| `outcome` | `text` | — |  |
| `ai_confidence` | `float8` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `macro_id` → [[macros]].`id`
- `message_id` → [[ticket_messages]].`id`
- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("macro_usage_log")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a ticket
```ts
const { data } = await admin.from("macro_usage_log")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("macro_usage_log")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
