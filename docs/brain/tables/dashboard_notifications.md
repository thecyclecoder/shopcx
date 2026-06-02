# dashboard_notifications

Generic notification system — macro_suggestion, pattern_review, knowledge_gap, fraud_alert, manual_action_needed, etc. Surfaced in the bell.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `user_id` | `uuid` | ✓ |  |
| `type` | `text` | — |  |
| `title` | `text` | — |  |
| `body` | `text` | ✓ |  |
| `link` | `text` | ✓ |  |
| `metadata` | `jsonb` | ✓ | default: `'{}'` |
| `read` | `bool` | — | default: `false` |
| `dismissed` | `bool` | — | default: `false` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("dashboard_notifications")
  .select("id, title, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("dashboard_notifications")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
