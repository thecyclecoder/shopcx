# workspace_pattern_overrides

Per-workspace overrides on global smart_patterns (disable a global pattern, raise/lower its threshold).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `pattern_id` | `uuid` | — | → [[smart_patterns]].id |
| `enabled` | `bool` | — | default: `true` |

## Foreign keys

**Out (this → others):**

- `pattern_id` → [[smart_patterns]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("workspace_pattern_overrides")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
