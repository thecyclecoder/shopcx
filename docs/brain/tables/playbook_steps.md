# playbook_steps

Steps inside a playbook — ordered, with action type and config. See [[../playbooks/README]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `playbook_id` | `uuid` | — | → [[playbooks]].id |
| `step_order` | `int4` | — | default: `0` |
| `type` | `text` | — |  |
| `name` | `text` | — |  |
| `instructions` | `text` | ✓ |  |
| `data_access` | `text[]` | — | default: `'{}'` |
| `resolved_condition` | `text` | ✓ |  |
| `config` | `jsonb` | — | default: `'{}'` |
| `skippable` | `bool` | — | default: `true` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `playbook_id` → [[playbooks]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("playbook_steps")
  .select("id, name, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("playbook_steps")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
