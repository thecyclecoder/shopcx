# playbook_exceptions

Per-(playbook, customer/ticket) one-off exception grants (e.g. tenured customer auto-approved).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `playbook_id` | `uuid` | — | → [[playbooks]].id |
| `policy_id` | `uuid` | — | → [[playbook_policies]].id |
| `tier` | `int4` | — | default: `1` |
| `name` | `text` | — |  |
| `conditions` | `jsonb` | — | default: `'{}'` |
| `resolution_type` | `text` | — |  |
| `instructions` | `text` | ✓ |  |
| `auto_grant` | `bool` | — | default: `false` · **Feature removed 2026-06-03** — column retained for backward compatibility but unused. The executor still filters `!auto_grant` defensively so any legacy `true` rows stay out of customer-facing tier offers. New rows are forced to `false` on every save. |
| `auto_grant_trigger` | `text` | ✓ | **Feature removed 2026-06-03.** Historical values: `duplicate_charge` / `cancelled_but_charged` / `never_delivered`. Never read at runtime now. |
| `sort_order` | `int4` | — | default: `0` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `skip_stand_firm` | `bool` | — | default: `false` |

## Foreign keys

**Out (this → others):**

- `playbook_id` → [[playbooks]].`id`
- `policy_id` → [[playbook_policies]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("playbook_exceptions")
  .select("id, name, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("playbook_exceptions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
