# sync_jobs

Background sync job state (Shopify bulk ops, Appstle pulls) — progress, status, error.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `type` | `text` | — |  |
| `status` | `text` | — | default: `'pending'` |
| `phase` | `text` | ✓ |  |
| `total_customers` | `int4` | ✓ | default: `0` |
| `synced_customers` | `int4` | ✓ | default: `0` |
| `total_orders` | `int4` | ✓ | default: `0` |
| `synced_orders` | `int4` | ✓ | default: `0` |
| `error` | `text` | ✓ |  |
| `started_at` | `timestamptz` | ✓ | default: `now()` |
| `completed_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `current_month` | `int4` | ✓ | default: `0` |
| `total_months` | `int4` | ✓ | default: `36` |
| `last_completed_month` | `int4` | ✓ | default: `0` |
| `last_cursor` | `text` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("sync_jobs")
  .select("id, status, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("sync_jobs")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("sync_jobs")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
