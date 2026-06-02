# workspace_members

User ↔ workspace membership. role enum (owner/admin/agent/social/marketing/read_only). display_name is the user-facing label.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `user_id` | `uuid` | — |  |
| `role` | `workspace_role` | — | default: `'read_only'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `display_name` | `text` | ✓ |  |
| `slack_user_id` | `text` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[fraud_cases]].`assigned_to`
- [[fraud_cases]].`reviewed_by`
- [[store_credit_log]].`issued_by`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("workspace_members")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("workspace_members")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Roles: `owner`, `admin`, `agent`, `social`, `marketing`, `read_only`.
- Always use `display_name` for user-facing strings — never full name. See feedback_display_name.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
