# ticket_heal_attempts

Per-ticket auto-heal attempts (research-and-heal pipeline). See [[../lifecycles/research-and-heal]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `ticket_id` | `uuid` | — | → [[tickets]].id |
| `research_run_id` | `uuid` | — | → [[ticket_research_runs]].id |
| `gap_id` | `text` | — |  |
| `recipe_slug` | `text` | — |  |
| `action_type` | `text` | — |  |
| `action_params` | `jsonb` | — | default: `'{}'` |
| `status` | `text` | — | default: `'pending'` |
| `result` | `jsonb` | ✓ |  |
| `error` | `text` | ✓ |  |
| `customer_message_sent` | `bool` | — | default: `false` |
| `customer_message_body` | `text` | ✓ |  |
| `attempted_at` | `timestamptz` | — | default: `now()` |
| `attempted_by` | `uuid` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `research_run_id` → [[ticket_research_runs]].`id`
- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ticket_heal_attempts")
  .select("id, status")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("ticket_heal_attempts")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Rows for a ticket
```ts
const { data } = await admin.from("ticket_heal_attempts")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
