# fraud_case_history

State transitions on a fraud case (open → reviewing → confirmed_fraud / dismissed).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `case_id` | `uuid` | — | → [[fraud_cases]].id |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `user_id` | `uuid` | ✓ |  |
| `action` | `text` | — |  |
| `old_value` | `text` | ✓ |  |
| `new_value` | `text` | ✓ |  |
| `notes` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `case_id` → [[fraud_cases]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("fraud_case_history")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("fraud_case_history")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
