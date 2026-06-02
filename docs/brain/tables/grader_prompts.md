# grader_prompts

Prompts used by the AI quality-grader pipeline to score sent responses.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `title` | `text` | — |  |
| `content` | `text` | — |  |
| `status` | `text` | — | default: `'proposed'` |
| `derived_from_ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `derived_from_analysis_id` | `uuid` | ✓ | → [[ticket_analyses]].id |
| `proposed_at` | `timestamptz` | ✓ | default: `now()` |
| `reviewed_at` | `timestamptz` | ✓ |  |
| `reviewed_by` | `uuid` | ✓ |  |
| `sort_order` | `int4` | ✓ | default: `100` |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `updated_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `derived_from_analysis_id` → [[ticket_analyses]].`id`
- `derived_from_ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("grader_prompts")
  .select("id, title, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("grader_prompts")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("grader_prompts")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
