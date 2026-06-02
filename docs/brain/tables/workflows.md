# workflows

Template-based deterministic workflows (order_tracking, cancel_request, subscription_inquiry, account_login, end_chat).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `template` | `text` | — |  |
| `trigger_tag` | `text` | — |  |
| `enabled` | `bool` | ✓ | default: `false` |
| `config` | `jsonb` | — | default: `'{}'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `sandbox_mode` | `bool` | — | default: `false` |
| `channels` | `text[]` | ✓ | default: `'{}'` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ai_workflows]].`post_response_workflow_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("workflows")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("workflows")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Discoverable by Sonnet via name OR `trigger_tag` OR `template` (case-insensitive).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
