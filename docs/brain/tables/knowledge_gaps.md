# knowledge_gaps

AI-detected knowledge gaps — moments the AI had nothing to say. Surfaced for admin review.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `topic` | `text` | — |  |
| `ticket_count` | `int4` | — | default: `0` |
| `sample_ticket_ids` | `uuid[]` | ✓ | default: `'{}'` |
| `suggested_title` | `text` | ✓ |  |
| `suggested_content` | `text` | ✓ |  |
| `suggested_category` | `text` | ✓ |  |
| `status` | `text` | — | default: `'pending'` |
| `created_kb_id` | `uuid` | ✓ | → [[knowledge_base]].id |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `created_kb_id` → [[knowledge_base]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("knowledge_gaps")
  .select("id, status, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("knowledge_gaps")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("knowledge_gaps")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
