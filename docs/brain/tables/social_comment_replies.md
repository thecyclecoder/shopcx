# social_comment_replies

Outbound replies to social-comment tickets (Meta / IG comments).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `social_comment_id` | `uuid` | — | → [[social_comments]].id |
| `meta_reply_id` | `text` | ✓ |  |
| `meta_sender_id` | `text` | ✓ |  |
| `meta_sender_name` | `text` | ✓ |  |
| `direction` | `text` | — |  |
| `author_type` | `text` | — |  |
| `author_user_id` | `uuid` | ✓ |  |
| `body` | `text` | — |  |
| `send_status` | `text` | ✓ |  |
| `send_error` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `social_comment_id` → [[social_comments]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("social_comment_replies")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("social_comment_replies")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
