# banned_meta_users

Meta DM / comment senders banned from messaging us. Workspace-scoped.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_sender_id` | `text` | — |  |
| `sender_name` | `text` | ✓ |  |
| `sender_username` | `text` | ✓ |  |
| `reason` | `text` | ✓ |  |
| `banned_by` | `uuid` | ✓ |  |
| `banned_at` | `timestamptz` | — | default: `now()` |
| `unbanned_at` | `timestamptz` | ✓ |  |
| `unbanned_by` | `uuid` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("banned_meta_users")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
