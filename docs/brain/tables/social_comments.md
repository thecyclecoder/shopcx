# social_comments

Inbound social comments (Meta Page posts, Instagram). channel='social_comments'.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_page_id` | `uuid` | — | → [[meta_pages]].id |
| `meta_comment_id` | `text` | — |  |
| `meta_parent_comment_id` | `text` | ✓ |  |
| `meta_post_id` | `text` | — |  |
| `meta_sender_id` | `text` | — |  |
| `meta_sender_name` | `text` | ✓ |  |
| `meta_sender_username` | `text` | ✓ |  |
| `body` | `text` | — |  |
| `is_ad` | `bool` | — | default: `false` |
| `page_type` | `text` | — |  |
| `ad_id` | `text` | ✓ |  |
| `sentiment` | `text` | ✓ |  |
| `matched_product_id` | `uuid` | ✓ | → [[products]].id |
| `status` | `text` | — | default: `'open'` |
| `moderation_source` | `text` | ✓ |  |
| `ai_action` | `text` | ✓ |  |
| `ai_reply_body` | `text` | ✓ |  |
| `ai_reasoning` | `text` | ✓ |  |
| `ai_ran_at` | `timestamptz` | ✓ |  |
| `assigned_to` | `uuid` | ✓ |  |
| `liked_at` | `timestamptz` | ✓ |  |
| `hidden_at` | `timestamptz` | ✓ |  |
| `hidden_by` | `uuid` | ✓ |  |
| `deleted_at` | `timestamptz` | ✓ |  |
| `deleted_by` | `uuid` | ✓ |  |
| `replied_at` | `timestamptz` | ✓ |  |
| `replied_by` | `uuid` | ✓ |  |
| `edited_at` | `timestamptz` | ✓ |  |
| `deleted_by_user_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `ai_visibility` | `text` | ✓ |  |
| `ai_considers` | `jsonb` | ✓ |  |
| `ai_kb_sources` | `text[]` | — | default: `'{}'` |
| `ai_model` | `text` | ✓ |  |
| `human_rating` | `text` | ✓ |  |
| `human_rating_notes` | `text` | ✓ |  |
| `human_rated_at` | `timestamptz` | ✓ |  |
| `human_rated_by` | `uuid` | ✓ |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `matched_product_id` → [[products]].`id`
- `meta_page_id` → [[meta_pages]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[social_comment_replies]].`social_comment_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("social_comments")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("social_comments")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("social_comments")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("social_comments")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
