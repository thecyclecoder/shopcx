# playbooks

Customer-service playbooks (e.g. unwanted_charge_subscription_dispute). Discoverable by Sonnet.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `description` | `text` | ✓ |  |
| `trigger_intents` | `text[]` | — | default: `'{}'` |
| `trigger_patterns` | `text[]` | — | default: `'{}'` |
| `priority` | `int4` | — | default: `0` |
| `is_active` | `bool` | — | default: `true` |
| `exception_limit` | `int4` | — | default: `1` |
| `stand_firm_max` | `int4` | — | default: `3` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `stand_firm_before_exceptions` | `int4` | — | default: `2` |
| `stand_firm_between_tiers` | `int4` | — | default: `2` |
| `exception_disqualifiers` | `jsonb` | — | default: `'[]'` |
| `disqualifier_behavior` | `text` | — | default: `'silent'` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[playbook_exceptions]].`playbook_id`
- [[playbook_policies]].`playbook_id`
- [[playbook_simulations]].`playbook_id`
- [[playbook_steps]].`playbook_id`
- [[tickets]].`active_playbook_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("playbooks")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("playbooks")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Discoverable by Sonnet via name OR any entry in `trigger_intents[]` (case-insensitive).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
