# ai_token_usage

Per-call AI token accounting — model, input/output/cache tokens, cost, latency. Drives usage dashboards.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `model` | `text` | — |  |
| `input_tokens` | `int4` | — | default: `0` |
| `output_tokens` | `int4` | — | default: `0` |
| `cache_creation_tokens` | `int4` | — | default: `0` |
| `cache_read_tokens` | `int4` | — | default: `0` |
| `purpose` | `text` | ✓ |  |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ai_token_usage")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a ticket
```ts
const { data } = await admin.from("ai_token_usage")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("ai_token_usage")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
