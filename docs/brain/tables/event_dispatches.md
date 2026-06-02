# event_dispatches

Per-(event, sink) dispatch state for the CAPI clearinghouse — pending/sent/failed/dlq. See STOREFRONT.md.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `event_id` | `uuid` | — | → [[storefront_events]].id |
| `sink_id` | `uuid` | — | → [[event_sinks]].id |
| `status` | `text` | — | default: `'pending'` |
| `attempts` | `int4` | — | default: `0` |
| `last_attempted_at` | `timestamptz` | ✓ |  |
| `last_response_code` | `int4` | ✓ |  |
| `last_response_body` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `event_id` → [[storefront_events]].`id`
- `sink_id` → [[event_sinks]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("event_dispatches")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("event_dispatches")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("event_dispatches")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
