# kb_chunks

RAG retrieval chunks for knowledge base articles. pgvector embedding (1536).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `kb_id` | `uuid` | — | → [[knowledge_base]].id |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `chunk_text` | `text` | — |  |
| `embedding` | `vector` | ✓ |  |
| `chunk_index` | `int4` | — |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `kb_id` → [[knowledge_base]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("kb_chunks")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("kb_chunks")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
