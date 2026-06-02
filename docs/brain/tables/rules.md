# rules

Compound AND/OR rules engine — ordered actions, 8 action types. Evaluated on inbound events.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `description` | `text` | ✓ |  |
| `enabled` | `bool` | ✓ | default: `true` |
| `trigger_events` | `text[]` | — |  |
| `conditions` | `jsonb` | — | default: `'{"groups": [], "operator": "AND"}'` |
| `actions` | `jsonb` | — | default: `'[]'` |
| `priority` | `int4` | ✓ | default: `0` |
| `stop_processing` | `bool` | ✓ | default: `false` |
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
const { data } = await admin.from("rules")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("rules")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
