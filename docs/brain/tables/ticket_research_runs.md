# ticket_research_runs

Per-ticket research runs (the deep-investigation pipeline that runs before a heal attempt).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `ticket_id` | `uuid` | — | → [[tickets]].id |
| `recipe_slug` | `text` | — |  |
| `recipe_version` | `int4` | — | default: `1` |
| `ran_at` | `timestamptz` | — | default: `now()` |
| `findings` | `jsonb` | — | default: `'[]'` |
| `gaps` | `jsonb` | — | default: `'[]'` |
| `triggered_by` | `text` | — |  |
| `source_analysis_id` | `uuid` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ticket_heal_attempts]].`research_run_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ticket_research_runs")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a ticket
```ts
const { data } = await admin.from("ticket_research_runs")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
