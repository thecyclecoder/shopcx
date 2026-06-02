# fraud_rules

Configurable fraud detection rules (shared_address, high_velocity, address_distance, name_mismatch, amazon_reseller).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `rule_type` | `text` | — |  |
| `name` | `text` | — |  |
| `description` | `text` | ✓ |  |
| `is_active` | `bool` | — | default: `true` |
| `config` | `jsonb` | — | default: `'{}'` |
| `severity` | `text` | — | default: `'medium'` |
| `is_seeded` | `bool` | — | default: `false` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[fraud_cases]].`rule_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("fraud_rules")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("fraud_rules")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
