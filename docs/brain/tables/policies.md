# policies

Canonical published policies (refund window, restocking, exchange rules, etc). Consumed by orchestrator, storefront, and (TODO) playbook executor.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `slug` | `text` | — |  |
| `name` | `text` | — |  |
| `version` | `int4` | — | default: `1` |
| `effective_at` | `timestamptz` | — | default: `now()` |
| `superseded_by` | `uuid` | ✓ | → [[policies]].id |
| `customer_summary` | `text` | — |  |
| `internal_summary` | `text` | — |  |
| `rules` | `jsonb` | — | default: `'[]'` |
| `is_active` | `bool` | — | default: `true` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `updated_by` | `uuid` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `superseded_by` → [[policies]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[policies]].`superseded_by`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("policies")
  .select("id, slug, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("policies")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- 5 canonical policies. Replaces ~60 scattered `sonnet_prompts` rules.
- Consumed by orchestrator + storefront. Playbook executor migration is pending.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
