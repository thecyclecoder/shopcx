# import_jobs

Background import jobs (Shopify/Gorgias/Klaviyo) with progress + status. UI shows a progress bar.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `type` | `text` | — |  |
| `status` | `text` | — | default: `'pending'` |
| `file_path` | `text` | — |  |
| `total_records` | `int4` | ✓ | default: `0` |
| `processed_records` | `int4` | ✓ | default: `0` |
| `failed_records` | `int4` | ✓ | default: `0` |
| `total_chunks` | `int4` | ✓ | default: `0` |
| `completed_chunks` | `int4` | ✓ | default: `0` |
| `finalize_total` | `int4` | ✓ | default: `0` |
| `finalize_completed` | `int4` | ✓ | default: `0` |
| `error` | `text` | ✓ |  |
| `failed_chunk_index` | `int4` | ✓ |  |
| `started_at` | `timestamptz` | ✓ | default: `now()` |
| `completed_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("import_jobs")
  .select("id, status, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("import_jobs")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("import_jobs")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
