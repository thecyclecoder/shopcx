# escalation_gaps

Audit of cases where the AI escalated AND a manual signal said it shouldn't have — feedback loop for confidence tuning.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `channel` | `text` | — |  |
| `detected_intent` | `text` | ✓ |  |
| `confidence` | `int4` | ✓ |  |
| `original_message` | `text` | — |  |
| `customer_context_summary` | `text` | ✓ |  |
| `resolved_as` | `text` | ✓ |  |
| `resolved_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("escalation_gaps")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("escalation_gaps")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Rows for a ticket
```ts
const { data } = await admin.from("escalation_gaps")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("escalation_gaps")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
