# journey_step_events

Append-only audit log of every step response within a journey session.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `session_id` | `uuid` | — | → [[journey_sessions]].id |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `step_index` | `int4` | — |  |
| `step_key` | `text` | — |  |
| `response_value` | `text` | — |  |
| `response_label` | `text` | — |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `session_id` → [[journey_sessions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("journey_step_events")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("journey_step_events")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
