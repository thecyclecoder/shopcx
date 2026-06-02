# playbook_policies

Policies attached to playbooks — limits, escalation thresholds. See [[../playbooks/README]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `playbook_id` | `uuid` | — | → [[playbooks]].id |
| `name` | `text` | — |  |
| `description` | `text` | ✓ |  |
| `conditions` | `jsonb` | — | default: `'{}'` |
| `ai_talking_points` | `text` | ✓ |  |
| `sort_order` | `int4` | — | default: `0` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `policy_url` | `text` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `playbook_id` → [[playbooks]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[playbook_exceptions]].`policy_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("playbook_policies")
  .select("id, name, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("playbook_policies")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
